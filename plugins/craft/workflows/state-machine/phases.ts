import type { ArtifactType, WorkflowState } from "../artifacts/generated";

export const YS_CRAFT_AGENT_IDS = Object.freeze([
  "ys-craft",
  "ys-craft-root-cause-analyst",
  "ys-craft-patch-planner",
  "ys-craft-patch-builder",
  "ys-craft-regression-verifier",
  "ys-craft-patch-reviewer",
  "ys-craft-delivery-coordinator",
] as const);

export type YsCraftAgentId = (typeof YS_CRAFT_AGENT_IDS)[number];
export type WorkflowPhase = WorkflowState["phase"];
export type ActiveWorkflowPhase = Exclude<WorkflowPhase, "blocked" | "completed">;
export type RemediationPhase = "root_cause" | "planning" | "building" | "verifying";

export const WORKFLOW_PHASES = Object.freeze([
  "intake",
  "root_cause",
  "planning",
  "building",
  "verifying",
  "reviewing",
  "delivering",
  "completed",
  "blocked",
] as const satisfies readonly WorkflowPhase[]);

export const PHASE_OWNER = Object.freeze({
  building: "ys-craft-patch-builder",
  delivering: "ys-craft-delivery-coordinator",
  intake: "ys-craft",
  planning: "ys-craft-patch-planner",
  reviewing: "ys-craft-patch-reviewer",
  root_cause: "ys-craft-root-cause-analyst",
  verifying: "ys-craft-regression-verifier",
} as const satisfies Readonly<Record<ActiveWorkflowPhase, YsCraftAgentId>>);

export const FORWARD_TRANSITION = Object.freeze({
  building: "verifying",
  delivering: "completed",
  intake: null,
  planning: "building",
  reviewing: "delivering",
  root_cause: "planning",
  verifying: "reviewing",
} as const satisfies Readonly<Record<ActiveWorkflowPhase, WorkflowPhase | null>>);

export const PHASE_OWNED_ARTIFACTS = Object.freeze({
  building: ["diff-manifest", "patch-candidate"],
  delivering: ["delivery"],
  intake: [],
  planning: ["patch-plan", "mutation-authorization"],
  reviewing: ["patch-review"],
  root_cause: ["root-cause"],
  verifying: [
    "verification-source",
    "verification-manifest",
    "verification-authorization",
    "criterion-evidence",
  ],
} as const satisfies Readonly<Record<ActiveWorkflowPhase, readonly ArtifactType[]>>);

const PHASE_INDEX = new Map<ActiveWorkflowPhase, number>(
  (
    [
      "intake",
      "root_cause",
      "planning",
      "building",
      "verifying",
      "reviewing",
      "delivering",
    ] as const
  ).map((phase, index) => [phase, index]),
);

export function isYsCraftAgentId(value: string): value is YsCraftAgentId {
  return (YS_CRAFT_AGENT_IDS as readonly string[]).includes(value);
}

export function isActiveWorkflowPhase(phase: WorkflowPhase): phase is ActiveWorkflowPhase {
  return phase !== "blocked" && phase !== "completed";
}

export function isEarlierPhase(current: ActiveWorkflowPhase, target: ActiveWorkflowPhase): boolean {
  const currentIndex = PHASE_INDEX.get(current);
  const targetIndex = PHASE_INDEX.get(target);
  return currentIndex !== undefined && targetIndex !== undefined && targetIndex < currentIndex;
}

export function canRemediateTo(from: ActiveWorkflowPhase, target: RemediationPhase): boolean {
  return from === target || isEarlierPhase(from, target);
}
