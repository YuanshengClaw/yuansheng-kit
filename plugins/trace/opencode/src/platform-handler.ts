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

interface OpenCodeConfiguration {
  readonly agent: AgentConfiguration;
  readonly artifactRoot: ArtifactRootConfiguration;
  readonly command: CommandConfiguration;
  readonly copies: readonly CopyConfiguration[];
  readonly permissions: Readonly<Record<string, PermissionAction>>;
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
    if (!SAFE_IDENTIFIER.test(name)) {
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
    ["agent", "artifact_root", "command", "copies", "permissions"],
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
  for (const destination of [
    agent.destination,
    command.destination,
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
    permissions: parsePermissions(configuration.permissions),
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
      body,
    ].join("\n"),
  );
}

function outputPath(output: PlatformOutputV1): string {
  return output.type === "copy-resource" ? output.destination : output.path;
}

function compareOutputs(left: PlatformOutputV1, right: PlatformOutputV1): number {
  const leftPath = outputPath(left);
  const rightPath = outputPath(right);
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
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
