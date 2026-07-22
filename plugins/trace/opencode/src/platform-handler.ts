import type {
  PlatformAssemblyPlanV1,
  PlatformHandlerV1,
  PlatformOutputV1,
  ResolvedAssemblyV1,
  ResolvedResourceV1,
} from "../../../../tools/plugin-builder/src/platform-handler";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();
const SAFE_IDENTIFIER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SAFE_PERMISSION_NAME = /^[a-z][a-z0-9_]*$/u;
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const SAFE_NODE_BUILTIN = /^node:[a-z0-9][a-z0-9/_-]*$/u;
const SAFE_DESTINATION =
  /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)(?:\.|\.\.)(?:\/|$))(?!.*\/\/)(?!.*\\).+$/u;
const EXPECTED_PLUGIN_ID = "trace";
const EXPECTED_PLATFORM_ID = "opencode";
const EXPECTED_ARTIFACT_NAME = "@yuansheng-kit/opencode-ys-trace";
const ARGUMENT_PLACEHOLDER = "$ARGUMENTS";

type PermissionAction = "allow" | "ask" | "deny";

interface AgentConfiguration {
  readonly description: string;
  readonly destination: string;
  readonly id: string;
  readonly mode: "primary";
  readonly resource: string;
}

interface CommandConfiguration {
  readonly agent: string;
  readonly argumentPlaceholder: typeof ARGUMENT_PLACEHOLDER;
  readonly description: string;
  readonly destination: string;
  readonly id: string;
  readonly resource: string;
}

interface CopyConfiguration {
  readonly destination: string;
  readonly resource: string;
}

interface ArtifactRootConfiguration {
  readonly defaultRelativePath: string;
  readonly requiresResolvedAbsolutePath: true;
}

interface RuntimeConfiguration {
  readonly bundleSha256: string;
  readonly destination: string;
  readonly entrypointResource: string;
  readonly external: readonly string[];
  readonly packageResource: string;
  readonly tool: string;
}

interface OpenCodeConfiguration {
  readonly agent: AgentConfiguration;
  readonly artifactRoot: ArtifactRootConfiguration;
  readonly command: CommandConfiguration;
  readonly copies: readonly CopyConfiguration[];
  readonly permissions: Readonly<Record<string, PermissionAction>>;
  readonly runtime: RuntimeConfiguration;
}

function fail(message: string): never {
  throw new TypeError(`Invalid Yuansheng Trace OpenCode configuration: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(`${label} must contain exactly ${sortedExpected.join(", ")}`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) {
    fail(`${label} must be a non-empty NFC string`);
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  const identifier = requireString(value, label);
  if (!SAFE_IDENTIFIER.test(identifier)) {
    fail(`${label} must be a normalized lower-case identifier`);
  }
  return identifier;
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

function requireDestination(value: unknown, label: string): string {
  const destination = requireString(value, label);
  if (!SAFE_DESTINATION.test(destination) || hasAsciiControl(destination)) {
    fail(`${label} must be a safe relative POSIX path`);
  }
  return destination;
}

function requireResource(
  resources: ReadonlyMap<string, ResolvedResourceV1>,
  resourceId: string,
  expectedKind: string | undefined,
  requireSingleFile: boolean,
  label: string,
): ResolvedResourceV1 {
  const resource = resources.get(resourceId);
  if (resource === undefined) {
    fail(`${label} references resource ${JSON.stringify(resourceId)} outside the resolved closure`);
  }
  if (expectedKind !== undefined && resource.kind !== expectedKind) {
    fail(`${label} resource must have kind ${JSON.stringify(expectedKind)}`);
  }
  if (requireSingleFile && (resource.source.kind !== "file" || resource.files.length !== 1)) {
    fail(`${label} resource must be a single file`);
  }
  return resource;
}

function parseAgent(value: unknown): AgentConfiguration {
  const agent = requireRecord(value, "agent");
  requireExactKeys(agent, ["description", "destination", "id", "mode", "resource"], "agent");
  const mode = requireString(agent.mode, "agent.mode");
  if (mode !== "primary") {
    fail("agent.mode must be primary");
  }
  return {
    description: requireString(agent.description, "agent.description"),
    destination: requireDestination(agent.destination, "agent.destination"),
    id: requireIdentifier(agent.id, "agent.id"),
    mode,
    resource: requireIdentifier(agent.resource, "agent.resource"),
  };
}

function parseCommand(value: unknown): CommandConfiguration {
  const command = requireRecord(value, "command");
  requireExactKeys(
    command,
    ["agent", "argument_placeholder", "description", "destination", "id", "resource"],
    "command",
  );
  const argumentPlaceholder = requireString(
    command.argument_placeholder,
    "command.argument_placeholder",
  );
  if (argumentPlaceholder !== ARGUMENT_PLACEHOLDER) {
    fail(`command.argument_placeholder must be ${ARGUMENT_PLACEHOLDER}`);
  }
  return {
    agent: requireIdentifier(command.agent, "command.agent"),
    argumentPlaceholder,
    description: requireString(command.description, "command.description"),
    destination: requireDestination(command.destination, "command.destination"),
    id: requireIdentifier(command.id, "command.id"),
    resource: requireIdentifier(command.resource, "command.resource"),
  };
}

function parseCopies(value: unknown): readonly CopyConfiguration[] {
  if (!Array.isArray(value)) {
    fail("copies must be an array");
  }
  const copies = value.map((item, index) => {
    const copy = requireRecord(item, `copies[${index}]`);
    requireExactKeys(copy, ["destination", "resource"], `copies[${index}]`);
    return {
      destination: requireDestination(copy.destination, `copies[${index}].destination`),
      resource: requireIdentifier(copy.resource, `copies[${index}].resource`),
    };
  });
  const resources = new Set<string>();
  const destinations = new Set<string>();
  for (const copy of copies) {
    if (resources.has(copy.resource)) {
      fail(`copies repeats resource ${JSON.stringify(copy.resource)}`);
    }
    if (destinations.has(copy.destination)) {
      fail(`copies repeats destination ${JSON.stringify(copy.destination)}`);
    }
    resources.add(copy.resource);
    destinations.add(copy.destination);
  }
  return copies;
}

function parsePermissions(value: unknown): Readonly<Record<string, PermissionAction>> {
  const permissions = requireRecord(value, "permissions");
  if (Object.keys(permissions).length === 0) {
    fail("permissions must not be empty");
  }
  const parsed: Record<string, PermissionAction> = {};
  for (const name of Object.keys(permissions).sort()) {
    if (!SAFE_PERMISSION_NAME.test(name)) {
      fail(`permission name ${JSON.stringify(name)} is invalid`);
    }
    const action = permissions[name];
    if (action !== "allow" && action !== "ask" && action !== "deny") {
      fail(`permission ${JSON.stringify(name)} has an invalid action`);
    }
    parsed[name] = action;
  }
  return Object.freeze(parsed);
}

function requireUniqueStringArray(
  value: unknown,
  label: string,
  pattern: RegExp,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must be a non-empty array`);
  }
  const parsed = value.map((item, index) => {
    const text = requireString(item, `${label}[${index}]`);
    if (!pattern.test(text)) {
      fail(`${label}[${index}] is invalid`);
    }
    return text;
  });
  if (new Set(parsed).size !== parsed.length) {
    fail(`${label} must not contain duplicates`);
  }
  const sorted = [...parsed].sort();
  if (parsed.some((item, index) => item !== sorted[index])) {
    fail(`${label} must be sorted`);
  }
  return Object.freeze(parsed);
}

function parseRuntime(value: unknown): RuntimeConfiguration {
  const runtime = requireRecord(value, "runtime");
  requireExactKeys(
    runtime,
    ["bundle_sha256", "destination", "entrypoint_resource", "external", "package_resource", "tool"],
    "runtime",
  );
  const bundleSha256 = requireString(runtime.bundle_sha256, "runtime.bundle_sha256");
  if (!/^[0-9a-f]{64}$/u.test(bundleSha256)) {
    fail("runtime.bundle_sha256 must be a lowercase SHA-256 digest");
  }
  const tool = requireString(runtime.tool, "runtime.tool");
  if (!SAFE_PERMISSION_NAME.test(tool)) {
    fail("runtime.tool must be a normalized OpenCode tool identifier");
  }
  return {
    bundleSha256,
    destination: requireDestination(runtime.destination, "runtime.destination"),
    entrypointResource: requireIdentifier(
      runtime.entrypoint_resource,
      "runtime.entrypoint_resource",
    ),
    external: requireUniqueStringArray(runtime.external, "runtime.external", SAFE_NODE_BUILTIN),
    packageResource: requireIdentifier(runtime.package_resource, "runtime.package_resource"),
    tool,
  };
}

function parseArtifactRoot(value: unknown): ArtifactRootConfiguration {
  const artifactRoot = requireRecord(value, "artifact_root");
  requireExactKeys(
    artifactRoot,
    ["default_relative_path", "requires_resolved_absolute_path"],
    "artifact_root",
  );
  if (artifactRoot.requires_resolved_absolute_path !== true) {
    fail("artifact_root.requires_resolved_absolute_path must be true");
  }
  return {
    defaultRelativePath: requireDestination(
      artifactRoot.default_relative_path,
      "artifact_root.default_relative_path",
    ),
    requiresResolvedAbsolutePath: true,
  };
}

function parseConfiguration(value: unknown): OpenCodeConfiguration {
  const configuration = requireRecord(value, "configuration");
  requireExactKeys(
    configuration,
    ["agent", "artifact_root", "command", "copies", "permissions", "runtime"],
    "configuration",
  );
  const agent = parseAgent(configuration.agent);
  const command = parseCommand(configuration.command);
  if (command.agent !== agent.id) {
    fail("command.agent must match agent.id");
  }
  if (agent.destination !== `.opencode/agents/${agent.id}.md`) {
    fail("agent.destination must match agent.id");
  }
  if (command.destination !== `.opencode/commands/${command.id}.md`) {
    fail("command.destination must match command.id");
  }
  const artifactRoot = parseArtifactRoot(configuration.artifact_root);
  const copies = parseCopies(configuration.copies);
  const permissions = parsePermissions(configuration.permissions);
  const runtime = parseRuntime(configuration.runtime);
  if (permissions[runtime.tool] !== "allow") {
    fail("runtime.tool permission must be allow");
  }
  for (const destination of [
    agent.destination,
    command.destination,
    runtime.destination,
    ...copies.map((copy) => copy.destination),
  ]) {
    if (
      destination === artifactRoot.defaultRelativePath ||
      destination.startsWith(`${artifactRoot.defaultRelativePath}/`) ||
      artifactRoot.defaultRelativePath.startsWith(`${destination}/`)
    ) {
      fail("artifact_root must not overlap an assembled output");
    }
  }
  return {
    agent,
    artifactRoot,
    command,
    copies,
    permissions,
    runtime,
  };
}

function decodeMarkdown(bytes: Uint8Array, label: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    fail(`${label} must not start with a UTF-8 byte order mark`);
  }
  let contents: string;
  try {
    contents = UTF8_DECODER.decode(bytes);
  } catch {
    fail(`${label} must be valid UTF-8`);
  }
  if (contents.startsWith("---\n") || contents.startsWith("---\r\n")) {
    fail(`${label} must not contain platform front matter`);
  }
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function generateAgent(configuration: OpenCodeConfiguration, body: string): Uint8Array {
  const permissions = Object.entries(configuration.permissions)
    .map(([name, action]) => `  ${name}: ${action}`)
    .join("\n");
  return UTF8_ENCODER.encode(
    [
      "---",
      `description: ${quoteYaml(configuration.agent.description)}`,
      `mode: ${configuration.agent.mode}`,
      "permission:",
      permissions,
      "---",
      "",
      body,
    ].join("\n"),
  );
}

function generateCommand(configuration: OpenCodeConfiguration, body: string): Uint8Array {
  return UTF8_ENCODER.encode(
    [
      "---",
      `agent: ${configuration.command.agent}`,
      `description: ${quoteYaml(configuration.command.description)}`,
      "---",
      "",
      `User input: ${configuration.command.argumentPlaceholder}`,
      "",
      `After collecting both required inputs, call ${configuration.runtime.tool} with those exact values and the optional artifact_root override. Present the returned absolute artifact_root before any later effect.`,
      "",
      body,
    ].join("\n"),
  );
}

function outputPath(output: PlatformOutputV1): string {
  return output.type === "generated-file" ? output.path : output.destination;
}

function compareOutputs(left: PlatformOutputV1, right: PlatformOutputV1): number {
  const leftPath = outputPath(left);
  const rightPath = outputPath(right);
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
}

function runtimeResourceClosure(
  resources: ReadonlyMap<string, ResolvedResourceV1>,
  entrypoint: string,
): readonly ResolvedResourceV1[] {
  const selected = new Map<string, ResolvedResourceV1>();
  const visit = (resourceId: string): void => {
    if (selected.has(resourceId)) {
      return;
    }
    const resource = requireResource(resources, resourceId, undefined, true, "runtime");
    selected.set(resourceId, resource);
    for (const dependency of resource.requires) {
      visit(dependency);
    }
  };
  visit(entrypoint);
  return [...selected.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

async function validateRuntimePackage(
  assembly: ResolvedAssemblyV1,
  configuration: OpenCodeConfiguration,
  resources: ReadonlyMap<string, ResolvedResourceV1>,
): Promise<readonly Readonly<{ name: string; version: string }>[]> {
  requireResource(
    resources,
    configuration.runtime.packageResource,
    "platform-package",
    true,
    "runtime.package_resource",
  );
  let packageDefinition: unknown;
  try {
    packageDefinition = JSON.parse(
      UTF8_DECODER.decode(await assembly.readSource(configuration.runtime.packageResource, "")),
    );
  } catch {
    fail("runtime package resource must be valid UTF-8 JSON");
  }
  const packageRecord = requireRecord(packageDefinition, "runtime package");
  if (packageRecord.name !== EXPECTED_ARTIFACT_NAME) {
    fail("runtime package name does not match the artifact name");
  }
  const dependencies = requireRecord(packageRecord.dependencies, "runtime package dependencies");
  const packageNames = Object.keys(dependencies).sort();
  if (packageNames.length === 0) {
    fail("runtime package dependencies must not be empty");
  }
  const bundledPackages = packageNames.map((packageName) => {
    if (!SAFE_PACKAGE_NAME.test(packageName)) {
      fail(`runtime package dependency ${JSON.stringify(packageName)} has an invalid name`);
    }
    const version = dependencies[packageName];
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      fail(`runtime package dependency ${JSON.stringify(packageName)} must have a version`);
    }
    return Object.freeze({ name: packageName, version });
  });
  if (dependencies["@opencode-ai/plugin"] !== "1.18.4") {
    fail("runtime package must pin @opencode-ai/plugin to 1.18.4");
  }
  return Object.freeze(bundledPackages);
}

async function assembleOpenCode(assembly: ResolvedAssemblyV1): Promise<PlatformAssemblyPlanV1> {
  if (
    assembly.apiVersion !== 1 ||
    assembly.plugin.id !== EXPECTED_PLUGIN_ID ||
    assembly.platform.id !== EXPECTED_PLATFORM_ID ||
    assembly.platform.artifactName !== EXPECTED_ARTIFACT_NAME
  ) {
    fail("assembly identity does not match the Yuansheng Trace OpenCode target");
  }
  const configuration = parseConfiguration(assembly.platform.configuration);
  const resources = new Map(assembly.resources.map((resource) => [resource.id, resource]));
  requireResource(resources, configuration.agent.resource, "agent", true, "agent");
  requireResource(resources, configuration.command.resource, "command", true, "command");
  requireResource(
    resources,
    configuration.runtime.entrypointResource,
    "platform-runtime",
    true,
    "runtime.entrypoint_resource",
  );
  const bundledPackages = await validateRuntimePackage(assembly, configuration, resources);
  const runtimeResources = runtimeResourceClosure(
    resources,
    configuration.runtime.entrypointResource,
  );
  const copiedResourceIds = new Set(configuration.copies.map((copy) => copy.resource));
  if (
    copiedResourceIds.has(configuration.agent.resource) ||
    copiedResourceIds.has(configuration.command.resource)
  ) {
    fail("logical agent and command resources must only be emitted as generated files");
  }
  const platformHandlers = assembly.resources.filter(
    (resource) => resource.kind === "platform-handler",
  );
  if (platformHandlers.length !== 1 || copiedResourceIds.has(platformHandlers[0]?.id ?? "")) {
    fail("the platform handler must be the sole build-time-only resource");
  }
  const emittedResourceIds = new Set([
    configuration.agent.resource,
    configuration.command.resource,
    configuration.runtime.packageResource,
    ...runtimeResources.map((resource) => resource.id),
    ...copiedResourceIds,
    platformHandlers[0]?.id ?? "",
  ]);
  const omittedResource = assembly.resources.find(
    (resource) => !emittedResourceIds.has(resource.id),
  );
  if (omittedResource !== undefined) {
    fail(`resolved resource ${JSON.stringify(omittedResource.id)} has no output mapping`);
  }

  const outputs: PlatformOutputV1[] = [];
  const agentBody = decodeMarkdown(
    await assembly.readSource(configuration.agent.resource, ""),
    "agent source",
  );
  const commandBody = decodeMarkdown(
    await assembly.readSource(configuration.command.resource, ""),
    "command source",
  );
  outputs.push(
    {
      bytes: generateAgent(configuration, agentBody),
      mode: "0644",
      path: configuration.agent.destination,
      type: "generated-file",
    },
    {
      bytes: generateCommand(configuration, commandBody),
      mode: "0644",
      path: configuration.command.destination,
      type: "generated-file",
    },
    {
      bundledPackages,
      destination: configuration.runtime.destination,
      entrypoint: configuration.runtime.entrypointResource,
      expectedSha256: configuration.runtime.bundleSha256,
      external: configuration.runtime.external,
      resources: runtimeResources.map((resource) => resource.id),
      type: "bun-bundle",
    },
  );

  for (const copy of configuration.copies) {
    requireResource(resources, copy.resource, undefined, false, "copy");
    outputs.push({
      destination: copy.destination,
      resourceId: copy.resource,
      type: "copy-resource",
    });
  }

  outputs.sort(compareOutputs);
  return Object.freeze({ outputs: Object.freeze(outputs) });
}

export const openCodePlatformHandler: PlatformHandlerV1 = Object.freeze({
  apiVersion: 1,
  assemble: assembleOpenCode,
  platform: EXPECTED_PLATFORM_ID,
});
