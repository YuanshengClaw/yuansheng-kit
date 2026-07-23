import { relative, resolve, sep } from "node:path";

import { canonicalizeJson } from "../artifacts/canonical";
import type {
  PhaseCommand,
  PhaseCommandAuthorization,
  PhaseCommandManifest,
  RepositoryBinding,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../artifacts/generated";
import { parseCraftContractBytes, validateCraftContractGraph } from "../artifacts/parser";
import { auditTrustedPrincipal, principalsEqual, type TrustedPrincipal } from "./principal";

export interface AuthorizedPhaseCommand {
  readonly argv: readonly [string, ...string[]];
  readonly commandId: string;
  readonly cwdRealpath: string;
  readonly environmentAllowlist: readonly string[];
  readonly outputRootRealpath: string;
  readonly targetAccess: "read-only";
  readonly targetWorktreeRealpath: string;
  readonly timeoutSeconds: number;
}

export class PhaseCommandGuardError extends Error {
  readonly code = "PHASE_COMMAND_DENIED";

  constructor(message: string) {
    super(`PHASE_COMMAND_DENIED: ${message}`);
    this.name = "PhaseCommandGuardError";
  }
}

function fail(message: string): never {
  throw new PhaseCommandGuardError(message);
}

function assertImmutableContract(
  contract: WorkflowState | RepositoryBinding,
  expectedType: "repository-binding" | "workflow-state",
): void {
  const parsed = parseCraftContractBytes(canonicalizeJson(contract).bytes);
  if (
    parsed.artifact_type !== expectedType ||
    parsed.artifact_digest !== contract.artifact_digest
  ) {
    fail(`Invalid ${expectedType} contract`);
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function commandById(manifest: PhaseCommandManifest, commandId: string): PhaseCommand {
  const commands = manifest.commands.filter((command) => command.command_id === commandId);
  if (commands.length !== 1 || commands[0] === undefined) {
    return fail("Command identity is missing or ambiguous in the manifest");
  }
  return commands[0];
}

function copyArgv(argv: PhaseCommand["argv"]): [string, ...string[]] {
  return [argv[0], ...argv.slice(1)];
}

export function authorizePhaseCommandExecution(input: {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly authorization: PhaseCommandAuthorization;
  readonly commandId: string;
  readonly manifest: PhaseCommandManifest;
  readonly principal: TrustedPrincipal;
  readonly repositoryBinding: RepositoryBinding;
  readonly state: WorkflowState;
}): AuthorizedPhaseCommand {
  assertImmutableContract(input.state, "workflow-state");
  assertImmutableContract(input.repositoryBinding, "repository-binding");
  const principal = auditTrustedPrincipal(input.principal);
  if (
    input.state.status !== "active" ||
    (input.state.phase !== "root_cause" && input.state.phase !== "planning") ||
    input.state.phase_principal === null ||
    !principalsEqual(input.state.phase_principal, principal)
  ) {
    return fail("Trusted principal is not bound to an executable workflow phase");
  }
  if (
    input.manifest.phase !== input.state.phase ||
    input.manifest.repository_binding_ref.digest !== input.repositoryBinding.artifact_digest ||
    input.manifest.target_access !== "read-only" ||
    input.authorization.action !== "allow" ||
    input.authorization.manifest_ref.digest !== input.manifest.artifact_digest ||
    !principalsEqual(input.authorization.principal, principal)
  ) {
    return fail("Manifest or authorization does not bind this exact execution");
  }
  const stateDigests = new Set(input.state.artifact_refs.map((ref) => ref.digest));
  if (
    !stateDigests.has(input.repositoryBinding.artifact_digest) ||
    !stateDigests.has(input.manifest.artifact_digest) ||
    !stateDigests.has(input.authorization.artifact_digest)
  ) {
    return fail("Execution contracts are not active in the workflow state");
  }
  const contractDigests = new Set(
    input.activeArtifacts.map((contract) => contract.artifact_digest),
  );
  if (
    contractDigests.size !== stateDigests.size ||
    [...stateDigests].some((digest) => !contractDigests.has(digest))
  ) {
    return fail("Execution requires the exact recorded active artifact graph");
  }
  try {
    const graph = new Map(
      [...input.activeArtifacts, input.manifest, input.authorization].map((contract) => [
        contract.artifact_digest,
        contract,
      ]),
    );
    validateCraftContractGraph([...graph.values()]);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Phase command artifact graph is invalid");
  }
  if (
    isWithin(input.repositoryBinding.target_worktree_realpath, input.manifest.output_root_realpath)
  ) {
    return fail("Command output root must be outside the read-only target worktree");
  }
  const command = commandById(input.manifest, input.commandId);
  const cwdRealpath = resolve(
    input.repositoryBinding.product_root_realpath,
    ...command.cwd.split("/"),
  );
  const productRelative = relative(input.repositoryBinding.product_root_realpath, cwdRealpath)
    .split(sep)
    .join("/");
  if (productRelative !== command.cwd) {
    return fail("Command cwd escapes the bound product root");
  }
  return Object.freeze({
    argv: Object.freeze(copyArgv(command.argv)),
    commandId: command.command_id,
    cwdRealpath,
    environmentAllowlist: Object.freeze([...command.environment_allowlist]),
    outputRootRealpath: input.manifest.output_root_realpath,
    targetAccess: "read-only" as const,
    targetWorktreeRealpath: input.repositoryBinding.target_worktree_realpath,
    timeoutSeconds: command.timeout_seconds,
  });
}
