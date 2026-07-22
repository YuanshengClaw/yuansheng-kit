import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type CommandResult,
  createInstalledArtifactEnvironment,
  parseJson,
} from "./capabilities/harness";

const WORKSPACE_ROOT = join(import.meta.dir, "../../..");
const INVENTORY_TOOL_ID = "ys_trace_inventory_remote_input";
const REPORT_TOOL_ID = "ys_trace_provide_validation_report";
const START_TOOL_ID = "ys_trace_start";

interface RuntimeToolContext {
  readonly abort: AbortSignal;
  readonly agent: string;
  readonly directory: string;
  readonly messageID: string;
  readonly sessionID: string;
  readonly worktree: string;
  ask(input: unknown): Promise<void>;
  metadata(input: unknown): void;
}

interface RuntimeTool {
  execute(args: Readonly<Record<string, unknown>>, context: RuntimeToolContext): Promise<unknown>;
}

interface InstalledPluginHooks {
  readonly dispose?: () => Promise<void>;
  readonly tool?: Readonly<Record<string, RuntimeTool>>;
}

interface InstalledPluginModule {
  readonly YuanshengTracePlugin: (input: never) => Promise<InstalledPluginHooks>;
}

function requireSuccess(label: string, result: CommandResult): void {
  if (result.exitCode === 0 && !result.timedOut) {
    return;
  }
  throw new Error(
    `${label} failed (exit ${result.exitCode}, timeout ${result.timedOut})\n` +
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function requireRecord(label: string, value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${label} did not return a JSON object`);
}

function commandRecords(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) {
    throw new Error("OpenCode command endpoint did not return an array");
  }
  return value.filter(
    (item): item is Readonly<Record<string, unknown>> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path)
    .then(() => true)
    .catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    });
}

function requireString(label: string, value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`${label} was not a string`);
}

function toolOutput(label: string, value: unknown): Readonly<Record<string, unknown>> {
  return requireRecord(label, parseJson(requireString(label, value)));
}

function runtimeContext(
  environment: Awaited<ReturnType<typeof createInstalledArtifactEnvironment>>,
  sessionID: string,
): RuntimeToolContext {
  return {
    abort: new AbortController().signal,
    agent: "ys-trace",
    directory: environment.projectDirectory,
    messageID: `message-${sessionID}`,
    sessionID,
    worktree: environment.projectDirectory,
    async ask() {},
    metadata() {},
  };
}

async function writeValidationReport(
  output: Readonly<Record<string, unknown>>,
  reportBytes: Uint8Array,
): Promise<Readonly<{ path: string; sha256: string }>> {
  const validationReport = requireRecord("validation report paths", output.validation_report);
  const directory = requireString("validation report directory", validationReport.directory);
  const path = requireString("validation report path", validationReport.path);
  await mkdir(directory, { mode: 0o700, recursive: true });
  await chmod(directory, 0o700);
  await writeFile(path, reportBytes, { flag: "wx", mode: 0o600 });
  return { path, sha256: createHash("sha256").update(reportBytes).digest("hex") };
}

function setDirectRuntimeEnvironment(root: string): () => void {
  const previous = {
    HOME: process.env.HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  };
  process.env.HOME = join(root, "home");
  process.env.XDG_CACHE_HOME = join(root, "xdg-cache");
  delete process.env.XDG_RUNTIME_DIR;
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

async function runTraceStart(
  environment: Awaited<ReturnType<typeof createInstalledArtifactEnvironment>>,
  label: string,
  params: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, unknown>>> {
  const result = await environment.run(label, [
    "debug",
    "agent",
    "ys-trace",
    "--tool",
    START_TOOL_ID,
    "--params",
    JSON.stringify(params),
  ]);
  requireSuccess(label, result);
  const commandOutput = requireRecord(label, parseJson(result.stdout));
  const toolResult = requireRecord(`${label} result`, commandOutput.result);
  if (typeof toolResult.output !== "string") {
    throw new Error(`${label} tool output was not a string`);
  }
  return requireRecord(`${label} tool output`, parseJson(toolResult.output));
}

test("the formal Yuansheng Trace artifact loads and starts its pre-validator workflow", async () => {
  const environment = await createInstalledArtifactEnvironment(WORKSPACE_ROOT);
  try {
    const initialInventory = await environment.inventory();
    const initialPackageCache = await environment.packageCacheInventory();
    const installedPaths = Object.keys(initialInventory);
    expect(installedPaths).toContain("plugins/ys-trace.js");
    expect(installedPaths).toContain("commands/ys-trace.md");
    expect(installedPaths).toContain("agents/ys-trace.md");
    expect(installedPaths).toContain("skills/write-root-cause-blueprint/SKILL.md");
    expect(installedPaths).toContain("yuansheng/tools/perf-data-validator/README.md");
    expect(installedPaths).toContain("yuansheng/tools/perf-data-validator/requirements.txt");
    expect(installedPaths).toContain(
      "yuansheng/tools/perf-data-validator/src/perf_data_validator/__main__.py",
    );
    expect(
      installedPaths.filter((path) =>
        /(?:^|\/)(?:package\.json|bun\.lockb?|node_modules)(?:\/|$)/u.test(path),
      ),
    ).toEqual([]);
    expect(installedPaths.filter((path) => /(?:^|\/)sources?(?:\/|$)/u.test(path))).toEqual([]);

    const version = await environment.run("version", ["--version"]);
    requireSuccess("OpenCode version", version);
    expect(version.stdout.trim()).toBe(environment.expectedVersion);

    const server = await environment.startServer();
    try {
      const traceCommands = commandRecords(await server.request("/command")).filter(
        (command) => command.name === "ys-trace",
      );
      expect(traceCommands).toHaveLength(1);
      expect(traceCommands[0]).toMatchObject({ agent: "ys-trace" });
      expect(traceCommands[0]?.template).toContain("$ARGUMENTS");
      expect(traceCommands[0]?.template).toContain(START_TOOL_ID);

      const toolIds = await server.request("/experimental/tool/ids");
      expect(Array.isArray(toolIds)).toBeTrue();
      if (!Array.isArray(toolIds)) {
        throw new Error("OpenCode tool IDs endpoint did not return an array");
      }
      expect(toolIds).toContain(INVENTORY_TOOL_ID);
      expect(toolIds).toContain(START_TOOL_ID);
      expect(toolIds).toContain(REPORT_TOOL_ID);
    } finally {
      await server.stop();
    }

    const restoreRuntimeEnvironment = setDirectRuntimeEnvironment(environment.root);
    const pluginUrl = pathToFileURL(join(environment.opencodeDirectory, "plugins/ys-trace.js"));
    const pluginModule = (await import(pluginUrl.href)) as InstalledPluginModule;
    const hooks = await pluginModule.YuanshengTracePlugin({} as never);
    try {
      const startTool = hooks.tool?.[START_TOOL_ID];
      const inventoryTool = hooks.tool?.[INVENTORY_TOOL_ID];
      const reportTool = hooks.tool?.[REPORT_TOOL_ID];
      if (startTool === undefined || inventoryTool === undefined || reportTool === undefined) {
        throw new Error("Installed Yuansheng Trace tools are unavailable");
      }
      const session = runtimeContext(environment, "validation-session");
      const otherSession = runtimeContext(environment, "other-session");
      const perfDataRoot = join(environment.root, "perf-data");
      const startOutput = toolOutput(
        "direct start",
        await startTool.execute({ perf_data_root: perfDataRoot, software: "openblas" }, session),
      );
      const runId = requireString("direct start run id", startOutput.run_id);
      const reportPaths = requireRecord("direct report paths", startOutput.validation_report);
      const reportPath = requireString("direct report path", reportPaths.path);
      const golden = await readFile(
        join(
          WORKSPACE_ROOT,
          "plugins/trace/tools/perf-data-validator/tests/golden/openblas-dgemv-report-v1.json",
        ),
      );
      const reportBytes = golden.at(-1) === 0x0a ? golden.subarray(0, -1) : golden;

      await expect(
        reportTool.execute(
          { report_path: reportPath, report_sha256: "0".repeat(64), run_id: runId },
          otherSession,
        ),
      ).rejects.toThrow("unknown in this OpenCode session");
      const receipt = await writeValidationReport(startOutput, reportBytes);
      const handoff = toolOutput(
        "validation report handoff",
        await reportTool.execute(
          { report_path: receipt.path, report_sha256: receipt.sha256, run_id: runId },
          session,
        ),
      );
      expect(handoff).toMatchObject({
        output: { type: "request_profile_selection" },
        report_sha256: receipt.sha256,
        run_id: runId,
      });
      expect(await pathExists(receipt.path)).toBeFalse();
      expect(await pathExists(join(receipt.path, ".."))).toBeFalse();
      await expect(
        reportTool.execute(
          { report_path: receipt.path, report_sha256: receipt.sha256, run_id: runId },
          session,
        ),
      ).rejects.toThrow("not waiting for a validation report");

      const rejectedStart = toolOutput(
        "rejected report start",
        await startTool.execute({ perf_data_root: perfDataRoot, software: "openblas" }, session),
      );
      const rejectedRunId = requireString("rejected report run id", rejectedStart.run_id);
      const rejectedReceipt = await writeValidationReport(rejectedStart, reportBytes);
      await expect(
        reportTool.execute(
          {
            report_path: rejectedReceipt.path,
            report_sha256: "0".repeat(64),
            run_id: rejectedRunId,
          },
          session,
        ),
      ).rejects.toThrow("receipt does not match");
      expect(await pathExists(rejectedReceipt.path)).toBeFalse();
      expect(await pathExists(join(rejectedReceipt.path, ".."))).toBeFalse();
      await expect(
        reportTool.execute(
          {
            report_path: rejectedReceipt.path,
            report_sha256: rejectedReceipt.sha256,
            run_id: rejectedRunId,
          },
          session,
        ),
      ).rejects.toThrow("unknown in this OpenCode session");

      const sshApprovals: unknown[] = [];
      const sshSession: RuntimeToolContext = {
        ...runtimeContext(environment, "ssh-plan-session"),
        async ask(input) {
          sshApprovals.push(input);
        },
      };
      const sshAlias = "ys-trace-unconfigured.invalid";
      const remoteRoot = "/srv/yuansheng/perf-data";
      const remoteStart = toolOutput(
        "remote plan start",
        await startTool.execute(
          {
            perf_data_root: remoteRoot,
            software: "openblas",
            ssh_alias: sshAlias,
          },
          sshSession,
        ),
      );
      expect(remoteStart).toMatchObject({
        location: {
          alias: sshAlias,
          kind: "ssh",
          remote_root_utf8: remoteRoot,
        },
        next_tool: INVENTORY_TOOL_ID,
        phase: "awaiting_inventory",
      });
      expect(remoteStart.plan_sha256).toMatch(/^[0-9a-f]{64}$/u);
      const remotePlan = requireRecord("remote transport plan", remoteStart.plan);
      const executableSha256 = requireRecord(
        "remote transport executable digests",
        remotePlan.executable_sha256,
      );
      expect(executableSha256.ssh).toMatch(/^[0-9a-f]{64}$/u);
      expect(executableSha256.sftp).toMatch(/^[0-9a-f]{64}$/u);
      expect(sshApprovals).toHaveLength(1);
      expect(requireRecord("remote transport approval", sshApprovals[0])).toMatchObject({
        permission: "ys_trace_ssh_transport",
        patterns: [remoteStart.plan_sha256],
      });
    } finally {
      await hooks.dispose?.();
      restoreRuntimeEnvironment();
    }

    const software = "openblas";
    const perfDataRoot = join(environment.root, "perf-data");
    const cases = [
      {
        expected: join(environment.projectDirectory, ".opencode/yuansheng/blueprint"),
        label: "default-artifact-root",
        params: { perf_data_root: perfDataRoot, software },
      },
      {
        expected: resolve(environment.projectDirectory, "artifacts/trace"),
        label: "relative-artifact-root",
        params: {
          artifact_root: "artifacts/trace",
          perf_data_root: perfDataRoot,
          software,
        },
      },
      {
        expected: join(environment.root, "absolute-artifact-root"),
        label: "absolute-artifact-root",
        params: {
          artifact_root: join(environment.root, "absolute-artifact-root"),
          perf_data_root: perfDataRoot,
          software,
        },
      },
    ] as const;

    for (const item of cases) {
      const output = await runTraceStart(environment, item.label, item.params);
      const runId = output.run_id;
      if (typeof runId !== "string") {
        throw new Error(`${item.label} did not return a run_id`);
      }
      expect(runId).toMatch(/^[0-9a-f]{32}$/u);
      const reportDirectory = join(
        environment.root,
        "xdg-cache/yuansheng-kit/ys-trace/reports",
        runId,
      );
      const reportPath = join(reportDirectory, "perf-data-validation-report-v1.json");
      const requirementsInventory =
        initialInventory["yuansheng/tools/perf-data-validator/requirements.txt"];
      const requirementsSha256 = requirementsInventory?.match(/sha256:([0-9a-f]{64})$/u)?.[1];
      if (requirementsSha256 === undefined) {
        throw new Error("Installed validator requirements have no inventory digest");
      }
      expect(output).toMatchObject({
        artifact_root: item.expected,
        output: {
          perfDataRoot,
          software,
          type: "request_validation_report",
        },
        perf_data_root: perfDataRoot,
        validation_report: {
          directory: reportDirectory,
          path: reportPath,
        },
        validator: {
          directory: join(
            environment.projectDirectory,
            ".opencode/yuansheng/tools/perf-data-validator",
          ),
          requirements_path: join(
            environment.projectDirectory,
            ".opencode/yuansheng/tools/perf-data-validator/requirements.txt",
          ),
          requirements_sha256: requirementsSha256,
        },
      });
      expect(output.state).toBeUndefined();
      const validator = requireRecord(`${item.label} validator`, output.validator);
      const toolTreeSha256 = validator.tool_tree_sha256;
      if (typeof toolTreeSha256 !== "string") {
        throw new Error(`${item.label} validator did not return a tool_tree_sha256`);
      }
      expect(toolTreeSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(await pathExists(item.expected)).toBeFalse();
      expect(await pathExists(reportPath)).toBeFalse();
    }

    expect(await environment.inventory()).toEqual(initialInventory);
    expect(await environment.packageCacheInventory()).toEqual(initialPackageCache);
  } finally {
    await environment.cleanup();
  }
}, 120_000);
