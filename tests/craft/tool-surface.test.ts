import { expect, test } from "bun:test";

import Ajv2020 from "ajv/dist/2020";

import { CRAFT_ENTRY_STRATEGIES } from "../../plugins/craft/workflows/entry-strategies/catalog";
import {
  CRAFT_TOOL_SURFACE,
  CRAFT_WORKFLOW_PHASES,
} from "../../plugins/craft/workflows/tool-surface";
import toolSurfaceSchema from "../../plugins/craft/workflows/tool-surface-v1.schema.json" with {
  type: "json",
};

const EXPECTED_TOOL_IDS = [
  "ys_craft_start_problem",
  "ys_craft_review_blueprint",
  "ys_craft_status",
  "ys_craft_resume",
  "ys_craft_prepare_repository",
  "ys_craft_record_artifact",
  "ys_craft_capture_candidate",
  "ys_craft_prepare_verification",
  "ys_craft_run_verification",
  "ys_craft_transition",
  "ys_craft_return_to_phase",
  "ys_craft_complete",
] as const;

test("Craft freezes exactly two entries and ten agent-internal lifecycle tools", () => {
  expect(CRAFT_TOOL_SURFACE.map((definition) => definition.id)).toEqual([...EXPECTED_TOOL_IDS]);
  expect(CRAFT_ENTRY_STRATEGIES).toEqual({
    "problem-description": "ys_craft_start_problem",
    "root-cause-import": "ys_craft_review_blueprint",
  });

  const entries = CRAFT_TOOL_SURFACE.filter(
    (definition) => definition.visibility === "workflow-entry",
  );
  const internal = CRAFT_TOOL_SURFACE.filter(
    (definition) => definition.visibility === "agent-internal",
  );
  expect(entries.map((definition) => definition.id)).toEqual([
    "ys_craft_start_problem",
    "ys_craft_review_blueprint",
  ]);
  expect(entries.every((definition) => definition.createsWorkflow)).toBe(true);
  expect(internal).toHaveLength(10);
  expect(internal.every((definition) => !definition.createsWorkflow)).toBe(true);
});

test("Craft tool metadata is strict, unique, phase-bound, and context-authenticated", () => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(toolSurfaceSchema);
  if (!validate(CRAFT_TOOL_SURFACE)) {
    throw new Error(`Craft tool surface is invalid: ${JSON.stringify(validate.errors)}`);
  }
  expect(new Set(CRAFT_TOOL_SURFACE.map((definition) => definition.id)).size).toBe(12);

  for (const definition of CRAFT_TOOL_SURFACE) {
    expect(definition.principalSource).toBe("trusted-platform-tool-context");
    expect(definition.allowedPhases.length).toBeGreaterThan(0);
    expect(definition.allowedPhases.every((phase) => CRAFT_WORKFLOW_PHASES.includes(phase))).toBe(
      true,
    );
    expect(new Set(definition.parameters.map((parameter) => parameter.name)).size).toBe(
      definition.parameters.length,
    );
  }
});
