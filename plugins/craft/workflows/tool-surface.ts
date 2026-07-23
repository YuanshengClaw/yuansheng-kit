import { CRAFT_ENTRY_STRATEGIES } from "./entry-strategies/catalog";
import { WORKFLOW_PHASES } from "./state-machine/phases";

export const CRAFT_WORKFLOW_PHASES = Object.freeze(["pre_workflow", ...WORKFLOW_PHASES] as const);

export type CraftWorkflowPhase = (typeof CRAFT_WORKFLOW_PHASES)[number];

type CraftToolVisibility = "agent-internal" | "workflow-entry";

interface CraftToolParameter {
  readonly name: string;
  readonly required: true;
  readonly type: "non_empty_string" | "non_negative_integer";
}

export interface CraftToolDefinition {
  readonly allowedPhases: readonly CraftWorkflowPhase[];
  readonly artifactOwnership: string | null;
  readonly createsWorkflow: boolean;
  readonly id: string;
  readonly parameters: readonly CraftToolParameter[];
  readonly principalSource: "trusted-platform-tool-context";
  readonly visibility: CraftToolVisibility;
}

const WORKFLOW_ID = Object.freeze({
  name: "workflow_id",
  required: true,
  type: "non_empty_string",
} as const);
const EXPECTED_REVISION = Object.freeze({
  name: "expected_revision",
  required: true,
  type: "non_negative_integer",
} as const);
const ACTIVE_PHASES = Object.freeze([
  "intake",
  "root_cause",
  "planning",
  "building",
  "verifying",
  "reviewing",
  "delivering",
  "blocked",
] as const);

export const CRAFT_TOOL_SURFACE = Object.freeze([
  {
    allowedPhases: ["pre_workflow"],
    artifactOwnership: null,
    createsWorkflow: true,
    id: CRAFT_ENTRY_STRATEGIES["problem-description"],
    parameters: [
      { name: "problem", required: true, type: "non_empty_string" },
      { name: "target_worktree", required: true, type: "non_empty_string" },
    ],
    principalSource: "trusted-platform-tool-context",
    visibility: "workflow-entry",
  },
  {
    allowedPhases: ["pre_workflow"],
    artifactOwnership: null,
    createsWorkflow: true,
    id: CRAFT_ENTRY_STRATEGIES["root-cause-import"],
    parameters: [
      { name: "sealed_function_directory", required: true, type: "non_empty_string" },
      { name: "target_worktree", required: true, type: "non_empty_string" },
    ],
    principalSource: "trusted-platform-tool-context",
    visibility: "workflow-entry",
  },
  {
    allowedPhases: CRAFT_WORKFLOW_PHASES,
    artifactOwnership: null,
    createsWorkflow: false,
    id: "ys_craft_status",
    parameters: [WORKFLOW_ID],
    principalSource: "trusted-platform-tool-context",
    visibility: "agent-internal",
  },
  {
    allowedPhases: ["blocked"],
    artifactOwnership: null,
    createsWorkflow: false,
    id: "ys_craft_resume",
    parameters: [WORKFLOW_ID, { name: "store_anchor", required: true, type: "non_empty_string" }],
    principalSource: "trusted-platform-tool-context",
    visibility: "agent-internal",
  },
  {
    allowedPhases: ["pre_workflow"],
    artifactOwnership: null,
    createsWorkflow: false,
    id: "ys_craft_prepare_repository",
    parameters: [{ name: "request_id", required: true, type: "non_empty_string" }],
    principalSource: "trusted-platform-tool-context",
    visibility: "agent-internal",
  },
  {
    allowedPhases: ["root_cause", "planning", "building", "verifying", "reviewing", "delivering"],
    artifactOwnership: "current-phase-owner",
    createsWorkflow: false,
    id: "ys_craft_record_artifact",
    parameters: [
      WORKFLOW_ID,
      { name: "artifact_kind", required: true, type: "non_empty_string" },
      { name: "artifact_payload", required: true, type: "non_empty_string" },
    ],
    principalSource: "trusted-platform-tool-context",
    visibility: "agent-internal",
  },
  {
    allowedPhases: ["building"],
    artifactOwnership: "ys-craft-patch-builder",
    createsWorkflow: false,
    id: "ys_craft_capture_candidate",
    parameters: [WORKFLOW_ID, EXPECTED_REVISION],
    principalSource: "trusted-platform-tool-context",
    visibility: "agent-internal",
  },
  {
    allowedPhases: ["verifying"],
    artifactOwnership: "ys-craft-regression-verifier",
    createsWorkflow: false,
    id: "ys_craft_prepare_verification",
    parameters: [WORKFLOW_ID, { name: "source", required: true, type: "non_empty_string" }],
    principalSource: "trusted-platform-tool-context",
    visibility: "agent-internal",
  },
  {
    allowedPhases: ["verifying"],
    artifactOwnership: "ys-craft-regression-verifier",
    createsWorkflow: false,
    id: "ys_craft_run_verification",
    parameters: [WORKFLOW_ID, EXPECTED_REVISION],
    principalSource: "trusted-platform-tool-context",
    visibility: "agent-internal",
  },
  {
    allowedPhases: ACTIVE_PHASES,
    artifactOwnership: null,
    createsWorkflow: false,
    id: "ys_craft_transition",
    parameters: [
      WORKFLOW_ID,
      EXPECTED_REVISION,
      { name: "target_phase", required: true, type: "non_empty_string" },
    ],
    principalSource: "trusted-platform-tool-context",
    visibility: "agent-internal",
  },
  {
    allowedPhases: ["planning", "building", "verifying", "reviewing", "delivering"],
    artifactOwnership: null,
    createsWorkflow: false,
    id: "ys_craft_return_to_phase",
    parameters: [
      WORKFLOW_ID,
      EXPECTED_REVISION,
      { name: "target_phase", required: true, type: "non_empty_string" },
      { name: "reason", required: true, type: "non_empty_string" },
    ],
    principalSource: "trusted-platform-tool-context",
    visibility: "agent-internal",
  },
  {
    allowedPhases: ["delivering"],
    artifactOwnership: "ys-craft-delivery-coordinator",
    createsWorkflow: false,
    id: "ys_craft_complete",
    parameters: [WORKFLOW_ID, EXPECTED_REVISION],
    principalSource: "trusted-platform-tool-context",
    visibility: "agent-internal",
  },
] as const satisfies readonly CraftToolDefinition[]);

export type CraftToolId = (typeof CRAFT_TOOL_SURFACE)[number]["id"];
