import { PLUGIN_BUILDER_EXIT_CODES } from "./cli-contract";

export type PluginBuilderExitCategory = "handler" | "input" | "internal" | "output" | "usage";

export type PluginBuilderErrorCode =
  | "bun-version-mismatch"
  | "config-load-failed"
  | "config-schema-invalid"
  | "config-version-unsupported"
  | "handler-contract-invalid"
  | "handler-failed"
  | "handler-load-failed"
  | "internal-error"
  | "output-commit-failed"
  | "output-conflict"
  | "output-path-conflict"
  | "output-path-invalid"
  | "output-write-failed"
  | "platform-unknown"
  | "resource-cycle"
  | "resource-duplicate"
  | "resource-undeclared"
  | "source-changed"
  | "source-missing"
  | "source-outside-workspace"
  | "source-path-invalid"
  | "source-type-forbidden"
  | "usage-invalid"
  | "workspace-invalid";

export const PLUGIN_BUILDER_ERROR_EXIT_CODES = Object.freeze({
  handler: PLUGIN_BUILDER_EXIT_CODES.handler,
  input: PLUGIN_BUILDER_EXIT_CODES.input,
  internal: PLUGIN_BUILDER_EXIT_CODES.internal,
  output: PLUGIN_BUILDER_EXIT_CODES.output,
  usage: PLUGIN_BUILDER_EXIT_CODES.usage,
} satisfies Readonly<Record<PluginBuilderExitCategory, number>>);

export type PluginBuilderErrorExitCode =
  (typeof PLUGIN_BUILDER_ERROR_EXIT_CODES)[PluginBuilderExitCategory];

export function exitCodeForCategory(
  category: PluginBuilderExitCategory,
): PluginBuilderErrorExitCode {
  return PLUGIN_BUILDER_ERROR_EXIT_CODES[category];
}

export class PluginBuilderError extends Error {
  readonly code: PluginBuilderErrorCode;
  readonly exitCategory: PluginBuilderExitCategory;
  readonly exitCode: PluginBuilderErrorExitCode;

  constructor(
    code: PluginBuilderErrorCode,
    category: PluginBuilderExitCategory,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PluginBuilderError";
    this.code = code;
    this.exitCategory = category;
    this.exitCode = exitCodeForCategory(category);
  }
}
