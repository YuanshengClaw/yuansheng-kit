import { posix } from "node:path";

import type { ArtifactOutputFile } from "./artifact";
import { PluginBuilderError } from "./errors";
import { sha256Hex } from "./json";
import { assertSafeRelativePosixPath, isPathWithin } from "./paths";
import type { SourceResourceSnapshot } from "./sources";
import { readStableOpenFile, type WorkspaceReader } from "./workspace-fs";

const VIRTUAL_SOURCE_ROOT = "/__yuansheng_sources__";
const ENTRYPOINT_SPECIFIER = "yuansheng:entry";
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const NODE_BUILTIN = /^node:[a-z0-9][a-z0-9/_-]*$/u;

interface BunBundlePlan {
  readonly bundledPackages: readonly BundledPackage[];
  readonly destination: string;
  readonly entrypoint: string;
  readonly expectedSha256: string;
  readonly external: readonly string[];
  readonly resources: readonly string[];
}

interface BundledPackage {
  readonly name: string;
  readonly version: string;
}

interface LockedPackage extends BundledPackage {
  readonly dependencies: readonly string[];
}

interface VirtualSource {
  readonly bytes: Uint8Array;
  readonly loader: Bun.Loader;
  readonly resourceId: string;
}

function contractError(message: string): PluginBuilderError {
  return new PluginBuilderError("handler-contract-invalid", "handler", message);
}

function buildError(message: string, cause?: unknown): PluginBuilderError {
  return new PluginBuilderError(
    "handler-failed",
    "handler",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw contractError("bun-bundle output has invalid fields");
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) {
    throw contractError(`${label} must be a non-empty NFC string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string, pattern?: RegExp): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw contractError(`${label} must be a non-empty array`);
  }
  const items = value.map((item, index) => {
    const text = requireString(item, `${label}[${index}]`);
    if (pattern !== undefined && !pattern.test(text)) {
      throw contractError(`${label}[${index}] is invalid`);
    }
    return text;
  });
  if (new Set(items).size !== items.length) {
    throw contractError(`${label} must not contain duplicates`);
  }
  const sorted = [...items].sort();
  if (items.some((item, index) => item !== sorted[index])) {
    throw contractError(`${label} must be sorted`);
  }
  return items;
}

function requireBundledPackages(value: unknown): readonly BundledPackage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw contractError("bun-bundle bundledPackages must be a non-empty array");
  }
  const packages = value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw contractError(`bun-bundle bundledPackages[${index}] must be an object`);
    }
    requireExactKeys(item as Record<string, unknown>, ["name", "version"]);
    const name = requireString(
      (item as Record<string, unknown>).name,
      `bun-bundle bundledPackages[${index}].name`,
    );
    const version = requireString(
      (item as Record<string, unknown>).version,
      `bun-bundle bundledPackages[${index}].version`,
    );
    if (!PACKAGE_NAME.test(name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      throw contractError(`bun-bundle bundledPackages[${index}] is invalid`);
    }
    return Object.freeze({ name, version });
  });
  const identities = packages.map((item) => `${item.name}@${item.version}`);
  if (new Set(identities).size !== identities.length) {
    throw contractError("bun-bundle bundledPackages must not contain duplicates");
  }
  const sorted = [...packages].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  if (packages.some((item, index) => item !== sorted[index])) {
    throw contractError("bun-bundle bundledPackages must be sorted");
  }
  return packages;
}

function parsePlan(output: Record<string, unknown>): BunBundlePlan {
  requireExactKeys(output, [
    "bundledPackages",
    "destination",
    "entrypoint",
    "expectedSha256",
    "external",
    "resources",
    "type",
  ]);
  if (output.type !== "bun-bundle") {
    throw contractError("bun-bundle output type is invalid");
  }
  const destination = requireString(output.destination, "bun-bundle destination");
  assertSafeRelativePosixPath(destination, "output-path-invalid", "bun-bundle destination");
  if (!destination.endsWith(".js")) {
    throw contractError("bun-bundle destination must end with .js");
  }
  const expectedSha256 = requireString(output.expectedSha256, "bun-bundle expectedSha256");
  if (!/^[0-9a-f]{64}$/u.test(expectedSha256)) {
    throw contractError("bun-bundle expectedSha256 must be a lowercase SHA-256 digest");
  }
  return {
    bundledPackages: requireBundledPackages(output.bundledPackages),
    destination,
    entrypoint: requireString(output.entrypoint, "bun-bundle entrypoint"),
    expectedSha256,
    external: requireStringArray(output.external, "bun-bundle external", NODE_BUILTIN),
    resources: requireStringArray(output.resources, "bun-bundle resources"),
  };
}

function loaderForPath(path: string): Bun.Loader {
  switch (posix.extname(path)) {
    case ".js":
    case ".mjs":
      return "js";
    case ".json":
      return "json";
    case ".jsonc":
      return "jsonc";
    case ".ts":
    case ".mts":
      return "ts";
    default:
      throw contractError(`bun-bundle source has an unsupported extension: ${path}`);
  }
}

function virtualPath(sourcePath: string): string {
  assertSafeRelativePosixPath(sourcePath, "source-path-invalid", "bun-bundle source path");
  return `${VIRTUAL_SOURCE_ROOT}/${sourcePath}`;
}

function createVirtualSources(
  plan: BunBundlePlan,
  snapshots: ReadonlyMap<string, SourceResourceSnapshot>,
): { readonly entrypoint: string; readonly sources: ReadonlyMap<string, VirtualSource> } {
  if (!plan.resources.includes(plan.entrypoint)) {
    throw contractError("bun-bundle resources must include its entrypoint");
  }
  const sources = new Map<string, VirtualSource>();
  let entrypoint: string | undefined;
  for (const resourceId of plan.resources) {
    const snapshot = snapshots.get(resourceId);
    if (snapshot === undefined) {
      throw contractError(`bun-bundle selected undeclared resource ${resourceId}`);
    }
    if (snapshot.manifest.source.kind !== "file" || snapshot.files.length !== 1) {
      throw contractError(`bun-bundle resource ${resourceId} must be a single file`);
    }
    const file = snapshot.files[0];
    if (file === undefined) {
      throw contractError(`bun-bundle resource ${resourceId} is empty`);
    }
    const path = virtualPath(snapshot.manifest.source.path);
    if (sources.has(path)) {
      throw contractError(`bun-bundle source path is duplicated: ${snapshot.manifest.source.path}`);
    }
    sources.set(path, {
      bytes: Uint8Array.from(file.bytes),
      loader: loaderForPath(path),
      resourceId,
    });
    if (resourceId === plan.entrypoint) {
      entrypoint = path;
    }
  }
  if (entrypoint === undefined) {
    throw contractError("bun-bundle entrypoint source is missing");
  }
  return { entrypoint, sources };
}

function resolveRelativeSource(
  importer: string,
  specifier: string,
  sources: ReadonlyMap<string, VirtualSource>,
): string {
  const base = posix.normalize(posix.resolve(posix.dirname(importer), specifier));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.mts`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.json`,
    `${base}.jsonc`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ];
  const resolved = candidates.find((candidate) => sources.has(candidate));
  if (resolved === undefined || !resolved.startsWith(`${VIRTUAL_SOURCE_ROOT}/`)) {
    throw buildError(`bun-bundle import is outside its selected resources: ${specifier}`);
  }
  return resolved;
}

function topLevelPackage(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
}

function formatBuildLogs(logs: readonly unknown[]): string {
  return logs.map((log) => String(log)).join("; ");
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseLockedResolution(resolution: string): BundledPackage | undefined {
  if (resolution.includes("@workspace:")) {
    return undefined;
  }
  const separator = resolution.lastIndexOf("@");
  if (separator <= 0 || separator === resolution.length - 1) {
    return undefined;
  }
  const name = resolution.slice(0, separator);
  const version = resolution.slice(separator + 1);
  if (!PACKAGE_NAME.test(name) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    return undefined;
  }
  return { name, version };
}

function lockedPackageClosure(
  bunLockBytes: Uint8Array,
  directPackages: readonly BundledPackage[],
): ReadonlySet<string> {
  let lockValue: unknown;
  try {
    lockValue = Bun.JSONC.parse(new TextDecoder("utf-8", { fatal: true }).decode(bunLockBytes));
  } catch (cause) {
    throw buildError("Root bun.lock could not be parsed for bundle dependency validation", cause);
  }
  const packageTable = jsonRecord(jsonRecord(lockValue)?.packages);
  if (packageTable === undefined) {
    throw buildError("Root bun.lock has no package table");
  }
  const packagesByName = new Map<string, LockedPackage[]>();
  for (const entry of Object.values(packageTable)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") {
      continue;
    }
    const identity = parseLockedResolution(entry[0]);
    if (identity === undefined) {
      continue;
    }
    const metadata = jsonRecord(entry[2]);
    const dependencies = jsonRecord(metadata?.dependencies);
    const lockedPackage: LockedPackage = {
      ...identity,
      dependencies: dependencies === undefined ? [] : Object.keys(dependencies).sort(),
    };
    const versions = packagesByName.get(identity.name) ?? [];
    versions.push(lockedPackage);
    packagesByName.set(identity.name, versions);
  }

  const selected = new Set<string>();
  const queue: LockedPackage[] = [];
  for (const directPackage of directPackages) {
    const locked = packagesByName
      .get(directPackage.name)
      ?.find((candidate) => candidate.version === directPackage.version);
    if (locked === undefined) {
      throw buildError(
        `Direct bundle dependency is not pinned by bun.lock: ${directPackage.name}@${directPackage.version}`,
      );
    }
    queue.push(locked);
  }
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const identity = `${current.name}@${current.version}`;
    if (selected.has(identity)) {
      continue;
    }
    selected.add(identity);
    for (const dependency of current.dependencies) {
      const candidates = packagesByName.get(dependency);
      if (candidates === undefined || candidates.length === 0) {
        throw buildError(`bun.lock dependency is unresolved: ${current.name} -> ${dependency}`);
      }
      queue.push(...candidates);
    }
  }
  return selected;
}

function packageRootForInput(inputPath: string, workspaceRoot: string): string | undefined {
  if (inputPath.includes(VIRTUAL_SOURCE_ROOT)) {
    return undefined;
  }
  const normalized = inputPath.replaceAll("\\", "/");
  const absolute = posix.isAbsolute(normalized)
    ? normalized
    : posix.resolve(workspaceRoot, normalized);
  const nodeModulesRoot = posix.join(workspaceRoot, "node_modules");
  if (!isPathWithin(nodeModulesRoot, absolute)) {
    throw buildError(`Bundle input is outside verified sources and node_modules: ${inputPath}`);
  }
  const marker = "/node_modules/";
  const markerIndex = absolute.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw buildError(`Bundle input has no package root: ${inputPath}`);
  }
  const packageStart = markerIndex + marker.length;
  const remainder = absolute.slice(packageStart).split("/");
  const segmentCount = remainder[0]?.startsWith("@") ? 2 : 1;
  const packageSegments = remainder.slice(0, segmentCount);
  if (packageSegments.length !== segmentCount || packageSegments.some((segment) => !segment)) {
    throw buildError(`Bundle input has an invalid package root: ${inputPath}`);
  }
  return `${absolute.slice(0, packageStart)}${packageSegments.join("/")}`;
}

async function readPackageIdentity(
  packageRoot: string,
  workspace: WorkspaceReader,
): Promise<string> {
  const packageJsonPath = posix.relative(
    workspace.rootPath,
    posix.join(packageRoot, "package.json"),
  );
  const anchored = await workspace.openFile(packageJsonPath, "Bundled dependency package.json");
  try {
    const stable = await readStableOpenFile(anchored, "Bundled dependency package.json");
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stable.bytes));
    const record = jsonRecord(value);
    if (
      record === undefined ||
      typeof record.name !== "string" ||
      typeof record.version !== "string"
    ) {
      throw buildError(`Bundled dependency has invalid package metadata: ${packageJsonPath}`);
    }
    return `${record.name}@${record.version}`;
  } catch (cause) {
    if (cause instanceof PluginBuilderError) {
      throw cause;
    }
    throw buildError(
      `Bundled dependency package metadata cannot be read: ${packageJsonPath}`,
      cause,
    );
  } finally {
    await anchored.handle.close();
  }
}

async function validateMetafile(
  plan: BunBundlePlan,
  metafile: Bun.BuildMetafile | undefined,
  sources: ReadonlyMap<string, VirtualSource>,
  lockedPackages: ReadonlySet<string>,
  workspace: WorkspaceReader,
): Promise<void> {
  if (metafile === undefined) {
    throw buildError("Bun did not return the required bundle metafile");
  }
  const inputPaths = Object.keys(metafile.inputs);
  const packageRoots = new Set<string>();
  for (const inputPath of inputPaths) {
    if (inputPath.includes(VIRTUAL_SOURCE_ROOT)) {
      if (![...sources.keys()].some((sourcePath) => inputPath.endsWith(sourcePath))) {
        throw buildError(`Bundle metafile contains an undeclared virtual source: ${inputPath}`);
      }
      continue;
    }
    const packageRoot = packageRootForInput(inputPath, workspace.rootPath);
    if (packageRoot === undefined) {
      throw buildError(`Bundle metafile input has no verified origin: ${inputPath}`);
    }
    packageRoots.add(packageRoot);
  }
  const observedPackages = new Set<string>();
  for (const packageRoot of packageRoots) {
    const identity = await readPackageIdentity(packageRoot, workspace);
    if (!lockedPackages.has(identity)) {
      throw buildError(`Bundle contains a dependency outside the bun.lock closure: ${identity}`);
    }
    observedPackages.add(identity);
  }
  for (const packageDefinition of plan.bundledPackages) {
    const identity = `${packageDefinition.name}@${packageDefinition.version}`;
    if (!observedPackages.has(identity)) {
      throw buildError(`Required package was not bundled: ${identity}`);
    }
  }
  const allowedExternal = new Set(plan.external);
  const observedExternal = new Set<string>();
  for (const [inputPath, input] of Object.entries(metafile.inputs)) {
    for (const dependency of input.imports) {
      if (dependency.external !== true) {
        continue;
      }
      const specifier = dependency.original ?? dependency.path;
      if (!allowedExternal.has(specifier)) {
        throw buildError(
          `Bundle input ${inputPath} contains an undeclared external import: ${specifier}`,
        );
      }
      observedExternal.add(specifier);
    }
  }
  for (const specifier of allowedExternal) {
    if (!observedExternal.has(specifier)) {
      throw buildError(`Declared external import was not used: ${specifier}`);
    }
  }
}

function assertPortableBundle(bytes: Uint8Array, workspaceRoot: string): void {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const forbidden = [
    workspaceRoot,
    "/nix/store",
    "/proc/self/fd",
    "node_modules/.bun",
    VIRTUAL_SOURCE_ROOT,
  ];
  const marker = forbidden.find((item) => text.includes(item));
  if (marker !== undefined) {
    throw buildError(`Bundle contains a build-host path marker: ${marker}`);
  }
}

function requireResolvedDependencyPath(path: string, workspaceRoot: string): string {
  if (!posix.isAbsolute(path) || !isPathWithin(posix.join(workspaceRoot, "node_modules"), path)) {
    throw buildError(`Bundled dependency resolved outside node_modules: ${path}`);
  }
  return path;
}

export async function expandBunBundleOutput(
  output: Record<string, unknown>,
  snapshots: ReadonlyMap<string, SourceResourceSnapshot>,
  workspace: WorkspaceReader,
  bunLockBytes: Uint8Array,
): Promise<ArtifactOutputFile> {
  const plan = parsePlan(output);
  const { entrypoint, sources } = createVirtualSources(plan, snapshots);
  const lockedPackages = lockedPackageClosure(bunLockBytes, plan.bundledPackages);
  const bundledPackages = new Set(plan.bundledPackages.map((item) => item.name));
  const external = new Set(plan.external);
  const plugin: Bun.BunPlugin = {
    name: "yuansheng-verified-sources",
    setup(builder) {
      builder.onResolve({ filter: /.*/u }, (args) => {
        if (args.importer.length === 0 && args.path === ENTRYPOINT_SPECIFIER) {
          return { namespace: "yuansheng-source", path: entrypoint };
        }
        if (sources.has(args.importer)) {
          if (args.path.startsWith(".")) {
            return {
              namespace: "yuansheng-source",
              path: resolveRelativeSource(args.importer, args.path, sources),
            };
          }
          if (args.path.startsWith("node:")) {
            if (!external.has(args.path)) {
              throw buildError(`bun-bundle source imports undeclared builtin ${args.path}`);
            }
            return { external: true, path: args.path };
          }
          const packageName = topLevelPackage(args.path);
          if (!bundledPackages.has(packageName)) {
            throw buildError(`bun-bundle source imports undeclared package ${args.path}`);
          }
          try {
            return {
              path: requireResolvedDependencyPath(
                Bun.resolveSync(args.path, workspace.rootDirectoryPath()),
                workspace.rootPath,
              ),
            };
          } catch (cause) {
            throw buildError(`bun-bundle package cannot be resolved: ${args.path}`, cause);
          }
        }
        if (args.path.startsWith("node:")) {
          if (!external.has(args.path)) {
            throw buildError(`Bundled dependency imports undeclared builtin ${args.path}`);
          }
          return { external: true, path: args.path };
        }
        if (args.importer.length === 0) {
          throw buildError(`Bun requested an unexpected entrypoint: ${args.path}`);
        }
        try {
          return {
            path: requireResolvedDependencyPath(
              Bun.resolveSync(args.path, posix.dirname(args.importer)),
              workspace.rootPath,
            ),
          };
        } catch (cause) {
          throw buildError(`Bundled dependency cannot be resolved: ${args.path}`, cause);
        }
      });
      builder.onLoad({ filter: /.*/u, namespace: "yuansheng-source" }, (args) => {
        const source = sources.get(args.path);
        if (source === undefined) {
          throw buildError(`bun-bundle attempted to load undeclared source ${args.path}`);
        }
        return { contents: source.bytes, loader: source.loader };
      });
    },
  };

  let result: Bun.BuildOutput;
  try {
    result = await Bun.build({
      allowUnresolved: [],
      entrypoints: [ENTRYPOINT_SPECIFIER],
      env: "disable",
      external: [...plan.external],
      format: "esm",
      metafile: true,
      minify: true,
      naming: posix.basename(plan.destination),
      packages: "bundle",
      plugins: [plugin],
      sourcemap: "none",
      splitting: false,
      target: "bun",
      throw: false,
    });
  } catch (cause) {
    throw buildError("Bun could not build the selected runtime sources", cause);
  }
  if (!result.success) {
    throw buildError(
      `Bun could not build the selected runtime sources: ${formatBuildLogs(result.logs)}`,
    );
  }
  const entryOutputs = result.outputs.filter((candidate) => candidate.kind === "entry-point");
  if (entryOutputs.length !== 1 || result.outputs.length !== 1) {
    const inventory = result.outputs
      .map((candidate) => `${candidate.kind}:${candidate.loader}:${candidate.path}`)
      .join(", ");
    throw buildError(
      `Bun bundle must contain exactly one JavaScript entry output; received ${inventory}`,
    );
  }
  await validateMetafile(plan, result.metafile, sources, lockedPackages, workspace);
  const entryOutput = entryOutputs[0];
  if (entryOutput === undefined) {
    throw buildError("Bun bundle entry output is missing");
  }
  const bytes = new Uint8Array(await entryOutput.arrayBuffer());
  assertPortableBundle(bytes, workspace.rootPath);
  const actualSha256 = sha256Hex(bytes);
  if (actualSha256 !== plan.expectedSha256) {
    throw buildError(
      `Bun bundle SHA-256 mismatch: expected ${plan.expectedSha256}, received ${actualSha256}`,
    );
  }
  return { bytes, mode: "0644", path: plan.destination };
}
