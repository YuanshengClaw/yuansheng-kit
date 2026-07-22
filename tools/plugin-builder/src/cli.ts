import { buildPlugin, serializeBuildReceipt } from "./build";
import { PLUGIN_BUILDER_COMMAND } from "./cli-contract";
import { PluginBuilderError } from "./errors";

interface CliOptions {
  readonly manifestPath: string;
  readonly outputPath: string;
  readonly platform: string;
  readonly workspaceRoot: string;
}

const OPTION_NAMES = Object.freeze([
  "--workspace-root",
  "--manifest",
  "--platform",
  "--output",
] as const);

type OptionName = (typeof OPTION_NAMES)[number];

function usageError(message: string): PluginBuilderError {
  return new PluginBuilderError("usage-invalid", "usage", message);
}

function parseArguments(arguments_: readonly string[]): CliOptions {
  if (arguments_[0] !== PLUGIN_BUILDER_COMMAND) {
    throw usageError(`Expected command ${PLUGIN_BUILDER_COMMAND}`);
  }
  const values = new Map<OptionName, string>();
  let index = 1;
  while (index < arguments_.length) {
    const name = arguments_[index];
    if (name === undefined || !OPTION_NAMES.includes(name as OptionName)) {
      throw usageError(`Unknown argument ${JSON.stringify(name)}`);
    }
    const option = name as OptionName;
    if (values.has(option)) {
      throw usageError(`Option ${option} may only be supplied once`);
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw usageError(`Option ${option} requires a value`);
    }
    values.set(option, value);
    index += 2;
  }
  for (const option of OPTION_NAMES) {
    if (!values.has(option)) {
      throw usageError(`Missing required option ${option}`);
    }
  }
  return {
    manifestPath: values.get("--manifest") as string,
    outputPath: values.get("--output") as string,
    platform: values.get("--platform") as string,
    workspaceRoot: values.get("--workspace-root") as string,
  };
}

export async function runPluginBuilderCli(arguments_: readonly string[]): Promise<number> {
  try {
    const options = parseArguments(arguments_);
    const receipt = await buildPlugin(options);
    process.stdout.write(`${serializeBuildReceipt(receipt)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof PluginBuilderError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`internal-error: ${message}\n`);
    return 70;
  }
}

if (import.meta.main) {
  process.exitCode = await runPluginBuilderCli(process.argv.slice(2));
}
