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
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const SAFE_NODE_BUILTIN = /^node:[a-z0-9][a-z0-9/_-]*$/u;
const SAFE_DESTINATION =
  /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)(?:\.|\.\.)(?:\/|$))(?!.*\/\/)(?!.*\\).+$/u;
const EXPECTED_PLUGIN_ID = "craft";
const EXPECTED_PLATFORM_ID = "opencode";
const EXPECTED_ARTIFACT_NAME = "opencode-ys-craft";
const EXPECTED_PRIMARY_AGENT = "ys-craft";
const EXPECTED_RUNTIME_DEPENDENCIES = Object.freeze({
  "@opencode-ai/plugin": "1.18.4",
  ajv: "8.20.0",
  "ajv-formats": "3.0.1",
  canonicalize: "3.0.0",
  "jsonc-parser": "3.3.1",
});

type PermissionAction = "allow" | "ask" | "deny";

interface AgentConfiguration {
  readonly description: string;
  readonly destination: string;
  readonly id: string;
  readonly mode: "primary" | "subagent";
  readonly resource: string;
}

interface CopyConfiguration {
  readonly destination: string;
  readonly resource: string;
}

interface RuntimeConfiguration {
  readonly destination: string;
  readonly entrypointResource: string;
  readonly external: readonly string[];
  readonly packageResource: string;
}

export interface OpenCodeConfiguration {
  readonly agents: readonly AgentConfiguration[];
  readonly copies: readonly CopyConfiguration[];
  readonly permissions: Readonly<Record<string, PermissionAction>>;
  readonly runtime: RuntimeConfiguration;
}

function fail(message: string): never {
  throw new TypeError(`Invalid Yuansheng Craft OpenCode configuration: ${message}`);
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

function requireUniqueStrings(value: unknown, label: string, pattern: RegExp): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${label} must be an array of strings`);
  }
  const strings = value.map((item) => requireString(item, label));
  if (new Set(strings).size !== strings.length || strings.some((item) => !pattern.test(item))) {
    fail(`${label} must contain unique valid values`);
  }
  return Object.freeze(strings);
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
    fail(`${label} references resource ${JSON.stringify(resourceId)} outside the closure`);
  }
  if (expectedKind !== undefined && resource.kind !== expectedKind) {
    fail(`${label} resource must have kind ${JSON.stringify(expectedKind)}`);
  }
  if (requireSingleFile && (resource.source.kind !== "file" || resource.files.length !== 1)) {
    fail(`${label} resource must be a single file`);
  }
  return resource;
}

function parseAgents(value: unknown): readonly AgentConfiguration[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("agents must be a non-empty array");
  }
  const agents = value.map((item, index) => {
    const agent = requireRecord(item, `agents[${index}]`);
    requireExactKeys(
      agent,
      ["description", "destination", "id", "mode", "resource"],
      `agents[${index}]`,
    );
    const id = requireIdentifier(agent.id, `agents[${index}].id`);
    const mode = requireString(agent.mode, `agents[${index}].mode`);
    if (mode !== "primary" && mode !== "subagent") {
      fail(`agents[${index}].mode must be primary or subagent`);
    }
    const destination = requireDestination(agent.destination, `agents[${index}].destination`);
    if (destination !== `.opencode/agents/${id}.md`) {
      fail(`agents[${index}].destination must match its id`);
    }
    return Object.freeze({
      description: requireString(agent.description, `agents[${index}].description`),
      destination,
      id,
      mode,
      resource: requireIdentifier(agent.resource, `agents[${index}].resource`),
    });
  });
  if (new Set(agents.map((agent) => agent.id)).size !== agents.length) {
    fail("agents must not repeat an id");
  }
  if (new Set(agents.map((agent) => agent.destination)).size !== agents.length) {
    fail("agents must not repeat a destination");
  }
  const primaryAgents = agents.filter((agent) => agent.mode === "primary");
  if (primaryAgents.length !== 1 || primaryAgents[0]?.id !== EXPECTED_PRIMARY_AGENT) {
    fail(`agents must contain exactly one ${EXPECTED_PRIMARY_AGENT} primary agent`);
  }
  return Object.freeze(agents);
}

function parseCopies(value: unknown): readonly CopyConfiguration[] {
  if (!Array.isArray(value)) {
    fail("copies must be an array");
  }
  const copies = value.map((item, index) => {
    const copy = requireRecord(item, `copies[${index}]`);
    requireExactKeys(copy, ["destination", "resource"], `copies[${index}]`);
    return Object.freeze({
      destination: requireDestination(copy.destination, `copies[${index}].destination`),
      resource: requireIdentifier(copy.resource, `copies[${index}].resource`),
    });
  });
  if (new Set(copies.map((copy) => copy.resource)).size !== copies.length) {
    fail("copies must not repeat a resource");
  }
  if (new Set(copies.map((copy) => copy.destination)).size !== copies.length) {
    fail("copies must not repeat a destination");
  }
  return Object.freeze(copies);
}

function parsePermissions(value: unknown): Readonly<Record<string, PermissionAction>> {
  const permissions = requireRecord(value, "permissions");
  if (Object.keys(permissions).length === 0) {
    fail("permissions must not be empty");
  }
  const parsed: Record<string, PermissionAction> = {};
  for (const name of Object.keys(permissions)) {
    if (name !== "*" && name !== "ys_craft_*" && !/^[a-z][a-z0-9_]*$/u.test(name)) {
      fail(`permission name ${JSON.stringify(name)} is invalid`);
    }
    const action = permissions[name];
    if (action !== "allow" && action !== "ask" && action !== "deny") {
      fail(`permission ${JSON.stringify(name)} has an invalid action`);
    }
    parsed[name] = action;
  }
  if (parsed["*"] !== "deny" || parsed["ys_craft_*"] === undefined) {
    fail("permissions must deny the catch-all and configure the Craft tool family");
  }
  return Object.freeze(parsed);
}

function parseRuntime(value: unknown): RuntimeConfiguration {
  const runtime = requireRecord(value, "runtime");
  requireExactKeys(
    runtime,
    ["destination", "entrypointResource", "external", "packageResource"],
    "runtime",
  );
  return Object.freeze({
    destination: requireDestination(runtime.destination, "runtime.destination"),
    entrypointResource: requireIdentifier(runtime.entrypointResource, "runtime.entrypointResource"),
    external: requireUniqueStrings(runtime.external, "runtime.external", SAFE_NODE_BUILTIN),
    packageResource: requireIdentifier(runtime.packageResource, "runtime.packageResource"),
  });
}

function parseConfiguration(value: unknown): OpenCodeConfiguration {
  const configuration = requireRecord(value, "configuration");
  requireExactKeys(configuration, ["agents", "copies", "permissions", "runtime"], "configuration");
  const permissions = parsePermissions(configuration.permissions);
  if (permissions["ys_craft_*"] !== "allow") {
    fail("permissions must allow the Craft tool family");
  }
  return Object.freeze({
    agents: parseAgents(configuration.agents),
    copies: parseCopies(configuration.copies),
    permissions,
    runtime: parseRuntime(configuration.runtime),
  });
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

function generateAgent(
  configuration: OpenCodeConfiguration,
  agent: AgentConfiguration,
  body: string,
): Uint8Array {
  const permissions = Object.entries(configuration.permissions)
    .map(([name, action]) => `  ${JSON.stringify(name)}: ${action}`)
    .join("\n");
  return UTF8_ENCODER.encode(
    [
      "---",
      `description: ${JSON.stringify(agent.description)}`,
      `mode: ${agent.mode}`,
      "permission:",
      permissions,
      "---",
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
  packageResourceId: string,
  resources: ReadonlyMap<string, ResolvedResourceV1>,
): Promise<readonly Readonly<{ name: string; version: string }>[]> {
  requireResource(resources, packageResourceId, "platform-package", true, "runtime package");
  let packageDefinition: unknown;
  try {
    packageDefinition = JSON.parse(
      UTF8_DECODER.decode(await assembly.readSource(packageResourceId, "")),
    );
  } catch {
    fail("runtime package must be valid UTF-8 JSON");
  }
  const packageRecord = requireRecord(packageDefinition, "runtime package");
  if (packageRecord.name !== EXPECTED_ARTIFACT_NAME) {
    fail("runtime package name must match the artifact name");
  }
  const dependencies = requireRecord(packageRecord.dependencies, "runtime package dependencies");
  const names = Object.keys(dependencies).sort();
  const expectedNames = Object.keys(EXPECTED_RUNTIME_DEPENDENCIES).sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    fail("runtime package dependencies must match the locked Craft runtime set");
  }
  return Object.freeze(
    names.map((name) => {
      const version = dependencies[name];
      if (
        typeof version !== "string" ||
        version !==
          EXPECTED_RUNTIME_DEPENDENCIES[name as keyof typeof EXPECTED_RUNTIME_DEPENDENCIES] ||
        !SAFE_PACKAGE_NAME.test(name)
      ) {
        fail(`runtime package must pin ${name} to the selected project version`);
      }
      return Object.freeze({ name, version });
    }),
  );
}

async function assembleOpenCode(assembly: ResolvedAssemblyV1): Promise<PlatformAssemblyPlanV1> {
  if (
    assembly.apiVersion !== 1 ||
    assembly.plugin.id !== EXPECTED_PLUGIN_ID ||
    assembly.platform.id !== EXPECTED_PLATFORM_ID ||
    assembly.platform.artifactName !== EXPECTED_ARTIFACT_NAME
  ) {
    fail("assembly identity does not match the Yuansheng Craft OpenCode target");
  }
  const configuration = parseConfiguration(assembly.platform.configuration);
  const resources = new Map(assembly.resources.map((resource) => [resource.id, resource]));
  for (const agent of configuration.agents) {
    requireResource(resources, agent.resource, "agent", true, `agent ${agent.id}`);
  }
  const runtimeResources = runtimeResourceClosure(
    resources,
    configuration.runtime.entrypointResource,
  );
  const bundledPackages = await validateRuntimePackage(
    assembly,
    configuration.runtime.packageResource,
    resources,
  );
  const copiedResourceIds = new Set(configuration.copies.map((copy) => copy.resource));
  const platformHandlers = assembly.resources.filter(
    (resource) => resource.kind === "platform-handler",
  );
  if (platformHandlers.length !== 1) {
    fail("the platform handler must be the only platform-handler resource");
  }
  const emittedResourceIds = new Set([
    ...configuration.agents.map((agent) => agent.resource),
    ...configuration.copies.map((copy) => copy.resource),
    ...runtimeResources.map((resource) => resource.id),
    configuration.runtime.packageResource,
    platformHandlers[0]?.id ?? "",
  ]);
  const omittedResource = assembly.resources.find(
    (resource) => !emittedResourceIds.has(resource.id),
  );
  if (omittedResource !== undefined) {
    fail(`resolved resource ${JSON.stringify(omittedResource.id)} has no output mapping`);
  }
  for (const copy of configuration.copies) {
    requireResource(resources, copy.resource, undefined, false, "copy");
  }
  if (
    configuration.agents.some((agent) => copiedResourceIds.has(agent.resource)) ||
    copiedResourceIds.has(platformHandlers[0]?.id ?? "")
  ) {
    fail("generated agents and the platform handler must not be copied");
  }

  const outputs: PlatformOutputV1[] = [];
  for (const agent of configuration.agents) {
    const body = decodeMarkdown(await assembly.readSource(agent.resource, ""), `agent ${agent.id}`);
    outputs.push({
      bytes: generateAgent(configuration, agent, body),
      mode: "0644",
      path: agent.destination,
      type: "generated-file",
    });
  }
  outputs.push({
    bundledPackages,
    destination: configuration.runtime.destination,
    entrypoint: configuration.runtime.entrypointResource,
    external: configuration.runtime.external,
    resources: runtimeResources.map((resource) => resource.id),
    type: "bun-bundle",
  });
  for (const copy of configuration.copies) {
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
