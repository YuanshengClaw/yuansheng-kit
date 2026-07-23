import { isAbsolute, relative, resolve } from "node:path";
import { SourceTextModule } from "node:vm";

import { type ArtifactOutputFile, commitArtifact } from "./artifact";
import { expandBunBundleOutput } from "./bun-bundle";
import { PLUGIN_BUILDER_BUN_VERSION } from "./cli-contract";
import { loadPluginConfig, selectPluginConfig } from "./config";
import { PluginBuilderError } from "./errors";
import { canonicalJson, canonicalJsonBytes, sha256Hex } from "./json";
import { createResolvedAssembly } from "./model";
import { assertSafeRelativePosixPath, isPathWithin } from "./paths";
import type {
  JsonObject,
  JsonValue,
  PlatformAssemblyPlanV1,
  PlatformHandlerV1,
} from "./platform-handler";
import {
  resolveResourceSources,
  type SourceResourceSnapshot,
  verifyResourceSources,
} from "./sources";
import { readStableOpenFile, WorkspaceReader } from "./workspace-fs";

export interface BuildPluginOptions {
  readonly configPath: string;
  readonly outputPath: string;
  readonly platform: string;
  readonly workspaceRoot: string;
}

export interface BuildReceiptV2 extends JsonObject {
  readonly artifact_manifest_sha256: string;
  readonly artifact_name: string;
  readonly bun_lock_sha256: string;
  readonly content_tree_sha256: string;
  readonly config_sha256: string;
  readonly format_version: 2;
  readonly output: string;
  readonly platform: string;
  readonly plugin: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputError(
  code: "workspace-invalid" | "source-missing",
  message: string,
  cause?: unknown,
) {
  return new PluginBuilderError(
    code,
    "input",
    message,
    cause === undefined ? undefined : { cause },
  );
}

async function readWorkspaceFile(
  workspace: WorkspaceReader,
  requestedPath: string,
  label: string,
): Promise<{ readonly bytes: Uint8Array; readonly path: string }> {
  const relativePath = isAbsolute(requestedPath)
    ? relative(workspace.rootPath, resolve(requestedPath)).split("\\").join("/")
    : requestedPath;
  const anchored = await workspace.openFile(relativePath, label);
  try {
    const stable = await readStableOpenFile(anchored, label);
    return { bytes: stable.bytes, path: anchored.canonicalPath };
  } finally {
    await anchored.handle.close();
  }
}

async function readBuildDefinition(workspace: WorkspaceReader): Promise<{
  readonly bunLockBytes: Uint8Array;
  readonly bunLockPath: string;
  readonly packagePath: string;
}> {
  const packageFile = await readWorkspaceFile(workspace, "package.json", "Root package.json");
  const bunLockFile = await readWorkspaceFile(workspace, "bun.lock", "Root bun.lock");
  let packageDefinition: unknown;
  try {
    packageDefinition = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(packageFile.bytes),
    );
  } catch (cause) {
    throw inputError("workspace-invalid", "Root package.json is invalid", cause);
  }
  if (
    !isRecord(packageDefinition) ||
    packageDefinition.packageManager !== `bun@${PLUGIN_BUILDER_BUN_VERSION}`
  ) {
    throw inputError(
      "workspace-invalid",
      `Root package.json must select bun@${PLUGIN_BUILDER_BUN_VERSION}`,
    );
  }
  return {
    bunLockBytes: bunLockFile.bytes,
    bunLockPath: bunLockFile.path,
    packagePath: packageFile.path,
  };
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathWithin(left, right) || isPathWithin(right, left);
}

function resolveOutputPath(
  workspaceRoot: string,
  requestedPath: string,
  protectedPaths: readonly string[],
): string {
  if (!isAbsolute(requestedPath)) {
    assertSafeRelativePosixPath(requestedPath, "output-path-invalid", "Output path");
  }
  const outputPath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspaceRoot, ...requestedPath.split("/"));
  if (protectedPaths.some((protectedPath) => pathsOverlap(outputPath, protectedPath))) {
    throw new PluginBuilderError(
      "output-path-invalid",
      "output",
      "Output path overlaps a build input",
    );
  }
  return outputPath;
}

async function loadHandler(
  handlerBytes: Uint8Array,
  exportName: string,
  expectedPlatform: string,
  sourceSha256: string,
): Promise<PlatformHandlerV1> {
  let module: Record<string, unknown>;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(handlerBytes);
    const transpiled = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(source);
    const handlerModule = new SourceTextModule(transpiled, {
      identifier: `yuansheng-plugin-handler:${sourceSha256}`,
    });
    await handlerModule.link((specifier) => {
      throw new TypeError(`Platform handlers must be self-contained: ${specifier}`);
    });
    await handlerModule.evaluate();
    module = handlerModule.namespace as unknown as Record<string, unknown>;
  } catch (cause) {
    throw new PluginBuilderError(
      "handler-load-failed",
      "handler",
      "Platform handler module could not be loaded",
      { cause },
    );
  }
  const value = module[exportName];
  if (
    !isRecord(value) ||
    value.apiVersion !== 1 ||
    value.platform !== expectedPlatform ||
    typeof value.assemble !== "function"
  ) {
    throw new PluginBuilderError(
      "handler-contract-invalid",
      "handler",
      "Platform handler export does not implement PlatformHandlerV1",
    );
  }
  return value as unknown as PlatformHandlerV1;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new PluginBuilderError(
      "handler-contract-invalid",
      "handler",
      "Platform handler returned an output with invalid fields",
    );
  }
}

function expandCopyOutput(
  output: Record<string, unknown>,
  snapshots: ReadonlyMap<string, SourceResourceSnapshot>,
): readonly ArtifactOutputFile[] {
  assertExactKeys(output, ["destination", "resourceId", "type"]);
  if (typeof output.resourceId !== "string" || typeof output.destination !== "string") {
    throw new PluginBuilderError(
      "handler-contract-invalid",
      "handler",
      "copy-resource output fields must be strings",
    );
  }
  assertSafeRelativePosixPath(
    output.destination,
    "output-path-invalid",
    `Resource ${output.resourceId} destination`,
  );
  const resource = snapshots.get(output.resourceId);
  if (resource === undefined) {
    throw new PluginBuilderError(
      "handler-contract-invalid",
      "handler",
      `Platform handler selected undeclared resource ${output.resourceId}`,
    );
  }
  if (resource.config.source.kind === "file") {
    const file = resource.files[0];
    if (file === undefined) {
      throw new PluginBuilderError(
        "internal-error",
        "internal",
        `Resolved file resource is empty: ${output.resourceId}`,
      );
    }
    return [{ bytes: file.bytes, mode: file.mode, path: output.destination }];
  }
  return resource.files.map((file) => ({
    bytes: file.bytes,
    mode: file.mode,
    path: `${output.destination}/${file.relativePath}`,
  }));
}

function expandGeneratedOutput(output: Record<string, unknown>): readonly ArtifactOutputFile[] {
  assertExactKeys(output, ["bytes", "mode", "path", "type"]);
  if (
    typeof output.path !== "string" ||
    !(output.bytes instanceof Uint8Array) ||
    (output.mode !== "0644" && output.mode !== "0755")
  ) {
    throw new PluginBuilderError(
      "handler-contract-invalid",
      "handler",
      "generated-file output does not match its contract",
    );
  }
  return [{ bytes: Uint8Array.from(output.bytes), mode: output.mode, path: output.path }];
}

async function expandPlan(
  plan: PlatformAssemblyPlanV1,
  snapshots: ReadonlyMap<string, SourceResourceSnapshot>,
  workspace: WorkspaceReader,
  bunLockBytes: Uint8Array,
): Promise<readonly ArtifactOutputFile[]> {
  if (!isRecord(plan) || !Array.isArray(plan.outputs) || Object.keys(plan).length !== 1) {
    throw new PluginBuilderError(
      "handler-contract-invalid",
      "handler",
      "Platform handler returned an invalid assembly plan",
    );
  }
  const files: ArtifactOutputFile[] = [];
  for (const candidate of plan.outputs as readonly unknown[]) {
    if (
      !isRecord(candidate) ||
      (candidate.type !== "bun-bundle" &&
        candidate.type !== "copy-resource" &&
        candidate.type !== "generated-file")
    ) {
      throw new PluginBuilderError(
        "handler-contract-invalid",
        "handler",
        "Platform handler returned an unknown output type",
      );
    }
    if (candidate.type === "copy-resource") {
      files.push(...expandCopyOutput(candidate, snapshots));
    } else if (candidate.type === "generated-file") {
      files.push(...expandGeneratedOutput(candidate));
    } else {
      files.push(await expandBunBundleOutput(candidate, snapshots, workspace, bunLockBytes));
    }
  }
  return files;
}

async function runHandler(
  handler: PlatformHandlerV1,
  assembly: Parameters<PlatformHandlerV1["assemble"]>[0],
): Promise<PlatformAssemblyPlanV1> {
  try {
    return await handler.assemble(assembly);
  } catch (cause) {
    throw new PluginBuilderError(
      "handler-failed",
      "handler",
      "Platform handler failed to assemble the selected resources",
      { cause },
    );
  }
}

async function buildPluginWithWorkspace(
  options: BuildPluginOptions,
  workspace: WorkspaceReader,
): Promise<BuildReceiptV2> {
  if (Bun.version !== PLUGIN_BUILDER_BUN_VERSION) {
    throw new PluginBuilderError(
      "bun-version-mismatch",
      "input",
      `plugin-builder requires Bun ${PLUGIN_BUILDER_BUN_VERSION}, received ${Bun.version}`,
    );
  }
  const workspaceRoot = workspace.rootPath;
  const buildDefinition = await readBuildDefinition(workspace);
  const configFile = await readWorkspaceFile(workspace, options.configPath, "Plugin configuration");
  const configPath = configFile.path;
  const configValue = await loadPluginConfig(configFile.bytes);
  const bunLockSha256 = sha256Hex(buildDefinition.bunLockBytes);
  const selected = selectPluginConfig(configValue, options.platform);
  const configSha256 = sha256Hex(canonicalJsonBytes(selected.config as unknown as JsonValue));
  const snapshots = await resolveResourceSources(workspace, selected.resources);
  const assembly = createResolvedAssembly({
    bunLockSha256,
    configSha256,
    selected,
    snapshots,
  });

  const handlerSnapshot = snapshots.get(selected.platform.handler.resource);
  const handlerFile = handlerSnapshot?.files[0];
  if (handlerSnapshot === undefined || handlerFile === undefined) {
    throw new PluginBuilderError(
      "handler-contract-invalid",
      "handler",
      "Resolved platform handler source is missing",
    );
  }
  const handler = await loadHandler(
    handlerFile.bytes,
    selected.platform.handler.export,
    selected.platform.id,
    handlerFile.sha256,
  );
  const plan = await runHandler(handler, assembly);
  const files = await expandPlan(plan, snapshots, workspace, buildDefinition.bunLockBytes);
  await verifyResourceSources(workspace, snapshots);

  const outputPath = resolveOutputPath(workspaceRoot, options.outputPath, [
    configPath,
    buildDefinition.packagePath,
    buildDefinition.bunLockPath,
    ...[...snapshots.values()].map((snapshot) => snapshot.absoluteRoot),
  ]);
  const committed = await commitArtifact(
    outputPath,
    {
      artifactName: selected.platform.artifactName,
      bunLockSha256,
      configSha256,
      platform: selected.platform.id,
      pluginId: selected.config.plugin.id,
    },
    files,
  );
  return Object.freeze({
    artifact_manifest_sha256: committed.artifactManifestSha256,
    artifact_name: selected.platform.artifactName,
    bun_lock_sha256: bunLockSha256,
    config_sha256: configSha256,
    content_tree_sha256: committed.contentTreeSha256,
    format_version: 2,
    output: committed.outputPath,
    platform: selected.platform.id,
    plugin: selected.config.plugin.id,
  });
}

export async function buildPlugin(options: BuildPluginOptions): Promise<BuildReceiptV2> {
  const workspace = await WorkspaceReader.open(options.workspaceRoot);
  try {
    return await buildPluginWithWorkspace(options, workspace);
  } finally {
    await workspace.close();
  }
}

export function serializeBuildReceipt(receipt: BuildReceiptV2): string {
  return canonicalJson(receipt as JsonValue);
}
