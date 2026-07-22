import { readFile } from "node:fs/promises";
import { isAbsolute, parse as parsePath, resolve } from "node:path";
import { type Plugin, tool } from "@opencode-ai/plugin";

import { parseSg2044HardwareProfile } from "../../workflows/hardware-profile";
import { startTraceWorkflow } from "../../workflows/trace-workflow";

const DEFAULT_ARTIFACT_ROOT = ".opencode/yuansheng/blueprint";
const SG2044_PROFILE_URL = new URL(
  "../yuansheng/resources/hardware-profiles/sg2044.json",
  import.meta.url,
);

function requireProjectRoot(worktree: string, directory: string): string {
  for (const candidate of [worktree, directory]) {
    if (candidate.length === 0 || !isAbsolute(candidate)) {
      continue;
    }
    const normalized = resolve(candidate);
    if (parsePath(normalized).root !== normalized) {
      return normalized;
    }
  }
  throw new TypeError("OpenCode did not provide a usable project or worktree directory");
}

function resolveArtifactRoot(projectRoot: string, override: string | undefined): string {
  if (override === undefined) {
    return resolve(projectRoot, DEFAULT_ARTIFACT_ROOT);
  }
  if (override.trim().length === 0 || override.includes("\0")) {
    throw new TypeError("artifact_root must be a non-empty path");
  }
  return isAbsolute(override) ? resolve(override) : resolve(projectRoot, override);
}

export const YuanshengTracePlugin: Plugin = async () => ({
  tool: {
    ys_trace_start: tool({
      description:
        "Resolve and display the Yuansheng Trace artifact root, then start the deterministic pre-validator workflow without performing effects.",
      args: {
        artifact_root: tool.schema.string().optional(),
        perf_data_root: tool.schema.string(),
        software: tool.schema.string(),
      },
      async execute({ artifact_root, perf_data_root, software }, context) {
        const projectRoot = requireProjectRoot(context.worktree, context.directory);
        const resolvedArtifactRoot = resolveArtifactRoot(projectRoot, artifact_root);
        context.metadata({
          metadata: { artifact_root: resolvedArtifactRoot },
          title: `Yuansheng Trace: ${resolvedArtifactRoot}`,
        });
        await context.ask({
          always: [resolvedArtifactRoot],
          metadata: { artifact_root: resolvedArtifactRoot },
          patterns: [resolvedArtifactRoot],
          permission: "ys_trace_start",
        });

        const profile = parseSg2044HardwareProfile(await readFile(SG2044_PROFILE_URL));
        const transition = startTraceWorkflow({
          artifactRoot: resolvedArtifactRoot,
          perfDataRoot: perf_data_root,
          profiles: [profile],
          software,
        });
        return JSON.stringify({
          artifact_root: resolvedArtifactRoot,
          output: transition.output,
          state: transition.state,
        });
      },
    }),
  },
});
