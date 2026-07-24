import { describe, expect, test } from "bun:test";

import { canonicalizeJson, sealArtifact } from "../../plugins/craft/workflows/artifacts/canonical";
import type {
  ArtifactType,
  PatchReview,
  PrincipalAudit,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../../plugins/craft/workflows/artifacts/generated";
import {
  artifactRef,
  parseCraftContractBytes,
  validateCraftContractGraph,
} from "../../plugins/craft/workflows/artifacts/parser";
import type { JsonValue } from "../../plugins/craft/workflows/artifacts/strict-json";
import {
  prepareDelivery,
  requestPatchChanges,
  reviewPatch,
} from "../../plugins/craft/workflows/review-delivery/review-delivery";
import { issueTrustedPrincipal } from "../../plugins/craft/workflows/state-machine/principal";
import { makeCompleteContractGraph } from "./contract-fixtures";

const REVIEWER_AUDIT = {
  agent_id: "ys-craft-patch-reviewer",
  session_id: "session:REVIEWER12345678",
} as const;
const DELIVERY_AUDIT = {
  agent_id: "ys-craft-delivery-coordinator",
  session_id: "session:DELIVERY12345678",
} as const;
const REVIEWER = issueTrustedPrincipal({
  agentId: REVIEWER_AUDIT.agent_id,
  sessionId: REVIEWER_AUDIT.session_id,
});
const DELIVERY = issueTrustedPrincipal({
  agentId: DELIVERY_AUDIT.agent_id,
  sessionId: DELIVERY_AUDIT.session_id,
});
const BUILDER_SESSION_REVIEWER = issueTrustedPrincipal({
  agentId: "ys-craft-patch-reviewer",
  sessionId: "session:BUILDER123456789",
});

function one<T extends ArtifactType>(
  artifacts: readonly YuanshengCraftContractV1[],
  artifactType: T,
): Extract<YuanshengCraftContractV1, { artifact_type: T }> {
  const matches = artifacts.filter(
    (artifact): artifact is Extract<YuanshengCraftContractV1, { artifact_type: T }> =>
      artifact.artifact_type === artifactType,
  );
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new TypeError(`Fixture requires exactly one ${artifactType}`);
  }
  return matches[0];
}

function sealState(input: {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly phase: "delivering" | "reviewing";
  readonly phasePrincipal: PrincipalAudit;
  readonly template: WorkflowState;
}): WorkflowState {
  const { artifact_digest: _digest, ...payload } = input.template;
  const audit = new Map(
    [payload.coordinator, input.phasePrincipal].map((principal) => [
      principal.session_id,
      principal,
    ]),
  );
  const sealed = sealArtifact({
    ...payload,
    artifact_refs: input.activeArtifacts.map(artifactRef),
    completed_at: null,
    phase: input.phase,
    phase_principal: input.phasePrincipal,
    principal_audit: [...audit.values()],
    revision: 20,
    stale_artifact_refs: [],
    status: "active",
    updated_at: "2026-07-24T12:00:00.000Z",
  } as unknown as Record<string, JsonValue>) as unknown as WorkflowState;
  const parsed = parseCraftContractBytes(canonicalizeJson(sealed).bytes);
  if (parsed.artifact_type !== "workflow-state") {
    throw new TypeError("Fixture did not produce workflow state");
  }
  return parsed;
}

function resealReview(
  review: PatchReview,
  overrides: Partial<Omit<PatchReview, "artifact_digest" | "artifact_type" | "artifact_version">>,
): PatchReview {
  const { artifact_digest: _digest, ...payload } = review;
  return sealArtifact({
    ...payload,
    ...overrides,
  } as unknown as Record<string, JsonValue>) as unknown as PatchReview;
}

function reviewHarness(principal: PrincipalAudit = REVIEWER_AUDIT): {
  readonly active: readonly YuanshengCraftContractV1[];
  readonly candidateDigest: string;
  readonly state: WorkflowState;
  readonly template: WorkflowState;
} {
  const graph = makeCompleteContractGraph();
  const template = one(graph.artifacts, "workflow-state");
  const active = graph.artifacts.filter(
    (artifact) =>
      artifact.artifact_type !== "workflow-state" &&
      artifact.artifact_type !== "action-journal" &&
      artifact.artifact_type !== "patch-review" &&
      artifact.artifact_type !== "delivery" &&
      artifact.artifact_type !== "phase-command-manifest" &&
      artifact.artifact_type !== "phase-command-authorization" &&
      !(artifact.artifact_type === "patch-candidate" && artifact.candidate_revision === 2),
  );
  return {
    active,
    candidateDigest: one(active, "patch-candidate").diff_content_digest,
    state: sealState({
      activeArtifacts: active,
      phase: "reviewing",
      phasePrincipal: principal,
      template,
    }),
    template,
  };
}

async function approvedReview() {
  const harness = reviewHarness();
  const result = await reviewPatch({
    activeArtifacts: harness.active,
    at: "2026-07-24T12:01:00.000Z",
    candidateObserver: {
      async observeDiffContentDigest() {
        return harness.candidateDigest;
      },
    },
    principal: REVIEWER,
    proposal: {
      findings: [],
      rootCauseEliminated: true,
      verificationSufficient: true,
      withinApprovedScope: true,
    },
    state: harness.state,
  });
  return { harness, result };
}

describe("Yuansheng Craft independent review and delivery", () => {
  test("seals a complete review binding from a distinct trusted session", async () => {
    const { harness, result } = await approvedReview();
    expect(result.outcome).toBe("approved");
    expect(result.review).toMatchObject({
      builder_session_id: "session:BUILDER123456789",
      diff_content_digest: harness.candidateDigest,
      reviewer: {
        agent_id: "ys-craft-patch-reviewer",
        session_id: "session:REVIEWER12345678",
      },
      status: "pass",
      unresolved_gap_ids: ["gap:LOGGING123456789"],
    });
    expect(result.review.manifest_ref.artifact_type).toBe("verification-manifest");
    expect(result.review.diff_manifest_ref.artifact_type).toBe("diff-manifest");
    expect(result.review.criterion_evidence_refs).toHaveLength(1);
  });

  test("rejects same-session review, missing evidence, candidate drift, and tampering", async () => {
    const sameSession = reviewHarness({
      agent_id: "ys-craft-patch-reviewer",
      session_id: "session:BUILDER123456789",
    });
    await expect(
      reviewPatch({
        activeArtifacts: sameSession.active,
        at: "2026-07-24T12:01:00.000Z",
        candidateObserver: {
          async observeDiffContentDigest() {
            return sameSession.candidateDigest;
          },
        },
        principal: BUILDER_SESSION_REVIEWER,
        proposal: {
          findings: [],
          rootCauseEliminated: true,
          verificationSufficient: true,
          withinApprovedScope: true,
        },
        state: sameSession.state,
      }),
    ).rejects.toThrow("distinct from the actual builder");

    const missing = reviewHarness();
    const withoutEvidence = missing.active.filter(
      (artifact) => artifact.artifact_type !== "criterion-evidence",
    );
    const missingState = sealState({
      activeArtifacts: withoutEvidence,
      phase: "reviewing",
      phasePrincipal: REVIEWER_AUDIT,
      template: missing.template,
    });
    await expect(
      reviewPatch({
        activeArtifacts: withoutEvidence,
        at: "2026-07-24T12:01:00.000Z",
        candidateObserver: {
          async observeDiffContentDigest() {
            return missing.candidateDigest;
          },
        },
        principal: REVIEWER,
        proposal: {
          findings: [],
          rootCauseEliminated: true,
          verificationSufficient: true,
          withinApprovedScope: true,
        },
        state: missingState,
      }),
    ).rejects.toThrow("requires one passing evidence");

    const drifted = reviewHarness();
    await expect(
      reviewPatch({
        activeArtifacts: drifted.active,
        at: "2026-07-24T12:01:00.000Z",
        candidateObserver: {
          async observeDiffContentDigest() {
            return "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
          },
        },
        principal: REVIEWER,
        proposal: {
          findings: [],
          rootCauseEliminated: true,
          verificationSufficient: true,
          withinApprovedScope: true,
        },
        state: drifted.state,
      }),
    ).rejects.toThrow("drifted");

    const approved = await approvedReview();
    const tampered = resealReview(approved.result.review, {
      builder_session_id: "session:OTHERBUILDER0001",
    });
    expect(() => validateCraftContractGraph([...approved.harness.active, tampered])).toThrow(
      "distinct real session",
    );
  });

  test("a failed review explicitly returns to planning or building and stales dependents", async () => {
    const harness = reviewHarness();
    const result = await reviewPatch({
      activeArtifacts: harness.active,
      at: "2026-07-24T12:01:00.000Z",
      candidateObserver: {
        async observeDiffContentDigest() {
          return harness.candidateDigest;
        },
      },
      principal: REVIEWER,
      proposal: {
        findings: [
          {
            finding_id: "finding:REWORK1234567890",
            severity: "blocking",
            summary: "The implementation needs a smaller mutation.",
          },
        ],
        rootCauseEliminated: false,
        verificationSufficient: true,
        withinApprovedScope: true,
      },
      state: harness.state,
    });
    expect(result.outcome).toBe("changes_requested");
    const activeWithReview = [...harness.active, result.review];
    const reviewingState = sealState({
      activeArtifacts: activeWithReview,
      phase: "reviewing",
      phasePrincipal: REVIEWER_AUDIT,
      template: harness.template,
    });
    const returned = requestPatchChanges({
      activeArtifacts: activeWithReview,
      at: "2026-07-24T12:02:00.000Z",
      expectedRevision: reviewingState.revision,
      principal: REVIEWER,
      reason: "Apply the blocking independent-review finding.",
      review: result.review,
      state: reviewingState,
      targetPhase: "building",
    });
    expect(returned.phase).toBe("building");
    expect(
      new Set(returned.stale_artifact_refs.map((reference) => reference.artifact_type)),
    ).toEqual(
      new Set([
        "criterion-evidence",
        "diff-manifest",
        "patch-candidate",
        "patch-review",
        "verification-authorization",
        "verification-manifest",
        "verification-source",
      ]),
    );
  });

  test("delivery rechecks the local diff and preserves reviewed files and evidence", async () => {
    const approved = await approvedReview();
    const active = [...approved.harness.active, approved.result.review];
    const state = sealState({
      activeArtifacts: active,
      phase: "delivering",
      phasePrincipal: DELIVERY_AUDIT,
      template: approved.harness.template,
    });
    const result = await prepareDelivery({
      activeArtifacts: active,
      at: "2026-07-24T12:03:00.000Z",
      candidateObserver: {
        async observeDiffContentDigest() {
          return approved.harness.candidateDigest;
        },
      },
      principal: DELIVERY,
      proposal: {
        followUpSteps: ["Run the documented manual OpenCode acceptance later."],
        residualRisks: [],
        summary: "The independently reviewed candidate is ready for delivery.",
      },
      state,
    });
    expect(result.delivery).toMatchObject({
      changed_paths: ["src/normalize.ts"],
      delivery_patch_digest: approved.harness.candidateDigest,
      human_criterion_ids: [],
      status: "complete",
      verified_criterion_ids: ["criterion:PRESERVE12345678"],
    });

    await expect(
      prepareDelivery({
        activeArtifacts: active,
        at: "2026-07-24T12:04:00.000Z",
        candidateObserver: {
          async observeDiffContentDigest() {
            return "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
          },
        },
        principal: DELIVERY,
        proposal: {
          followUpSteps: [],
          residualRisks: [],
          summary: "This must not be delivered.",
        },
        state,
      }),
    ).rejects.toThrow("drifted");
  });
});
