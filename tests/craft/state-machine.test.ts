import { describe, expect, test } from "bun:test";

import type {
  ArtifactType,
  RepositoryBinding,
  RootCauseArtifact,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../../plugins/craft/workflows/artifacts/generated";
import { artifactRef } from "../../plugins/craft/workflows/artifacts/parser";
import type { BlueprintImportTransaction } from "../../plugins/craft/workflows/blueprint-import/transaction";
import {
  bindPhasePrincipal,
  blockWorkflow,
  createBlueprintWorkflowState,
  createProblemWorkflowState,
  recordPhaseArtifact,
  remediateBlockedWorkflow,
  returnWorkflowToPhase,
  transitionWorkflow,
} from "../../plugins/craft/workflows/state-machine/engine";
import { authorizePhaseCommandExecution } from "../../plugins/craft/workflows/state-machine/phase-commands";
import { issueTrustedPrincipal } from "../../plugins/craft/workflows/state-machine/principal";
import { evaluateStopGate } from "../../plugins/craft/workflows/state-machine/stop-gate";
import { makeCompleteContractGraph, makeProblemEntryGraph } from "./contract-fixtures";

const WORKFLOW_ID = "workflow:ABCDEFGHIJKLMNOP";
const COORDINATOR = issueTrustedPrincipal({
  agentId: "ys-craft",
  sessionId: "session:PRIMARY1234567890",
});
const PLANNER = issueTrustedPrincipal({
  agentId: "ys-craft-patch-planner",
  sessionId: "session:PLANNER123456789",
});
const BUILDER = issueTrustedPrincipal({
  agentId: "ys-craft-patch-builder",
  sessionId: "session:BUILDER123456789",
});
const VERIFIER = issueTrustedPrincipal({
  agentId: "ys-craft-regression-verifier",
  sessionId: "session:VERIFIER12345678",
});
const REVIEWER = issueTrustedPrincipal({
  agentId: "ys-craft-patch-reviewer",
  sessionId: "session:REVIEWER12345678",
});
const DELIVERY = issueTrustedPrincipal({
  agentId: "ys-craft-delivery-coordinator",
  sessionId: "session:DELIVERY12345678",
});

interface ImportedHarness {
  readonly artifacts: readonly YuanshengCraftContractV1[];
  readonly byType: ReadonlyMap<ArtifactType, readonly YuanshengCraftContractV1[]>;
  readonly binding: RepositoryBinding;
  readonly state: WorkflowState;
}

function contractsByType(
  artifacts: readonly YuanshengCraftContractV1[],
): ReadonlyMap<ArtifactType, readonly YuanshengCraftContractV1[]> {
  const result = new Map<ArtifactType, YuanshengCraftContractV1[]>();
  for (const artifact of artifacts) {
    const values = result.get(artifact.artifact_type) ?? [];
    values.push(artifact);
    result.set(artifact.artifact_type, values);
  }
  return result;
}

function one<T extends ArtifactType>(
  byType: ReadonlyMap<ArtifactType, readonly YuanshengCraftContractV1[]>,
  artifactType: T,
): Extract<YuanshengCraftContractV1, { artifact_type: T }> {
  const matches = byType.get(artifactType) ?? [];
  const match = matches[0];
  if (matches.length === 0 || match?.artifact_type !== artifactType) {
    throw new TypeError(`Fixture is missing ${artifactType}`);
  }
  return match as Extract<YuanshengCraftContractV1, { artifact_type: T }>;
}

function importedHarness(): ImportedHarness {
  const graph = makeCompleteContractGraph();
  const artifacts = graph.artifacts.filter(
    (artifact) =>
      artifact.artifact_type !== "workflow-state" &&
      artifact.artifact_type !== "action-journal" &&
      !(artifact.artifact_type === "patch-candidate" && artifact.candidate_revision === 2),
  );
  const byType = contractsByType(artifacts);
  const binding = one(byType, "repository-binding");
  const subject = one(byType, "blueprint-review-subject");
  const attestation = one(byType, "blueprint-review-attestation");
  const rootCause = one(byType, "root-cause");
  const transaction: BlueprintImportTransaction = {
    attestation,
    contracts: [subject, attestation, rootCause],
    repositoryBindingRef: artifactRef(binding),
    reviewSubject: subject,
    rootCauseArtifact: rootCause,
  };
  const state = createBlueprintWorkflowState({
    at: "2026-07-24T08:00:00.000Z",
    coordinator: COORDINATOR,
    repositoryBinding: binding,
    transaction,
    workflowId: WORKFLOW_ID,
  });
  return {
    artifacts,
    binding,
    byType,
    state,
  };
}

function initialImportedArtifacts(harness: ImportedHarness): YuanshengCraftContractV1[] {
  return [
    harness.binding,
    one(harness.byType, "blueprint-review-subject"),
    one(harness.byType, "blueprint-review-attestation"),
    one(harness.byType, "root-cause"),
  ];
}

function appendArtifact(
  state: WorkflowState,
  active: YuanshengCraftContractV1[],
  artifact: YuanshengCraftContractV1,
  principal: Parameters<typeof recordPhaseArtifact>[0]["principal"],
  at: string,
): WorkflowState {
  active.push(artifact);
  return recordPhaseArtifact({
    activeArtifacts: active,
    artifact,
    at,
    expectedRevision: state.revision,
    principal,
    state,
  });
}

function progressImportedToDelivering(): {
  readonly active: YuanshengCraftContractV1[];
  readonly harness: ImportedHarness;
  readonly state: WorkflowState;
} {
  const harness = importedHarness();
  const active = initialImportedArtifacts(harness);
  let state = bindPhasePrincipal({
    at: "2026-07-24T08:01:00.000Z",
    expectedRevision: harness.state.revision,
    principal: PLANNER,
    state: harness.state,
  });
  state = appendArtifact(
    state,
    active,
    one(harness.byType, "patch-plan"),
    PLANNER,
    "2026-07-24T08:03:00.000Z",
  );
  state = appendArtifact(
    state,
    active,
    one(harness.byType, "mutation-authorization"),
    PLANNER,
    "2026-07-24T08:04:00.000Z",
  );
  state = transitionWorkflow({
    activeArtifacts: active,
    at: "2026-07-24T08:04:00.000Z",
    expectedRevision: state.revision,
    principal: PLANNER,
    state,
    targetPhase: "building",
  });
  state = bindPhasePrincipal({
    activeArtifacts: active,
    at: "2026-07-24T08:04:00.000Z",
    expectedRevision: state.revision,
    principal: BUILDER,
    state,
  });
  state = appendArtifact(
    state,
    active,
    one(harness.byType, "diff-manifest"),
    BUILDER,
    "2026-07-24T08:05:00.000Z",
  );
  state = appendArtifact(
    state,
    active,
    one(harness.byType, "patch-candidate"),
    BUILDER,
    "2026-07-24T08:06:00.000Z",
  );
  state = transitionWorkflow({
    activeArtifacts: active,
    at: "2026-07-24T08:07:00.000Z",
    expectedRevision: state.revision,
    principal: BUILDER,
    state,
    targetPhase: "verifying",
  });
  state = bindPhasePrincipal({
    at: "2026-07-24T08:08:00.000Z",
    expectedRevision: state.revision,
    principal: VERIFIER,
    state,
  });
  for (const artifactType of [
    "verification-source",
    "verification-manifest",
    "verification-authorization",
    "criterion-evidence",
  ] as const) {
    const artifact = one(harness.byType, artifactType);
    state = appendArtifact(state, active, artifact, VERIFIER, artifact.created_at);
  }
  state = transitionWorkflow({
    activeArtifacts: active,
    at: "2026-07-24T08:14:00.000Z",
    expectedRevision: state.revision,
    principal: VERIFIER,
    state,
    targetPhase: "reviewing",
  });
  state = bindPhasePrincipal({
    at: "2026-07-24T08:15:00.000Z",
    expectedRevision: state.revision,
    principal: REVIEWER,
    state,
  });
  state = appendArtifact(
    state,
    active,
    one(harness.byType, "patch-review"),
    REVIEWER,
    "2026-07-24T08:15:00.000Z",
  );
  state = transitionWorkflow({
    activeArtifacts: active,
    at: "2026-07-24T08:15:00.000Z",
    expectedRevision: state.revision,
    principal: REVIEWER,
    state,
    targetPhase: "delivering",
  });
  state = bindPhasePrincipal({
    at: "2026-07-24T08:16:00.000Z",
    expectedRevision: state.revision,
    principal: DELIVERY,
    state,
  });
  return { active, harness, state };
}

describe("Yuansheng Craft platform-neutral state machine", () => {
  test("problem and allowed Blueprint entries converge on planning without sharing entry semantics", () => {
    const [bindingValue, rootCauseValue] = makeProblemEntryGraph();
    const binding = bindingValue as RepositoryBinding;
    const rootCause = rootCauseValue as RootCauseArtifact;
    let problem = createProblemWorkflowState({
      at: "2026-07-24T08:00:00.000Z",
      coordinator: COORDINATOR,
      problem: "Configuration normalization drops a required field.",
      repositoryBinding: binding,
      workflowId: WORKFLOW_ID,
    });
    expect(problem.phase).toBe("root_cause");
    problem = bindPhasePrincipal({
      at: "2026-07-24T08:01:00.000Z",
      expectedRevision: problem.revision,
      principal: issueTrustedPrincipal({
        agentId: "ys-craft-root-cause-analyst",
        sessionId: "session:ROOTCAUSE1234567",
      }),
      state: problem,
    });
    const active = [binding, rootCause];
    problem = recordPhaseArtifact({
      activeArtifacts: active,
      artifact: rootCause,
      at: "2026-07-24T08:02:00.000Z",
      expectedRevision: problem.revision,
      principal: issueTrustedPrincipal({
        agentId: "ys-craft-root-cause-analyst",
        sessionId: "session:ROOTCAUSE1234567",
      }),
      state: problem,
    });
    problem = transitionWorkflow({
      activeArtifacts: active,
      at: "2026-07-24T08:03:00.000Z",
      expectedRevision: problem.revision,
      principal: issueTrustedPrincipal({
        agentId: "ys-craft-root-cause-analyst",
        sessionId: "session:ROOTCAUSE1234567",
      }),
      state: problem,
      targetPhase: "planning",
    });

    const importedHarnessValue = importedHarness();
    let imported = importedHarnessValue.state;
    imported = bindPhasePrincipal({
      at: "2026-07-24T08:01:00.000Z",
      expectedRevision: imported.revision,
      principal: PLANNER,
      state: imported,
    });
    expect(problem.phase).toBe("planning");
    expect(problem.entry_context.strategy).toBe("problem-description");
    expect(imported.phase).toBe("planning");
    expect(imported.entry_context.strategy).toBe("root-cause-import");
    expect(() =>
      returnWorkflowToPhase({
        at: "2026-07-24T08:01:00.000Z",
        expectedRevision: imported.revision,
        principal: PLANNER,
        reason: "Do not rerun root-cause analysis.",
        state: imported,
        targetPhase: "root_cause",
      }),
    ).toThrow("entry strategy");
    expect(() =>
      createProblemWorkflowState({
        at: "2026-07-24T08:00:00.000Z",
        coordinator: COORDINATOR,
        problem: "   ",
        repositoryBinding: binding,
        workflowId: WORKFLOW_ID,
      }),
    ).toThrow("non-whitespace");

    const subject = one(importedHarnessValue.byType, "blueprint-review-subject");
    const allowed = one(importedHarnessValue.byType, "blueprint-review-attestation");
    const importedRoot = one(importedHarnessValue.byType, "root-cause");
    const denied = { ...allowed, action: "deny" as const };
    expect(() =>
      createBlueprintWorkflowState({
        at: "2026-07-24T08:00:00.000Z",
        coordinator: COORDINATOR,
        repositoryBinding: importedHarnessValue.binding,
        transaction: {
          attestation: denied,
          contracts: [subject, denied, importedRoot],
          repositoryBindingRef: artifactRef(importedHarnessValue.binding),
          reviewSubject: subject,
          rootCauseArtifact: importedRoot,
        },
        workflowId: WORKFLOW_ID,
      }),
    ).toThrow("does not bind");
  });

  test("drives the imported chain through all guarded phases and terminal completion", () => {
    const progressed = progressImportedToDelivering();
    const deliveryArtifact = one(progressed.harness.byType, "delivery");
    progressed.active.push(deliveryArtifact);
    let state = recordPhaseArtifact({
      activeArtifacts: progressed.active,
      artifact: deliveryArtifact,
      at: "2026-07-24T08:16:00.000Z",
      expectedRevision: progressed.state.revision,
      principal: DELIVERY,
      state: progressed.state,
    });
    state = transitionWorkflow({
      activeArtifacts: progressed.active,
      at: "2026-07-24T08:16:00.000Z",
      expectedRevision: state.revision,
      principal: DELIVERY,
      state,
      targetPhase: "completed",
    });

    expect(state.phase).toBe("completed");
    expect(state.status).toBe("completed");
    expect(state.completed_at).toBe("2026-07-24T08:16:00.000Z");
    expect(state.phase_principal).toBeNull();
    expect(evaluateStopGate({ principal: COORDINATOR, state })).toEqual({
      allowStop: true,
      applies: true,
      reason: "completed",
      workflowId: WORKFLOW_ID,
    });
    expect(() =>
      bindPhasePrincipal({
        at: "2026-07-24T08:17:00.000Z",
        expectedRevision: state.revision,
        principal: DELIVERY,
        state,
      }),
    ).toThrow("TERMINAL_WORKFLOW");
  });

  test("fails closed on missing gates, stale revisions, wrong roles, and raw principal objects", () => {
    const harness = importedHarness();
    const active = initialImportedArtifacts(harness);
    let state = bindPhasePrincipal({
      at: "2026-07-24T08:01:00.000Z",
      expectedRevision: harness.state.revision,
      principal: PLANNER,
      state: harness.state,
    });
    state = appendArtifact(
      state,
      active,
      one(harness.byType, "patch-plan"),
      PLANNER,
      "2026-07-24T08:03:00.000Z",
    );
    expect(() =>
      transitionWorkflow({
        activeArtifacts: active,
        at: "2026-07-24T08:04:00.000Z",
        expectedRevision: state.revision,
        principal: PLANNER,
        state,
        targetPhase: "building",
      }),
    ).toThrow("mutation-authorization");
    expect(() =>
      bindPhasePrincipal({
        at: "2026-07-24T08:04:00.000Z",
        expectedRevision: 0,
        principal: PLANNER,
        state,
      }),
    ).toThrow("REVISION_CONFLICT");
    expect(() =>
      bindPhasePrincipal({
        at: "2026-07-24T08:04:00.000Z",
        expectedRevision: state.revision,
        principal: BUILDER,
        state,
      }),
    ).toThrow("does not own planning");
    expect(() =>
      bindPhasePrincipal({
        at: "2026-07-24T08:04:00.000Z",
        expectedRevision: state.revision,
        principal: {
          source: "trusted-platform-tool-context",
        } as Parameters<typeof bindPhasePrincipal>[0]["principal"],
        state,
      }),
    ).toThrow("UNTRUSTED_PRINCIPAL");
    const diff = one(harness.byType, "diff-manifest");
    expect(() =>
      recordPhaseArtifact({
        activeArtifacts: [...active, diff],
        artifact: diff,
        at: "2026-07-24T08:04:00.000Z",
        expectedRevision: state.revision,
        principal: PLANNER,
        state,
      }),
    ).toThrow("cannot write diff-manifest");
  });

  test("rollback marks the old candidate and every dependent artifact stale", () => {
    const progressed = progressImportedToDelivering();
    const delivery = one(progressed.harness.byType, "delivery");
    progressed.active.push(delivery);
    const deliveringState = recordPhaseArtifact({
      activeArtifacts: progressed.active,
      artifact: delivery,
      at: "2026-07-24T08:16:00.000Z",
      expectedRevision: progressed.state.revision,
      principal: DELIVERY,
      state: progressed.state,
    });
    const rolledBack = returnWorkflowToPhase({
      at: "2026-07-24T08:17:00.000Z",
      expectedRevision: deliveringState.revision,
      principal: DELIVERY,
      reason: "Delivery found a candidate issue.",
      state: deliveringState,
      targetPhase: "building",
    });
    const staleTypes = new Set(rolledBack.stale_artifact_refs.map((ref) => ref.artifact_type));
    expect(rolledBack.phase).toBe("building");
    expect(staleTypes).toEqual(
      new Set([
        "diff-manifest",
        "patch-candidate",
        "verification-source",
        "verification-manifest",
        "verification-authorization",
        "criterion-evidence",
        "patch-review",
        "delivery",
      ]),
    );
    expect(rolledBack.artifact_refs.some((ref) => ref.artifact_type === "patch-candidate")).toBe(
      false,
    );

    const rebound = bindPhasePrincipal({
      activeArtifacts: rolledBack.artifact_refs.map((ref) => {
        const artifact = progressed.active.find(
          (candidate) => candidate.artifact_digest === ref.digest,
        );
        if (artifact === undefined) {
          throw new TypeError("Missing active rollback artifact");
        }
        return artifact;
      }),
      at: "2026-07-24T08:18:00.000Z",
      expectedRevision: rolledBack.revision,
      principal: BUILDER,
      state: rolledBack,
    });
    expect(() =>
      transitionWorkflow({
        activeArtifacts: progressed.active,
        at: "2026-07-24T08:19:00.000Z",
        expectedRevision: rebound.revision,
        principal: BUILDER,
        state: rebound,
        targetPhase: "verifying",
      }),
    ).toThrow("Stale");
  });

  test("blocked remediation is explicit and stop gate applies only to bound sessions", () => {
    const harness = importedHarness();
    let state = bindPhasePrincipal({
      at: "2026-07-24T08:01:00.000Z",
      expectedRevision: harness.state.revision,
      principal: PLANNER,
      state: harness.state,
    });
    expect(evaluateStopGate({ principal: COORDINATOR, state })).toMatchObject({
      allowStop: false,
      applies: true,
      phase: "planning",
    });
    expect(
      evaluateStopGate({
        principal: issueTrustedPrincipal({
          agentId: "ys-craft-patch-reviewer",
          sessionId: "session:UNRELATED1234567",
        }),
        state,
      }),
    ).toEqual({
      allowStop: true,
      applies: false,
      reason: "unrelated-session",
    });
    state = blockWorkflow({
      at: "2026-07-24T08:02:00.000Z",
      expectedRevision: state.revision,
      principal: PLANNER,
      reason: "Repository preparation requires remediation.",
      remediationPhase: "planning",
      state,
    });
    expect(evaluateStopGate({ principal: COORDINATOR, state })).toMatchObject({
      allowStop: true,
      applies: true,
      reason: "blocked",
    });
    expect(() =>
      remediateBlockedWorkflow({
        at: "2026-07-24T08:03:00.000Z",
        expectedRevision: state.revision,
        principal: PLANNER,
        state,
      }),
    ).toThrow("bound workflow coordinator");
    state = remediateBlockedWorkflow({
      at: "2026-07-24T08:03:00.000Z",
      expectedRevision: state.revision,
      principal: COORDINATOR,
      state,
    });
    expect(state).toMatchObject({
      blocked_context: null,
      phase: "planning",
      phase_principal: null,
      status: "active",
    });
  });

  test("enforces independent reviewer sessions", () => {
    const progressed = progressImportedToDelivering();
    const reviewing = returnWorkflowToPhase({
      at: "2026-07-24T08:17:00.000Z",
      expectedRevision: progressed.state.revision,
      principal: DELIVERY,
      reason: "Repeat review with a fresh reviewer.",
      state: progressed.state,
      targetPhase: "reviewing",
    });
    expect(() =>
      bindPhasePrincipal({
        at: "2026-07-24T08:18:00.000Z",
        expectedRevision: reviewing.revision,
        principal: issueTrustedPrincipal({
          agentId: "ys-craft-patch-reviewer",
          sessionId: "session:BUILDER123456789",
        }),
        state: reviewing,
      }),
    ).toThrow();
  });

  test("authorizes only exact, immutable, read-only phase commands", () => {
    const harness = importedHarness();
    const active = initialImportedArtifacts(harness);
    let state = bindPhasePrincipal({
      at: "2026-07-24T08:01:00.000Z",
      expectedRevision: harness.state.revision,
      principal: PLANNER,
      state: harness.state,
    });
    for (const artifactType of [
      "patch-plan",
      "mutation-authorization",
      "phase-command-manifest",
      "phase-command-authorization",
    ] as const) {
      const artifact = one(harness.byType, artifactType);
      state = appendArtifact(state, active, artifact, PLANNER, artifact.created_at);
    }
    const manifest = one(harness.byType, "phase-command-manifest");
    const authorization = one(harness.byType, "phase-command-authorization");
    const execution = authorizePhaseCommandExecution({
      activeArtifacts: active,
      authorization,
      commandId: "command:PHASE12345678901",
      manifest,
      principal: PLANNER,
      repositoryBinding: harness.binding,
      state,
    });
    expect(execution).toEqual({
      argv: ["bun", "test"],
      commandId: "command:PHASE12345678901",
      cwdRealpath: "/workspace/project/tests",
      environmentAllowlist: ["CI"],
      outputRootRealpath: "/workspace/output",
      targetAccess: "read-only",
      targetWorktreeRealpath: "/workspace/project",
      timeoutSeconds: 300,
    });
    expect(() =>
      authorizePhaseCommandExecution({
        activeArtifacts: active,
        authorization,
        commandId: "command:UNKNOWN123456789",
        manifest,
        principal: PLANNER,
        repositoryBinding: harness.binding,
        state,
      }),
    ).toThrow("Command identity");
  });
});
