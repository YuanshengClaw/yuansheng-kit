import { canonicalizeJson, sealArtifact } from "../artifacts/canonical";
import type {
  MutationAuthorization,
  PatchPlan,
  PlannedChange,
  RepositoryBinding,
  RootCauseArtifact,
  YuanshengCraftContractV1,
} from "../artifacts/generated";
import {
  artifactRef,
  parseCraftContractBytes,
  validateCraftContractGraph,
} from "../artifacts/parser";
import type { JsonValue } from "../artifacts/strict-json";
import { auditTrustedPrincipal, type TrustedPrincipal } from "../state-machine/principal";

export interface PatchPlanProposal {
  readonly changes: readonly PlannedChange[];
  readonly criterionIds: readonly string[];
  readonly nonGoals: readonly string[];
  readonly objectives: readonly string[];
  readonly planRevision: number;
}

export type PatchPlanApprovalResult =
  | {
      readonly status: "denied";
    }
  | {
      readonly authorization: MutationAuthorization;
      readonly plan: PatchPlan;
      readonly status: "approved";
    };

export class PatchPlanApprovalError extends Error {
  readonly code = "PATCH_PLAN_APPROVAL_INVALID";

  constructor(message: string) {
    super(`PATCH_PLAN_APPROVAL_INVALID: ${message}`);
    this.name = "PatchPlanApprovalError";
  }
}

function fail(message: string): never {
  throw new PatchPlanApprovalError(message);
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
    return fail(`Approval requires exactly one active ${artifactType}`);
  }
  return matches[0] as Extract<YuanshengCraftContractV1, { artifact_type: T }>;
}

function seal<T extends YuanshengCraftContractV1>(payload: Omit<T, "artifact_digest">): T {
  const sealed = sealArtifact(payload as unknown as Record<string, JsonValue>) as unknown as T;
  const parsed = parseCraftContractBytes(canonicalizeJson(sealed).bytes);
  if (parsed.artifact_type !== sealed.artifact_type) {
    return fail(`Approval produced an invalid ${sealed.artifact_type}`);
  }
  return parsed as T;
}

function copyChanges(changes: readonly PlannedChange[]): PatchPlan["changes"] {
  if (changes.length === 0) {
    return fail("A patch plan must contain at least one exact file mutation");
  }
  return changes.map((change) => ({
    criterion_ids: [...change.criterion_ids],
    id: change.id,
    operation: change.operation,
    path: change.path,
    reason: change.reason,
    root_cause_item_ids: [...change.root_cause_item_ids],
    source_path: change.source_path,
  })) as PatchPlan["changes"];
}

function requireNonEmptyTuple<T>(values: readonly T[], label: string): [T, ...T[]] {
  if (values.length === 0) {
    return fail(`${label} must not be empty`);
  }
  return [...values] as [T, ...T[]];
}

export function approvePatchPlan(input: {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly approved: boolean;
  readonly at: string;
  readonly builderPrincipal: TrustedPrincipal;
  readonly proposal: PatchPlanProposal;
  readonly workflowId: string;
}): PatchPlanApprovalResult {
  if (!input.approved) {
    return Object.freeze({ status: "denied" });
  }
  const activeIndex = validateCraftContractGraph(input.activeArtifacts);
  if (activeIndex.size !== input.activeArtifacts.length) {
    return fail("Active planning graph contains duplicate artifacts");
  }
  const rootCause = requireOne(input.activeArtifacts, "root-cause") as RootCauseArtifact;
  const binding = requireOne(input.activeArtifacts, "repository-binding") as RepositoryBinding;
  if (rootCause.workflow_id !== input.workflowId || rootCause.status !== "confirmed") {
    return fail("Approval requires the current confirmed root cause for this workflow");
  }
  if (
    input.activeArtifacts.some(
      (artifact) =>
        artifact.artifact_type === "patch-plan" ||
        artifact.artifact_type === "mutation-authorization",
    )
  ) {
    return fail("An immutable plan approval event cannot replace active approval artifacts");
  }
  const builder = auditTrustedPrincipal(input.builderPrincipal);
  if (builder.agent_id !== "ys-craft-patch-builder") {
    return fail("Mutation authorization must bind a trusted patch-builder session");
  }

  const plan = seal<PatchPlan>({
    artifact_type: "patch-plan",
    artifact_version: 1,
    changes: copyChanges(input.proposal.changes),
    created_at: input.at,
    criterion_ids: requireNonEmptyTuple(input.proposal.criterionIds, "criterionIds"),
    non_goals: [...input.proposal.nonGoals],
    objectives: requireNonEmptyTuple(input.proposal.objectives, "objectives"),
    plan_revision: input.proposal.planRevision,
    root_cause_ref: artifactRef(rootCause),
    status: "approved",
    workflow_id: input.workflowId,
  });
  const authorization = seal<MutationAuthorization>({
    action: "allow",
    artifact_type: "mutation-authorization",
    artifact_version: 1,
    authorized_changes: plan.changes.map((change) => ({
      operation: change.operation,
      path: change.path,
      planned_change_id: change.id,
      source_path: change.source_path,
    })) as MutationAuthorization["authorized_changes"],
    authorized_revision: plan.plan_revision,
    baseline_commit: binding.commit_sha,
    capability: "file-mutation-only",
    created_at: input.at,
    plan_ref: artifactRef(plan),
    principal: builder,
    repository_binding_ref: artifactRef(binding),
    target_worktree_realpath: binding.target_worktree_realpath,
    workflow_id: input.workflowId,
  });
  validateCraftContractGraph([...input.activeArtifacts, plan, authorization]);
  return Object.freeze({
    authorization,
    plan,
    status: "approved",
  });
}
