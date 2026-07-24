import { posix } from "node:path";

import Ajv2020 from "ajv/dist/2020";

import { canonicalizeJson } from "../artifacts/canonical";
import { parseStrictJson } from "../artifacts/strict-json";
import runtimeConfigSchema from "./ys-craft-runtime-config-v1.schema.json" with { type: "json" };

const DEFAULT_MAX_ITERATIONS = 5;
const SENSITIVE_ARGUMENT =
  /(?:^|[^a-z])(?:authorization|credential|password|passwd|private[-_]?key|secret|token)(?:[^a-z]|$)/iu;
const SAFE_RELATIVE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/u;

export interface CommandProposal {
  readonly argv: readonly string[];
  readonly id: string;
}

export interface LocalVerificationRunner {
  readonly command_proposals: readonly CommandProposal[];
  readonly cwd: string;
  readonly id: string;
  readonly timeout_ms: number;
  readonly type: "local";
}

export interface SshVerificationRunner {
  readonly command_proposals: readonly CommandProposal[];
  readonly host_alias: string;
  readonly id: string;
  readonly remote_cwd: string;
  readonly timeout_ms: number;
  readonly type: "ssh";
}

export type VerificationRunner = LocalVerificationRunner | SshVerificationRunner;

export interface CraftRuntimeConfig {
  readonly repository: {
    readonly preparation_policy: "manual-only" | "manual-or-managed";
    readonly timeout_ms: number;
  };
  readonly verification: {
    readonly max_iterations: number;
    readonly runners: readonly VerificationRunner[];
  };
  readonly version: 1;
}

interface CraftRuntimeConfigInput {
  readonly repository: CraftRuntimeConfig["repository"];
  readonly verification: {
    readonly max_iterations?: number;
    readonly runners: readonly VerificationRunner[];
  };
  readonly version: 1;
}

export interface ParsedCraftRuntimeConfig {
  readonly config: CraftRuntimeConfig;
  readonly configDigest: `sha256:${string}`;
}

export class CraftRuntimeConfigError extends Error {
  readonly code = "YS_CRAFT_CONFIG_INVALID";

  constructor(message: string) {
    super(`YS_CRAFT_CONFIG_INVALID: ${message}`);
    this.name = "CraftRuntimeConfigError";
  }
}

const validateRuntimeConfig = new Ajv2020({
  allErrors: true,
  strict: true,
}).compile<CraftRuntimeConfigInput>(runtimeConfigSchema);

function fail(message: string): never {
  throw new CraftRuntimeConfigError(message);
}

function assertRelativeCwd(value: string, label: string): void {
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value.endsWith("/") ||
    value
      .split("/")
      .some((segment) => segment === ".." || !SAFE_RELATIVE_PATH_SEGMENT.test(segment))
  ) {
    fail(`${label} must be a canonical product-relative POSIX path`);
  }
}

function assertRemoteCwd(value: string, label: string): void {
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    !posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "/" ||
    value.endsWith("/")
  ) {
    fail(`${label} must be a canonical absolute POSIX path below the filesystem root`);
  }
}

function normalizeProposals(
  proposals: readonly CommandProposal[],
  runnerId: string,
): readonly CommandProposal[] {
  const proposalIds = new Set<string>();
  return Object.freeze(
    proposals.map((proposal) => {
      if (proposalIds.has(proposal.id)) {
        fail(`runner ${runnerId} repeats command proposal ${proposal.id}`);
      }
      proposalIds.add(proposal.id);
      if (
        proposal.argv.some(
          (argument) =>
            argument.includes("\0") ||
            argument.trim().length === 0 ||
            SENSITIVE_ARGUMENT.test(argument),
        )
      ) {
        fail(`runner ${runnerId} proposal ${proposal.id} contains an unsafe argument`);
      }
      return Object.freeze({
        argv: Object.freeze([...proposal.argv]),
        id: proposal.id,
      });
    }),
  );
}

function normalizeConfig(input: CraftRuntimeConfigInput): CraftRuntimeConfig {
  const runnerIds = new Set<string>();
  const runners = input.verification.runners.map((runner) => {
    if (runnerIds.has(runner.id)) {
      fail(`verification runner ID ${runner.id} is duplicated`);
    }
    runnerIds.add(runner.id);
    const commandProposals = normalizeProposals(runner.command_proposals, runner.id);
    if (runner.type === "local") {
      assertRelativeCwd(runner.cwd, `runner ${runner.id} cwd`);
      return Object.freeze({
        command_proposals: commandProposals,
        cwd: runner.cwd,
        id: runner.id,
        timeout_ms: runner.timeout_ms,
        type: runner.type,
      });
    }
    assertRemoteCwd(runner.remote_cwd, `runner ${runner.id} remote_cwd`);
    return Object.freeze({
      command_proposals: commandProposals,
      host_alias: runner.host_alias,
      id: runner.id,
      remote_cwd: runner.remote_cwd,
      timeout_ms: runner.timeout_ms,
      type: runner.type,
    });
  });
  return Object.freeze({
    repository: Object.freeze({ ...input.repository }),
    verification: Object.freeze({
      max_iterations: input.verification.max_iterations ?? DEFAULT_MAX_ITERATIONS,
      runners: Object.freeze(runners),
    }),
    version: input.version,
  });
}

export function parseCraftRuntimeConfigBytes(bytes: Uint8Array): ParsedCraftRuntimeConfig {
  let value: unknown;
  try {
    value = parseStrictJson(bytes);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (!validateRuntimeConfig(value)) {
    fail(
      validateRuntimeConfig.errors
        ?.map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
        .join("; ") ?? "schema validation failed",
    );
  }
  return Object.freeze({
    config: normalizeConfig(value),
    configDigest: canonicalizeJson(value).digest,
  });
}
