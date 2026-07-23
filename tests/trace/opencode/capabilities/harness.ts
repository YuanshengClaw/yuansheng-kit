import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

const CAPABILITIES_ROOT = import.meta.dir;
const FIXTURE_ROOT = join(CAPABILITIES_ROOT, "fixtures", "project");
const PLUGIN_SOURCE = join(CAPABILITIES_ROOT, "capability-plugin.ts");
const DEFAULT_EXPECTED_VERSION = "1.18.4";
const ASK_AGENT_PROMPT_SENTINEL = "CAPABILITY_ASK_AGENT_PROMPT_SENTINEL";
const ASK_PROVIDER_REQUEST_SENTINEL = "CAPABILITY_ASK_PROVIDER_REQUEST_SENTINEL";
const ASK_TOOL_INPUT_SENTINEL = "CAPABILITY_ASK_TOOL_INPUT_SENTINEL";
const PROVIDER_RESPONSE_SENTINEL = "CAPABILITY_PROVIDER_RESPONSE_SENTINEL";
const PROCESS_TIMEOUT_MS = 30_000;
const HTTP_REQUEST_TIMEOUT_MS = 10_000;
const SERVER_START_TIMEOUT_MS = 20_000;

type JsonRecord = Record<string, unknown>;

export interface CommandResult {
  readonly args: readonly string[];
  readonly durationMs: number;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface ProviderRequest {
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
}

export interface ProbeEnvironment {
  readonly evidenceDirectory: string;
  readonly expectedVersion: string;
  readonly opencodeDirectory: string;
  readonly projectDirectory: string;
  readonly provider: LocalProvider;
  readonly root: string;
  cleanup(): Promise<void>;
  inventory(): Promise<Readonly<Record<string, string>>>;
  run(label: string, args: readonly string[], timeoutMs?: number): Promise<CommandResult>;
  startServer(): Promise<ProbeServer>;
}

export interface InstalledArtifactEnvironment {
  readonly expectedVersion: string;
  readonly opencodeDirectory: string;
  readonly projectDirectory: string;
  readonly root: string;
  cleanup(): Promise<void>;
  inventory(): Promise<Readonly<Record<string, string>>>;
  packageCacheInventory(): Promise<Readonly<Record<string, string>>>;
  run(label: string, args: readonly string[], timeoutMs?: number): Promise<CommandResult>;
  startServer(): Promise<ProbeServer>;
}

interface LocalProvider {
  readonly baseUrl: string;
  readonly requests: ProviderRequest[];
  stop(): void;
}

export interface ProbeServer {
  readonly baseUrl: string;
  request(path: string): Promise<unknown>;
  stop(): Promise<void>;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEvidenceText(text: string, root: string): string {
  return text
    .replaceAll(root, "<PROBE_ROOT>")
    .replace(/http:\/\/127\.0\.0\.1:\d+/gu, "http://127.0.0.1:<PORT>")
    .replace(/timestamp=\S+/gu, "timestamp=<TIMESTAMP>")
    .replace(/\brun=[0-9A-Za-z]+\b/gu, "run=<RUN_ID>")
    .replace(/"timestamp":\d+/gu, '"timestamp":"<TIMESTAMP>"')
    .replace(/"sessionID":"[^"]+"/gu, '"sessionID":"<SESSION_ID>"')
    .replace(/"messageID":"[^"]+"/gu, '"messageID":"<MESSAGE_ID>"')
    .replace(/"id":"(?:msg|prt)_[^"]+"/gu, '"id":"<EVENT_ID>"')
    .replace(
      /"time":\{"start":\d+,"end":\d+\}/gu,
      '"time":{"start":"<TIMESTAMP>","end":"<TIMESTAMP>"}',
    )
    .replace(/Today's date: [^\r\n]+/gu, "Today's date: <DATE>");
}

function normalizeEvidenceValue(
  value: unknown,
  root: string,
  key?: string,
  parentKey?: string,
): unknown {
  if (typeof value === "string") {
    if (key === "sessionID") {
      return "<SESSION_ID>";
    }
    if (key === "messageID") {
      return "<MESSAGE_ID>";
    }
    if (key === "id" && /^(?:msg|prt)_/u.test(value)) {
      return "<EVENT_ID>";
    }
    return normalizeEvidenceText(value, root);
  }
  if (
    typeof value === "number" &&
    (key === "timestamp" || (parentKey === "time" && (key === "start" || key === "end")))
  ) {
    return "<TIMESTAMP>";
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeEvidenceValue(item, root, undefined, key));
  }
  if (isJsonRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([itemKey, item]) => [
        itemKey,
        normalizeEvidenceValue(item, root, itemKey, key),
      ]),
    );
  }
  return value;
}

function serializeEvidence(value: unknown, root: string): string {
  return `${JSON.stringify(normalizeEvidenceValue(value, root), null, 2)}\n`;
}

async function writeEvidence(path: string, value: unknown, root: string): Promise<void> {
  await writeFile(path, serializeEvidence(value, root), {
    encoding: "utf8",
    mode: 0o600,
  });
}

function providerChunk(content: string, finishReason: "stop" | null): JsonRecord {
  return {
    choices: [
      {
        delta: content.length === 0 ? { role: "assistant" } : { content },
        finish_reason: finishReason,
        index: 0,
      },
    ],
    created: 0,
    id: "chatcmpl-capability-probe",
    model: "probe",
    object: "chat.completion.chunk",
  };
}

function providerResponse(): Response {
  const events: unknown[] = [
    providerChunk("", null),
    providerChunk(PROVIDER_RESPONSE_SENTINEL, null),
    providerChunk("", "stop"),
    {
      choices: [],
      created: 0,
      id: "chatcmpl-capability-probe",
      model: "probe",
      object: "chat.completion.chunk",
      usage: {
        completion_tokens: 1,
        prompt_tokens: 1,
        total_tokens: 2,
      },
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    },
  });
}

function providerToolCallResponse(): Response {
  const events: unknown[] = [
    providerChunk("", null),
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify({ value: ASK_TOOL_INPUT_SENTINEL }),
                  name: "capability_echo",
                },
                id: "call_capability_ask",
                index: 0,
                type: "function",
              },
            ],
          },
          finish_reason: null,
          index: 0,
        },
      ],
      created: 0,
      id: "chatcmpl-capability-ask",
      model: "probe",
      object: "chat.completion.chunk",
    },
    {
      choices: [
        {
          delta: {},
          finish_reason: "tool_calls",
          index: 0,
        },
      ],
      created: 0,
      id: "chatcmpl-capability-ask",
      model: "probe",
      object: "chat.completion.chunk",
    },
  ];
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
    },
  });
}

function startLocalProvider(evidenceDirectory: string, root: string): LocalProvider {
  const requests: ProviderRequest[] = [];
  let askToolCallSent = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      let body: unknown;
      try {
        body = text.length === 0 ? null : JSON.parse(text);
      } catch {
        body = text;
      }
      const providerRequest = {
        body,
        method: request.method,
        path: url.pathname,
      };
      requests.push(providerRequest);
      const serializedEvidence = serializeEvidence(providerRequest, root);
      const evidenceDigest = createHash("sha256")
        .update(serializedEvidence)
        .digest("hex")
        .slice(0, 16);
      await writeFile(
        join(evidenceDirectory, `provider-${evidenceDigest}.json`),
        serializedEvidence,
        { encoding: "utf8", mode: 0o600 },
      );

      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        return Response.json({ error: "unexpected capability-provider request" }, { status: 404 });
      }
      if (
        !askToolCallSent &&
        JSON.stringify(body).includes(ASK_AGENT_PROMPT_SENTINEL) &&
        JSON.stringify(body).includes(ASK_PROVIDER_REQUEST_SENTINEL)
      ) {
        askToolCallSent = true;
        return providerToolCallResponse();
      }
      return providerResponse();
    },
  });
  return {
    baseUrl: `http://${server.hostname}:${server.port}/v1`,
    requests,
    stop() {
      server.stop(true);
    },
  };
}

async function makeDirectoryReadOnly(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Capability fixture contains a symlink: ${path}`);
    }
    if (entry.isDirectory()) {
      await makeDirectoryReadOnly(path);
      continue;
    }
    await chmod(path, 0o444);
  }
  await chmod(directory, 0o555);
}

async function makeDirectoryWritable(directory: string): Promise<void> {
  await chmod(directory, 0o755).catch(() => undefined);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await makeDirectoryWritable(path);
      continue;
    }
    await chmod(path, 0o644).catch(() => undefined);
  }
}

async function directoryInventory(directory: string): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};

  async function visit(current: string): Promise<void> {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      const logicalPath = relative(directory, path).replaceAll("\\", "/");
      const status = await lstat(path);
      const mode = (status.mode & 0o777).toString(8).padStart(3, "0");
      if (status.isSymbolicLink()) {
        throw new Error(`Capability fixture contains a symlink: ${logicalPath}`);
      }
      if (status.isDirectory()) {
        result[logicalPath] = `directory:${mode}`;
        await visit(path);
        continue;
      }
      if (!status.isFile()) {
        throw new Error(`Capability fixture contains a special file: ${logicalPath}`);
      }
      const digest = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      result[logicalPath] = `file:${mode}:sha256:${digest}`;
    }
  }

  await visit(directory);
  return result;
}

async function spawnCommand(
  command: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
  },
): Promise<CommandResult> {
  const startedAt = performance.now();
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stderr: "pipe",
    stdout: "pipe",
  });
  let timedOut = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
  }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timeout);
  if (forceTimer !== undefined) {
    clearTimeout(forceTimer);
  }
  return {
    args: command.slice(1),
    durationMs: Math.round(performance.now() - startedAt),
    exitCode,
    stderr,
    stdout,
    timedOut,
  };
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let result = "";
  while (true) {
    const item = await reader.read();
    if (item.done) {
      result += decoder.decode();
      return result;
    }
    const text = decoder.decode(item.value, { stream: true });
    result += text;
    onText(result);
  }
}

async function startProbeServer(options: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly evidenceDirectory: string;
  readonly executable: string;
  readonly normalizationRoot: string;
}): Promise<ProbeServer> {
  const child = Bun.spawn([options.executable, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stderr: "pipe",
    stdout: "pipe",
  });
  let settled = false;
  let serverUrl: string | undefined;
  let resolveReady: ((url: string) => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const inspectOutput = (text: string): void => {
    if (settled) {
      return;
    }
    const match = text.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/u);
    if (match?.[1] === undefined) {
      return;
    }
    settled = true;
    serverUrl = match[1];
    resolveReady?.(serverUrl);
  };
  const stdoutPromise = readStream(child.stdout, inspectOutput);
  const stderrPromise = readStream(child.stderr, () => undefined);
  void child.exited.then((exitCode) => {
    if (settled) {
      return;
    }
    settled = true;
    rejectReady?.(new Error(`OpenCode server exited before listening (exit ${exitCode})`));
  });
  const timeout = setTimeout(() => {
    if (settled) {
      return;
    }
    settled = true;
    child.kill("SIGTERM");
    rejectReady?.(new Error("OpenCode server did not report a listening address"));
  }, SERVER_START_TIMEOUT_MS);
  try {
    serverUrl = await ready;
  } catch (error) {
    child.kill("SIGTERM");
    const forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    await child.exited;
    clearTimeout(forceTimer);
    await Promise.all([stdoutPromise, stderrPromise]);
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  let stopped = false;
  return {
    baseUrl: serverUrl,
    async request(path) {
      const url = new URL(path, serverUrl);
      url.searchParams.set("directory", options.cwd);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
      });
      const body = await response.text();
      await writeEvidence(
        join(options.evidenceDirectory, `http-${basename(path)}.json`),
        {
          body,
          method: "GET",
          path,
          status: response.status,
        },
        options.normalizationRoot,
      );
      if (!response.ok) {
        throw new Error(`OpenCode ${path} returned ${response.status}: ${body}`);
      }
      return parseJson(body);
    },
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      child.kill("SIGTERM");
      const forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      await child.exited;
      clearTimeout(forceTimer);
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      await writeEvidence(
        join(options.evidenceDirectory, "http-server.json"),
        {
          stderr,
          stdout,
          termination: "sigterm-with-sigkill-fallback",
        },
        options.normalizationRoot,
      );
    },
  };
}

function toolPath(): string {
  const configured = process.env.OPENCODE_BIN;
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  const discovered = Bun.which("opencode");
  if (discovered === null) {
    throw new Error("OpenCode was not found. Set OPENCODE_BIN to the locked v1.18.4 binary.");
  }
  return discovered;
}

async function initializeGit(projectDirectory: string, homeDirectory: string): Promise<void> {
  const path = process.env.PATH ?? "";
  const result = await spawnCommand(["git", "init", "--quiet"], {
    cwd: projectDirectory,
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: homeDirectory,
      PATH: path,
    },
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Failed to initialize the probe Git project: ${result.stderr}`);
  }
}

async function buildPlugin(opencodeDirectory: string): Promise<void> {
  const outputDirectory = join(opencodeDirectory, "plugins");
  await mkdir(outputDirectory, { recursive: true });
  const result = await Bun.build({
    entrypoints: [PLUGIN_SOURCE],
    format: "esm",
    minify: false,
    naming: "capability.js",
    outdir: outputDirectory,
    packages: "bundle",
    sourcemap: "none",
    target: "bun",
  });
  if (!result.success || result.outputs.length !== 1) {
    throw new Error(
      `Failed to bundle the capability plugin:\n${result.logs.map(String).join("\n")}`,
    );
  }
}

function openCodeConfig(providerBaseUrl: string): string {
  return JSON.stringify({
    autoupdate: false,
    enabled_providers: ["capability"],
    formatter: false,
    lsp: false,
    model: "capability/probe",
    provider: {
      capability: {
        env: [],
        models: {
          probe: {
            attachment: false,
            limit: {
              context: 4_096,
              output: 512,
            },
            name: "Capability Probe",
            reasoning: false,
            temperature: false,
            tool_call: true,
          },
        },
        name: "Local Capability Provider",
        npm: "@ai-sdk/openai-compatible",
        options: {
          apiKey: "test-only",
          baseURL: providerBaseUrl,
        },
      },
    },
    share: "disabled",
    snapshot: false,
  });
}

function installedArtifactOpenCodeConfig(): string {
  return JSON.stringify({
    autoupdate: false,
    formatter: false,
    lsp: false,
    share: "disabled",
    snapshot: false,
  });
}

function definedProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export function findRecord(
  value: unknown,
  predicate: (record: Readonly<JsonRecord>) => boolean,
): Readonly<JsonRecord> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.find((item): item is JsonRecord => isJsonRecord(item) && predicate(item));
}

export async function createProbeEnvironment(): Promise<ProbeEnvironment> {
  const executable = await realpath(toolPath());
  const root = await mkdtemp(join(tmpdir(), "yuansheng-opencode-capabilities-"));
  const homeDirectory = join(root, "home");
  const xdgConfigDirectory = join(root, "xdg-config");
  const xdgDataDirectory = join(root, "xdg-data");
  const xdgStateDirectory = join(root, "xdg-state");
  const xdgCacheDirectory = join(root, "xdg-cache");
  const temporaryDirectory = join(root, "tmp");
  const configuredEvidenceRoot = process.env.OPENCODE_CAPABILITY_EVIDENCE_DIR;
  const evidenceDirectory =
    configuredEvidenceRoot === undefined
      ? join(root, "evidence")
      : join(configuredEvidenceRoot, "runtime");
  const projectDirectory = join(root, "project");
  const globalConfigDirectory = join(xdgConfigDirectory, "opencode");
  const opencodeDirectory = join(projectDirectory, ".opencode");
  const directories = [
    homeDirectory,
    xdgConfigDirectory,
    xdgDataDirectory,
    xdgStateDirectory,
    xdgCacheDirectory,
    temporaryDirectory,
    globalConfigDirectory,
  ];
  let createdExternalEvidenceDirectory = false;
  let provider: LocalProvider | undefined;
  try {
    await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));
    if (configuredEvidenceRoot === undefined) {
      await mkdir(evidenceDirectory, { recursive: true });
    } else {
      await mkdir(configuredEvidenceRoot, { recursive: true });
      await mkdir(evidenceDirectory);
      createdExternalEvidenceDirectory = true;
    }
    await cp(FIXTURE_ROOT, projectDirectory, { recursive: true });
    await initializeGit(projectDirectory, homeDirectory);
    await buildPlugin(opencodeDirectory);
    await makeDirectoryReadOnly(opencodeDirectory);
    await makeDirectoryReadOnly(globalConfigDirectory);
    provider = startLocalProvider(evidenceDirectory, root);
  } catch (error) {
    provider?.stop();
    await makeDirectoryWritable(opencodeDirectory);
    await makeDirectoryWritable(globalConfigDirectory);
    await rm(root, { force: true, recursive: true });
    if (createdExternalEvidenceDirectory) {
      await rm(evidenceDirectory, { force: true, recursive: true });
    }
    throw error;
  }
  if (provider === undefined) {
    throw new Error("Capability provider initialization did not complete");
  }
  const expectedVersion =
    process.env.OPENCODE_CAPABILITY_EXPECTED_VERSION ?? DEFAULT_EXPECTED_VERSION;
  const environment: Record<string, string> = {
    BUN_INSTALL_CACHE_DIR: join(xdgCacheDirectory, "bun"),
    CAPABILITY_PROVIDER_BASE_URL: provider.baseUrl,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    HOME: homeDirectory,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    NO_PROXY: "127.0.0.1,localhost",
    NPM_CONFIG_CACHE: join(xdgCacheDirectory, "npm"),
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: openCodeConfig(provider.baseUrl),
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_PLUGIN_META_FILE: join(xdgStateDirectory, "plugin-meta.json"),
    OPENCODE_TEST_HOME: homeDirectory,
    PATH: process.env.PATH ?? "",
    TERM: "dumb",
    TMPDIR: temporaryDirectory,
    XDG_CACHE_HOME: xdgCacheDirectory,
    XDG_CONFIG_HOME: xdgConfigDirectory,
    XDG_DATA_HOME: xdgDataDirectory,
    XDG_STATE_HOME: xdgStateDirectory,
  };
  return {
    evidenceDirectory,
    expectedVersion,
    opencodeDirectory,
    projectDirectory,
    provider,
    root,
    async cleanup() {
      provider.stop();
      await makeDirectoryWritable(opencodeDirectory);
      await makeDirectoryWritable(globalConfigDirectory);
      await rm(root, { force: true, recursive: true });
    },
    inventory() {
      return directoryInventory(opencodeDirectory);
    },
    async run(label, args, timeoutMs) {
      const result = await spawnCommand([executable, ...args], {
        cwd: projectDirectory,
        env: environment,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      const evidenceName = `${basename(label)}.json`;
      await writeEvidence(
        join(evidenceDirectory, evidenceName),
        {
          label,
          result: {
            args: result.args,
            exitCode: result.exitCode,
            stderr: result.stderr,
            stdout: result.stdout,
            timedOut: result.timedOut,
          },
        },
        root,
      );
      return result;
    },
    startServer() {
      return startProbeServer({
        cwd: projectDirectory,
        env: environment,
        evidenceDirectory,
        executable,
        normalizationRoot: root,
      });
    },
  };
}

export async function createInstalledArtifactEnvironment(
  workspaceRoot: string,
): Promise<InstalledArtifactEnvironment> {
  const executable = await realpath(toolPath());
  const root = await mkdtemp(join(tmpdir(), "yuansheng-opencode-artifact-"));
  const homeDirectory = join(root, "home");
  const xdgConfigDirectory = join(root, "xdg-config");
  const xdgDataDirectory = join(root, "xdg-data");
  const xdgStateDirectory = join(root, "xdg-state");
  const xdgCacheDirectory = join(root, "xdg-cache");
  const bunInstallCacheDirectory = join(xdgCacheDirectory, "bun");
  const npmCacheDirectory = join(xdgCacheDirectory, "npm");
  const temporaryDirectory = join(root, "tmp");
  const evidenceDirectory = join(root, "evidence");
  const projectDirectory = join(root, "project");
  const artifactDirectory = join(root, "artifact");
  const globalConfigDirectory = join(xdgConfigDirectory, "opencode");
  const opencodeDirectory = join(projectDirectory, ".opencode");
  const directories = [
    homeDirectory,
    xdgConfigDirectory,
    xdgDataDirectory,
    xdgStateDirectory,
    xdgCacheDirectory,
    bunInstallCacheDirectory,
    npmCacheDirectory,
    temporaryDirectory,
    evidenceDirectory,
    projectDirectory,
    globalConfigDirectory,
  ];
  try {
    await Promise.all(directories.map((directory) => mkdir(directory, { recursive: true })));
    const build = await spawnCommand(
      [
        process.execPath,
        "run",
        "plugin-builder",
        "--",
        "build",
        "--workspace-root",
        ".",
        "--config",
        "plugins/trace/plugin.config.ts",
        "--platform",
        "opencode",
        "--output",
        artifactDirectory,
      ],
      {
        cwd: workspaceRoot,
        env: definedProcessEnvironment(),
      },
    );
    if (build.exitCode !== 0 || build.timedOut) {
      throw new Error(
        `Formal plugin build failed (exit ${build.exitCode})\n${build.stdout}\n${build.stderr}`,
      );
    }
    await cp(join(artifactDirectory, ".opencode"), opencodeDirectory, { recursive: true });
    await initializeGit(projectDirectory, homeDirectory);
    await makeDirectoryReadOnly(opencodeDirectory);
    await makeDirectoryReadOnly(globalConfigDirectory);
  } catch (error) {
    await makeDirectoryWritable(opencodeDirectory);
    await makeDirectoryWritable(globalConfigDirectory);
    await rm(root, { force: true, recursive: true });
    throw error;
  }

  const environment: Record<string, string> = {
    ALL_PROXY: "http://127.0.0.1:1",
    BUN_CONFIG_REGISTRY: "http://127.0.0.1:1",
    BUN_INSTALL_CACHE_DIR: bunInstallCacheDirectory,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    HOME: homeDirectory,
    HTTPS_PROXY: "http://127.0.0.1:1",
    HTTP_PROXY: "http://127.0.0.1:1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NO_COLOR: "1",
    NO_PROXY: "127.0.0.1,localhost",
    NPM_CONFIG_CACHE: npmCacheDirectory,
    NPM_CONFIG_REGISTRY: "http://127.0.0.1:1",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_CONFIG_CONTENT: installedArtifactOpenCodeConfig(),
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_SHARE: "1",
    OPENCODE_PLUGIN_META_FILE: join(xdgStateDirectory, "plugin-meta.json"),
    PATH: process.env.PATH ?? "",
    TERM: "dumb",
    TMPDIR: temporaryDirectory,
    XDG_CACHE_HOME: xdgCacheDirectory,
    XDG_CONFIG_HOME: xdgConfigDirectory,
    XDG_DATA_HOME: xdgDataDirectory,
    XDG_STATE_HOME: xdgStateDirectory,
    all_proxy: "http://127.0.0.1:1",
    http_proxy: "http://127.0.0.1:1",
    https_proxy: "http://127.0.0.1:1",
    no_proxy: "127.0.0.1,localhost",
  };
  return {
    expectedVersion: DEFAULT_EXPECTED_VERSION,
    opencodeDirectory,
    projectDirectory,
    root,
    async cleanup() {
      await makeDirectoryWritable(opencodeDirectory);
      await makeDirectoryWritable(globalConfigDirectory);
      await rm(root, { force: true, recursive: true });
    },
    inventory() {
      return directoryInventory(opencodeDirectory);
    },
    async packageCacheInventory() {
      const [bunCache, npmCache] = await Promise.all([
        directoryInventory(bunInstallCacheDirectory),
        directoryInventory(npmCacheDirectory),
      ]);
      return Object.fromEntries([
        ...Object.entries(bunCache).map(([path, value]) => [`bun/${path}`, value]),
        ...Object.entries(npmCache).map(([path, value]) => [`npm/${path}`, value]),
      ]);
    },
    async run(label, args, timeoutMs) {
      const result = await spawnCommand([executable, ...args], {
        cwd: projectDirectory,
        env: environment,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      await writeEvidence(
        join(evidenceDirectory, `${basename(label)}.json`),
        {
          label,
          result: {
            args: result.args,
            exitCode: result.exitCode,
            stderr: result.stderr,
            stdout: result.stdout,
            timedOut: result.timedOut,
          },
        },
        root,
      );
      return result;
    },
    startServer() {
      return startProbeServer({
        cwd: projectDirectory,
        env: environment,
        evidenceDirectory,
        executable,
        normalizationRoot: root,
      });
    },
  };
}

export const CapabilitySentinels = {
  agent: "CAPABILITY_AGENT_PROMPT_SENTINEL",
  argument: "ARG_SENTINEL",
  askAgent: ASK_AGENT_PROMPT_SENTINEL,
  askInput: ASK_TOOL_INPUT_SENTINEL,
  askProviderRequest: ASK_PROVIDER_REQUEST_SENTINEL,
  command: "CAPABILITY_COMMAND_TEMPLATE_SENTINEL",
  provider: PROVIDER_RESPONSE_SENTINEL,
  skill: "CAPABILITY_SKILL_BODY_SENTINEL",
  toolInput: "TOOL_INPUT_SENTINEL",
  toolResult: "CAPABILITY_TOOL_RESULT_SENTINEL",
} as const;
