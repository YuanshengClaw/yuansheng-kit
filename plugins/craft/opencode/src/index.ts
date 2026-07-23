import { isAbsolute } from "node:path";
import { type Plugin, type ToolDefinition, tool } from "@opencode-ai/plugin";

import { CRAFT_TOOL_SURFACE, type CraftToolId } from "../../workflows/tool-surface";

export type * from "../../workflows/artifacts/generated";
export {
  artifactRef,
  assertBlueprintPlanningEligible,
  parseCraftContractBytes,
  parseCraftContractGraph,
  validateCraftContractGraph,
} from "../../workflows/artifacts/parser";
export type {
  TraceFunctionIdentity,
  VerifiedEvidenceDigest,
  VerifiedSealedBlueprint,
  VerifiedSealedBlueprintSnapshot,
} from "../../workflows/blueprint-import/sealed-verifier";
export {
  snapshotVerifiedSealedBlueprint,
  verifySealedBlueprintDirectory,
} from "../../workflows/blueprint-import/sealed-verifier";
export type {
  BlueprintImportTransaction,
  BlueprintReviewContext,
  BlueprintReviewOutcome,
} from "../../workflows/blueprint-import/transaction";
export {
  buildBlueprintReviewAttestation,
  buildBlueprintReviewSubject,
  reviewBlueprintForImport,
} from "../../workflows/blueprint-import/transaction";

const TOOL_DESCRIPTIONS = Object.freeze(
  Object.fromEntries(
    CRAFT_TOOL_SURFACE.map((definition) => [
      definition.id,
      definition.visibility === "workflow-entry"
        ? `Start the explicit Yuansheng Craft ${definition.id} workflow entry.`
        : `Run the Yuansheng Craft ${definition.id} lifecycle operation for an exact workflow.`,
    ]),
  ) as Readonly<Record<CraftToolId, string>>,
);

function unavailable(toolId: CraftToolId): never {
  throw new Error(
    `YS_CRAFT_SKELETON_UNAVAILABLE: ${toolId} is registered but has no workflow implementation`,
  );
}

function requireAbsolutePath(value: string, parameter: string): void {
  if (!isAbsolute(value)) {
    throw new Error(`${parameter} must be an absolute path`);
  }
}

const craftTools = {
  ys_craft_start_problem: tool({
    description: TOOL_DESCRIPTIONS.ys_craft_start_problem,
    args: {
      problem: tool.schema.string().min(1),
      target_worktree: tool.schema.string().min(1),
    },
    async execute({ target_worktree }) {
      requireAbsolutePath(target_worktree, "target_worktree");
      return unavailable("ys_craft_start_problem");
    },
  }),
  ys_craft_review_blueprint: tool({
    description: TOOL_DESCRIPTIONS.ys_craft_review_blueprint,
    args: {
      sealed_function_directory: tool.schema.string().min(1),
      target_worktree: tool.schema.string().min(1),
    },
    async execute({ sealed_function_directory, target_worktree }) {
      requireAbsolutePath(sealed_function_directory, "sealed_function_directory");
      requireAbsolutePath(target_worktree, "target_worktree");
      return unavailable("ys_craft_review_blueprint");
    },
  }),
  ys_craft_status: tool({
    description: TOOL_DESCRIPTIONS.ys_craft_status,
    args: {
      workflow_id: tool.schema.string().min(1),
    },
    async execute() {
      return unavailable("ys_craft_status");
    },
  }),
  ys_craft_resume: tool({
    description: TOOL_DESCRIPTIONS.ys_craft_resume,
    args: {
      store_anchor: tool.schema.string().min(1),
      workflow_id: tool.schema.string().min(1),
    },
    async execute() {
      return unavailable("ys_craft_resume");
    },
  }),
  ys_craft_prepare_repository: tool({
    description: TOOL_DESCRIPTIONS.ys_craft_prepare_repository,
    args: {
      request_id: tool.schema.string().min(1),
    },
    async execute() {
      return unavailable("ys_craft_prepare_repository");
    },
  }),
  ys_craft_record_artifact: tool({
    description: TOOL_DESCRIPTIONS.ys_craft_record_artifact,
    args: {
      artifact_kind: tool.schema.string().min(1),
      artifact_payload: tool.schema.string().min(1),
      workflow_id: tool.schema.string().min(1),
    },
    async execute() {
      return unavailable("ys_craft_record_artifact");
    },
  }),
  ys_craft_capture_candidate: tool({
    description: TOOL_DESCRIPTIONS.ys_craft_capture_candidate,
    args: {
      expected_revision: tool.schema.number().int().nonnegative(),
      workflow_id: tool.schema.string().min(1),
    },
    async execute() {
      return unavailable("ys_craft_capture_candidate");
    },
  }),
  ys_craft_prepare_verification: tool({
    description: TOOL_DESCRIPTIONS.ys_craft_prepare_verification,
    args: {
      source: tool.schema.string().min(1),
      workflow_id: tool.schema.string().min(1),
    },
    async execute() {
      return unavailable("ys_craft_prepare_verification");
    },
  }),
  ys_craft_run_verification: tool({
    description: TOOL_DESCRIPTIONS.ys_craft_run_verification,
    args: {
      expected_revision: tool.schema.number().int().nonnegative(),
      workflow_id: tool.schema.string().min(1),
    },
    async execute() {
      return unavailable("ys_craft_run_verification");
    },
  }),
  ys_craft_transition: tool({
    description: TOOL_DESCRIPTIONS.ys_craft_transition,
    args: {
      expected_revision: tool.schema.number().int().nonnegative(),
      target_phase: tool.schema.string().min(1),
      workflow_id: tool.schema.string().min(1),
    },
    async execute() {
      return unavailable("ys_craft_transition");
    },
  }),
  ys_craft_return_to_phase: tool({
    description: TOOL_DESCRIPTIONS.ys_craft_return_to_phase,
    args: {
      expected_revision: tool.schema.number().int().nonnegative(),
      reason: tool.schema.string().min(1),
      target_phase: tool.schema.string().min(1),
      workflow_id: tool.schema.string().min(1),
    },
    async execute() {
      return unavailable("ys_craft_return_to_phase");
    },
  }),
  ys_craft_complete: tool({
    description: TOOL_DESCRIPTIONS.ys_craft_complete,
    args: {
      expected_revision: tool.schema.number().int().nonnegative(),
      workflow_id: tool.schema.string().min(1),
    },
    async execute() {
      return unavailable("ys_craft_complete");
    },
  }),
} satisfies Record<CraftToolId, ToolDefinition>;

const expectedToolIds = CRAFT_TOOL_SURFACE.map((definition) => definition.id).sort();
const registeredToolIds = Object.keys(craftTools).sort();
if (
  expectedToolIds.length !== registeredToolIds.length ||
  expectedToolIds.some((toolId, index) => toolId !== registeredToolIds[index])
) {
  throw new Error("Yuansheng Craft runtime tool registration does not match the frozen surface");
}

export const YuanshengCraftPlugin: Plugin = async () => ({
  tool: craftTools,
});
