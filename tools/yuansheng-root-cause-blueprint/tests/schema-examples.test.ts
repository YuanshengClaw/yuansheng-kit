import { describe, expect, test } from "bun:test";

import { validateYuanshengRootCauseBlueprintV1Lite } from "../src/generated/validators";
import { type JsonValue, parseStrictJson } from "../src/strict-json";

const repositoryRoot = new URL("../../../", import.meta.url);
const exampleRoot = "contracts/yuansheng-root-cause-blueprint/v1-lite/examples";
const validExample = `${exampleRoot}/valid/openjdk-hashmapbench-001.json`;
const invalidExamples = [
  `${exampleRoot}/invalid/auto-forward-enabled.json`,
  `${exampleRoot}/invalid/confidence-out-of-range.json`,
  `${exampleRoot}/invalid/current-gaps-string.json`,
  `${exampleRoot}/invalid/human-review-disabled.json`,
  `${exampleRoot}/invalid/metric-without-observation.json`,
  `${exampleRoot}/invalid/missing-null-gap.json`,
  `${exampleRoot}/invalid/missing-pattern-gap.json`,
  `${exampleRoot}/invalid/pattern-fields-non-null.json`,
  `${exampleRoot}/invalid/status-conflict.json`,
  `${exampleRoot}/invalid/unknown-sentinel.json`,
] as const;

async function readStrictJson(path: string): Promise<JsonValue> {
  const bytes = new Uint8Array(await Bun.file(new URL(path, repositoryRoot)).arrayBuffer());
  return parseStrictJson(bytes);
}

describe("generated RootCauseBlueprint validator", () => {
  test("accepts the current example", async () => {
    const value = await readStrictJson(validExample);
    expect(validateYuanshengRootCauseBlueprintV1Lite(value)).toBe(true);
  });

  test("rejects every invalid example", async () => {
    for (const path of invalidExamples) {
      const value = await readStrictJson(path);
      expect(validateYuanshengRootCauseBlueprintV1Lite(value), path).toBe(false);
    }
  });
});
