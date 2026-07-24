import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { canonicalizeJson, sealArtifact, sha256Digest } from "../artifacts/canonical";
import type {
  CriterionEvidence,
  HumanCriterionConfirmation,
  PatchCandidate,
  PatchPlan,
  RepositoryBinding,
  RootCauseArtifact,
  VerificationAuthorization,
  VerificationCommand,
  VerificationCommandResult,
  VerificationManifest,
  VerificationSource,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../artifacts/generated";
import {
  artifactRef,
  parseCraftContractBytes,
  validateCraftContractGraph,
} from "../artifacts/parser";
import type { JsonValue } from "../artifacts/strict-json";
import type { ParsedCraftRuntimeConfig } from "../runtime-config/config";
import {
  auditTrustedPrincipal,
  principalsEqual,
  type TrustedPrincipal,
} from "../state-machine/principal";

export interface VerificationSourceProposal {
  readonly commands: readonly VerificationCommand[];
  readonly humanCriterionIds: readonly string[];
  readonly sourceType: VerificationSource["source_type"];
}

export interface PreparedVerification {
  readonly manifest: VerificationManifest;
  readonly source: VerificationSource;
}

export type VerificationApproval =
  | {
      readonly authorization: VerificationAuthorization;
      readonly status: "approved";
    }
  | {
      readonly authorization: VerificationAuthorization;
      readonly status: "denied";
    };

export type LocalProcessResult =
  | {
      readonly exitCode: number;
      readonly kind: "exited";
      readonly outputArtifactDigests: readonly `sha256:${string}`[];
      readonly stderr: Uint8Array;
      readonly stdout: Uint8Array;
    }
  | {
      readonly error: "cancelled" | "spawn_failure" | "timeout";
      readonly kind: "infra_error";
      readonly stderr: Uint8Array;
      readonly stdout: Uint8Array;
    };

export interface LocalProcessRunner {
  readonly run: (input: {
    readonly argv: readonly [string, ...string[]];
    readonly cwdRealpath: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
  }) => Promise<LocalProcessResult>;
}

export interface VerificationLogSink {
  readonly write: (input: {
    readonly bytes: Uint8Array;
    readonly logRealpath: string;
  }) => Promise<void>;
}

export interface CandidateDiffObserver {
  readonly observeDiffContentDigest: () => Promise<string>;
}

export interface VerificationClock {
  readonly now: () => string;
}

export interface HumanCriterionDecision {
  readonly action: HumanCriterionConfirmation["action"];
  readonly confirmationDigest: `sha256:${string}`;
  readonly finishedAt: string;
  readonly sessionId: string;
  readonly startedAt: string;
}

export interface LocalVerificationRun {
  readonly evidence: readonly CriterionEvidence[];
  readonly observedDiffContentDigest: string;
  readonly status: "blocked" | "fail" | "infra_error" | "pass";
}

export class LocalVerificationError extends Error {
  readonly code = "LOCAL_VERIFICATION_INVALID";

  constructor(message: string) {
    super(`LOCAL_VERIFICATION_INVALID: ${message}`);
    this.name = "LocalVerificationError";
  }
}

function fail(message: string): never {
  throw new LocalVerificationError(message);
}

function seal<T extends YuanshengCraftContractV1>(payload: Omit<T, "artifact_digest">): T {
  const sealed = sealArtifact(payload as unknown as Record<string, JsonValue>) as unknown as T;
  const parsed = parseCraftContractBytes(canonicalizeJson(sealed).bytes);
  if (parsed.artifact_type !== sealed.artifact_type) {
    return fail(`Verification produced an invalid ${sealed.artifact_type}`);
  }
  return parsed as T;
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
    return fail(`Verification requires exactly one active ${artifactType}`);
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
    fail("Verification requires the exact active artifact graph");
  }
}

function assertVerifier(
  state: WorkflowState,
  principal: TrustedPrincipal,
): ReturnType<typeof auditTrustedPrincipal> {
  const audit = auditTrustedPrincipal(principal);
  if (
    state.status !== "active" ||
    state.phase !== "verifying" ||
    state.phase_principal === null ||
    audit.agent_id !== "ys-craft-regression-verifier" ||
    !principalsEqual(state.phase_principal, audit)
  ) {
    return fail("Trusted regression verifier is not bound to the verifying phase");
  }
  return audit;
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return canonicalizeJson(left).text === canonicalizeJson(right).text;
}

function assertOfficialCommand(
  command: VerificationCommand,
  config: ParsedCraftRuntimeConfig,
): void {
  const runners = config.config.verification.runners.filter(
    (runner) => runner.id === command.runner_id && runner.type === command.runner_type,
  );
  if (runners.length !== 1) {
    fail(`Official command references an unknown configured runner: ${command.runner_id}`);
  }
  const runner = runners[0];
  if (runner === undefined) {
    fail("Configured verification runner disappeared");
  }
  const configuredCwd = runner.type === "local" ? runner.cwd : runner.remote_cwd;
  const configuredHostAlias = runner.type === "local" ? null : runner.host_alias;
  if (
    command.cwd !== configuredCwd ||
    command.host_alias !== configuredHostAlias ||
    command.timeout_seconds * 1_000 > runner.timeout_ms ||
    !runner.command_proposals.some((proposal) => sameArgv(proposal.argv, command.argv))
  ) {
    fail(`Official command differs from its configured proposal: ${command.command_id}`);
  }
}

function copyCommands(commands: readonly VerificationCommand[]): VerificationCommand[] {
  return commands.map((command) => ({
    argv: [command.argv[0], ...command.argv.slice(1)],
    command_id: command.command_id,
    criterion_id: command.criterion_id,
    cwd: command.cwd,
    environment_allowlist: [...command.environment_allowlist],
    host_alias: command.host_alias,
    log_path: command.log_path,
    required: command.required,
    runner_id: command.runner_id,
    runner_type: command.runner_type,
    timeout_seconds: command.timeout_seconds,
  }));
}

export function prepareVerification(input: {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly at: string;
  readonly config: ParsedCraftRuntimeConfig;
  readonly logRootRealpath: string;
  readonly previousManifests: readonly VerificationManifest[];
  readonly principal: TrustedPrincipal;
  readonly proposal: VerificationSourceProposal;
  readonly state: WorkflowState;
}): PreparedVerification {
  assertExactActiveGraph(input.state, input.activeArtifacts);
  assertVerifier(input.state, input.principal);
  if (
    input.activeArtifacts.some(
      (artifact) =>
        artifact.artifact_type === "verification-source" ||
        artifact.artifact_type === "verification-manifest" ||
        artifact.artifact_type === "verification-authorization",
    )
  ) {
    return fail("One candidate may have only one active verification manifest");
  }
  const binding = requireOne(input.activeArtifacts, "repository-binding") as RepositoryBinding;
  const plan = requireOne(input.activeArtifacts, "patch-plan") as PatchPlan;
  const candidate = requireOne(input.activeArtifacts, "patch-candidate") as PatchCandidate;
  if (
    input.previousManifests.some(
      (manifest) => manifest.candidate_ref.digest === candidate.artifact_digest,
    )
  ) {
    return fail("This immutable candidate revision already has a verification manifest");
  }
  if (candidate.iteration > input.config.config.verification.max_iterations) {
    return fail("Candidate iteration exceeds the configured verification limit");
  }
  if (input.proposal.sourceType === "official") {
    for (const command of input.proposal.commands) {
      assertOfficialCommand(command, input.config);
    }
  }
  const source = seal<VerificationSource>({
    artifact_type: "verification-source",
    artifact_version: 1,
    commands: copyCommands(input.proposal.commands),
    config_digest: input.config.configDigest,
    created_at: input.at,
    human_criterion_ids: [...input.proposal.humanCriterionIds],
    plan_ref: artifactRef(plan),
    repository_binding_ref: artifactRef(binding),
    source_type: input.proposal.sourceType,
    workflow_id: input.state.workflow_id,
  });
  const manifest = seal<VerificationManifest>({
    artifact_type: "verification-manifest",
    artifact_version: 1,
    baseline_commit: binding.commit_sha,
    candidate_ref: artifactRef(candidate),
    commands: copyCommands(source.commands),
    config_digest: input.config.configDigest,
    created_at: input.at,
    diff_content_digest: candidate.diff_content_digest,
    human_criterion_ids: [...source.human_criterion_ids],
    log_root_realpath: input.logRootRealpath,
    repository_binding_ref: artifactRef(binding),
    ssh_preflight_protocol: input.proposal.commands.some((command) => command.runner_type === "ssh")
      ? "ys-craft-canonical-diff-v1"
      : null,
    source_ref: artifactRef(source),
    target_worktree_realpath: binding.target_worktree_realpath,
    workflow_id: input.state.workflow_id,
  });
  validateCraftContractGraph([...input.activeArtifacts, source, manifest]);
  return Object.freeze({ manifest, source });
}

export function approveVerification(input: {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly approved: boolean;
  readonly at: string;
  readonly manifest: VerificationManifest;
  readonly principal: TrustedPrincipal;
  readonly state: WorkflowState;
}): VerificationApproval {
  assertExactActiveGraph(input.state, input.activeArtifacts);
  assertVerifier(input.state, input.principal);
  const candidate = requireOne(input.activeArtifacts, "patch-candidate") as PatchCandidate;
  const audit = auditTrustedPrincipal(input.principal);
  if (input.manifest.candidate_ref.digest !== candidate.artifact_digest) {
    return fail("Verification approval candidate differs from the active candidate");
  }
  const authorization = seal<VerificationAuthorization>({
    action: input.approved ? "allow" : "deny",
    artifact_type: "verification-authorization",
    artifact_version: 1,
    candidate_ref: artifactRef(candidate),
    created_at: input.at,
    manifest_ref: artifactRef(input.manifest),
    principal: audit,
    workflow_id: input.state.workflow_id,
  });
  const graph = new Map(
    [...input.activeArtifacts, input.manifest, authorization].map((artifact) => [
      artifact.artifact_digest,
      artifact,
    ]),
  );
  validateCraftContractGraph([...graph.values()]);
  return Object.freeze({
    authorization,
    status: input.approved ? "approved" : "denied",
  });
}

function commandById(manifest: VerificationManifest, commandId: string): VerificationCommand {
  const matches = manifest.commands.filter((command) => command.command_id === commandId);
  if (matches.length !== 1) {
    return fail(`Verification command is missing or ambiguous: ${commandId}`);
  }
  return matches[0] as VerificationCommand;
}

async function assertExecutionPaths(
  binding: RepositoryBinding,
  manifest: VerificationManifest,
  command: VerificationCommand,
): Promise<{ readonly cwdRealpath: string; readonly logRealpath: string }> {
  if (command.runner_type !== "local") {
    return fail("Local verification cannot execute an SSH operation");
  }
  const cwdRealpath = resolve(binding.product_root_realpath, ...command.cwd.split("/"));
  const cwdRelative = relative(binding.product_root_realpath, cwdRealpath);
  if (
    cwdRelative === ".." ||
    cwdRelative.startsWith(`..${sep}`) ||
    (await realpath(cwdRealpath)) !== cwdRealpath
  ) {
    return fail("Local verification cwd escaped or drifted from the product root");
  }
  const cwdStats = await lstat(cwdRealpath);
  if (cwdStats.isSymbolicLink() || !cwdStats.isDirectory()) {
    return fail("Local verification cwd must be a non-symlink directory");
  }
  if ((await realpath(manifest.log_root_realpath)) !== manifest.log_root_realpath) {
    return fail("Verification log root is not its canonical realpath");
  }
  const logRootStats = await lstat(manifest.log_root_realpath);
  if (logRootStats.isSymbolicLink() || !logRootStats.isDirectory()) {
    return fail("Verification log root must be a non-symlink directory");
  }
  const logRealpath = resolve(manifest.log_root_realpath, ...command.log_path.split("/"));
  const logRelative = relative(manifest.log_root_realpath, logRealpath);
  if (logRelative === ".." || logRelative.startsWith(`..${sep}`)) {
    return fail("Verification log path escaped its manifest root");
  }
  return { cwdRealpath, logRealpath };
}

function filterEnvironment(
  allowlist: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const name of allowlist) {
    const value = environment[name];
    if (value !== undefined) {
      selected[name] = value;
    }
  }
  return Object.freeze(selected);
}

export function buildVerificationLogBytes(input: {
  readonly commandId: string;
  readonly exitCode: number | null;
  readonly infraError: VerificationCommandResult["infra_error"];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
}): Uint8Array {
  const header = canonicalizeJson({
    command_id: input.commandId,
    exit_code: input.exitCode,
    infra_error: input.infraError,
    metadata: input.metadata ?? {},
    stderr_bytes: input.stderr.byteLength,
    stderr_digest: sha256Digest(input.stderr),
    stdout_bytes: input.stdout.byteLength,
    stdout_digest: sha256Digest(input.stdout),
  }).bytes;
  const output = new Uint8Array(
    header.byteLength + 1 + input.stdout.byteLength + input.stderr.byteLength,
  );
  output.set(header);
  output[header.byteLength] = 0x0a;
  output.set(input.stdout, header.byteLength + 1);
  output.set(input.stderr, header.byteLength + 1 + input.stdout.byteLength);
  return output;
}

async function executeCommand(input: {
  readonly binding: RepositoryBinding;
  readonly clock: VerificationClock;
  readonly command: VerificationCommand;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly logSink: VerificationLogSink;
  readonly manifest: VerificationManifest;
  readonly runner: LocalProcessRunner;
}): Promise<VerificationCommandResult> {
  const paths = await assertExecutionPaths(input.binding, input.manifest, input.command);
  const startedAt = input.clock.now();
  let processResult: LocalProcessResult;
  try {
    processResult = await input.runner.run({
      argv: [input.command.argv[0], ...input.command.argv.slice(1)],
      cwdRealpath: paths.cwdRealpath,
      environment: filterEnvironment(input.command.environment_allowlist, input.environment),
      timeoutMs: input.command.timeout_seconds * 1_000,
    });
  } catch {
    processResult = {
      error: "spawn_failure",
      kind: "infra_error",
      stderr: new Uint8Array(),
      stdout: new Uint8Array(),
    };
  }
  const finishedAt = input.clock.now();
  const exitCode = processResult.kind === "exited" ? processResult.exitCode : null;
  const infraError = processResult.kind === "infra_error" ? processResult.error : null;
  const logBytes = buildVerificationLogBytes({
    commandId: input.command.command_id,
    exitCode,
    infraError,
    stderr: processResult.stderr,
    stdout: processResult.stdout,
  });
  let logPersisted = true;
  let effectiveInfraError: VerificationCommandResult["infra_error"] = infraError;
  try {
    await input.logSink.write({ bytes: logBytes, logRealpath: paths.logRealpath });
  } catch {
    logPersisted = false;
    effectiveInfraError = "log_write_failure";
  }
  const status = effectiveInfraError !== null ? "infra_error" : exitCode === 0 ? "pass" : "fail";
  return {
    command_id: input.command.command_id,
    exit_code: exitCode,
    finished_at: finishedAt,
    infra_error: effectiveInfraError,
    log_digest: sha256Digest(logBytes),
    log_persisted: logPersisted,
    output_artifact_digests:
      processResult.kind === "exited" ? [...processResult.outputArtifactDigests] : [],
    started_at: startedAt,
    status,
    stderr_digest: sha256Digest(processResult.stderr),
    stdout_digest: sha256Digest(processResult.stdout),
  };
}

function machineEvidenceStatus(
  commands: readonly VerificationCommand[],
  results: readonly VerificationCommandResult[],
): CriterionEvidence["status"] {
  const requiredResults = commands
    .filter((command) => command.required)
    .map((command) => results.find((result) => result.command_id === command.command_id));
  if (requiredResults.some((result) => result?.status === "infra_error")) {
    return "infra_error";
  }
  if (requiredResults.some((result) => result?.status === "fail")) {
    return "fail";
  }
  if (requiredResults.every((result) => result?.status === "pass")) {
    return "pass";
  }
  return "blocked";
}

export function sealMachineCriterionEvidence(input: {
  readonly candidate: PatchCandidate;
  readonly commands: readonly VerificationCommand[];
  readonly criterionId: string;
  readonly manifest: VerificationManifest;
  readonly observedDiffContentDigest: string;
  readonly results: readonly VerificationCommandResult[];
  readonly workflowId: string;
}): CriterionEvidence {
  const startedAt = input.results[0]?.started_at;
  const finishedAt = input.results.at(-1)?.finished_at;
  if (startedAt === undefined || finishedAt === undefined) {
    return fail("Machine criterion has no command result");
  }
  return seal<CriterionEvidence>({
    artifact_type: "criterion-evidence",
    artifact_version: 1,
    candidate_ref: artifactRef(input.candidate),
    command_results: [...input.results],
    created_at: finishedAt,
    criterion_id: input.criterionId,
    evidence_kind: "machine",
    finished_at: finishedAt,
    human_confirmation: null,
    manifest_ref: artifactRef(input.manifest),
    observed_diff_content_digest: input.observedDiffContentDigest,
    started_at: startedAt,
    status: machineEvidenceStatus(input.commands, input.results),
    workflow_id: input.workflowId,
  });
}

export function blockMachineCriterionEvidence(evidence: CriterionEvidence): CriterionEvidence {
  if (evidence.evidence_kind !== "machine") {
    return fail("Only machine criterion evidence may be blocked by candidate drift");
  }
  const { artifact_digest: _digest, ...payload } = evidence;
  return seal<CriterionEvidence>({
    ...payload,
    status: "blocked",
  });
}

export function sealHumanCriterionEvidence(input: {
  readonly candidate: PatchCandidate;
  readonly criterionId: string;
  readonly decision: HumanCriterionDecision;
  readonly manifest: VerificationManifest;
  readonly workflowId: string;
}): CriterionEvidence {
  return seal<CriterionEvidence>({
    artifact_type: "criterion-evidence",
    artifact_version: 1,
    candidate_ref: artifactRef(input.candidate),
    command_results: [],
    created_at: input.decision.finishedAt,
    criterion_id: input.criterionId,
    evidence_kind: "human",
    finished_at: input.decision.finishedAt,
    human_confirmation: {
      action: input.decision.action,
      confirmation_digest: input.decision.confirmationDigest,
      session_id: input.decision.sessionId,
    },
    manifest_ref: artifactRef(input.manifest),
    observed_diff_content_digest: input.candidate.diff_content_digest,
    started_at: input.decision.startedAt,
    status: input.decision.action === "allow" ? "pass" : "fail",
    workflow_id: input.workflowId,
  });
}

export function verificationOverallStatus(
  rootCause: RootCauseArtifact,
  evidence: readonly CriterionEvidence[],
): LocalVerificationRun["status"] {
  const required = rootCause.criteria.filter((criterion) => criterion.required);
  const statuses = required.map((criterion) =>
    evidence.find((item) => item.criterion_id === criterion.id),
  );
  if (statuses.some((item) => item === undefined || item.status === "blocked")) {
    return "blocked";
  }
  if (statuses.some((item) => item?.status === "infra_error")) {
    return "infra_error";
  }
  if (statuses.some((item) => item?.status === "fail")) {
    return "fail";
  }
  return "pass";
}

export async function runLocalVerification(input: {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly authorization: VerificationAuthorization;
  readonly candidateObserver: CandidateDiffObserver;
  readonly clock: VerificationClock;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly humanDecisions: ReadonlyMap<string, HumanCriterionDecision>;
  readonly logSink: VerificationLogSink;
  readonly manifest: VerificationManifest;
  readonly principal: TrustedPrincipal;
  readonly processRunner: LocalProcessRunner;
  readonly state: WorkflowState;
}): Promise<LocalVerificationRun> {
  assertExactActiveGraph(input.state, input.activeArtifacts);
  assertVerifier(input.state, input.principal);
  const binding = requireOne(input.activeArtifacts, "repository-binding") as RepositoryBinding;
  const candidate = requireOne(input.activeArtifacts, "patch-candidate") as PatchCandidate;
  const rootCause = requireOne(input.activeArtifacts, "root-cause") as RootCauseArtifact;
  const audit = auditTrustedPrincipal(input.principal);
  if (
    input.authorization.action !== "allow" ||
    input.authorization.manifest_ref.digest !== input.manifest.artifact_digest ||
    input.authorization.candidate_ref.digest !== candidate.artifact_digest ||
    !principalsEqual(input.authorization.principal, audit) ||
    input.manifest.candidate_ref.digest !== candidate.artifact_digest ||
    input.manifest.repository_binding_ref.digest !== binding.artifact_digest
  ) {
    return fail("Local execution lacks the exact allowed verification manifest");
  }
  if (input.manifest.commands.some((command) => command.runner_type !== "local")) {
    return fail("Local verification cannot consume a manifest containing SSH operations");
  }
  const graph = new Map(
    [...input.activeArtifacts, input.manifest, input.authorization].map((artifact) => [
      artifact.artifact_digest,
      artifact,
    ]),
  );
  validateCraftContractGraph([...graph.values()]);

  let observedDiffContentDigest = await input.candidateObserver.observeDiffContentDigest();
  if (observedDiffContentDigest !== candidate.diff_content_digest) {
    return Object.freeze({
      evidence: [],
      observedDiffContentDigest,
      status: "blocked",
    });
  }

  const results: VerificationCommandResult[] = [];
  for (const command of input.manifest.commands) {
    observedDiffContentDigest = await input.candidateObserver.observeDiffContentDigest();
    if (observedDiffContentDigest !== candidate.diff_content_digest) {
      return Object.freeze({
        evidence: [],
        observedDiffContentDigest,
        status: "blocked",
      });
    }
    results.push(
      await executeCommand({
        binding,
        clock: input.clock,
        command: commandById(input.manifest, command.command_id),
        environment: input.environment,
        logSink: input.logSink,
        manifest: input.manifest,
        runner: input.processRunner,
      }),
    );
    observedDiffContentDigest = await input.candidateObserver.observeDiffContentDigest();
    if (observedDiffContentDigest !== candidate.diff_content_digest) {
      const commands = input.manifest.commands.filter(
        (item) => item.criterion_id === command.criterion_id,
      );
      const criterionResults = results.filter((result) =>
        commands.some((item) => item.command_id === result.command_id),
      );
      const evidence = sealMachineCriterionEvidence({
        candidate,
        commands,
        criterionId: command.criterion_id,
        manifest: input.manifest,
        observedDiffContentDigest,
        results: criterionResults,
        workflowId: input.state.workflow_id,
      });
      return Object.freeze({
        evidence: [blockMachineCriterionEvidence(evidence)],
        observedDiffContentDigest,
        status: "blocked",
      });
    }
  }

  const evidence: CriterionEvidence[] = [];
  const machineCriterionIds = [
    ...new Set(input.manifest.commands.map((command) => command.criterion_id)),
  ];
  for (const criterionId of machineCriterionIds) {
    const commands = input.manifest.commands.filter(
      (command) => command.criterion_id === criterionId,
    );
    evidence.push(
      sealMachineCriterionEvidence({
        candidate,
        commands,
        criterionId,
        manifest: input.manifest,
        observedDiffContentDigest,
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
    status: verificationOverallStatus(rootCause, evidence),
  });
}
