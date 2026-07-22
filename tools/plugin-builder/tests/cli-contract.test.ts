import { describe, expect, test } from "bun:test";

import {
  ARTIFACT_MANIFEST_NAME,
  BUILDER_CONTRACT_VERSION,
  BUILDER_EXIT_CODES,
  BUILDER_SUBCOMMAND,
  REQUIRED_BUILD_OPTIONS,
  SUPPORTED_BUN_VERSION,
} from "../src/cli-contract";

describe("plugin-builder CLI contract", () => {
  test("freezes the task 2 command surface", () => {
    expect(BUILDER_CONTRACT_VERSION).toBe(1);
    expect(SUPPORTED_BUN_VERSION).toBe("1.3.13");
    expect(BUILDER_SUBCOMMAND).toBe("build");
    expect(REQUIRED_BUILD_OPTIONS).toEqual([
      "--workspace-root",
      "--manifest",
      "--platform",
      "--output",
    ]);
  });

  test("reserves stable result boundaries", () => {
    expect(ARTIFACT_MANIFEST_NAME).toBe("yuansheng-artifact.json");
    expect(BUILDER_EXIT_CODES).toEqual({
      success: 0,
      usage: 2,
      invalidInput: 3,
      outputConflict: 4,
      platformBuildFailure: 5,
      internalError: 70,
    });
  });
});
