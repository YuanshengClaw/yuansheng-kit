import { canonicalizeJson, sealArtifact } from "../artifacts/canonical";
import type {
  ArtifactRef,
  ArtifactType,
  PrincipalAudit,
  RepositoryBinding,
  RootCauseArtifact,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../artifacts/generated";
import {
  artifactRef,
  parseCraftContractBytes,
  validateCraftContractGraph,
} from "../artifacts/parser";
import type { JsonValue } from "../artifacts/strict-json";
import type { BlueprintImportTransaction } from "../blueprint-import/transaction";
import {
  type ActiveWorkflowPhase,
  canRemediateTo,
  FORWARD_TRANSITION,
  isActiveWorkflowPhase,
  isEarlierPhase,
  PHASE_OWNED_ARTIFACTS,
  PHASE_OWNER,
  type RemediationPhase,
  type WorkflowPhase,
} from "./phases";
import { auditTrustedPrincipal, principalsEqual, type TrustedPrincipal } from "./principal";

export type WorkflowGuardCode =
  | "ARTIFACT_CHAIN_INVALID"
  | "ARTIFACT_OWNERSHIP_INVALID"
  | "ENTRY_INVALID"
  | "INVALID_TRANSITION"
  | "REVISION_CONFLICT"
  | "SESSION_BINDING_INVALID"
  | "SESSION_INDEPENDENCE_INVALID"
  | "TERMINAL_WORKFLOW"
  | "VERIFICATION_GATE_INVALID";

export class WorkflowGuardError extends Error {
  constructor(
    readonly code: WorkflowGuardCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "WorkflowGuardError";
  }
}

interface StateUpdateInput {
  readonly at: string;
  readonly expectedRevision: number;
  readonly principal: TrustedPrincipal;
  readonly state: WorkflowState;
}

export interface CreateProblemWorkflowInput {
  readonly at: string;
  readonly coordinator: TrustedPrincipal;
  readonly problem: string;
  readonly repositoryBinding: RepositoryBinding;
  readonly workflowId: string;
}

export interface CreateBlueprintWorkflowInput {
  readonly at: string;
  readonly coordinator: TrustedPrincipal;
  readonly repositoryBinding: RepositoryBinding;
  readonly transaction: BlueprintImportTransaction;
  readonly workflowId: string;
}

export interface TransitionWorkflowInput extends StateUpdateInput {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly targetPhase: WorkflowPhase;
}

export interface BlockWorkflowInput extends StateUpdateInput {
  readonly reason: string;
  readonly remediationPhase: RemediationPhase;
}

export interface RecordPhaseArtifactInput extends StateUpdateInput {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly artifact: YuanshengCraftContractV1;
}

export interface ReturnWorkflowInput extends StateUpdateInput {
  readonly reason: string;
  readonly targetPhase: ActiveWorkflowPhase;
}

type RollbackPhase = RemediationPhase | "reviewing";

function fail(code: WorkflowGuardCode, message: string): never {
  throw new WorkflowGuardError(code, message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRollbackPhase(phase: ActiveWorkflowPhase): phase is RollbackPhase {
  return (
    phase === "root_cause" ||
    phase === "planning" ||
    phase === "building" ||
    phase === "verifying" ||
    phase === "reviewing"
  );
}

function sealState(payload: Omit<WorkflowState, "artifact_digest">): WorkflowState {
  const sealed = sealArtifact(
    payload as unknown as Record<string, JsonValue>,
  ) as unknown as WorkflowState;
  const parsed = parseCraftContractBytes(canonicalizeJson(sealed).bytes);
  if (parsed.artifact_type !== "workflow-state") {
    return fail("ARTIFACT_CHAIN_INVALID", "State payload did not produce a workflow state");
  }
  return parsed;
}

function assertState(state: WorkflowState): void {
  const parsed = parseCraftContractBytes(canonicalizeJson(state).bytes);
  if (
    parsed.artifact_type !== "workflow-state" ||
    parsed.artifact_digest !== state.artifact_digest
  ) {
    fail("ARTIFACT_CHAIN_INVALID", "Workflow state is not a valid immutable contract");
  }
}

function assertRepositoryBinding(binding: RepositoryBinding): void {
  const parsed = parseCraftContractBytes(canonicalizeJson(binding).bytes);
  if (parsed.artifact_type !== "repository-binding") {
    fail("ENTRY_INVALID", "Workflow entry requires a valid repository binding");
  }
}

function assertCoordinator(principal: TrustedPrincipal): PrincipalAudit {
  const audit = auditTrustedPrincipal(principal);
  if (audit.agent_id !== "ys-craft") {
    return fail("SESSION_BINDING_INVALID", "Workflow coordinator must be ys-craft");
  }
  return audit;
}

function assertRevision(state: WorkflowState, expectedRevision: number, at: string): void {
  assertState(state);
  if (state.revision !== expectedRevision) {
    fail("REVISION_CONFLICT", `Expected revision ${expectedRevision}, found ${state.revision}`);
  }
  if (!Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(state.updated_at)) {
    fail("REVISION_CONFLICT", "State update time must be valid and monotonic");
  }
}

function appendAudit(
  principals: WorkflowState["principal_audit"],
  principal: PrincipalAudit,
): WorkflowState["principal_audit"] {
  const existing = principals.find((candidate) => candidate.session_id === principal.session_id);
  if (existing !== undefined) {
    if (!principalsEqual(existing, principal)) {
      return fail(
        "SESSION_BINDING_INVALID",
        "One real session cannot claim multiple Yuansheng Craft roles",
      );
    }
    return [...principals];
  }
  return [principals[0], ...principals.slice(1), principal];
}

function assertBoundPhasePrincipal(
  state: WorkflowState,
  principal: TrustedPrincipal,
): PrincipalAudit {
  const audit = auditTrustedPrincipal(principal);
  if (state.phase_principal === null || !principalsEqual(state.phase_principal, audit)) {
    return fail(
      "SESSION_BINDING_INVALID",
      "Operation principal is not the trusted principal bound to this phase",
    );
  }
  return audit;
}

function sortedRefs(contracts: readonly YuanshengCraftContractV1[]): ArtifactRef[] {
  return contracts.map(artifactRef).sort((left, right) => {
    const byType = compareText(left.artifact_type, right.artifact_type);
    return byType !== 0 ? byType : compareText(left.digest, right.digest);
  });
}

function indexActiveArtifacts(
  state: WorkflowState,
  contracts: readonly YuanshengCraftContractV1[],
): ReadonlyMap<string, YuanshengCraftContractV1> {
  if (
    contracts.some(
      (contract) =>
        contract.artifact_type === "workflow-state" || contract.artifact_type === "action-journal",
    )
  ) {
    return fail(
      "ARTIFACT_CHAIN_INVALID",
      "Active phase graph cannot contain mutable state or journal contracts",
    );
  }
  let index: ReadonlyMap<string, YuanshengCraftContractV1>;
  try {
    index = validateCraftContractGraph(contracts);
  } catch (error) {
    return fail(
      "ARTIFACT_CHAIN_INVALID",
      error instanceof Error ? error.message : "Active artifact graph is invalid",
    );
  }
  const stale = new Set(state.stale_artifact_refs.map((ref) => ref.digest));
  for (const ref of state.artifact_refs) {
    if (!index.has(ref.digest)) {
      return fail("ARTIFACT_CHAIN_INVALID", `Active artifact graph omitted ${ref.artifact_type}`);
    }
  }
  for (const contract of contracts) {
    if (stale.has(contract.artifact_digest)) {
      return fail(
        "ARTIFACT_CHAIN_INVALID",
        `Stale ${contract.artifact_type} cannot become active again`,
      );
    }
  }
  return index;
}

function assertExactActiveSet(
  state: WorkflowState,
  contracts: readonly YuanshengCraftContractV1[],
): void {
  const stateDigests = new Set(state.artifact_refs.map((ref) => ref.digest));
  const contractDigests = new Set(contracts.map((contract) => contract.artifact_digest));
  if (
    stateDigests.size !== contractDigests.size ||
    [...stateDigests].some((digest) => !contractDigests.has(digest))
  ) {
    fail(
      "ARTIFACT_CHAIN_INVALID",
      "Transition artifact graph differs from the recorded active state",
    );
  }
}

function contractsOfType<T extends ArtifactType>(
  index: ReadonlyMap<string, YuanshengCraftContractV1>,
  artifactType: T,
): Extract<YuanshengCraftContractV1, { artifact_type: T }>[] {
  return [...index.values()].filter(
    (contract): contract is Extract<YuanshengCraftContractV1, { artifact_type: T }> =>
      contract.artifact_type === artifactType,
  );
}

function requireOne<T extends ArtifactType>(
  index: ReadonlyMap<string, YuanshengCraftContractV1>,
  artifactType: T,
): Extract<YuanshengCraftContractV1, { artifact_type: T }> {
  const matches = contractsOfType(index, artifactType);
  if (matches.length !== 1) {
    return fail(
      "ARTIFACT_CHAIN_INVALID",
      `Active graph requires exactly one ${artifactType}, found ${matches.length}`,
    );
  }
  const match = matches[0];
  if (match === undefined) {
    return fail("ARTIFACT_CHAIN_INVALID", `Missing ${artifactType}`);
  }
  return match;
}

function validateForwardGate(
  state: WorkflowState,
  targetPhase: WorkflowPhase,
  principal: PrincipalAudit,
  index: ReadonlyMap<string, YuanshengCraftContractV1>,
): void {
  if (state.phase === "root_cause" && targetPhase === "planning") {
    const rootCause = requireOne(index, "root-cause");
    if (
      state.entry_strategy !== "problem-description" ||
      rootCause.entry_strategy !== "problem-description" ||
      rootCause.status !== "confirmed"
    ) {
      fail("ENTRY_INVALID", "Problem entry requires its own confirmed root cause before planning");
    }
    return;
  }
  if (state.phase === "planning" && targetPhase === "building") {
    requireOne(index, "root-cause");
    requireOne(index, "patch-plan");
    requireOne(index, "mutation-authorization");
    return;
  }
  if (state.phase === "building" && targetPhase === "verifying") {
    requireOne(index, "patch-plan");
    requireOne(index, "mutation-authorization");
    requireOne(index, "diff-manifest");
    requireOne(index, "patch-candidate");
    return;
  }
  if (state.phase === "verifying" && targetPhase === "reviewing") {
    const rootCause = requireOne(index, "root-cause");
    const candidate = requireOne(index, "patch-candidate");
    const manifest = requireOne(index, "verification-manifest");
    const authorization = requireOne(index, "verification-authorization");
    if (
      authorization.action !== "allow" ||
      authorization.candidate_ref.digest !== candidate.artifact_digest ||
      authorization.manifest_ref.digest !== manifest.artifact_digest
    ) {
      fail(
        "VERIFICATION_GATE_INVALID",
        "Verification authorization does not allow the active candidate manifest",
      );
    }
    const evidence = contractsOfType(index, "criterion-evidence").filter(
      (item) =>
        item.candidate_ref.digest === candidate.artifact_digest &&
        item.manifest_ref.digest === manifest.artifact_digest,
    );
    for (const criterion of rootCause.criteria.filter((item) => item.required)) {
      const matching = evidence.filter((item) => item.criterion_id === criterion.id);
      if (matching.length !== 1 || matching[0]?.status !== "pass") {
        fail(
          "VERIFICATION_GATE_INVALID",
          `Required criterion is not uniquely passing: ${criterion.id}`,
        );
      }
    }
    return;
  }
  if (state.phase === "reviewing" && targetPhase === "delivering") {
    const review = requireOne(index, "patch-review");
    if (review.status !== "pass" || !principalsEqual(review.reviewer, principal)) {
      fail(
        "ARTIFACT_CHAIN_INVALID",
        "Delivering requires the passing review authored by the bound reviewer",
      );
    }
    return;
  }
  if (state.phase === "delivering" && targetPhase === "completed") {
    requireOne(index, "delivery");
    return;
  }
  fail("INVALID_TRANSITION", `No forward gate exists for ${state.phase} -> ${targetPhase}`);
}

function nextActiveState(
  state: WorkflowState,
  input: {
    readonly activeRefs: readonly ArtifactRef[];
    readonly at: string;
    readonly phase: ActiveWorkflowPhase;
    readonly principalAudit: WorkflowState["principal_audit"];
    readonly staleRefs?: readonly ArtifactRef[];
  },
): WorkflowState {
  return sealState({
    artifact_refs: [...input.activeRefs],
    artifact_type: "workflow-state",
    artifact_version: 1,
    blocked_context: null,
    completed_at: null,
    coordinator: state.coordinator,
    created_at: state.created_at,
    entry_context: state.entry_context,
    entry_strategy: state.entry_strategy,
    phase: input.phase,
    phase_principal: null,
    principal_audit: [...input.principalAudit] as WorkflowState["principal_audit"],
    revision: state.revision + 1,
    stale_artifact_refs: [...(input.staleRefs ?? state.stale_artifact_refs)],
    status: "active",
    updated_at: input.at,
    workflow_id: state.workflow_id,
  });
}

export function createProblemWorkflowState(input: CreateProblemWorkflowInput): WorkflowState {
  const coordinator = assertCoordinator(input.coordinator);
  assertRepositoryBinding(input.repositoryBinding);
  if (input.problem.trim().length === 0) {
    return fail("ENTRY_INVALID", "Problem description must contain non-whitespace text");
  }
  const bindingRef = artifactRef(input.repositoryBinding);
  const state = sealState({
    artifact_refs: [bindingRef],
    artifact_type: "workflow-state",
    artifact_version: 1,
    blocked_context: null,
    completed_at: null,
    coordinator,
    created_at: input.at,
    entry_context: {
      problem: input.problem,
      repository_binding_ref: bindingRef,
      strategy: "problem-description",
    },
    entry_strategy: "problem-description",
    phase: "root_cause",
    phase_principal: null,
    principal_audit: [coordinator],
    revision: 0,
    stale_artifact_refs: [],
    status: "active",
    updated_at: input.at,
    workflow_id: input.workflowId,
  });
  validateCraftContractGraph([input.repositoryBinding, state]);
  return state;
}

export function createBlueprintWorkflowState(input: CreateBlueprintWorkflowInput): WorkflowState {
  const coordinator = assertCoordinator(input.coordinator);
  assertRepositoryBinding(input.repositoryBinding);
  const { attestation, reviewSubject, rootCauseArtifact } = input.transaction;
  if (
    input.transaction.repositoryBindingRef.digest !== input.repositoryBinding.artifact_digest ||
    attestation.action !== "allow" ||
    rootCauseArtifact.workflow_id !== input.workflowId
  ) {
    return fail(
      "ENTRY_INVALID",
      "Blueprint transaction does not bind the requested workflow and repository",
    );
  }
  const contracts = [input.repositoryBinding, ...input.transaction.contracts] as const;
  try {
    validateCraftContractGraph(contracts);
  } catch (error) {
    return fail(
      "ENTRY_INVALID",
      error instanceof Error ? error.message : "Blueprint transaction is invalid",
    );
  }
  const state = sealState({
    artifact_refs: sortedRefs(contracts),
    artifact_type: "workflow-state",
    artifact_version: 1,
    blocked_context: null,
    completed_at: null,
    coordinator,
    created_at: input.at,
    entry_context: {
      attestation_ref: artifactRef(attestation),
      repository_binding_ref: artifactRef(input.repositoryBinding),
      review_subject_ref: artifactRef(reviewSubject),
      root_cause_ref: artifactRef(rootCauseArtifact),
      strategy: "root-cause-import",
    },
    entry_strategy: "root-cause-import",
    phase: "planning",
    phase_principal: null,
    principal_audit: [coordinator],
    revision: 0,
    stale_artifact_refs: [],
    status: "active",
    updated_at: input.at,
    workflow_id: input.workflowId,
  });
  validateCraftContractGraph([...contracts, state]);
  return state;
}

export function bindPhasePrincipal(
  input: StateUpdateInput & {
    readonly activeArtifacts?: readonly YuanshengCraftContractV1[];
  },
): WorkflowState {
  assertRevision(input.state, input.expectedRevision, input.at);
  if (!isActiveWorkflowPhase(input.state.phase)) {
    return fail("TERMINAL_WORKFLOW", "Terminal workflow cannot bind a phase principal");
  }
  const principal = auditTrustedPrincipal(input.principal);
  if (principal.agent_id !== PHASE_OWNER[input.state.phase]) {
    return fail(
      "ARTIFACT_OWNERSHIP_INVALID",
      `${principal.agent_id} does not own ${input.state.phase}`,
    );
  }
  if (
    input.state.phase_principal !== null &&
    !principalsEqual(input.state.phase_principal, principal)
  ) {
    return fail("SESSION_BINDING_INVALID", "Phase is already bound to a different real principal");
  }
  if (input.state.phase === "building") {
    if (input.activeArtifacts === undefined) {
      return fail(
        "ARTIFACT_CHAIN_INVALID",
        "Building binding requires the active mutation authorization",
      );
    }
    const index = indexActiveArtifacts(input.state, input.activeArtifacts);
    assertExactActiveSet(input.state, input.activeArtifacts);
    const mutation = requireOne(index, "mutation-authorization");
    if (!principalsEqual(mutation.principal, principal)) {
      return fail(
        "SESSION_BINDING_INVALID",
        "Builder session differs from the approved mutation principal",
      );
    }
  }
  if (
    input.state.phase === "reviewing" &&
    input.state.principal_audit.some(
      (audit) =>
        audit.agent_id === "ys-craft-patch-builder" && audit.session_id === principal.session_id,
    )
  ) {
    return fail(
      "SESSION_INDEPENDENCE_INVALID",
      "Patch reviewer must use a session distinct from the builder",
    );
  }
  const principalAudit = appendAudit(input.state.principal_audit, principal);
  const { artifact_digest: _artifactDigest, ...statePayload } = input.state;
  return sealState({
    ...statePayload,
    phase_principal: principal,
    principal_audit: principalAudit,
    revision: input.state.revision + 1,
    updated_at: input.at,
  });
}

export function assertPhaseArtifactWrite(input: {
  readonly artifact: YuanshengCraftContractV1;
  readonly principal: TrustedPrincipal;
  readonly state: WorkflowState;
}): void {
  assertState(input.state);
  if (!isActiveWorkflowPhase(input.state.phase)) {
    fail("TERMINAL_WORKFLOW", "Terminal workflow cannot accept phase artifacts");
  }
  const principal = assertBoundPhasePrincipal(input.state, input.principal);
  const ordinaryOwnership = (
    PHASE_OWNED_ARTIFACTS[input.state.phase] as readonly ArtifactType[]
  ).includes(input.artifact.artifact_type);
  const phaseCommandOwnership =
    (input.artifact.artifact_type === "phase-command-manifest" &&
      input.artifact.phase === input.state.phase &&
      (input.state.phase === "root_cause" || input.state.phase === "planning")) ||
    (input.artifact.artifact_type === "phase-command-authorization" &&
      (input.state.phase === "root_cause" || input.state.phase === "planning"));
  if (!ordinaryOwnership && !phaseCommandOwnership) {
    fail(
      "ARTIFACT_OWNERSHIP_INVALID",
      `${principal.agent_id} cannot write ${input.artifact.artifact_type} in ${input.state.phase}`,
    );
  }
  let embeddedPrincipal: PrincipalAudit | null = null;
  if (
    input.artifact.artifact_type === "verification-authorization" ||
    input.artifact.artifact_type === "phase-command-authorization"
  ) {
    embeddedPrincipal = input.artifact.principal;
  } else if (input.artifact.artifact_type === "patch-review") {
    embeddedPrincipal = input.artifact.reviewer;
  }
  if (embeddedPrincipal !== null && !principalsEqual(embeddedPrincipal, principal)) {
    fail("SESSION_BINDING_INVALID", `${input.artifact.artifact_type} embeds a different principal`);
  }
  if ("workflow_id" in input.artifact && input.artifact.workflow_id !== input.state.workflow_id) {
    fail("ARTIFACT_CHAIN_INVALID", "Phase artifact belongs to a different workflow");
  }
}

export function recordPhaseArtifact(input: RecordPhaseArtifactInput): WorkflowState {
  assertRevision(input.state, input.expectedRevision, input.at);
  assertPhaseArtifactWrite(input);
  const staleDigests = new Set(input.state.stale_artifact_refs.map((ref) => ref.digest));
  if (
    staleDigests.has(input.artifact.artifact_digest) ||
    input.state.artifact_refs.some((ref) => ref.digest === input.artifact.artifact_digest)
  ) {
    return fail(
      "ARTIFACT_CHAIN_INVALID",
      "An active or stale artifact digest cannot be recorded again",
    );
  }
  if (
    input.artifact.artifact_type !== "criterion-evidence" &&
    input.state.artifact_refs.some((ref) => ref.artifact_type === input.artifact.artifact_type)
  ) {
    return fail(
      "ARTIFACT_CHAIN_INVALID",
      `Active ${input.artifact.artifact_type} must be invalidated before replacement`,
    );
  }
  const expectedDigests = new Set([
    ...input.state.artifact_refs.map((ref) => ref.digest),
    input.artifact.artifact_digest,
  ]);
  const actualDigests = new Set(input.activeArtifacts.map((contract) => contract.artifact_digest));
  if (
    expectedDigests.size !== actualDigests.size ||
    [...expectedDigests].some((digest) => !actualDigests.has(digest))
  ) {
    return fail(
      "ARTIFACT_CHAIN_INVALID",
      "Artifact recording requires the exact previous graph plus one artifact",
    );
  }
  indexActiveArtifacts(input.state, input.activeArtifacts);
  const { artifact_digest: _artifactDigest, ...statePayload } = input.state;
  return sealState({
    ...statePayload,
    artifact_refs: sortedRefs(input.activeArtifacts),
    revision: input.state.revision + 1,
    updated_at: input.at,
  });
}

export function transitionWorkflow(input: TransitionWorkflowInput): WorkflowState {
  assertRevision(input.state, input.expectedRevision, input.at);
  if (!isActiveWorkflowPhase(input.state.phase)) {
    return fail("TERMINAL_WORKFLOW", "Terminal workflow cannot transition");
  }
  const principal = assertBoundPhasePrincipal(input.state, input.principal);
  if (FORWARD_TRANSITION[input.state.phase] !== input.targetPhase) {
    return fail(
      "INVALID_TRANSITION",
      `${input.state.phase} cannot advance to ${input.targetPhase}`,
    );
  }
  const index = indexActiveArtifacts(input.state, input.activeArtifacts);
  assertExactActiveSet(input.state, input.activeArtifacts);
  validateForwardGate(input.state, input.targetPhase, principal, index);
  const refs = sortedRefs(input.activeArtifacts);
  if (input.targetPhase === "completed") {
    return sealState({
      artifact_refs: refs,
      artifact_type: "workflow-state",
      artifact_version: 1,
      blocked_context: null,
      completed_at: input.at,
      coordinator: input.state.coordinator,
      created_at: input.state.created_at,
      entry_context: input.state.entry_context,
      entry_strategy: input.state.entry_strategy,
      phase: "completed",
      phase_principal: null,
      principal_audit: [...input.state.principal_audit] as WorkflowState["principal_audit"],
      revision: input.state.revision + 1,
      stale_artifact_refs: [...input.state.stale_artifact_refs],
      status: "completed",
      updated_at: input.at,
      workflow_id: input.state.workflow_id,
    });
  }
  if (!isActiveWorkflowPhase(input.targetPhase)) {
    return fail("INVALID_TRANSITION", "Blocked transitions require blockWorkflow");
  }
  return nextActiveState(input.state, {
    activeRefs: refs,
    at: input.at,
    phase: input.targetPhase,
    principalAudit: input.state.principal_audit,
  });
}

export function blockWorkflow(input: BlockWorkflowInput): WorkflowState {
  assertRevision(input.state, input.expectedRevision, input.at);
  if (!isActiveWorkflowPhase(input.state.phase)) {
    return fail("TERMINAL_WORKFLOW", "Terminal workflow cannot be blocked again");
  }
  const principal = assertBoundPhasePrincipal(input.state, input.principal);
  if (
    input.reason.trim().length === 0 ||
    !canRemediateTo(input.state.phase, input.remediationPhase) ||
    (input.state.entry_strategy === "root-cause-import" && input.remediationPhase === "root_cause")
  ) {
    return fail(
      "INVALID_TRANSITION",
      "Blocked workflow requires a safe explicit remediation target",
    );
  }
  return sealState({
    artifact_refs: [...input.state.artifact_refs],
    artifact_type: "workflow-state",
    artifact_version: 1,
    blocked_context: {
      from_phase: input.state.phase,
      reason: input.reason,
      remediation_phase: input.remediationPhase,
    },
    completed_at: null,
    coordinator: input.state.coordinator,
    created_at: input.state.created_at,
    entry_context: input.state.entry_context,
    entry_strategy: input.state.entry_strategy,
    phase: "blocked",
    phase_principal: null,
    principal_audit: appendAudit(input.state.principal_audit, principal),
    revision: input.state.revision + 1,
    stale_artifact_refs: [...input.state.stale_artifact_refs],
    status: "blocked",
    updated_at: input.at,
    workflow_id: input.state.workflow_id,
  });
}

const INVALID_FROM_PHASE = Object.freeze({
  building: new Set<ArtifactType>([
    "diff-manifest",
    "patch-candidate",
    "verification-source",
    "verification-manifest",
    "verification-authorization",
    "criterion-evidence",
    "patch-review",
    "delivery",
    "phase-command-manifest",
    "phase-command-authorization",
  ]),
  planning: new Set<ArtifactType>([
    "patch-plan",
    "mutation-authorization",
    "diff-manifest",
    "patch-candidate",
    "verification-source",
    "verification-manifest",
    "verification-authorization",
    "criterion-evidence",
    "patch-review",
    "delivery",
    "phase-command-manifest",
    "phase-command-authorization",
  ]),
  reviewing: new Set<ArtifactType>([
    "patch-review",
    "delivery",
    "phase-command-manifest",
    "phase-command-authorization",
  ]),
  root_cause: new Set<ArtifactType>([
    "root-cause",
    "patch-plan",
    "mutation-authorization",
    "diff-manifest",
    "patch-candidate",
    "verification-source",
    "verification-manifest",
    "verification-authorization",
    "criterion-evidence",
    "patch-review",
    "delivery",
    "phase-command-manifest",
    "phase-command-authorization",
  ]),
  verifying: new Set<ArtifactType>([
    "verification-source",
    "verification-manifest",
    "verification-authorization",
    "criterion-evidence",
    "patch-review",
    "delivery",
    "phase-command-manifest",
    "phase-command-authorization",
  ]),
} as const satisfies Readonly<Record<RollbackPhase, ReadonlySet<ArtifactType>>>);

function invalidateForTarget(
  state: WorkflowState,
  target: RollbackPhase,
): {
  readonly active: readonly ArtifactRef[];
  readonly stale: readonly ArtifactRef[];
} {
  const protectedEntryDigests = new Set(
    state.entry_context.strategy === "root-cause-import"
      ? [
          state.entry_context.repository_binding_ref.digest,
          state.entry_context.review_subject_ref.digest,
          state.entry_context.attestation_ref.digest,
          state.entry_context.root_cause_ref.digest,
        ]
      : [state.entry_context.repository_binding_ref.digest],
  );
  const invalidTypes = INVALID_FROM_PHASE[target];
  const newlyStale = state.artifact_refs.filter(
    (ref) => !protectedEntryDigests.has(ref.digest) && invalidTypes.has(ref.artifact_type),
  );
  const newlyStaleDigests = new Set(newlyStale.map((ref) => ref.digest));
  const active = state.artifact_refs.filter((ref) => !newlyStaleDigests.has(ref.digest));
  const staleByDigest = new Map(
    [...state.stale_artifact_refs, ...newlyStale].map((ref) => [ref.digest, ref]),
  );
  return {
    active,
    stale: [...staleByDigest.values()].sort((left, right) =>
      compareText(left.digest, right.digest),
    ),
  };
}

export function returnWorkflowToPhase(input: ReturnWorkflowInput): WorkflowState {
  assertRevision(input.state, input.expectedRevision, input.at);
  if (!isActiveWorkflowPhase(input.state.phase)) {
    return fail("TERMINAL_WORKFLOW", "Terminal workflow cannot use ordinary rollback");
  }
  assertBoundPhasePrincipal(input.state, input.principal);
  const targetPhase = input.targetPhase;
  if (
    input.reason.trim().length === 0 ||
    !isEarlierPhase(input.state.phase, targetPhase) ||
    !isRollbackPhase(targetPhase) ||
    (input.state.entry_strategy === "root-cause-import" && targetPhase === "root_cause")
  ) {
    return fail(
      "INVALID_TRANSITION",
      "Rollback requires an earlier safe phase allowed by the entry strategy",
    );
  }
  const invalidated = invalidateForTarget(input.state, targetPhase);
  return nextActiveState(input.state, {
    activeRefs: invalidated.active,
    at: input.at,
    phase: targetPhase,
    principalAudit: input.state.principal_audit,
    staleRefs: invalidated.stale,
  });
}

export function remediateBlockedWorkflow(input: StateUpdateInput): WorkflowState {
  assertRevision(input.state, input.expectedRevision, input.at);
  const principal = auditTrustedPrincipal(input.principal);
  if (input.state.phase !== "blocked" || input.state.blocked_context === null) {
    return fail("INVALID_TRANSITION", "Only a blocked workflow can be remediated");
  }
  if (!principalsEqual(principal, input.state.coordinator)) {
    return fail(
      "SESSION_BINDING_INVALID",
      "Blocked remediation requires the bound workflow coordinator",
    );
  }
  const target = input.state.blocked_context.remediation_phase;
  const invalidated = invalidateForTarget(input.state, target);
  return nextActiveState(input.state, {
    activeRefs: invalidated.active,
    at: input.at,
    phase: target,
    principalAudit: appendAudit(input.state.principal_audit, principal),
    staleRefs: invalidated.stale,
  });
}

export function activeRootCause(
  state: WorkflowState,
  contracts: readonly YuanshengCraftContractV1[],
): RootCauseArtifact {
  const index = indexActiveArtifacts(state, contracts);
  assertExactActiveSet(state, contracts);
  return requireOne(index, "root-cause");
}
