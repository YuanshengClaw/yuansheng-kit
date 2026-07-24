import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodeBuilderWriteGuard } from "../../plugins/craft/opencode/src/builder-write-guard";
import {
  canonicalizeJson,
  sealArtifact,
  sha256Digest,
} from "../../plugins/craft/workflows/artifacts/canonical";
import type {
  MutationAuthorization,
  PatchPlan,
  RepositoryBinding,
  RootCauseArtifact,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../../plugins/craft/workflows/artifacts/generated";
import { artifactRef } from "../../plugins/craft/workflows/artifacts/parser";
import type { JsonValue } from "../../plugins/craft/workflows/artifacts/strict-json";
import {
  assertCandidateWorktreeUnchanged,
  type BinaryGitRunner,
  captureCanonicalDiff,
  capturePatchCandidate,
} from "../../plugins/craft/workflows/building/candidate-capture";
import {
  approvePatchPlan,
  PatchPlanApprovalError,
} from "../../plugins/craft/workflows/building/plan-authorization";
import {
  assertAuthorizedFileMutation,
  assertBuildingProcessDenied,
} from "../../plugins/craft/workflows/building/write-guard";
import {
  auditTrustedPrincipal,
  issueTrustedPrincipal,
} from "../../plugins/craft/workflows/state-machine/principal";

const WORKFLOW_ID = "workflow:BUILDING12345678";
const CREATED_AT = "2026-07-24T10:00:00.000Z";
const BUILDER = issueTrustedPrincipal({
  agentId: "ys-craft-patch-builder",
  sessionId: "session:BUILDING12345678",
});
const PLANNER = issueTrustedPrincipal({
  agentId: "ys-craft-patch-planner",
  sessionId: "session:PLANNING12345678",
});
const COORDINATOR = {
  agent_id: "ys-craft",
  session_id: "session:PRIMARY1234567890",
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

function seal<T extends YuanshengCraftContractV1>(payload: Omit<T, "artifact_digest">): T {
  return sealArtifact(payload as unknown as Record<string, JsonValue>) as unknown as T;
}

async function runBytes(
  argv: readonly string[],
  cwd: string,
): Promise<{
  readonly exitCode: number;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
}> {
  const child = Bun.spawn([...argv], {
    cwd,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]);
  return {
    exitCode,
    stderr: new Uint8Array(stderr),
    stdout: new Uint8Array(stdout),
  };
}

async function mustGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await runBytes(["git", ...args], cwd);
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

const GIT_RUNNER: BinaryGitRunner = {
  async run(argv, cwd) {
    return runBytes(argv, cwd);
  },
};

interface BuildingHarness {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly authorization: MutationAuthorization;
  readonly binding: RepositoryBinding;
  readonly plan: PatchPlan;
  readonly root: string;
  readonly rootCause: RootCauseArtifact;
  readonly state: WorkflowState;
}

async function makeBuildingHarness(): Promise<BuildingHarness> {
  const root = await mkdtemp(join(tmpdir(), "ys-craft-building-"));
  temporaryRoots.push(root);
  await mustGit(root, "init", "-q");
  await mustGit(root, "config", "user.name", "Yuansheng Craft Test");
  await mustGit(root, "config", "user.email", "craft@example.invalid");
  await mustGit(root, "config", "commit.gpgsign", "false");
  await writeFile(join(root, "modify.txt"), "before\n");
  await writeFile(join(root, "delete.txt"), "remove me\n");
  await writeFile(join(root, "rename-old.txt"), "rename content\n");
  await writeFile(join(root, "mode.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "mode.sh"), 0o644);
  await writeFile(join(root, "binary.bin"), new Uint8Array([1, 0, 2, 3]));
  await writeFile(join(root, "untouched.txt"), "user content\n");
  await mustGit(root, "add", ".");
  await mustGit(root, "commit", "-qm", "test baseline");
  const commit = await mustGit(root, "rev-parse", "HEAD");
  const canonicalRoot = await realpath(root);
  const binding = seal<RepositoryBinding>({
    artifact_type: "repository-binding",
    artifact_version: 1,
    commit_sha: commit,
    created_at: CREATED_AT,
    git_root_realpath: canonicalRoot,
    preparation_mode: "manual",
    product_root_realpath: canonicalRoot,
    repository_url: "https://example.invalid/building.git",
    target_worktree_realpath: canonicalRoot,
    tree_digest: sha256Digest(new TextEncoder().encode("baseline tree")),
  });
  const rootCause = seal<RootCauseArtifact>({
    artifact_type: "root-cause",
    artifact_version: 1,
    created_at: CREATED_AT,
    criteria: [
      {
        fact_ids: ["fact:BUILDING12345678"],
        id: "criterion:BUILDING12345678",
        required: true,
        statement: "Every approved mutation is represented by the candidate.",
      },
    ],
    entry_strategy: "problem-description",
    facts: [
      {
        evidence_refs: [artifactRef(binding)],
        id: "fact:BUILDING12345678",
        statement: "The baseline requires one exact multi-file patch.",
      },
    ],
    gaps: [],
    inferences: [
      {
        basis_fact_ids: ["fact:BUILDING12345678"],
        id: "inference:BUILDING12345678",
        statement: "The approved files require direct mutations.",
      },
    ],
    problem_summary: "Exercise the exact building mutation boundary.",
    provenance: {
      source: "problem-description",
      source_refs: [artifactRef(binding)],
    },
    status: "confirmed",
    workflow_id: WORKFLOW_ID,
  });
  const approval = approvePatchPlan({
    activeArtifacts: [binding, rootCause],
    approved: true,
    at: "2026-07-24T10:01:00.000Z",
    builderPrincipal: BUILDER,
    proposal: {
      changes: [
        {
          criterion_ids: ["criterion:BUILDING12345678"],
          id: "change:MODIFYBUILDING001",
          operation: "modify",
          path: "modify.txt",
          reason: "Modify the approved text file.",
          root_cause_item_ids: ["inference:BUILDING12345678"],
          source_path: null,
        },
        {
          criterion_ids: ["criterion:BUILDING12345678"],
          id: "change:DELETEBUILDING001",
          operation: "delete",
          path: "delete.txt",
          reason: "Delete the approved obsolete file.",
          root_cause_item_ids: ["inference:BUILDING12345678"],
          source_path: null,
        },
        {
          criterion_ids: ["criterion:BUILDING12345678"],
          id: "change:RENAMEBUILDING001",
          operation: "rename",
          path: "rename-new.txt",
          reason: "Rename the approved file.",
          root_cause_item_ids: ["inference:BUILDING12345678"],
          source_path: "rename-old.txt",
        },
        {
          criterion_ids: ["criterion:BUILDING12345678"],
          id: "change:MODEBUILDING00001",
          operation: "modify",
          path: "mode.sh",
          reason: "Change the approved executable mode.",
          root_cause_item_ids: ["inference:BUILDING12345678"],
          source_path: null,
        },
        {
          criterion_ids: ["criterion:BUILDING12345678"],
          id: "change:BINARYBUILDING001",
          operation: "modify",
          path: "binary.bin",
          reason: "Modify the approved binary file.",
          root_cause_item_ids: ["inference:BUILDING12345678"],
          source_path: null,
        },
        {
          criterion_ids: ["criterion:BUILDING12345678"],
          id: "change:CREATEBUILDING001",
          operation: "create",
          path: "new/untracked.txt",
          reason: "Create the approved untracked file.",
          root_cause_item_ids: ["inference:BUILDING12345678"],
          source_path: null,
        },
      ],
      criterionIds: ["criterion:BUILDING12345678"],
      nonGoals: ["Change untouched.txt."],
      objectives: ["Apply the exact approved patch."],
      planRevision: 1,
    },
    workflowId: WORKFLOW_ID,
  });
  if (approval.status !== "approved") {
    throw new Error("test plan unexpectedly denied");
  }
  const activeArtifacts = [binding, rootCause, approval.plan, approval.authorization] as const;
  const builderAudit = auditTrustedPrincipal(BUILDER);
  const state = seal<WorkflowState>({
    artifact_refs: activeArtifacts.map(artifactRef),
    artifact_type: "workflow-state",
    artifact_version: 1,
    blocked_context: null,
    completed_at: null,
    coordinator: COORDINATOR,
    created_at: CREATED_AT,
    entry_context: {
      problem: "Exercise building.",
      repository_binding_ref: artifactRef(binding),
      strategy: "problem-description",
    },
    entry_strategy: "problem-description",
    phase: "building",
    phase_principal: builderAudit,
    principal_audit: [COORDINATOR, builderAudit],
    revision: 4,
    stale_artifact_refs: [],
    status: "active",
    updated_at: "2026-07-24T10:02:00.000Z",
    workflow_id: WORKFLOW_ID,
  });
  return {
    activeArtifacts,
    authorization: approval.authorization,
    binding,
    plan: approval.plan,
    root,
    rootCause,
    state,
  };
}

describe("Yuansheng Craft planning and direct building", () => {
  test("one approval event seals the plan and exact file-only authorization", async () => {
    const harness = await makeBuildingHarness();
    expect(harness.plan.created_at).toBe(harness.authorization.created_at);
    expect(harness.authorization.capability).toBe("file-mutation-only");
    expect(harness.authorization.baseline_commit).toBe(harness.binding.commit_sha);
    expect(harness.authorization.target_worktree_realpath).toBe(harness.root);
    expect([...harness.authorization.authorized_changes]).toEqual(
      harness.plan.changes.map((change) => ({
        operation: change.operation,
        path: change.path,
        planned_change_id: change.id,
        source_path: change.source_path,
      })),
    );

    const denied = approvePatchPlan({
      activeArtifacts: [harness.binding, harness.rootCause],
      approved: false,
      at: "2026-07-24T10:03:00.000Z",
      builderPrincipal: BUILDER,
      proposal: {
        changes: harness.plan.changes,
        criterionIds: harness.plan.criterion_ids,
        nonGoals: harness.plan.non_goals,
        objectives: harness.plan.objectives,
        planRevision: 2,
      },
      workflowId: WORKFLOW_ID,
    });
    expect(denied).toEqual({ status: "denied" });
    expect(() =>
      approvePatchPlan({
        activeArtifacts: [harness.binding, harness.rootCause],
        approved: true,
        at: "2026-07-24T10:03:00.000Z",
        builderPrincipal: PLANNER,
        proposal: {
          changes: harness.plan.changes,
          criterionIds: harness.plan.criterion_ids,
          nonGoals: harness.plan.non_goals,
          objectives: harness.plan.objectives,
          planRevision: 2,
        },
        workflowId: WORKFLOW_ID,
      }),
    ).toThrow(PatchPlanApprovalError);

    const revised = approvePatchPlan({
      activeArtifacts: [harness.binding, harness.rootCause],
      approved: true,
      at: "2026-07-24T10:03:00.000Z",
      builderPrincipal: BUILDER,
      proposal: {
        changes: harness.plan.changes,
        criterionIds: harness.plan.criterion_ids,
        nonGoals: harness.plan.non_goals,
        objectives: ["Apply the exact approved patch with a revised plan."],
        planRevision: 2,
      },
      workflowId: WORKFLOW_ID,
    });
    expect(revised.status).toBe("approved");
    if (revised.status === "approved") {
      expect(revised.plan.artifact_digest).not.toBe(harness.plan.artifact_digest);
      expect(revised.authorization.artifact_digest).not.toBe(harness.authorization.artifact_digest);
    }
  });

  test("write guard allows only exact builder, phase, operation, paths, and real files", async () => {
    const harness = await makeBuildingHarness();
    await expect(
      assertAuthorizedFileMutation({
        activeArtifacts: harness.activeArtifacts,
        principal: BUILDER,
        request: { operation: "modify", path: "modify.txt", sourcePath: null },
        state: harness.state,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertAuthorizedFileMutation({
        activeArtifacts: harness.activeArtifacts,
        principal: PLANNER,
        request: { operation: "modify", path: "modify.txt", sourcePath: null },
        state: harness.state,
      }),
    ).rejects.toThrow("FILE_MUTATION_DENIED");
    await expect(
      assertAuthorizedFileMutation({
        activeArtifacts: harness.activeArtifacts,
        principal: BUILDER,
        request: { operation: "modify", path: "untouched.txt", sourcePath: null },
        state: harness.state,
      }),
    ).rejects.toThrow("exactly match");
    const { artifact_digest: _stateDigest, ...statePayload } = harness.state;
    const planningState = seal<WorkflowState>({
      ...statePayload,
      phase: "planning",
      phase_principal: null,
    });
    await expect(
      assertAuthorizedFileMutation({
        activeArtifacts: harness.activeArtifacts,
        principal: BUILDER,
        request: { operation: "modify", path: "modify.txt", sourcePath: null },
        state: planningState,
      }),
    ).rejects.toThrow("building phase");
    await expect(
      assertAuthorizedFileMutation({
        activeArtifacts: harness.activeArtifacts,
        principal: BUILDER,
        request: { operation: "rename", path: "rename-new.txt", sourcePath: "rename-old.txt" },
        state: harness.state,
      }),
    ).resolves.toBeUndefined();
    expect(() => assertBuildingProcessDenied({ principal: BUILDER, state: harness.state })).toThrow(
      "never permits Bash",
    );

    await mkdir(join(harness.root, "new"));
    const outside = await mkdtemp(join(tmpdir(), "ys-craft-escape-"));
    temporaryRoots.push(outside);
    await rm(join(harness.root, "new"), { recursive: true });
    await symlink(outside, join(harness.root, "new"), "dir");
    await expect(
      assertAuthorizedFileMutation({
        activeArtifacts: harness.activeArtifacts,
        principal: BUILDER,
        request: { operation: "create", path: "new/untracked.txt", sourcePath: null },
        state: harness.state,
      }),
    ).rejects.toThrow("symlink");
    expect(await readFile(join(harness.root, "untouched.txt"), "utf8")).toBe("user content\n");
  });

  test("OpenCode hook derives the builder from ToolContext and fails closed", async () => {
    const harness = await makeBuildingHarness();
    const guard = createOpenCodeBuilderWriteGuard();
    const context = {
      abort: new AbortController().signal,
      agent: "ys-craft-patch-builder",
      ask: async () => {},
      directory: harness.root,
      messageID: "message:BUILDING1234567",
      metadata: () => {},
      sessionID: "session:BUILDING12345678",
      worktree: harness.root,
    } satisfies Parameters<typeof guard.activateFromToolContext>[0];
    await guard.hooks["chat.params"]?.(
      {
        agent: context.agent,
        message: {} as never,
        model: {} as never,
        provider: {} as never,
        sessionID: context.sessionID,
      },
      {
        maxOutputTokens: undefined,
        options: {},
        temperature: 0,
        topK: 0,
        topP: 0,
      },
    );
    guard.activateFromToolContext(context, harness.state, harness.activeArtifacts);
    await expect(
      guard.hooks["tool.execute.before"]?.(
        { callID: "call:BUILDING12345678", sessionID: context.sessionID, tool: "edit" },
        { args: { filePath: join(harness.root, "modify.txt") } },
      ),
    ).resolves.toBeUndefined();
    await expect(
      guard.hooks["tool.execute.before"]?.(
        { callID: "call:BUILDING12345679", sessionID: context.sessionID, tool: "bash" },
        { args: { command: "true" } },
      ),
    ).rejects.toThrow("never permits Bash");
    await expect(
      guard.hooks["tool.execute.before"]?.(
        {
          callID: "call:BUILDING12345680",
          sessionID: "session:UNBOUND123456789",
          tool: "write",
        },
        { args: { filePath: join(harness.root, "modify.txt") } },
      ),
    ).rejects.toThrow("active authorized builder");
  });

  test("captures every real Git diff kind deterministically and rejects later drift", async () => {
    const harness = await makeBuildingHarness();
    await writeFile(join(harness.root, "modify.txt"), "after\n");
    await unlink(join(harness.root, "delete.txt"));
    await rename(join(harness.root, "rename-old.txt"), join(harness.root, "rename-new.txt"));
    await chmod(join(harness.root, "mode.sh"), 0o755);
    await writeFile(join(harness.root, "binary.bin"), new Uint8Array([1, 0, 9, 3]));
    await mkdir(join(harness.root, "new"));
    await writeFile(join(harness.root, "new", "untracked.txt"), "untracked\n");

    const first = await capturePatchCandidate({
      activeArtifacts: harness.activeArtifacts,
      at: "2026-07-24T10:04:00.000Z",
      gitRunner: GIT_RUNNER,
      previousCandidates: [],
      principal: BUILDER,
      state: harness.state,
    });
    const second = await capturePatchCandidate({
      activeArtifacts: harness.activeArtifacts,
      at: "2026-07-24T10:05:00.000Z",
      gitRunner: GIT_RUNNER,
      previousCandidates: [first.candidate],
      principal: BUILDER,
      state: harness.state,
    });

    const expectedScopes: Array<{
      operation: "create" | "delete" | "modify" | "rename";
      path: string;
      source_path: string | null;
    }> = [
      { operation: "delete", path: "delete.txt", source_path: null },
      { operation: "modify", path: "binary.bin", source_path: null },
      { operation: "modify", path: "mode.sh", source_path: null },
      { operation: "modify", path: "modify.txt", source_path: null },
      { operation: "create", path: "new/untracked.txt", source_path: null },
      { operation: "rename", path: "rename-new.txt", source_path: "rename-old.txt" },
    ];
    expect(
      first.entries.map(({ operation, path, source_path }) => ({
        operation,
        path,
        source_path,
      })),
    ).toEqual(
      expectedScopes.sort((left, right) => {
        const leftKey = `${left.source_path ?? ""}\0${left.path}\0${left.operation}`;
        const rightKey = `${right.source_path ?? ""}\0${right.path}\0${right.operation}`;
        return leftKey.localeCompare(rightKey);
      }),
    );
    expect(first.entries.find((entry) => entry.path === "binary.bin")?.binary).toBe(true);
    expect(first.entries.find((entry) => entry.path === "mode.sh")).toMatchObject({
      new_mode: "100755",
      old_mode: "100644",
    });
    expect(new TextDecoder().decode(first.binaryPatchBytes)).toContain("GIT binary patch");
    expect(second.diffContentDigest).toBe(first.diffContentDigest);
    expect(second.binaryPatchDigest).toBe(first.binaryPatchDigest);
    expect(second.candidate.iteration).toBe(2);
    expect(second.candidate.candidate_revision).toBe(2);
    expect(second.candidate.artifact_digest).not.toBe(first.candidate.artifact_digest);
    expect(canonicalizeJson(second.entries).text).toBe(canonicalizeJson(first.entries).text);
    expect(await lstat(join(harness.root, "modify.txt"))).toBeDefined();

    await writeFile(join(harness.root, "modify.txt"), "drifted\n");
    const drifted = await captureCanonicalDiff({
      authorization: harness.authorization,
      binding: harness.binding,
      gitRunner: GIT_RUNNER,
    });
    expect(drifted.diffContentDigest).not.toBe(first.diffContentDigest);
    await expect(
      assertCandidateWorktreeUnchanged({
        authorization: harness.authorization,
        binding: harness.binding,
        candidate: first.candidate,
        gitRunner: GIT_RUNNER,
      }),
    ).rejects.toThrow("drifted");
    expect(await readFile(join(harness.root, "untouched.txt"), "utf8")).toBe("user content\n");
  });
});
