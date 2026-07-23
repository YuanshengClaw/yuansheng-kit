import { describe, expect, test } from "bun:test";

import type { YuanshengRootCauseBlueprintV1Lite } from "../src/generated/types/yuansheng-root-cause-blueprint-v1-lite";
import { validateYuanshengRootCauseBlueprintV1Lite } from "../src/generated/validators";
import { checkYuanshengRootCauseBlueprintV1Lite } from "../src/semantic-rules";
import { parseStrictJson } from "../src/strict-json";

const repositoryRoot = new URL("../../../", import.meta.url);

async function loadBlueprint(): Promise<YuanshengRootCauseBlueprintV1Lite> {
  const relativePath =
    "contracts/yuansheng-root-cause-blueprint/v1-lite/examples/valid/openjdk-hashmapbench-001.json";
  const bytes = new Uint8Array(await Bun.file(new URL(relativePath, repositoryRoot)).arrayBuffer());
  const value = parseStrictJson(bytes);
  expect(validateYuanshengRootCauseBlueprintV1Lite(value)).toBe(true);
  if (!validateYuanshengRootCauseBlueprintV1Lite(value)) {
    throw new Error(`Fixture ${relativePath} did not satisfy its Schema`);
  }
  return value as unknown as YuanshengRootCauseBlueprintV1Lite;
}

describe("RootCauseBlueprint semantic rules", () => {
  test("accepts the current example and rejects unsupported conclusions", async () => {
    const blueprint = await loadBlueprint();
    expect(checkYuanshengRootCauseBlueprintV1Lite(blueprint)).toEqual([]);

    const conflicting = structuredClone(blueprint);
    conflicting.section6_ys_craft_actions.proceed_to_optimization = "no";
    expect(checkYuanshengRootCauseBlueprintV1Lite(conflicting)).toContainEqual(
      expect.objectContaining({ code: "ys-craft-decision-conflict" }),
    );

    const unsupportedLocation = structuredClone(blueprint);
    unsupportedLocation.section6_ys_craft_actions.priority_location = "unobserved_function";
    expect(checkYuanshengRootCauseBlueprintV1Lite(unsupportedLocation)).toContainEqual(
      expect.objectContaining({ code: "unsupported-priority-location" }),
    );

    const inventedPath = structuredClone(blueprint);
    inventedPath.section6_ys_craft_actions.recommended_first_action =
      "Edit src/hotspot/share/runtime/thread.cpp:42.";
    expect(checkYuanshengRootCauseBlueprintV1Lite(inventedPath)).toContainEqual(
      expect.objectContaining({ code: "unsupported-action-location" }),
    );
  });
});
