import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";

import {
  canonicalOpenCodeSessionId,
  createDefaultOpenCodeCraftRuntimeDependencies,
  createOpenCodeCraftTools,
  issueOpenCodePrincipal,
  OpenCodeCraftRuntime,
} from "../../../plugins/craft/opencode/src";
import type { OpenCodeCraftRuntimeDependencies } from "../../../plugins/craft/opencode/src/adapter-runtime";
import type { OpenCodeCraftController } from "../../../plugins/craft/opencode/src/controller-runtime";
import {
  createOpenCodeBinaryGitRunner,
  createOpenCodeGitRunner,
  createOpenCodeLocalProcessRunner,
  createOpenCodeVerificationLogSink,
  loadOpenCodeCraftController,
} from "../../../plugins/craft/opencode/src/controller-runtime";
import type {
  WorkflowState,
  YuanshengCraftContractV1,
} from "../../../plugins/craft/workflows/artifacts/generated";
import type {
  GitCommandResult,
  GitRunner,
} from "../../../plugins/craft/workflows/repository-preflight/preflight";
import { blockWorkflow } from "../../../plugins/craft/workflows/state-machine/engine";
import { auditTrustedPrincipal } from "../../../plugins/craft/workflows/state-machine/principal";
import {
  appendActionJournal,
  openAtomicWorkflowStore,
} from "../../../plugins/craft/workflows/store";
import {
  createSealedBlueprintFixture,
  type SealedBlueprintFixture,
} from "../sealed-blueprint-fixture";

const roots: string[] = [];
const REPOSITORY_URL = "https://example.invalid/product.git";

function runtimeConfig(): object {
  return {
    repository: {
      preparation_policy: "manual-or-managed",
      timeout_ms: 30_000,
    },
    verification: {
      runners: [
        {
          command_proposals: [{ argv: ["bun", "test"], id: "tests" }],
          cwd: ".",
          id: "local",
          timeout_ms: 120_000,
          type: "local",
        },
      ],
    },
    version: 1,
  };
}

async function gitLine(argv: readonly string[]): Promise<string> {
  const result = await runGit(argv);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

async function runGit(argv: readonly string[]): Promise<GitCommandResult> {
  const child = Bun.spawn([...argv], {
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

class LocalManagedGitRunner implements GitRunner {
  readonly calls: string[][] = [];

  constructor(
    private readonly source: string,
    private readonly destination: string,
  ) {}

  async run(argv: readonly string[]): Promise<GitCommandResult> {
    this.calls.push([...argv]);
    if (argv.includes("clone")) {
      return runGit([
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--no-checkout",
        "--",
        this.source,
        this.destination,
      ]);
    }
    const result = await runGit(argv);
    if (result.exitCode === 0 && argv.includes("checkout")) {
      const configured = await runGit([
        "git",
        "-C",
        this.destination,
        "remote",
        "set-url",
        "origin",
        REPOSITORY_URL,
      ]);
      if (configured.exitCode !== 0) {
        return configured;
      }
    }
    return result;
  }
}

async function makeRepository(): Promise<{
  readonly controller: OpenCodeCraftController;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "ys-craft-opencode-adapter-"));
  roots.push(root);
  await gitLine(["git", "init", "-b", "main", root]);
  await gitLine(["git", "-C", root, "config", "user.name", "Yuansheng Test"]);
  await gitLine(["git", "-C", root, "config", "user.email", "test@example.invalid"]);
  await gitLine(["git", "-C", root, "config", "commit.gpgSign", "false"]);
  const isolatedExcludes = join(root, ".git/isolated-global-excludes");
  await writeFile(isolatedExcludes, "");
  await gitLine(["git", "-C", root, "config", "core.excludesFile", isolatedExcludes]);
  await gitLine(["git", "-C", root, "remote", "add", "origin", REPOSITORY_URL]);
  await mkdir(join(root, ".opencode/yuansheng"), { recursive: true });
  await mkdir(join(root, "src/kernel"), { recursive: true });
  await writeFile(
    join(root, ".opencode/yuansheng/craft.json"),
    `${JSON.stringify(runtimeConfig(), null, 2)}\n`,
  );
  await writeFile(join(root, "product.txt"), "baseline\n");
  await writeFile(join(root, "src/kernel/dgemv_n.c"), "void dgemv_n(void) {}\n");
  await gitLine(["git", "-C", root, "add", "."]);
  await gitLine(["git", "-C", root, "commit", "-m", "test: create baseline"]);
  await writeFile(join(root, ".git/info/exclude"), "/.opencode/yuansheng/workflow/\n");
  return {
    controller: await loadOpenCodeCraftController({
      directory: root,
      worktree: root,
    }),
    root,
  };
}

function deterministicDependencies(
  controller: OpenCodeCraftController,
  builderActivations: WorkflowState[],
): OpenCodeCraftRuntimeDependencies {
  let id = 0;
  let second = 0;
  return {
    ...createDefaultOpenCodeCraftRuntimeDependencies({
      binaryGit: createOpenCodeBinaryGitRunner(),
      builderWrite: {
        activate(
          _context: ToolContext,
          state: WorkflowState,
          _artifacts: readonly YuanshengCraftContractV1[],
        ): void {
          builderActivations.push(state);
        },
      },
      controller,
      git: createOpenCodeGitRunner(controller.controllerRoot),
      localProcess: createOpenCodeLocalProcessRunner(),
      logSink: createOpenCodeVerificationLogSink(),
      reloadController: async () =>
        loadOpenCodeCraftController({
          directory: controller.controllerRoot,
          worktree: controller.controllerRoot,
        }),
      ssh: async () => {
        throw new Error("SSH is not used by this adapter test");
      },
    }),
    clock: {
      now(): string {
        const value = `2026-07-24T12:00:${String(second).padStart(2, "0")}.000Z`;
        second += 1;
        return value;
      },
    },
    id: {
      next(prefix): string {
        id += 1;
        return `${prefix}:ADAPTERTEST${String(id).padStart(8, "0")}`;
      },
    },
  };
}

function context(input: {
  readonly agent: string;
  readonly asks?: (request: Parameters<ToolContext["ask"]>[0]) => Promise<void>;
  readonly root: string;
  readonly sessionId: string;
}): ToolContext {
  return {
    abort: new AbortController().signal,
    agent: input.agent,
    ask: input.asks ?? (async () => {}),
    directory: input.root,
    messageID: "message:ADAPTERTEST0001",
    metadata(): void {},
    sessionID: input.sessionId,
    worktree: input.root,
  };
}

async function absent(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

async function blueprintFor(repositoryRoot: string): Promise<SealedBlueprintFixture> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "ys-craft-adapter-blueprint-"));
  roots.push(fixtureRoot);
  return createSealedBlueprintFixture(fixtureRoot, {
    commitSha: await gitLine(["git", "-C", repositoryRoot, "rev-parse", "HEAD"]),
    repositoryUrl: REPOSITORY_URL,
    sourcePath: "src/kernel/dgemv_n.c",
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Yuansheng Craft OpenCode adapter", () => {
  test("registers the exact typed surface and rejects unobserved or changed identities", async () => {
    const repository = await makeRepository();
    const runtime = new OpenCodeCraftRuntime(deterministicDependencies(repository.controller, []));
    const tools = createOpenCodeCraftTools(runtime);
    expect(Object.keys(tools)).toEqual([
      "ys_craft_start_problem",
      "ys_craft_review_blueprint",
      "ys_craft_status",
      "ys_craft_resume",
      "ys_craft_prepare_repository",
      "ys_craft_record_artifact",
      "ys_craft_capture_candidate",
      "ys_craft_prepare_verification",
      "ys_craft_run_verification",
      "ys_craft_transition",
      "ys_craft_return_to_phase",
      "ys_craft_complete",
    ]);
    expect(
      Object.fromEntries(
        Object.entries(tools).map(([name, definition]) => [
          name,
          Object.keys(definition.args).sort(),
        ]),
      ),
    ).toMatchSnapshot();
    expect(canonicalOpenCodeSessionId("ses_adapter_primary_01")).toMatch(
      /^session:[A-Za-z0-9_-]{43}$/u,
    );
    expect(canonicalOpenCodeSessionId("ses_adapter_primary_01")).toBe(
      canonicalOpenCodeSessionId("ses_adapter_primary_01"),
    );

    const primary = context({
      agent: "ys-craft",
      root: repository.root,
      sessionId: "ses_adapter_primary_01",
    });
    await expect(
      runtime.startProblem(
        { problem: "Preserve the product behavior", target_worktree: repository.root },
        primary,
      ),
    ).rejects.toThrow("does not match the observed OpenCode chat identity");
    runtime.observeChatAgent(primary.sessionID, primary.agent);
    expect(() =>
      runtime.observeChatAgent(primary.sessionID, "ys-craft-root-cause-analyst"),
    ).toThrow("cannot change agent identity");
  });

  test("starts only after external permission and preflight, binds exact status sessions, and stores pointer only", async () => {
    const repository = await makeRepository();
    const stateRoot = repository.controller.stateRootPath;
    const asks: Parameters<ToolContext["ask"]>[0][] = [];
    const runtime = new OpenCodeCraftRuntime(deterministicDependencies(repository.controller, []));
    const primary = context({
      agent: "ys-craft",
      asks: async (request) => {
        expect(await absent(stateRoot)).toBe(true);
        asks.push(request);
      },
      root: repository.root,
      sessionId: "session:ADAPTERPRIMARY01",
    });
    runtime.observeChatAgent(primary.sessionID, primary.agent);
    const started = JSON.parse(
      await runtime.startProblem(
        { problem: "Preserve the product behavior", target_worktree: repository.root },
        primary,
      ),
    ) as {
      phase: string;
      revision: number;
      workflow_id: string;
    };
    expect(started).toMatchObject({ phase: "root_cause", revision: 0 });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      always: [],
      patterns: [repository.root],
      permission: "ys_craft_external_directory",
    });
    expect(runtime.compactionPointer(primary.sessionID)).toContain(started.workflow_id);
    await expect(
      runtime.handleEvent({
        properties: { sessionID: primary.sessionID },
        type: "session.idle",
      }),
    ).rejects.toThrow("session cannot stop");
    await runtime.handleEvent({
      properties: { sessionID: primary.sessionID },
      type: "session.compacted",
    });
    expect(runtime.compactionPointer(primary.sessionID)).toContain(started.workflow_id);

    const analyst = context({
      agent: "ys-craft-root-cause-analyst",
      root: repository.root,
      sessionId: "session:ADAPTERANALYST01",
    });
    runtime.observeChatAgent(analyst.sessionID, analyst.agent);
    const status = JSON.parse(await runtime.status(started.workflow_id, analyst)) as {
      revision: number;
      session_binding: {
        phase_principal: { agent_id: string; session_id: string };
      };
    };
    expect(status.revision).toBe(1);
    expect(status.session_binding.phase_principal).toEqual({
      agent_id: analyst.agent,
      session_id: canonicalOpenCodeSessionId(analyst.sessionID),
    });
    await expect(runtime.status("workflow:UNKNOWNWORKFLOW01", analyst)).rejects.toThrow();

    const store = await openAtomicWorkflowStore(stateRoot);
    const active = await store.readExactWorkflow(started.workflow_id);
    const analystPrincipal = issueOpenCodePrincipal({
      agentId: analyst.agent,
      sessionId: analyst.sessionID,
    });
    const blockedState = blockWorkflow({
      at: new Date(Date.parse(active.state.updated_at) + 1).toISOString(),
      expectedRevision: active.state.revision,
      principal: analystPrincipal,
      reason: "Explicitly test restart recovery.",
      remediationPhase: "root_cause",
      state: active.state,
    });
    await store.commitWorkflow({
      artifacts: active.artifacts,
      expectedRevision: active.state.revision,
      journal: appendActionJournal({
        action: "ys_craft_transition",
        at: blockedState.updated_at,
        journal: active.journal,
        principal: auditTrustedPrincipal(analystPrincipal),
        result: "blocked",
        state: blockedState,
        subjectRefs: [],
      }),
      state: blockedState,
    });
    const resumedPrimary = context({
      agent: "ys-craft",
      root: repository.root,
      sessionId: "ses_adapter_resumed_primary",
    });
    runtime.observeChatAgent(resumedPrimary.sessionID, resumedPrimary.agent);
    const resumed = JSON.parse(
      await runtime.resume(
        {
          store_anchor: stateRoot,
          workflow_id: started.workflow_id,
        },
        resumedPrimary,
      ),
    ) as {
      phase: string;
      revision: number;
      session_binding: { coordinator: { session_id: string } };
    };
    expect(resumed).toMatchObject({ phase: "blocked", revision: 3 });
    expect(resumed.session_binding.coordinator.session_id).toBe(
      canonicalOpenCodeSessionId(resumedPrimary.sessionID),
    );
    const remediated = JSON.parse(
      await runtime.transition(
        {
          expected_revision: resumed.revision,
          target_phase: "root_cause",
          workflow_id: started.workflow_id,
        },
        resumedPrimary,
      ),
    ) as { phase: string; revision: number };
    expect(remediated).toMatchObject({ phase: "root_cause", revision: 4 });
  });

  test("permission exceptions leave no resumable workflow", async () => {
    const repository = await makeRepository();
    const runtime = new OpenCodeCraftRuntime(deterministicDependencies(repository.controller, []));
    const primary = context({
      agent: "ys-craft",
      asks: async () => {
        throw new Error("simulated platform permission failure");
      },
      root: repository.root,
      sessionId: "session:ADAPTERPRIMARY01",
    });
    runtime.observeChatAgent(primary.sessionID, primary.agent);
    await expect(
      runtime.startProblem(
        { problem: "Preserve the product behavior", target_worktree: repository.root },
        primary,
      ),
    ).rejects.toThrow("simulated platform permission failure");
    expect(await absent(repository.controller.stateRootPath)).toBe(true);
  });

  test("imports Blueprint only after repository receipt and a separate real review allow", async () => {
    const repository = await makeRepository();
    const blueprint = await blueprintFor(repository.root);
    const permissions: string[] = [];
    const runtime = new OpenCodeCraftRuntime(deterministicDependencies(repository.controller, []));
    const primary = context({
      agent: "ys-craft",
      asks: async (request) => {
        permissions.push(request.permission);
        if (request.permission === "ys_craft_blueprint_review") {
          expect(await absent(join(repository.controller.stateRootPath, "workflows"))).toBe(true);
        }
      },
      root: repository.root,
      sessionId: "session:ADAPTERPRIMARY01",
    });
    runtime.observeChatAgent(primary.sessionID, primary.agent);
    const imported = JSON.parse(
      await runtime.reviewBlueprint(
        {
          sealed_function_directory: blueprint.directoryPath,
          target_worktree: repository.root,
        },
        primary,
      ),
    ) as {
      current_artifacts: { artifact_type: string }[];
      phase: string;
      workflow_id: string;
    };
    expect(permissions).toEqual(["ys_craft_external_directory", "ys_craft_blueprint_review"]);
    expect(imported.phase).toBe("planning");
    expect(imported.current_artifacts.map((item) => item.artifact_type)).toContain("root-cause");
    expect(runtime.compactionPointer(primary.sessionID)).toContain(imported.workflow_id);
  });

  test("prepares a missing Blueprint repository only through an explicit immutable managed plan", async () => {
    const repository = await makeRepository();
    const blueprint = await blueprintFor(repository.root);
    const managedRoot = await mkdtemp(join(tmpdir(), "ys-craft-adapter-managed-"));
    roots.push(managedRoot);
    const destination = join(managedRoot, "checkout");
    const runner = new LocalManagedGitRunner(repository.root, destination);
    const asks: Parameters<ToolContext["ask"]>[0][] = [];
    const runtime = new OpenCodeCraftRuntime({
      ...deterministicDependencies(repository.controller, []),
      git: runner,
    });
    const primary = context({
      agent: "ys-craft",
      asks: async (request) => {
        asks.push(request);
        if (request.permission === "ys_craft_repository_preparation") {
          expect(await absent(destination)).toBe(true);
          expect(await absent(repository.controller.stateRootPath)).toBe(true);
        }
      },
      root: repository.root,
      sessionId: "session:ADAPTERMANAGED01",
    });
    runtime.observeChatAgent(primary.sessionID, primary.agent);

    const pending = JSON.parse(
      await runtime.reviewBlueprint(
        {
          sealed_function_directory: blueprint.directoryPath,
          target_worktree: destination,
        },
        primary,
      ),
    ) as {
      pending_repository_preflight: {
        plan: {
          git_argv: string[][];
          plan_digest: string;
          request_id: string;
        };
        request_id: string;
        status: string;
      };
      workflow_id: string;
    };
    expect(pending.pending_repository_preflight.status).toBe("decision-required");
    expect(await absent(destination)).toBe(true);
    expect(await absent(repository.controller.stateRootPath)).toBe(true);

    const ready = JSON.parse(
      await runtime.prepareRepository(pending.pending_repository_preflight.request_id, primary),
    ) as {
      created_or_updated_paths: string[];
      status: string;
    };
    expect(ready).toMatchObject({
      created_or_updated_paths: [destination],
      status: "ready",
    });
    expect(runner.calls.slice(0, 3)).toEqual(pending.pending_repository_preflight.plan.git_argv);
    expect(await absent(repository.controller.stateRootPath)).toBe(true);

    const imported = JSON.parse(
      await runtime.reviewBlueprint(
        {
          sealed_function_directory: blueprint.directoryPath,
          target_worktree: destination,
        },
        primary,
      ),
    ) as {
      phase: string;
      workflow_id: string;
    };
    expect(imported.phase).toBe("planning");
    expect(imported.workflow_id).not.toBe(pending.workflow_id);
    expect(asks.map((request) => request.permission)).toEqual([
      "ys_craft_external_directory",
      "ys_craft_repository_preparation",
      "ys_craft_external_directory",
      "ys_craft_blueprint_review",
    ]);
    expect(asks[1]).toMatchObject({
      always: [],
      patterns: [pending.pending_repository_preflight.plan.plan_digest],
      permission: "ys_craft_repository_preparation",
    });
    await expect(runtime.status(pending.workflow_id, primary)).rejects.toThrow();
  });
});
