import { canonicalizeJson, sealArtifact } from "../artifacts/canonical";
import type {
  CriterionEvidence,
  Delivery,
  DiffManifest,
  MutationAuthorization,
  PatchCandidate,
  PatchPlan,
  PatchReview,
  RepositoryBinding,
  ReviewFinding,
  RootCauseArtifact,
  VerificationManifest,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../artifacts/generated";
import {
  artifactRef,
  parseCraftContractBytes,
  validateCraftContractGraph,
} from "../artifacts/parser";
import type { JsonValue } from "../artifacts/strict-json";
import { type ReturnWorkflowInput, returnWorkflowToPhase } from "../state-machine/engine";
import {
  auditTrustedPrincipal,
  principalsEqual,
  type TrustedPrincipal,
} from "../state-machine/principal";
import type { CandidateDiffObserver } from "../verification/local-verification";

export interface PatchReviewProposal {
  readonly findings: readonly ReviewFinding[];
  readonly rootCauseEliminated: boolean;
  readonly verificationSufficient: boolean;
  readonly withinApprovedScope: boolean;
}

export interface PatchReviewResult {
  readonly outcome: "approved" | "changes_requested";
  readonly review: PatchReview;
}

export interface DeliveryProposal {
  readonly followUpSteps: readonly string[];
  readonly residualRisks: readonly string[];
  readonly summary: string;
}

export interface DeliveryResult {
  readonly delivery: Delivery;
  readonly observedDiffContentDigest: string;
}

export class ReviewDeliveryError extends Error {
  readonly code = "REVIEW_DELIVERY_INVALID";

  constructor(message: string) {
    super(`REVIEW_DELIVERY_INVALID: ${message}`);
    this.name = "ReviewDeliveryError";
  }
}

function fail(message: string): never {
  throw new ReviewDeliveryError(message);
}

function seal<T extends YuanshengCraftContractV1>(payload: Omit<T, "artifact_digest">): T {
  const sealed = sealArtifact(payload as unknown as Record<string, JsonValue>) as unknown as T;
  const parsed = parseCraftContractBytes(canonicalizeJson(sealed).bytes);
  if (parsed.artifact_type !== sealed.artifact_type) {
    return fail(`Review or delivery produced an invalid ${sealed.artifact_type}`);
  }
  return parsed as T;
}

function requireOne<T extends YuanshengCraftContractV1["artifact_type"]>(
  artifacts: readonly YuanshengCraftContractV1[],
  artifactType: T,
): Extract<YuanshengCraftContractV1, { artifact_type: T }> {
  const matches = artifacts.filter(
    (artifact): artifact is Extract<YuanshengCraftContractV1, { artifact_type: T }> =>
      artifact.artifact_type === artifactType,
  );
  if (matches.length !== 1) {
    return fail(`Active graph requires exactly one ${artifactType}`);
  }
  return matches[0] as Extract<YuanshengCraftContractV1, { artifact_type: T }>;
}

function assertExactActiveGraph(
  state: WorkflowState,
  artifacts: readonly YuanshengCraftContractV1[],
): void {
  validateCraftContractGraph(artifacts);
  const expected = new Set(state.artifact_refs.map((reference) => reference.digest));
  const actual = new Set(artifacts.map((artifact) => artifact.artifact_digest));
  if (expected.size !== actual.size || [...expected].some((digest) => !actual.has(digest))) {
    fail("Operation requires the exact active artifact graph");
  }
}

function assertPhasePrincipal(
  state: WorkflowState,
  principal: TrustedPrincipal,
  phase: "delivering" | "reviewing",
  agentId: "ys-craft-delivery-coordinator" | "ys-craft-patch-reviewer",
): ReturnType<typeof auditTrustedPrincipal> {
  const audit = auditTrustedPrincipal(principal);
  if (
    state.status !== "active" ||
    state.phase !== phase ||
    state.phase_principal === null ||
    audit.agent_id !== agentId ||
    !principalsEqual(state.phase_principal, audit)
  ) {
    return fail(`Trusted ${agentId} is not bound to ${phase}`);
  }
  return audit;
}

function reviewInputs(artifacts: readonly YuanshengCraftContractV1[]): {
  readonly candidate: PatchCandidate;
  readonly diff: DiffManifest;
  readonly evidence: readonly CriterionEvidence[];
  readonly manifest: VerificationManifest;
  readonly mutation: MutationAuthorization;
  readonly plan: PatchPlan;
  readonly rootCause: RootCauseArtifact;
} {
  const candidate = requireOne(artifacts, "patch-candidate") as PatchCandidate;
  const diff = requireOne(artifacts, "diff-manifest") as DiffManifest;
  const manifest = requireOne(artifacts, "verification-manifest") as VerificationManifest;
  const mutation = requireOne(artifacts, "mutation-authorization") as MutationAuthorization;
  const plan = requireOne(artifacts, "patch-plan") as PatchPlan;
  const rootCause = requireOne(artifacts, "root-cause") as RootCauseArtifact;
  if (
    candidate.diff_manifest_ref.digest !== diff.artifact_digest ||
    candidate.plan_ref.digest !== plan.artifact_digest ||
    diff.mutation_authorization_ref.digest !== mutation.artifact_digest ||
    manifest.candidate_ref.digest !== candidate.artifact_digest ||
    plan.root_cause_ref.digest !== rootCause.artifact_digest
  ) {
    return fail("Review inputs do not bind one candidate evidence chain");
  }
  const evidence = artifacts.filter(
    (artifact): artifact is CriterionEvidence =>
      artifact.artifact_type === "criterion-evidence" &&
      artifact.candidate_ref.digest === candidate.artifact_digest &&
      artifact.manifest_ref.digest === manifest.artifact_digest,
  );
  for (const criterion of rootCause.criteria.filter((item) => item.required)) {
    const matching = evidence.filter((item) => item.criterion_id === criterion.id);
    if (matching.length !== 1 || matching[0]?.status !== "pass") {
      return fail(`Review requires one passing evidence artifact for ${criterion.id}`);
    }
  }
  return { candidate, diff, evidence, manifest, mutation, plan, rootCause };
}

function evidenceRefs(
  evidence: readonly CriterionEvidence[],
): PatchReview["criterion_evidence_refs"] {
  const first = evidence[0];
  if (first === undefined) {
    return fail("Review requires at least one criterion evidence artifact");
  }
  return [artifactRef(first), ...evidence.slice(1).map(artifactRef)];
}

function nonEmptyStrings(values: readonly string[], label: string): [string, ...string[]] {
  const first = values[0];
  if (first === undefined) {
    return fail(`${label} must not be empty`);
  }
  return [first, ...values.slice(1)];
}

export async function reviewPatch(input: {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly at: string;
  readonly candidateObserver: CandidateDiffObserver;
  readonly principal: TrustedPrincipal;
  readonly proposal: PatchReviewProposal;
  readonly state: WorkflowState;
}): Promise<PatchReviewResult> {
  assertExactActiveGraph(input.state, input.activeArtifacts);
  const reviewer = assertPhasePrincipal(
    input.state,
    input.principal,
    "reviewing",
    "ys-craft-patch-reviewer",
  );
  const { candidate, diff, evidence, manifest, mutation, rootCause } = reviewInputs(
    input.activeArtifacts,
  );
  if (mutation.principal.session_id === reviewer.session_id) {
    return fail("Patch reviewer must use a session distinct from the actual builder");
  }
  const observedDiffContentDigest = await input.candidateObserver.observeDiffContentDigest();
  if (observedDiffContentDigest !== candidate.diff_content_digest) {
    return fail("Current local diff drifted from the candidate before review");
  }
  const hasBlockingFinding = input.proposal.findings.some(
    (finding) => finding.severity === "blocking",
  );
  const approved =
    input.proposal.rootCauseEliminated &&
    input.proposal.verificationSufficient &&
    input.proposal.withinApprovedScope &&
    !hasBlockingFinding;
  const review = seal<PatchReview>({
    artifact_type: "patch-review",
    artifact_version: 1,
    builder_session_id: mutation.principal.session_id,
    candidate_ref: artifactRef(candidate),
    created_at: input.at,
    criterion_evidence_refs: evidenceRefs(evidence),
    diff_content_digest: candidate.diff_content_digest,
    diff_manifest_ref: artifactRef(diff),
    findings: input.proposal.findings.map((finding) => ({ ...finding })),
    manifest_ref: artifactRef(manifest),
    reviewer,
    root_cause_eliminated: input.proposal.rootCauseEliminated,
    status: approved ? "pass" : "fail",
    unresolved_gap_ids: rootCause.gaps.map((gap) => gap.id),
    verification_sufficient: input.proposal.verificationSufficient,
    within_approved_scope: input.proposal.withinApprovedScope,
    workflow_id: input.state.workflow_id,
  });
  validateCraftContractGraph([...input.activeArtifacts, review]);
  return Object.freeze({
    outcome: approved ? "approved" : "changes_requested",
    review,
  });
}

export function requestPatchChanges(input: {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly at: string;
  readonly expectedRevision: number;
  readonly principal: TrustedPrincipal;
  readonly reason: string;
  readonly review: PatchReview;
  readonly state: WorkflowState;
  readonly targetPhase: "building" | "planning";
}): WorkflowState {
  assertExactActiveGraph(input.state, input.activeArtifacts);
  assertPhasePrincipal(input.state, input.principal, "reviewing", "ys-craft-patch-reviewer");
  if (
    input.review.status !== "fail" ||
    !input.state.artifact_refs.some(
      (reference) => reference.digest === input.review.artifact_digest,
    )
  ) {
    return fail("Only the active failed review may request patch changes");
  }
  const rollback: ReturnWorkflowInput = {
    at: input.at,
    expectedRevision: input.expectedRevision,
    principal: input.principal,
    reason: input.reason,
    state: input.state,
    targetPhase: input.targetPhase,
  };
  return returnWorkflowToPhase(rollback);
}

export async function prepareDelivery(input: {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly at: string;
  readonly candidateObserver: CandidateDiffObserver;
  readonly principal: TrustedPrincipal;
  readonly proposal: DeliveryProposal;
  readonly state: WorkflowState;
}): Promise<DeliveryResult> {
  assertExactActiveGraph(input.state, input.activeArtifacts);
  assertPhasePrincipal(input.state, input.principal, "delivering", "ys-craft-delivery-coordinator");
  const binding = requireOne(input.activeArtifacts, "repository-binding") as RepositoryBinding;
  const review = requireOne(input.activeArtifacts, "patch-review") as PatchReview;
  if (review.status !== "pass") {
    return fail("Delivery requires the active passing independent review");
  }
  const { candidate, diff, evidence, manifest, plan, rootCause } = reviewInputs(
    input.activeArtifacts,
  );
  if (
    review.candidate_ref.digest !== candidate.artifact_digest ||
    review.diff_manifest_ref.digest !== diff.artifact_digest ||
    review.manifest_ref.digest !== manifest.artifact_digest ||
    manifest.repository_binding_ref.digest !== binding.artifact_digest
  ) {
    return fail("Delivery inputs differ from the independently reviewed candidate");
  }
  const reviewedEvidence = new Set(
    review.criterion_evidence_refs.map((reference) => reference.digest),
  );
  if (
    evidence.length !== reviewedEvidence.size ||
    evidence.some((item) => !reviewedEvidence.has(item.artifact_digest))
  ) {
    return fail("Delivery evidence differs from the independently reviewed evidence");
  }
  const observedDiffContentDigest = await input.candidateObserver.observeDiffContentDigest();
  if (observedDiffContentDigest !== candidate.diff_content_digest) {
    return fail("Current local diff drifted from the independently reviewed candidate");
  }
  const reviewedEvidenceRefs = evidenceRefs(evidence);
  const delivery = seal<Delivery>({
    artifact_type: "delivery",
    artifact_version: 1,
    candidate_ref: artifactRef(candidate),
    changed_paths: nonEmptyStrings(
      diff.entries.map((entry) => entry.path),
      "Delivery changed paths",
    ),
    created_at: input.at,
    criterion_evidence_refs: reviewedEvidenceRefs,
    delivery_patch_digest: candidate.diff_content_digest,
    diff_manifest_ref: artifactRef(diff),
    follow_up_steps: [...input.proposal.followUpSteps],
    human_criterion_ids: evidence
      .filter((item) => item.evidence_kind === "human")
      .map((item) => item.criterion_id),
    manifest_ref: artifactRef(manifest),
    patch_review_ref: artifactRef(review),
    plan_ref: artifactRef(plan),
    residual_risks: [...input.proposal.residualRisks],
    root_cause_ref: artifactRef(rootCause),
    status: "complete",
    summary: input.proposal.summary,
    verified_criterion_ids: nonEmptyStrings(
      evidence.map((item) => item.criterion_id),
      "Delivery verified criteria",
    ),
    workflow_id: input.state.workflow_id,
  });
  validateCraftContractGraph([...input.activeArtifacts, delivery]);
  return Object.freeze({ delivery, observedDiffContentDigest });
}
