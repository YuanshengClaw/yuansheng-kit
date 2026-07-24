import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalizeJson,
  sealArtifact,
  sha256Digest,
} from "../../plugins/craft/workflows/artifacts/canonical";
import type {
  ActionJournal,
  PrincipalAudit,
  RepositoryBinding,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../../plugins/craft/workflows/artifacts/generated";
import {
  artifactRef,
  parseCraftContractBytes,
} from "../../plugins/craft/workflows/artifacts/parser";
import type { JsonValue } from "../../plugins/craft/workflows/artifacts/strict-json";
import { issueTrustedPrincipal } from "../../plugins/craft/workflows/state-machine/principal";
import {
  openAtomicWorkflowStore,
  type ResumeRepositoryObservation,
} from "../../plugins/craft/workflows/store";
import { makeCompleteContractGraph, makeRepositoryBinding } from "./contract-fixtures";

const CREATED_AT = "2026-07-24T08:00:00.000Z";
const CONFIG_DIGEST = sha256Digest(new TextEncoder().encode("craft config v1"));
const CONTROLLER_ROOT = "/workspace/controller";
const COORDINATOR_AUDIT: PrincipalAudit = {
  agent_id: "ys-craft",
  session_id: "session:STOREPRIMARY0001",
};
const BUILDER_AUDIT: PrincipalAudit = {
  agent_id: "ys-craft-patch-builder",
  session_id: "session:STOREBUILDER0001",
};
const COORDINATOR = issueTrustedPrincipal({
  agentId: COORDINATOR_AUDIT.agent_id,
  sessionId: COORDINATOR_AUDIT.session_id,
});
const RESUMED_COORDINATOR = issueTrustedPrincipal({
  agentId: "ys-craft",
  sessionId: "session:STORERESUME00001",
});

function sealState(
  workflowId: string,
  binding: RepositoryBinding,
  options: {
    readonly blocked?: boolean;
    readonly building?: boolean;
    readonly coordinator?: PrincipalAudit;
    readonly revision?: number;
    readonly updatedAt?: string;
  } = {},
): WorkflowState {
  const coordinator = options.coordinator ?? COORDINATOR_AUDIT;
  const phase = options.blocked ? "blocked" : options.building ? "building" : "root_cause";
  const payload: Omit<WorkflowState, "artifact_digest"> = {
    artifact_refs: [artifactRef(binding)],
    artifact_type: "workflow-state",
    artifact_version: 1,
    blocked_context: options.blocked
      ? {
          from_phase: "root_cause",
          reason: "Explicit human review is required.",
          remediation_phase: "root_cause",
        }
      : null,
    completed_at: null,
    coordinator,
    created_at: CREATED_AT,
    entry_context: {
      problem: "Configuration normalization drops a required field.",
      repository_binding_ref: artifactRef(binding),
      strategy: "problem-description",
    },
    entry_strategy: "problem-description",
    phase,
    phase_principal: options.building ? BUILDER_AUDIT : null,
    principal_audit: options.building ? [coordinator, BUILDER_AUDIT] : [coordinator],
    revision: options.revision ?? 0,
    stale_artifact_refs: [],
    status: options.blocked ? "blocked" : "active",
    updated_at: options.updatedAt ?? CREATED_AT,
    workflow_id: workflowId,
  };
  return parseState(
    sealArtifact(payload as unknown as Record<string, JsonValue>) as unknown as WorkflowState,
  );
}

function sealJournal(state: WorkflowState, entries: ActionJournal["entries"] = []): ActionJournal {
  const journal = sealArtifact({
    artifact_type: "action-journal",
    artifact_version: 1,
    created_at: CREATED_AT,
    entries,
    revision: state.revision,
    workflow_id: state.workflow_id,
  } as unknown as Record<string, JsonValue>) as unknown as ActionJournal;
  const parsed = parseCraftContractBytes(canonicalizeJson(journal).bytes);
  if (parsed.artifact_type !== "action-journal") {
    throw new TypeError("Fixture did not produce an action journal");
  }
  return parsed;
}

function parseState(state: WorkflowState): WorkflowState {
  const parsed = parseCraftContractBytes(canonicalizeJson(state).bytes);
  if (parsed.artifact_type !== "workflow-state") {
    throw new TypeError("Fixture did not produce a workflow state");
  }
  return parsed;
}

function revisedBlockedState(state: WorkflowState, at: string, reason: string): WorkflowState {
  const { artifact_digest: _digest, ...payload } = state;
  return parseState(
    sealArtifact({
      ...payload,
      blocked_context: {
        ...state.blocked_context,
        reason,
      },
      revision: state.revision + 1,
      updated_at: at,
    } as unknown as Record<string, JsonValue>) as unknown as WorkflowState,
  );
}

function appendJournal(
  journal: ActionJournal,
  state: WorkflowState,
  at: string,
  result: "blocked" | "succeeded" = "blocked",
): ActionJournal {
  return sealJournal(state, [
    ...journal.entries,
    {
      action: "ys_craft_status",
      at,
      principal: COORDINATOR_AUDIT,
      result,
      sequence: journal.entries.length + 1,
      subject_refs: [],
    },
  ]);
}

function observation(
  root: string,
  binding: RepositoryBinding,
  overrides: Partial<ResumeRepositoryObservation> = {},
): ResumeRepositoryObservation {
  return {
    configDigest: CONFIG_DIGEST,
    controllerRootRealpath: CONTROLLER_ROOT,
    diffContentDigest: null,
    gitRootRealpath: binding.git_root_realpath,
    headCommit: binding.commit_sha,
    headTreeDigest: binding.tree_digest as `sha256:${string}`,
    productRootRealpath: binding.product_root_realpath,
    status: "clean",
    storeRootIgnored: true,
    storeRootRealpath: root,
    targetWorktreeRealpath: binding.target_worktree_realpath,
    ...overrides,
  };
}

async function makeStoreHarness(
  input: {
    readonly blocked?: boolean;
    readonly building?: boolean;
    readonly workflowId?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ys-craft-store-"));
  const store = await openAtomicWorkflowStore(root);
  const binding = makeRepositoryBinding();
  const workflowId = input.workflowId ?? "workflow:STORETEST00000001";
  const state = sealState(workflowId, binding, input);
  const journal = sealJournal(state);
  await store.initializeWorkflow({
    artifacts: [binding],
    configDigest: CONFIG_DIGEST,
    controllerRootRealpath: CONTROLLER_ROOT,
    journal,
    state,
  });
  return { binding, journal, root, state, store, workflowId };
}

describe("Yuansheng Craft atomic workflow Store", () => {
  test("rejects workflow ID collisions and never overwrites the committed snapshot", async () => {
    const harness = await makeStoreHarness();

    await expect(
      harness.store.initializeWorkflow({
        artifacts: [harness.binding],
        configDigest: CONFIG_DIGEST,
        controllerRootRealpath: CONTROLLER_ROOT,
        journal: harness.journal,
        state: harness.state,
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_COLLISION" });

    const snapshot = await harness.store.readExactWorkflow(harness.workflowId);
    expect(snapshot.state.artifact_digest).toBe(harness.state.artifact_digest);
    expect(snapshot.state.revision).toBe(0);
  });

  test("allows exactly one concurrent CAS update and preserves append-only journal history", async () => {
    const harness = await makeStoreHarness({ blocked: true });
    const firstState = revisedBlockedState(
      harness.state,
      "2026-07-24T08:01:00.000Z",
      "First competing update.",
    );
    const secondState = revisedBlockedState(
      harness.state,
      "2026-07-24T08:02:00.000Z",
      "Second competing update.",
    );
    const firstJournal = appendJournal(harness.journal, firstState, firstState.updated_at);
    const secondJournal = appendJournal(harness.journal, secondState, secondState.updated_at);

    const results = await Promise.allSettled([
      harness.store.commitWorkflow({
        artifacts: [harness.binding],
        expectedRevision: 0,
        journal: firstJournal,
        state: firstState,
      }),
      harness.store.commitWorkflow({
        artifacts: [harness.binding],
        expectedRevision: 0,
        journal: secondJournal,
        state: secondState,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const snapshot = await harness.store.readExactWorkflow(harness.workflowId);
    expect(snapshot.state.revision).toBe(1);
    expect(snapshot.journal.entries).toHaveLength(1);

    const nextState = revisedBlockedState(
      snapshot.state,
      "2026-07-24T08:03:00.000Z",
      "Attempted journal rewrite.",
    );
    const rewrittenJournal = sealJournal(nextState, []);
    await expect(
      harness.store.commitWorkflow({
        artifacts: [harness.binding],
        expectedRevision: 1,
        journal: rewrittenJournal,
        state: nextState,
      }),
    ).rejects.toMatchObject({ code: "JOURNAL_NOT_APPEND_ONLY" });
  });

  test("grants only one building lease per canonical worktree", async () => {
    const first = await makeStoreHarness({
      building: true,
      workflowId: "workflow:STORELEASE0000001",
    });
    const secondState = sealState("workflow:STORELEASE0000002", first.binding, { building: true });

    await expect(
      first.store.initializeWorkflow({
        artifacts: [first.binding],
        configDigest: CONFIG_DIGEST,
        controllerRootRealpath: CONTROLLER_ROOT,
        journal: sealJournal(secondState),
        state: secondState,
      }),
    ).rejects.toMatchObject({ code: "BUILDING_LEASE_CONFLICT" });
    expect((await first.store.readExactWorkflow(first.workflowId)).state.phase).toBe("building");

    const otherBinding = makeRepositoryBinding({
      git_root_realpath: "/workspace/other-project",
      product_root_realpath: "/workspace/other-project",
      target_worktree_realpath: "/workspace/other-project",
    });
    const parallelState = sealState("workflow:STORELEASE0000003", otherBinding, {
      building: true,
    });
    await expect(
      first.store.initializeWorkflow({
        artifacts: [otherBinding],
        configDigest: CONFIG_DIGEST,
        controllerRootRealpath: CONTROLLER_ROOT,
        journal: sealJournal(parallelState),
        state: parallelState,
      }),
    ).resolves.toMatchObject({ state: { phase: "building" } });
  });

  test("treats the committed pointer as authoritative and reports stage, backup, and lock residue", async () => {
    const harness = await makeStoreHarness({ blocked: true });
    const workflowName = sha256Digest(new TextEncoder().encode(harness.workflowId)).slice(
      "sha256:".length,
    );
    const stagePath = join(
      harness.root,
      "workflows",
      workflowName,
      ".current.json.interrupted.stage",
    );
    await writeFile(stagePath, '{"not":"authoritative"}');
    await writeFile(
      join(harness.root, "workflows", workflowName, ".current.json.backup"),
      '{"not":"authoritative"}',
    );
    await writeFile(
      join(harness.root, "workflows", workflowName, ".lock"),
      '{"interrupted":"writer"}',
    );

    const snapshot = await harness.store.readExactWorkflow(harness.workflowId);
    expect(snapshot.state.revision).toBe(0);
    expect(
      new Set(
        (await harness.store.inspectResidues(harness.workflowId)).map((residue) => residue.kind),
      ),
    ).toEqual(new Set(["backup", "lock", "stage"]));
    const result = await harness.store.resumeExactWorkflow({
      at: "2026-07-24T08:03:00.000Z",
      observation: observation(harness.root, harness.binding),
      principal: RESUMED_COORDINATOR,
      storeAnchor: harness.root,
      workflowId: harness.workflowId,
    });
    expect(result.status).toBe("blocked");
    if (result.status === "blocked") {
      expect(result.issues.map((issue) => issue.code)).toContain("STORE_RESIDUE");
    }
    expect((await harness.store.readExactWorkflow(harness.workflowId)).state.revision).toBe(0);
  });

  test("fails closed when a committed path is replaced by a symlink", async () => {
    const harness = await makeStoreHarness();
    const workflowName = sha256Digest(new TextEncoder().encode(harness.workflowId)).slice(
      "sha256:".length,
    );
    const currentPath = join(harness.root, "workflows", workflowName, "current.json");
    const targetPath = join(harness.root, "attacker-controlled.json");
    await writeFile(targetPath, await readFile(currentPath));
    await unlink(currentPath);
    await symlink(targetPath, currentPath);

    await expect(harness.store.readExactWorkflow(harness.workflowId)).rejects.toMatchObject({
      code: "STORE_CORRUPT",
    });
  });

  test("does not replay an unaccounted side effect and resumes only after an explicit result", async () => {
    const harness = await makeStoreHarness({ blocked: true });
    const operationId = "operation:STOREPROCESS0001";
    await harness.store.recordOperationIntent({
      action: "ys_craft_run_verification",
      at: "2026-07-24T08:01:00.000Z",
      operationId,
      principal: COORDINATOR,
      sideEffect: "process-execution",
      subjectRefs: [],
      workflowId: harness.workflowId,
    });
    await harness.store.markOperationStarted({
      at: "2026-07-24T08:02:00.000Z",
      operationId,
      workflowId: harness.workflowId,
    });

    const blocked = await harness.store.resumeExactWorkflow({
      at: "2026-07-24T08:03:00.000Z",
      observation: observation(harness.root, harness.binding),
      principal: RESUMED_COORDINATOR,
      storeAnchor: harness.root,
      workflowId: harness.workflowId,
    });
    expect(blocked.status).toBe("blocked");
    if (blocked.status === "blocked") {
      expect(blocked.issues.map((issue) => issue.code)).toContain("AMBIGUOUS_SIDE_EFFECT");
    }
    expect((await harness.store.readExactWorkflow(harness.workflowId)).state.revision).toBe(0);

    await harness.store.recordOperationResult({
      at: "2026-07-24T08:04:00.000Z",
      evidenceRefs: [],
      operationId,
      outcome: "succeeded",
      principal: RESUMED_COORDINATOR,
      workflowId: harness.workflowId,
    });
    const resumed = await harness.store.resumeExactWorkflow({
      at: "2026-07-24T08:05:00.000Z",
      observation: observation(harness.root, harness.binding),
      principal: RESUMED_COORDINATOR,
      storeAnchor: harness.root,
      workflowId: harness.workflowId,
    });
    expect(resumed.status).toBe("resumed");
    if (resumed.status === "resumed") {
      expect(resumed.snapshot.state.coordinator.session_id).toBe("session:STORERESUME00001");
      expect(resumed.snapshot.state.phase).toBe("blocked");
      expect(resumed.snapshot.state.revision).toBe(1);
      expect(resumed.snapshot.journal.entries.at(-1)?.action).toBe("ys_craft_resume");
    }
  });

  test("atomically blocks an active workflow when recovery finds an ambiguous side effect", async () => {
    const harness = await makeStoreHarness();
    const operationId = "operation:STORECRASH000001";
    await harness.store.recordOperationIntent({
      action: "ys_craft_run_verification",
      at: "2026-07-24T08:01:00.000Z",
      operationId,
      principal: COORDINATOR,
      sideEffect: "process-execution",
      subjectRefs: [],
      workflowId: harness.workflowId,
    });
    await harness.store.markOperationStarted({
      at: "2026-07-24T08:02:00.000Z",
      operationId,
      workflowId: harness.workflowId,
    });

    const result = await harness.store.resumeExactWorkflow({
      at: "2026-07-24T08:03:00.000Z",
      observation: observation(harness.root, harness.binding),
      principal: RESUMED_COORDINATOR,
      storeAnchor: harness.root,
      workflowId: harness.workflowId,
    });

    expect(result.status).toBe("blocked");
    const recovered = await harness.store.readExactWorkflow(harness.workflowId);
    expect(recovered.state.phase).toBe("blocked");
    expect(recovered.state.revision).toBe(1);
    expect(recovered.state.coordinator).toEqual(COORDINATOR_AUDIT);
    expect(recovered.journal.entries.at(-1)?.result).toBe("blocked");
  });

  test("wrong exact ID and configuration drift mutate no workflow", async () => {
    const first = await makeStoreHarness({
      blocked: true,
      workflowId: "workflow:STOREEXACT000001",
    });
    const secondState = sealState("workflow:STOREEXACT000002", first.binding, { blocked: true });
    await first.store.initializeWorkflow({
      artifacts: [first.binding],
      configDigest: CONFIG_DIGEST,
      controllerRootRealpath: CONTROLLER_ROOT,
      journal: sealJournal(secondState),
      state: secondState,
    });

    await expect(
      first.store.resumeExactWorkflow({
        at: "2026-07-24T08:01:00.000Z",
        observation: observation(first.root, first.binding),
        principal: RESUMED_COORDINATOR,
        storeAnchor: first.root,
        workflowId: "workflow:STOREMISSING0001",
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_NOT_FOUND" });

    const drifted = await first.store.resumeExactWorkflow({
      at: "2026-07-24T08:02:00.000Z",
      observation: observation(first.root, first.binding, {
        configDigest: sha256Digest(new TextEncoder().encode("changed config")),
      }),
      principal: RESUMED_COORDINATOR,
      storeAnchor: first.root,
      workflowId: secondState.workflow_id,
    });
    expect(drifted.status).toBe("blocked");
    if (drifted.status === "blocked") {
      expect(drifted.issues.map((issue) => issue.code)).toContain("CONFIG_DRIFT");
    }
    const controllerDrifted = await first.store.resumeExactWorkflow({
      at: "2026-07-24T08:03:00.000Z",
      observation: observation(first.root, first.binding, {
        controllerRootRealpath: "/workspace/other-controller",
      }),
      principal: RESUMED_COORDINATOR,
      storeAnchor: first.root,
      workflowId: secondState.workflow_id,
    });
    expect(controllerDrifted.status).toBe("blocked");
    if (controllerDrifted.status === "blocked") {
      expect(controllerDrifted.issues.map((issue) => issue.code)).toContain("CONFIG_DRIFT");
    }
    expect((await first.store.readExactWorkflow(first.workflowId)).state.revision).toBe(0);
    expect((await first.store.readExactWorkflow(secondState.workflow_id)).state.revision).toBe(0);
  });

  test("accepts only the exact recorded candidate diff after validating the full evidence chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "ys-craft-store-candidate-"));
    const store = await openAtomicWorkflowStore(root);
    const graph = makeCompleteContractGraph();
    const artifacts = graph.artifacts.filter(
      (artifact): artifact is Exclude<YuanshengCraftContractV1, ActionJournal | WorkflowState> =>
        artifact.artifact_type !== "workflow-state" &&
        artifact.artifact_type !== "action-journal" &&
        artifact.artifact_digest !== graph.repeatedDiffCandidate.artifact_digest,
    );
    const binding = artifacts.find(
      (artifact): artifact is RepositoryBinding => artifact.artifact_type === "repository-binding",
    );
    if (binding === undefined) {
      throw new TypeError("Complete fixture has no repository binding");
    }
    const completed = graph.artifacts.find(
      (artifact): artifact is WorkflowState => artifact.artifact_type === "workflow-state",
    );
    if (completed === undefined) {
      throw new TypeError("Complete fixture has no workflow state");
    }
    const { artifact_digest: _digest, ...payload } = completed;
    const state = parseState(
      sealArtifact({
        ...payload,
        artifact_refs: artifacts.map(artifactRef),
        blocked_context: {
          from_phase: "delivering",
          reason: "Delivery requires explicit recovery.",
          remediation_phase: "verifying",
        },
        completed_at: null,
        phase: "blocked",
        revision: 0,
        status: "blocked",
        updated_at: CREATED_AT,
      } as unknown as Record<string, JsonValue>) as unknown as WorkflowState,
    );
    await store.initializeWorkflow({
      artifacts,
      configDigest: CONFIG_DIGEST,
      controllerRootRealpath: CONTROLLER_ROOT,
      journal: sealJournal(state),
      state,
    });

    const drifted = await store.resumeExactWorkflow({
      at: "2026-07-24T08:17:00.000Z",
      observation: observation(root, binding, {
        diffContentDigest: sha256Digest(new TextEncoder().encode("extra drift")),
        status: "dirty",
      }),
      principal: RESUMED_COORDINATOR,
      storeAnchor: root,
      workflowId: state.workflow_id,
    });
    expect(drifted.status).toBe("blocked");
    if (drifted.status === "blocked") {
      expect(drifted.issues.map((issue) => issue.code)).toContain("CANDIDATE_DRIFT");
    }
    expect((await store.readExactWorkflow(state.workflow_id)).state.revision).toBe(0);

    const resumed = await store.resumeExactWorkflow({
      at: "2026-07-24T08:18:00.000Z",
      observation: observation(root, binding, {
        diffContentDigest: graph.candidate.diff_content_digest as `sha256:${string}`,
        status: "dirty",
      }),
      principal: RESUMED_COORDINATOR,
      storeAnchor: root,
      workflowId: state.workflow_id,
    });
    expect(resumed.status).toBe("resumed");
  });
});
