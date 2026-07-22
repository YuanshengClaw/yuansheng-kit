export const BUILDER_CONTRACT_VERSION = 1 as const;

export const SUPPORTED_BUN_VERSION = "1.3.13" as const;

export const BUILDER_SUBCOMMAND = "build" as const;

export const REQUIRED_BUILD_OPTIONS = [
  "--workspace-root",
  "--manifest",
  "--platform",
  "--output",
] as const;

export const ARTIFACT_MANIFEST_NAME = "yuansheng-artifact.json" as const;

export const BUILDER_EXIT_CODES = {
  success: 0,
  usage: 2,
  invalidInput: 3,
  outputConflict: 4,
  platformBuildFailure: 5,
  internalError: 70,
} as const;

export type BuilderExitCode = (typeof BUILDER_EXIT_CODES)[keyof typeof BUILDER_EXIT_CODES];
