import { canonicalizeJson } from "../artifacts/canonical";
import type { ArtifactType, WorkflowState } from "../artifacts/generated";
import { parseCraftContractBytes } from "../artifacts/parser";
import { auditTrustedPrincipal, principalsEqual, type TrustedPrincipal } from "./principal";

export type StopGateResult =
  | {
      readonly allowStop: true;
      readonly applies: false;
      readonly reason: "unrelated-session";
    }
  | {
      readonly allowStop: true;
      readonly applies: true;
      readonly reason: "blocked" | "completed";
      readonly workflowId: string;
    }
  | {
      readonly allowStop: false;
      readonly applies: true;
      readonly missingGates: readonly string[];
      readonly phase: WorkflowState["phase"];
      readonly reason: "active-workflow";
      readonly workflowId: string;
    };

const PHASE_GATE_ARTIFACTS = Object.freeze({
  building: ["diff-manifest", "patch-candidate"],
  delivering: ["delivery"],
  intake: [],
  planning: ["patch-plan", "mutation-authorization"],
  reviewing: ["patch-review"],
  root_cause: ["root-cause"],
  verifying: ["verification-manifest", "verification-authorization", "criterion-evidence"],
} as const satisfies Readonly<
  Record<Exclude<WorkflowState["phase"], "blocked" | "completed">, readonly ArtifactType[]>
>);

function assertState(state: WorkflowState): void {
  const parsed = parseCraftContractBytes(canonicalizeJson(state).bytes);
  if (
    parsed.artifact_type !== "workflow-state" ||
    parsed.artifact_digest !== state.artifact_digest
  ) {
    throw new TypeError("Stop gate requires a valid immutable workflow state");
  }
}

export function evaluateStopGate(input: {
  readonly principal: TrustedPrincipal;
  readonly state: WorkflowState;
}): StopGateResult {
  assertState(input.state);
  const principal = auditTrustedPrincipal(input.principal);
  const bound =
    principalsEqual(input.state.coordinator, principal) ||
    (input.state.phase_principal !== null &&
      principalsEqual(input.state.phase_principal, principal));
  if (!bound) {
    return Object.freeze({
      allowStop: true as const,
      applies: false as const,
      reason: "unrelated-session" as const,
    });
  }
  if (input.state.phase === "completed") {
    return Object.freeze({
      allowStop: true as const,
      applies: true as const,
      reason: "completed" as const,
      workflowId: input.state.workflow_id,
    });
  }
  if (input.state.phase === "blocked") {
    return Object.freeze({
      allowStop: true as const,
      applies: true as const,
      reason: "blocked" as const,
      workflowId: input.state.workflow_id,
    });
  }
  const activeTypes = new Set(input.state.artifact_refs.map((ref) => ref.artifact_type));
  const missingGates = PHASE_GATE_ARTIFACTS[input.state.phase]
    .filter((artifactType) => !activeTypes.has(artifactType))
    .map((artifactType) => `missing:${artifactType}`);
  if (missingGates.length === 0) {
    missingGates.push("pending:phase-handoff");
  }
  return Object.freeze({
    allowStop: false as const,
    applies: true as const,
    missingGates: Object.freeze(missingGates),
    phase: input.state.phase,
    reason: "active-workflow" as const,
    workflowId: input.state.workflow_id,
  });
}
