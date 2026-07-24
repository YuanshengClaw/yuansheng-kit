import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { sha256Digest } from "../artifacts/canonical";
import type {
  CriterionEvidence,
  DiffEntry,
  MutationAuthorization,
  PatchCandidate,
  RepositoryBinding,
  RootCauseArtifact,
  VerificationAuthorization,
  VerificationCommand,
  VerificationCommandResult,
  VerificationManifest,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../artifacts/generated";
import { validateCraftContractGraph } from "../artifacts/parser";
import { canonicalizeCapturedDiff } from "../building/candidate-capture";
import {
  auditTrustedPrincipal,
  principalsEqual,
  type TrustedPrincipal,
} from "../state-machine/principal";
import {
  blockMachineCriterionEvidence,
  buildVerificationLogBytes,
  type HumanCriterionDecision,
  type LocalProcessResult,
  sealHumanCriterionEvidence,
  sealMachineCriterionEvidence,
  type VerificationClock,
  type VerificationLogSink,
  verificationOverallStatus,
} from "./local-verification";

export const SSH_PREFLIGHT_PROTOCOL = "ys-craft-canonical-diff-v1";

export interface SshCandidateObservation {
  readonly binaryPatchBytes: Uint8Array;
  readonly entries: readonly DiffEntry[];
  readonly headCommit: string;
  readonly remoteCwdRealpath: string;
  readonly remoteIdentity: string;
}

export type SshPreflightResult =
  | {
      readonly kind: "observed";
      readonly observation: SshCandidateObservation;
    }
  | {
      readonly error: "spawn_failure" | "timeout";
      readonly kind: "infra_error";
      readonly stderr: Uint8Array;
      readonly stdout: Uint8Array;
    };

export interface SshVerificationExecutor {
  readonly captureCandidate: (input: {
    readonly baselineCommit: string;
    readonly hostAlias: string;
    readonly remoteCwd: string;
    readonly timeoutMs: number;
  }) => Promise<SshPreflightResult>;
  readonly run: (input: {
    readonly argv: readonly [string, ...string[]];
    readonly hostAlias: string;
    readonly remoteCwd: string;
    readonly timeoutMs: number;
  }) => Promise<LocalProcessResult>;
}

export interface RemoteWorktreeDisposition {
  readonly cleanupResponsibility: "user";
  readonly currentState: "drifted" | "unchanged" | "unknown";
  readonly message: string;
}

export interface SshVerificationRun {
  readonly evidence: readonly CriterionEvidence[];
  readonly observedDiffContentDigest: string | null;
  readonly reason:
    | "complete"
    | "remote_candidate_mismatch"
    | "remote_preflight_infra_error"
    | "remote_verification_mutated_candidate";
  readonly remoteWorktree: RemoteWorktreeDisposition;
  readonly status: "blocked" | "fail" | "infra_error" | "pass";
}

export class SshVerificationError extends Error {
  readonly code = "SSH_VERIFICATION_INVALID";

  constructor(message: string) {
    super(`SSH_VERIFICATION_INVALID: ${message}`);
    this.name = "SshVerificationError";
  }
}

function fail(message: string): never {
  throw new SshVerificationError(message);
}

function requireOne<T extends YuanshengCraftContractV1["artifact_type"]>(
  artifacts: readonly YuanshengCraftContractV1[],
  artifactType: T,
): Extract<YuanshengCraftContractV1, { artifact_type: T }> {
  const matches = artifacts.filter(
    (artifact): artifact is Extract<YuanshengCraftContractV1, { artifact_type: T }> =>
      artifact.artifact_type === artifactType,
  );
  if (matches.length !== 1) {
    return fail(`SSH verification requires exactly one active ${artifactType}`);
  }
  return matches[0] as Extract<YuanshengCraftContractV1, { artifact_type: T }>;
}

function assertExactActiveGraph(
  state: WorkflowState,
  artifacts: readonly YuanshengCraftContractV1[],
): void {
  validateCraftContractGraph(artifacts);
  const expected = new Set(state.artifact_refs.map((reference) => reference.digest));
  const actual = new Set(artifacts.map((artifact) => artifact.artifact_digest));
  if (expected.size !== actual.size || [...expected].some((digest) => !actual.has(digest))) {
    fail("SSH verification requires the exact active artifact graph");
  }
}

function assertAuthorization(input: {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly authorization: VerificationAuthorization;
  readonly candidate: PatchCandidate;
  readonly manifest: VerificationManifest;
  readonly principal: TrustedPrincipal;
  readonly state: WorkflowState;
}): void {
  const audit = auditTrustedPrincipal(input.principal);
  if (
    input.state.status !== "active" ||
    input.state.phase !== "verifying" ||
    input.state.phase_principal === null ||
    audit.agent_id !== "ys-craft-regression-verifier" ||
    !principalsEqual(input.state.phase_principal, audit) ||
    input.authorization.action !== "allow" ||
    input.authorization.manifest_ref.digest !== input.manifest.artifact_digest ||
    input.authorization.candidate_ref.digest !== input.candidate.artifact_digest ||
    !principalsEqual(input.authorization.principal, audit) ||
    input.manifest.candidate_ref.digest !== input.candidate.artifact_digest
  ) {
    fail("SSH execution lacks the exact allowed verification manifest");
  }
}

async function logRealpath(
  manifest: VerificationManifest,
  command: VerificationCommand,
): Promise<string> {
  if ((await realpath(manifest.log_root_realpath)) !== manifest.log_root_realpath) {
    return fail("Verification log root is not its canonical realpath");
  }
  const stats = await lstat(manifest.log_root_realpath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return fail("Verification log root must be a non-symlink directory");
  }
  const path = resolve(manifest.log_root_realpath, ...command.log_path.split("/"));
  const child = relative(manifest.log_root_realpath, path);
  if (child === ".." || child.startsWith(`..${sep}`)) {
    return fail("Verification log path escaped its manifest root");
  }
  return path;
}

function unknownDisposition(message: string): RemoteWorktreeDisposition {
  return Object.freeze({
    cleanupResponsibility: "user",
    currentState: "unknown",
    message,
  });
}

function disposition(
  state: RemoteWorktreeDisposition["currentState"],
  message: string,
): RemoteWorktreeDisposition {
  return Object.freeze({
    cleanupResponsibility: "user",
    currentState: state,
    message,
  });
}

type ObservedRemoteCandidate =
  | {
      readonly diffContentDigest: string;
      readonly kind: "matched";
      readonly remoteIdentity: string;
    }
  | {
      readonly diffContentDigest: string | null;
      readonly kind: "mismatch";
      readonly remoteIdentity: string | null;
    }
  | {
      readonly error: "spawn_failure" | "timeout";
      readonly kind: "infra_error";
      readonly stderr: Uint8Array;
      readonly stdout: Uint8Array;
    };

async function observeRemoteCandidate(input: {
  readonly authorization: MutationAuthorization;
  readonly candidate: PatchCandidate;
  readonly command: VerificationCommand;
  readonly manifest: VerificationManifest;
  readonly runner: SshVerificationExecutor;
}): Promise<ObservedRemoteCandidate> {
  if (input.command.host_alias === null || input.command.runner_type !== "ssh") {
    return fail("SSH verification received a non-SSH command");
  }
  let captured: SshPreflightResult;
  try {
    captured = await input.runner.captureCandidate({
      baselineCommit: input.manifest.baseline_commit,
      hostAlias: input.command.host_alias,
      remoteCwd: input.command.cwd,
      timeoutMs: input.command.timeout_seconds * 1_000,
    });
  } catch {
    captured = {
      error: "spawn_failure",
      kind: "infra_error",
      stderr: new Uint8Array(),
      stdout: new Uint8Array(),
    };
  }
  if (captured.kind === "infra_error") {
    return captured;
  }
  const observation = captured.observation;
  if (
    observation.remoteIdentity.length === 0 ||
    observation.remoteCwdRealpath !== input.command.cwd ||
    observation.headCommit !== input.manifest.baseline_commit
  ) {
    return {
      diffContentDigest: null,
      kind: "mismatch",
      remoteIdentity: observation.remoteIdentity || null,
    };
  }
  try {
    const snapshot = canonicalizeCapturedDiff({
      authorization: input.authorization,
      binaryPatchBytes: observation.binaryPatchBytes,
      entries: observation.entries,
    });
    if (
      snapshot.diffContentDigest !== input.candidate.diff_content_digest ||
      snapshot.diffContentDigest !== input.manifest.diff_content_digest
    ) {
      return {
        diffContentDigest: snapshot.diffContentDigest,
        kind: "mismatch",
        remoteIdentity: observation.remoteIdentity,
      };
    }
    return {
      diffContentDigest: snapshot.diffContentDigest,
      kind: "matched",
      remoteIdentity: observation.remoteIdentity,
    };
  } catch {
    return {
      diffContentDigest: null,
      kind: "mismatch",
      remoteIdentity: observation.remoteIdentity,
    };
  }
}

async function recordRemoteCommand(input: {
  readonly after: Extract<ObservedRemoteCandidate, { kind: "matched" | "mismatch" }>;
  readonly before: Extract<ObservedRemoteCandidate, { kind: "matched" }>;
  readonly clock: VerificationClock;
  readonly command: VerificationCommand;
  readonly logSink: VerificationLogSink;
  readonly manifest: VerificationManifest;
  readonly processResult: LocalProcessResult;
  readonly startedAt: string;
}): Promise<VerificationCommandResult> {
  if (input.command.host_alias === null) {
    return fail("SSH command lost its host alias");
  }
  const finishedAt = input.clock.now();
  const exitCode = input.processResult.kind === "exited" ? input.processResult.exitCode : null;
  const infraError = input.processResult.kind === "infra_error" ? input.processResult.error : null;
  const logBytes = buildVerificationLogBytes({
    commandId: input.command.command_id,
    exitCode,
    infraError,
    metadata: {
      argv: [...input.command.argv],
      baseline_commit: input.manifest.baseline_commit,
      candidate_artifact_digest: input.manifest.candidate_ref.digest,
      diff_content_digest_after: input.after.diffContentDigest,
      diff_content_digest_before: input.before.diffContentDigest,
      host_alias: input.command.host_alias,
      preflight_protocol: SSH_PREFLIGHT_PROTOCOL,
      remote_cwd_realpath: input.command.cwd,
      remote_identity: input.before.remoteIdentity,
      timeout_seconds: input.command.timeout_seconds,
    },
    stderr: input.processResult.stderr,
    stdout: input.processResult.stdout,
  });
  let logPersisted = true;
  let effectiveInfraError: VerificationCommandResult["infra_error"] = infraError;
  try {
    await input.logSink.write({
      bytes: logBytes,
      logRealpath: await logRealpath(input.manifest, input.command),
    });
  } catch {
    logPersisted = false;
    effectiveInfraError = "log_write_failure";
  }
  return {
    command_id: input.command.command_id,
    exit_code: exitCode,
    finished_at: finishedAt,
    infra_error: effectiveInfraError,
    log_digest: sha256Digest(logBytes),
    log_persisted: logPersisted,
    output_artifact_digests:
      input.processResult.kind === "exited" ? [...input.processResult.outputArtifactDigests] : [],
    started_at: input.startedAt,
    status: effectiveInfraError !== null ? "infra_error" : exitCode === 0 ? "pass" : "fail",
    stderr_digest: sha256Digest(input.processResult.stderr),
    stdout_digest: sha256Digest(input.processResult.stdout),
  };
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(left.byteLength + right.byteLength);
  bytes.set(left);
  bytes.set(right, left.byteLength);
  return bytes;
}

async function persistPreflightFailure(input: {
  readonly command: VerificationCommand;
  readonly failure: Extract<ObservedRemoteCandidate, { kind: "infra_error" }>;
  readonly logSink: VerificationLogSink;
  readonly manifest: VerificationManifest;
  readonly phase: "postflight" | "preflight";
  readonly processResult?: LocalProcessResult;
}): Promise<void> {
  const processStdout = input.processResult?.stdout ?? new Uint8Array();
  const processStderr = input.processResult?.stderr ?? new Uint8Array();
  const bytes = buildVerificationLogBytes({
    commandId: input.command.command_id,
    exitCode: input.processResult?.kind === "exited" ? input.processResult.exitCode : null,
    infraError: input.failure.error,
    metadata: {
      argv: [...input.command.argv],
      baseline_commit: input.manifest.baseline_commit,
      candidate_artifact_digest: input.manifest.candidate_ref.digest,
      host_alias: input.command.host_alias,
      preflight_protocol: SSH_PREFLIGHT_PROTOCOL,
      preflight_stage: input.phase,
      remote_cwd_realpath: input.command.cwd,
      timeout_seconds: input.command.timeout_seconds,
    },
    stderr: concatenateBytes(processStderr, input.failure.stderr),
    stdout: concatenateBytes(processStdout, input.failure.stdout),
  });
  try {
    await input.logSink.write({
      bytes,
      logRealpath: await logRealpath(input.manifest, input.command),
    });
  } catch {
    // The run remains an infrastructure error; a failed immutable log write cannot make it pass.
  }
}

export async function runSshVerification(input: {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly authorization: VerificationAuthorization;
  readonly clock: VerificationClock;
  readonly humanDecisions: ReadonlyMap<string, HumanCriterionDecision>;
  readonly logSink: VerificationLogSink;
  readonly manifest: VerificationManifest;
  readonly principal: TrustedPrincipal;
  readonly sshRunner: SshVerificationExecutor;
  readonly state: WorkflowState;
}): Promise<SshVerificationRun> {
  assertExactActiveGraph(input.state, input.activeArtifacts);
  const binding = requireOne(input.activeArtifacts, "repository-binding") as RepositoryBinding;
  const candidate = requireOne(input.activeArtifacts, "patch-candidate") as PatchCandidate;
  const mutationAuthorization = requireOne(
    input.activeArtifacts,
    "mutation-authorization",
  ) as MutationAuthorization;
  const rootCause = requireOne(input.activeArtifacts, "root-cause") as RootCauseArtifact;
  assertAuthorization({ ...input, candidate });
  if (
    input.manifest.repository_binding_ref.digest !== binding.artifact_digest ||
    input.manifest.baseline_commit !== binding.commit_sha ||
    input.manifest.commands.length === 0 ||
    input.manifest.commands.some(
      (command) =>
        command.runner_type !== "ssh" ||
        command.host_alias === null ||
        command.environment_allowlist.length !== 0,
    )
  ) {
    return fail("SSH verification manifest has an invalid remote target");
  }
  const graph = new Map(
    [...input.activeArtifacts, input.manifest, input.authorization].map((artifact) => [
      artifact.artifact_digest,
      artifact,
    ]),
  );
  validateCraftContractGraph([...graph.values()]);

  const results: VerificationCommandResult[] = [];
  let observedDiffContentDigest: string | null = null;
  let remoteIdentity: string | null = null;
  for (const command of input.manifest.commands) {
    const hostAlias = command.host_alias;
    if (hostAlias === null) {
      return fail("SSH command lost its approved host alias");
    }
    const before = await observeRemoteCandidate({
      authorization: mutationAuthorization,
      candidate,
      command,
      manifest: input.manifest,
      runner: input.sshRunner,
    });
    if (before.kind === "infra_error") {
      await persistPreflightFailure({
        command,
        failure: before,
        logSink: input.logSink,
        manifest: input.manifest,
        phase: "preflight",
      });
      return Object.freeze({
        evidence: [],
        observedDiffContentDigest,
        reason: "remote_preflight_infra_error",
        remoteWorktree: unknownDisposition(
          "Remote preflight failed; the user remains responsible for inspecting and cleaning the remote worktree.",
        ),
        status: "infra_error",
      });
    }
    observedDiffContentDigest = before.diffContentDigest;
    if (
      before.kind === "mismatch" ||
      (remoteIdentity !== null && before.remoteIdentity !== remoteIdentity)
    ) {
      return Object.freeze({
        evidence: [],
        observedDiffContentDigest,
        reason: "remote_candidate_mismatch",
        remoteWorktree: disposition(
          "drifted",
          "The remote candidate did not match the approved worktree; the user owns its cleanup.",
        ),
        status: "blocked",
      });
    }
    remoteIdentity = before.remoteIdentity;
    const startedAt = input.clock.now();
    let processResult: LocalProcessResult;
    try {
      processResult = await input.sshRunner.run({
        argv: [command.argv[0], ...command.argv.slice(1)],
        hostAlias,
        remoteCwd: command.cwd,
        timeoutMs: command.timeout_seconds * 1_000,
      });
    } catch {
      processResult = {
        error: "spawn_failure",
        kind: "infra_error",
        stderr: new Uint8Array(),
        stdout: new Uint8Array(),
      };
    }
    const after = await observeRemoteCandidate({
      authorization: mutationAuthorization,
      candidate,
      command,
      manifest: input.manifest,
      runner: input.sshRunner,
    });
    if (after.kind === "infra_error") {
      await persistPreflightFailure({
        command,
        failure: after,
        logSink: input.logSink,
        manifest: input.manifest,
        phase: "postflight",
        processResult,
      });
      return Object.freeze({
        evidence: [],
        observedDiffContentDigest,
        reason: "remote_preflight_infra_error",
        remoteWorktree: unknownDisposition(
          "Post-verification preflight failed; the user must inspect and clean the remote worktree.",
        ),
        status: "infra_error",
      });
    }
    observedDiffContentDigest = after.diffContentDigest;
    const result = await recordRemoteCommand({
      after,
      before,
      clock: input.clock,
      command,
      logSink: input.logSink,
      manifest: input.manifest,
      processResult,
      startedAt,
    });
    results.push(result);
    if (
      after.kind === "mismatch" ||
      after.remoteIdentity !== before.remoteIdentity ||
      after.diffContentDigest !== before.diffContentDigest
    ) {
      const criterionCommands = input.manifest.commands.filter(
        (item) => item.criterion_id === command.criterion_id,
      );
      const evidence = sealMachineCriterionEvidence({
        candidate,
        commands: criterionCommands,
        criterionId: command.criterion_id,
        manifest: input.manifest,
        observedDiffContentDigest:
          after.kind === "mismatch"
            ? (after.diffContentDigest ?? sha256Digest(new Uint8Array()))
            : sha256Digest(
                new TextEncoder().encode(`remote-identity-drift:${after.remoteIdentity}`),
              ),
        results: results.filter((item) =>
          criterionCommands.some(
            (candidateCommand) => candidateCommand.command_id === item.command_id,
          ),
        ),
        workflowId: input.state.workflow_id,
      });
      return Object.freeze({
        evidence: [blockMachineCriterionEvidence(evidence)],
        observedDiffContentDigest,
        reason: "remote_verification_mutated_candidate",
        remoteWorktree: disposition(
          "drifted",
          "Verification changed the remote candidate; the result is invalid and the user owns cleanup.",
        ),
        status: "blocked",
      });
    }
  }

  const evidence: CriterionEvidence[] = [];
  for (const criterionId of new Set(
    input.manifest.commands.map((command) => command.criterion_id),
  )) {
    const commands = input.manifest.commands.filter(
      (command) => command.criterion_id === criterionId,
    );
    evidence.push(
      sealMachineCriterionEvidence({
        candidate,
        commands,
        criterionId,
        manifest: input.manifest,
        observedDiffContentDigest: candidate.diff_content_digest,
        results: results.filter((result) =>
          commands.some((command) => command.command_id === result.command_id),
        ),
        workflowId: input.state.workflow_id,
      }),
    );
  }
  for (const criterionId of input.manifest.human_criterion_ids) {
    const decision = input.humanDecisions.get(criterionId);
    if (decision !== undefined) {
      evidence.push(
        sealHumanCriterionEvidence({
          candidate,
          criterionId,
          decision,
          manifest: input.manifest,
          workflowId: input.state.workflow_id,
        }),
      );
    }
  }
  validateCraftContractGraph([...graph.values(), ...evidence]);
  return Object.freeze({
    evidence: Object.freeze(evidence),
    observedDiffContentDigest,
    reason: "complete",
    remoteWorktree: disposition(
      "unchanged",
      "The remote candidate still matches the approved input; any later cleanup remains the user's responsibility.",
    ),
    status: verificationOverallStatus(rootCause, evidence),
  });
}
