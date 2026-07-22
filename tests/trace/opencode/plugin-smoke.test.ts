import { expect, test } from "bun:test";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  type CommandResult,
  createInstalledArtifactEnvironment,
  parseJson,
} from "./capabilities/harness";

const WORKSPACE_ROOT = join(import.meta.dir, "../../..");
const TOOL_ID = "ys_trace_start";

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
    TOOL_ID,
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
    expect(
      installedPaths.filter((path) =>
        /(?:^|\/)(?:package\.json|bun\.lockb?|node_modules)(?:\/|$)/u.test(path),
      ),
    ).toEqual([]);
    expect(
      installedPaths.filter((path) =>
        /(?:^|\/)(?:perf-data-validator|sources?)(?:\/|$)/u.test(path),
      ),
    ).toEqual([]);

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
      expect(traceCommands[0]?.template).toContain(TOOL_ID);

      const toolIds = await server.request("/experimental/tool/ids");
      expect(Array.isArray(toolIds)).toBeTrue();
      if (!Array.isArray(toolIds)) {
        throw new Error("OpenCode tool IDs endpoint did not return an array");
      }
      expect(toolIds).toContain(TOOL_ID);
    } finally {
      await server.stop();
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
      expect(output).toMatchObject({
        artifact_root: item.expected,
        output: {
          perfDataRoot,
          software,
          type: "request_validation_report",
        },
        state: {
          artifactRoot: item.expected,
          phase: "awaiting_validation_report",
        },
      });
      expect(await pathExists(item.expected)).toBeFalse();
    }

    expect(await environment.inventory()).toEqual(initialInventory);
    expect(await environment.packageCacheInventory()).toEqual(initialPackageCache);
  } finally {
    await environment.cleanup();
  }
}, 120_000);
