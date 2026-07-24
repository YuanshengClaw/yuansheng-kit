import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpenCodeLocalProcessRunner,
  createOpenCodeVerificationLogSink,
} from "../../plugins/craft/opencode/src/controller-runtime";
import {
  buildOpenSshVerificationArgv,
  OPENSSH_REMOTE_CAPTURE_SCRIPT,
  quoteOpenSshPosixArgument,
} from "../../plugins/craft/opencode/src/openssh-verification-runtime";
import {
  canonicalizeJson,
  sealArtifact,
  sha256Digest,
} from "../../plugins/craft/workflows/artifacts/canonical";
import type {
  DiffManifest,
  MutationAuthorization,
  PatchCandidate,
  PatchPlan,
  RepositoryBinding,
  RootCauseArtifact,
  VerificationAuthorization,
  VerificationCommand,
  VerificationManifest,
  VerificationSource,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../../plugins/craft/workflows/artifacts/generated";
import { artifactRef } from "../../plugins/craft/workflows/artifacts/parser";
import type { JsonValue } from "../../plugins/craft/workflows/artifacts/strict-json";
import { parseCraftRuntimeConfigBytes } from "../../plugins/craft/workflows/runtime-config/config";
import { issueTrustedPrincipal } from "../../plugins/craft/workflows/state-machine/principal";
import {
  approveVerification,
  type LocalProcessResult,
  LocalVerificationError,
  type PreparedVerification,
  prepareVerification,
  runLocalVerification,
} from "../../plugins/craft/workflows/verification/local-verification";
import {
  runSshVerification,
  type SshCandidateObservation,
  type SshVerificationExecutor,
} from "../../plugins/craft/workflows/verification/ssh-verification";

const WORKFLOW_ID = "workflow:VERIFYING1234567";
const MACHINE_CRITERION = "criterion:MACHINE123456789";
const HUMAN_CRITERION = "criterion:HUMAN12345678901";
const COMMAND_ID = "command:LOCALVERIFY12345";
const CREATED_AT = "2026-07-24T11:00:00.000Z";
const EXPECTED_DIFF = sha256Digest(new TextEncoder().encode("candidate diff"));
const VERIFIER = issueTrustedPrincipal({
  agentId: "ys-craft-regression-verifier",
  sessionId: "session:VERIFIER12345678",
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

function seal<T extends YuanshengCraftContractV1>(payload: Omit<T, "artifact_digest">): T {
  return sealArtifact(payload as unknown as Record<string, JsonValue>) as unknown as T;
}

function runtimeConfig() {
  return parseCraftRuntimeConfigBytes(
    new TextEncoder().encode(
      JSON.stringify({
        repository: {
          preparation_policy: "manual-only",
          timeout_ms: 30_000,
        },
        verification: {
          max_iterations: 5,
          runners: [
            {
              command_proposals: [
                {
                  argv: ["test-runner", "--machine"],
                  id: "machine-check",
                },
              ],
              cwd: ".",
              id: "local",
              timeout_ms: 30_000,
              type: "local",
            },
          ],
        },
        version: 1,
      }),
    ),
  );
}

interface VerificationHarness {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly binaryPatchBytes: Uint8Array;
  readonly binding: RepositoryBinding;
  readonly candidate: PatchCandidate;
  readonly entries: DiffManifest["entries"];
  readonly logRoot: string;
  readonly projectRoot: string;
  readonly state: WorkflowState;
}

async function makeVerificationHarness(): Promise<VerificationHarness> {
  const root = await mkdtemp(join(tmpdir(), "ys-craft-verification-"));
  temporaryRoots.push(root);
  const projectRoot = join(root, "project");
  const logRoot = join(root, "logs");
  await mkdir(projectRoot);
  await mkdir(logRoot);
  const canonicalProject = await realpath(projectRoot);
  const canonicalLogs = await realpath(logRoot);
  const binding = seal<RepositoryBinding>({
    artifact_type: "repository-binding",
    artifact_version: 1,
    commit_sha: "0123456789abcdef0123456789abcdef01234567",
    created_at: CREATED_AT,
    git_root_realpath: canonicalProject,
    preparation_mode: "manual",
    product_root_realpath: canonicalProject,
    repository_url: "https://example.invalid/verification.git",
    target_worktree_realpath: canonicalProject,
    tree_digest: sha256Digest(new TextEncoder().encode("verification tree")),
  });
  const rootCause = seal<RootCauseArtifact>({
    artifact_type: "root-cause",
    artifact_version: 1,
    created_at: CREATED_AT,
    criteria: [
      {
        fact_ids: ["fact:VERIFYING1234567"],
        id: MACHINE_CRITERION,
        required: true,
        statement: "The machine check passes.",
      },
      {
        fact_ids: ["fact:VERIFYING1234567"],
        id: HUMAN_CRITERION,
        required: true,
        statement: "A human confirms the rendered behavior.",
      },
    ],
    entry_strategy: "problem-description",
    facts: [
      {
        evidence_refs: [artifactRef(binding)],
        id: "fact:VERIFYING1234567",
        statement: "The candidate requires machine and human verification.",
      },
    ],
    gaps: [],
    inferences: [
      {
        basis_fact_ids: ["fact:VERIFYING1234567"],
        id: "inference:VERIFYING1234567",
        statement: "Independent checks are required.",
      },
    ],
    problem_summary: "Verify each criterion independently.",
    provenance: {
      source: "problem-description",
      source_refs: [artifactRef(binding)],
    },
    status: "confirmed",
    workflow_id: WORKFLOW_ID,
  });
  const plan = seal<PatchPlan>({
    artifact_type: "patch-plan",
    artifact_version: 1,
    changes: [
      {
        criterion_ids: [MACHINE_CRITERION, HUMAN_CRITERION],
        id: "change:VERIFYING1234567",
        operation: "modify",
        path: "source.txt",
        reason: "Apply the verified change.",
        root_cause_item_ids: ["inference:VERIFYING1234567"],
        source_path: null,
      },
    ],
    created_at: "2026-07-24T11:01:00.000Z",
    criterion_ids: [MACHINE_CRITERION, HUMAN_CRITERION],
    non_goals: [],
    objectives: ["Satisfy both independent criteria."],
    plan_revision: 1,
    root_cause_ref: artifactRef(rootCause),
    status: "approved",
    workflow_id: WORKFLOW_ID,
  });
  const mutation = seal<MutationAuthorization>({
    action: "allow",
    artifact_type: "mutation-authorization",
    artifact_version: 1,
    authorized_changes: [
      {
        operation: "modify",
        path: "source.txt",
        planned_change_id: "change:VERIFYING1234567",
        source_path: null,
      },
    ],
    authorized_revision: 1,
    baseline_commit: binding.commit_sha,
    capability: "file-mutation-only",
    created_at: "2026-07-24T11:02:00.000Z",
    plan_ref: artifactRef(plan),
    principal: {
      agent_id: "ys-craft-patch-builder",
      session_id: "session:BUILDER123456789",
    },
    repository_binding_ref: artifactRef(binding),
    target_worktree_realpath: binding.target_worktree_realpath,
    workflow_id: WORKFLOW_ID,
  });
  const entries: DiffManifest["entries"] = [
    {
      binary: false,
      new_blob_digest: sha256Digest(new TextEncoder().encode("after")),
      new_mode: "100644",
      old_blob_digest: sha256Digest(new TextEncoder().encode("before")),
      old_mode: "100644",
      operation: "modify",
      path: "source.txt",
      source_path: null,
    },
  ];
  const binaryPatchDigest = sha256Digest(new TextEncoder().encode("binary patch"));
  const diff = seal<DiffManifest>({
    artifact_type: "diff-manifest",
    artifact_version: 1,
    binary_patch_digest: binaryPatchDigest,
    created_at: "2026-07-24T11:03:00.000Z",
    diff_content_digest: canonicalizeJson({
      binary_patch_digest: binaryPatchDigest,
      entries,
    }).digest,
    entries,
    mutation_authorization_ref: artifactRef(mutation),
    plan_ref: artifactRef(plan),
    repository_binding_ref: artifactRef(binding),
    workflow_id: WORKFLOW_ID,
  });
  const candidate = seal<PatchCandidate>({
    artifact_type: "patch-candidate",
    artifact_version: 1,
    candidate_revision: 1,
    created_at: "2026-07-24T11:04:00.000Z",
    diff_content_digest: diff.diff_content_digest,
    diff_manifest_ref: artifactRef(diff),
    iteration: 1,
    plan_ref: artifactRef(plan),
    status: "ready-for-verification",
    workflow_id: WORKFLOW_ID,
  });
  const activeArtifacts = [binding, rootCause, plan, mutation, diff, candidate] as const;
  const verifierAudit = {
    agent_id: "ys-craft-regression-verifier",
    session_id: "session:VERIFIER12345678",
  };
  const state = seal<WorkflowState>({
    artifact_refs: activeArtifacts.map(artifactRef),
    artifact_type: "workflow-state",
    artifact_version: 1,
    blocked_context: null,
    completed_at: null,
    coordinator: {
      agent_id: "ys-craft",
      session_id: "session:PRIMARY1234567890",
    },
    created_at: CREATED_AT,
    entry_context: {
      problem: "Verify the candidate.",
      repository_binding_ref: artifactRef(binding),
      strategy: "problem-description",
    },
    entry_strategy: "problem-description",
    phase: "verifying",
    phase_principal: verifierAudit,
    principal_audit: [
      {
        agent_id: "ys-craft",
        session_id: "session:PRIMARY1234567890",
      },
      verifierAudit,
    ],
    revision: 8,
    stale_artifact_refs: [],
    status: "active",
    updated_at: "2026-07-24T11:05:00.000Z",
    workflow_id: WORKFLOW_ID,
  });
  return {
    activeArtifacts,
    binaryPatchBytes: new TextEncoder().encode("binary patch"),
    binding,
    candidate,
    entries,
    logRoot: canonicalLogs,
    projectRoot: canonicalProject,
    state,
  };
}

function sshRuntimeConfig() {
  return parseCraftRuntimeConfigBytes(
    new TextEncoder().encode(
      JSON.stringify({
        repository: {
          preparation_policy: "manual-only",
          timeout_ms: 30_000,
        },
        verification: {
          max_iterations: 5,
          runners: [
            {
              command_proposals: [
                {
                  argv: ["test-runner", "--machine"],
                  id: "machine-check",
                },
              ],
              host_alias: "verification-host",
              id: "remote",
              remote_cwd: "/srv/ys-craft-candidate",
              timeout_ms: 30_000,
              type: "ssh",
            },
          ],
        },
        version: 1,
      }),
    ),
  );
}

function sshMachineCommand(): VerificationCommand {
  return {
    argv: ["test-runner", "--machine"],
    command_id: COMMAND_ID,
    criterion_id: MACHINE_CRITERION,
    cwd: "/srv/ys-craft-candidate",
    environment_allowlist: [],
    host_alias: "verification-host",
    log_path: "remote-machine.log",
    required: true,
    runner_id: "remote",
    runner_type: "ssh",
    timeout_seconds: 30,
  };
}

function machineCommand(): VerificationCommand {
  return {
    argv: ["test-runner", "--machine"],
    command_id: COMMAND_ID,
    criterion_id: MACHINE_CRITERION,
    cwd: ".",
    environment_allowlist: ["CI"],
    host_alias: null,
    log_path: "machine.log",
    required: true,
    runner_id: "local",
    runner_type: "local",
    timeout_seconds: 30,
  };
}

function proposal(): Parameters<typeof prepareVerification>[0]["proposal"] {
  return {
    commands: [machineCommand()],
    humanCriterionIds: [HUMAN_CRITERION],
    sourceType: "official",
  };
}

function advanceState(
  state: WorkflowState,
  activeArtifacts: readonly YuanshengCraftContractV1[],
): WorkflowState {
  const { artifact_digest: _digest, ...payload } = state;
  return seal<WorkflowState>({
    ...payload,
    artifact_refs: activeArtifacts.map(artifactRef),
    revision: state.revision + 1,
    updated_at: "2026-07-24T11:06:00.000Z",
  });
}

function prepareHarnessArtifacts(harness: VerificationHarness): {
  readonly active: readonly YuanshengCraftContractV1[];
  readonly prepared: PreparedVerification;
  readonly state: WorkflowState;
} {
  const prepared = prepareVerification({
    activeArtifacts: harness.activeArtifacts,
    at: "2026-07-24T11:06:00.000Z",
    config: runtimeConfig(),
    logRootRealpath: harness.logRoot,
    previousManifests: [],
    principal: VERIFIER,
    proposal: proposal(),
    state: harness.state,
  });
  const active = [...harness.activeArtifacts, prepared.source, prepared.manifest];
  return {
    active,
    prepared,
    state: advanceState(harness.state, active),
  };
}

function prepareSshHarnessArtifacts(harness: VerificationHarness): {
  readonly active: readonly YuanshengCraftContractV1[];
  readonly prepared: PreparedVerification;
  readonly state: WorkflowState;
} {
  const prepared = prepareVerification({
    activeArtifacts: harness.activeArtifacts,
    at: "2026-07-24T11:06:00.000Z",
    config: sshRuntimeConfig(),
    logRootRealpath: harness.logRoot,
    previousManifests: [],
    principal: VERIFIER,
    proposal: {
      commands: [sshMachineCommand()],
      humanCriterionIds: [HUMAN_CRITERION],
      sourceType: "official",
    },
    state: harness.state,
  });
  const active = [...harness.activeArtifacts, prepared.source, prepared.manifest];
  return {
    active,
    prepared,
    state: advanceState(harness.state, active),
  };
}

function authorizeHarness(
  preparedHarness: ReturnType<typeof prepareHarnessArtifacts>,
  approved = true,
): {
  readonly active: readonly YuanshengCraftContractV1[];
  readonly authorization: VerificationAuthorization;
  readonly manifest: VerificationManifest;
  readonly source: VerificationSource;
  readonly state: WorkflowState;
} {
  const approval = approveVerification({
    activeArtifacts: preparedHarness.active,
    approved,
    at: "2026-07-24T11:07:00.000Z",
    manifest: preparedHarness.prepared.manifest,
    principal: VERIFIER,
    state: preparedHarness.state,
  });
  const active = [...preparedHarness.active, approval.authorization];
  return {
    active,
    authorization: approval.authorization,
    manifest: preparedHarness.prepared.manifest,
    source: preparedHarness.prepared.source,
    state: advanceState(preparedHarness.state, active),
  };
}

function clock() {
  let second = 10;
  return {
    now(): string {
      const value = `2026-07-24T11:07:${String(second).padStart(2, "0")}.000Z`;
      second += 1;
      return value;
    },
  };
}

const HUMAN_ALLOW = {
  action: "allow" as const,
  confirmationDigest: sha256Digest(new TextEncoder().encode("human allow")),
  finishedAt: "2026-07-24T11:08:01.000Z",
  sessionId: "session:HUMAN12345678901",
  startedAt: "2026-07-24T11:08:00.000Z",
};

describe("Yuansheng Craft local verification", () => {
  test("builds one candidate/config-bound manifest and requires exact approval", async () => {
    const harness = await makeVerificationHarness();
    const prepared = prepareHarnessArtifacts(harness);
    expect(prepared.prepared.source.source_type).toBe("official");
    expect(prepared.prepared.manifest).toMatchObject({
      baseline_commit: harness.binding.commit_sha,
      config_digest: runtimeConfig().configDigest,
      diff_content_digest: harness.candidate.diff_content_digest,
      human_criterion_ids: [HUMAN_CRITERION],
      log_root_realpath: harness.logRoot,
      target_worktree_realpath: harness.projectRoot,
    });
    const authorization = authorizeHarness(prepared);
    expect(authorization.authorization.action).toBe("allow");

    const userProvided = prepareVerification({
      activeArtifacts: harness.activeArtifacts,
      at: "2026-07-24T11:06:00.000Z",
      config: runtimeConfig(),
      logRootRealpath: harness.logRoot,
      previousManifests: [],
      principal: VERIFIER,
      proposal: {
        ...proposal(),
        commands: [
          {
            ...machineCommand(),
            argv: ["project-specific-runner", "--check"],
          },
        ],
        sourceType: "user-provided",
      },
      state: harness.state,
    });
    expect(userProvided.source.source_type).toBe("user-provided");

    expect(() =>
      prepareVerification({
        activeArtifacts: harness.activeArtifacts,
        at: "2026-07-24T11:06:00.000Z",
        config: runtimeConfig(),
        logRootRealpath: harness.logRoot,
        previousManifests: [prepared.prepared.manifest],
        principal: VERIFIER,
        proposal: {
          ...proposal(),
          sourceType: "user-provided",
        },
        state: harness.state,
      }),
    ).toThrow("already has a verification manifest");

    expect(() =>
      prepareVerification({
        activeArtifacts: harness.activeArtifacts,
        at: "2026-07-24T11:06:00.000Z",
        config: runtimeConfig(),
        logRootRealpath: harness.logRoot,
        previousManifests: [],
        principal: VERIFIER,
        proposal: {
          ...proposal(),
          commands: [
            {
              ...machineCommand(),
              argv: ["unconfigured-command"],
            },
          ],
        },
        state: harness.state,
      }),
    ).toThrow(LocalVerificationError);
  });

  test("records independent machine and human evidence without leaking environment", async () => {
    const harness = await makeVerificationHarness();
    const authorized = authorizeHarness(prepareHarnessArtifacts(harness));
    const runnerInputs: unknown[] = [];
    const logs: Uint8Array[] = [];
    const processResult: LocalProcessResult = {
      exitCode: 0,
      kind: "exited",
      outputArtifactDigests: [sha256Digest(new TextEncoder().encode("coverage artifact"))],
      stderr: new TextEncoder().encode("stderr"),
      stdout: new TextEncoder().encode("stdout"),
    };
    const result = await runLocalVerification({
      activeArtifacts: authorized.active,
      authorization: authorized.authorization,
      candidateObserver: {
        async observeDiffContentDigest() {
          return harness.candidate.diff_content_digest;
        },
      },
      clock: clock(),
      environment: {
        CI: "1",
        SECRET_TOKEN: "must-not-pass",
      },
      humanDecisions: new Map([[HUMAN_CRITERION, HUMAN_ALLOW]]),
      logSink: {
        async write(input) {
          logs.push(input.bytes);
        },
      },
      manifest: authorized.manifest,
      principal: VERIFIER,
      processRunner: {
        async run(input) {
          runnerInputs.push(input);
          return processResult;
        },
      },
      state: authorized.state,
    });

    expect(result.status).toBe("pass");
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.find((item) => item.criterion_id === MACHINE_CRITERION)).toMatchObject({
      evidence_kind: "machine",
      status: "pass",
    });
    expect(result.evidence.find((item) => item.criterion_id === HUMAN_CRITERION)).toMatchObject({
      evidence_kind: "human",
      status: "pass",
    });
    expect(runnerInputs).toEqual([
      expect.objectContaining({
        argv: ["test-runner", "--machine"],
        environment: { CI: "1" },
        timeoutMs: 30_000,
      }),
    ]);
    expect(logs).toHaveLength(1);
  });

  test("exit zero cannot bulk-pass a missing human criterion", async () => {
    const harness = await makeVerificationHarness();
    const authorized = authorizeHarness(prepareHarnessArtifacts(harness));
    const result = await runLocalVerification({
      activeArtifacts: authorized.active,
      authorization: authorized.authorization,
      candidateObserver: {
        async observeDiffContentDigest() {
          return harness.candidate.diff_content_digest;
        },
      },
      clock: clock(),
      environment: {},
      humanDecisions: new Map(),
      logSink: { async write() {} },
      manifest: authorized.manifest,
      principal: VERIFIER,
      processRunner: {
        async run() {
          return {
            exitCode: 0,
            kind: "exited",
            outputArtifactDigests: [],
            stderr: new Uint8Array(),
            stdout: new Uint8Array(),
          };
        },
      },
      state: authorized.state,
    });
    expect(result.status).toBe("blocked");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.criterion_id).toBe(MACHINE_CRITERION);
  });

  test("deny, infrastructure errors, log failures, and candidate drift never pass", async () => {
    const harness = await makeVerificationHarness();
    const prepared = prepareHarnessArtifacts(harness);
    const denied = authorizeHarness(prepared, false);
    await expect(
      runLocalVerification({
        activeArtifacts: denied.active,
        authorization: denied.authorization,
        candidateObserver: {
          async observeDiffContentDigest() {
            return harness.candidate.diff_content_digest;
          },
        },
        clock: clock(),
        environment: {},
        humanDecisions: new Map([[HUMAN_CRITERION, HUMAN_ALLOW]]),
        logSink: { async write() {} },
        manifest: denied.manifest,
        principal: VERIFIER,
        processRunner: {
          async run() {
            throw new Error("must not execute");
          },
        },
        state: denied.state,
      }),
    ).rejects.toThrow("lacks the exact allowed");

    const authorized = authorizeHarness(prepared);
    const infra = await runLocalVerification({
      activeArtifacts: authorized.active,
      authorization: authorized.authorization,
      candidateObserver: {
        async observeDiffContentDigest() {
          return harness.candidate.diff_content_digest;
        },
      },
      clock: clock(),
      environment: {},
      humanDecisions: new Map([[HUMAN_CRITERION, HUMAN_ALLOW]]),
      logSink: { async write() {} },
      manifest: authorized.manifest,
      principal: VERIFIER,
      processRunner: {
        async run() {
          return {
            error: "timeout",
            kind: "infra_error",
            stderr: new Uint8Array(),
            stdout: new Uint8Array(),
          };
        },
      },
      state: authorized.state,
    });
    expect(infra.status).toBe("infra_error");
    expect(infra.evidence[0]?.command_results[0]).toMatchObject({
      infra_error: "timeout",
      status: "infra_error",
    });

    const logFailure = await runLocalVerification({
      activeArtifacts: authorized.active,
      authorization: authorized.authorization,
      candidateObserver: {
        async observeDiffContentDigest() {
          return harness.candidate.diff_content_digest;
        },
      },
      clock: clock(),
      environment: {},
      humanDecisions: new Map([[HUMAN_CRITERION, HUMAN_ALLOW]]),
      logSink: {
        async write() {
          throw new Error("disk full");
        },
      },
      manifest: authorized.manifest,
      principal: VERIFIER,
      processRunner: {
        async run() {
          return {
            exitCode: 0,
            kind: "exited",
            outputArtifactDigests: [],
            stderr: new Uint8Array(),
            stdout: new Uint8Array(),
          };
        },
      },
      state: authorized.state,
    });
    expect(logFailure.status).toBe("infra_error");
    expect(logFailure.evidence[0]?.command_results[0]).toMatchObject({
      exit_code: 0,
      infra_error: "log_write_failure",
      log_persisted: false,
    });

    let observations = 0;
    let executions = 0;
    const drifted = await runLocalVerification({
      activeArtifacts: authorized.active,
      authorization: authorized.authorization,
      candidateObserver: {
        async observeDiffContentDigest() {
          observations += 1;
          return observations < 3 ? harness.candidate.diff_content_digest : EXPECTED_DIFF;
        },
      },
      clock: clock(),
      environment: {},
      humanDecisions: new Map([[HUMAN_CRITERION, HUMAN_ALLOW]]),
      logSink: { async write() {} },
      manifest: authorized.manifest,
      principal: VERIFIER,
      processRunner: {
        async run() {
          executions += 1;
          return {
            exitCode: 0,
            kind: "exited",
            outputArtifactDigests: [],
            stderr: new Uint8Array(),
            stdout: new Uint8Array(),
          };
        },
      },
      state: authorized.state,
    });
    expect(executions).toBe(1);
    expect(drifted.status).toBe("blocked");
    expect(drifted.observedDiffContentDigest).toBe(EXPECTED_DIFF);
    expect(drifted.evidence[0]?.status).toBe("blocked");
  });

  test("OpenCode local adapter uses argv without a shell, times out, and writes logs once", async () => {
    const root = await mkdtemp(join(tmpdir(), "ys-craft-local-runner-"));
    temporaryRoots.push(root);
    const runner = createOpenCodeLocalProcessRunner();
    const executed = await runner.run({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write((process.env.CI ?? '') + ':' + (process.env.SECRET ?? ''))",
      ],
      cwdRealpath: root,
      environment: { CI: "1" },
      timeoutMs: 5_000,
    });
    expect(executed.kind).toBe("exited");
    if (executed.kind === "exited") {
      expect(executed.exitCode).toBe(0);
      expect(new TextDecoder().decode(executed.stdout)).toBe("1:");
    }

    const timedOut = await runner.run({
      argv: [process.execPath, "-e", "await Bun.sleep(1000)"],
      cwdRealpath: root,
      environment: {},
      timeoutMs: 10,
    });
    expect(timedOut).toMatchObject({
      error: "timeout",
      kind: "infra_error",
    });

    const logPath = join(root, "verification.log");
    const sink = createOpenCodeVerificationLogSink();
    await sink.write({
      bytes: new TextEncoder().encode("immutable log"),
      logRealpath: logPath,
    });
    expect(await readFile(logPath, "utf8")).toBe("immutable log");
    await expect(
      sink.write({
        bytes: new TextEncoder().encode("overwrite"),
        logRealpath: logPath,
      }),
    ).rejects.toThrow();
    expect(await readFile(logPath, "utf8")).toBe("immutable log");
  });
});

describe("Yuansheng Craft SSH verification", () => {
  function remoteObservation(harness: VerificationHarness): SshCandidateObservation {
    return {
      binaryPatchBytes: harness.binaryPatchBytes,
      entries: harness.entries,
      headCommit: harness.binding.commit_sha,
      remoteCwdRealpath: "/srv/ys-craft-candidate",
      remoteIdentity: "build-host.example:1000:/srv/repository",
    };
  }

  test("binds the approved host and records the same per-criterion evidence", async () => {
    const harness = await makeVerificationHarness();
    const authorized = authorizeHarness(prepareSshHarnessArtifacts(harness));
    const calls: unknown[] = [];
    const logs: Uint8Array[] = [];
    const executor: SshVerificationExecutor = {
      async captureCandidate(input) {
        calls.push({ input, operation: "capture" });
        return { kind: "observed", observation: remoteObservation(harness) };
      },
      async run(input) {
        calls.push({ input, operation: "run" });
        return {
          exitCode: 0,
          kind: "exited",
          outputArtifactDigests: [],
          stderr: new TextEncoder().encode("remote stderr"),
          stdout: new TextEncoder().encode("remote stdout"),
        };
      },
    };
    const result = await runSshVerification({
      activeArtifacts: authorized.active,
      authorization: authorized.authorization,
      clock: clock(),
      humanDecisions: new Map([[HUMAN_CRITERION, HUMAN_ALLOW]]),
      logSink: {
        async write(input) {
          logs.push(input.bytes);
        },
      },
      manifest: authorized.manifest,
      principal: VERIFIER,
      sshRunner: executor,
      state: authorized.state,
    });

    expect(result).toMatchObject({
      reason: "complete",
      remoteWorktree: {
        cleanupResponsibility: "user",
        currentState: "unchanged",
      },
      status: "pass",
    });
    expect(calls).toEqual([
      {
        input: {
          baselineCommit: harness.binding.commit_sha,
          hostAlias: "verification-host",
          remoteCwd: "/srv/ys-craft-candidate",
          timeoutMs: 30_000,
        },
        operation: "capture",
      },
      {
        input: {
          argv: ["test-runner", "--machine"],
          hostAlias: "verification-host",
          remoteCwd: "/srv/ys-craft-candidate",
          timeoutMs: 30_000,
        },
        operation: "run",
      },
      {
        input: {
          baselineCommit: harness.binding.commit_sha,
          hostAlias: "verification-host",
          remoteCwd: "/srv/ys-craft-candidate",
          timeoutMs: 30_000,
        },
        operation: "capture",
      },
    ]);
    expect(logs).toHaveLength(1);
    expect(new TextDecoder().decode(logs[0])).toContain('"host_alias":"verification-host"');
    expect(new TextDecoder().decode(logs[0])).toContain(
      '"preflight_protocol":"ys-craft-canonical-diff-v1"',
    );
  });

  test("rejects remote candidate mismatch before command execution", async () => {
    const harness = await makeVerificationHarness();
    const authorized = authorizeHarness(prepareSshHarnessArtifacts(harness));
    let executions = 0;
    const result = await runSshVerification({
      activeArtifacts: authorized.active,
      authorization: authorized.authorization,
      clock: clock(),
      humanDecisions: new Map([[HUMAN_CRITERION, HUMAN_ALLOW]]),
      logSink: { async write() {} },
      manifest: authorized.manifest,
      principal: VERIFIER,
      sshRunner: {
        async captureCandidate() {
          return {
            kind: "observed",
            observation: {
              ...remoteObservation(harness),
              entries: [
                ...harness.entries,
                {
                  binary: false,
                  new_blob_digest: sha256Digest(new TextEncoder().encode("extra")),
                  new_mode: "100644",
                  old_blob_digest: null,
                  old_mode: null,
                  operation: "create",
                  path: "extra.txt",
                  source_path: null,
                },
              ],
            },
          };
        },
        async run() {
          executions += 1;
          throw new Error("must not execute");
        },
      },
      state: authorized.state,
    });
    expect(executions).toBe(0);
    expect(result).toMatchObject({
      reason: "remote_candidate_mismatch",
      remoteWorktree: {
        cleanupResponsibility: "user",
        currentState: "drifted",
      },
      status: "blocked",
    });
  });

  test("rejects wrong remote cwd and HEAD before command execution", async () => {
    const harness = await makeVerificationHarness();
    const authorized = authorizeHarness(prepareSshHarnessArtifacts(harness));
    for (const observation of [
      {
        ...remoteObservation(harness),
        remoteCwdRealpath: "/srv/wrong-candidate",
      },
      {
        ...remoteObservation(harness),
        headCommit: "abcdef0123456789abcdef0123456789abcdef01",
      },
    ]) {
      let executions = 0;
      const result = await runSshVerification({
        activeArtifacts: authorized.active,
        authorization: authorized.authorization,
        clock: clock(),
        humanDecisions: new Map([[HUMAN_CRITERION, HUMAN_ALLOW]]),
        logSink: { async write() {} },
        manifest: authorized.manifest,
        principal: VERIFIER,
        sshRunner: {
          async captureCandidate() {
            return { kind: "observed", observation };
          },
          async run() {
            executions += 1;
            throw new Error("must not execute");
          },
        },
        state: authorized.state,
      });
      expect(executions).toBe(0);
      expect(result.status).toBe("blocked");
    }
  });

  test("invalidates a result when verification mutates the remote candidate", async () => {
    const harness = await makeVerificationHarness();
    const authorized = authorizeHarness(prepareSshHarnessArtifacts(harness));
    let captures = 0;
    const result = await runSshVerification({
      activeArtifacts: authorized.active,
      authorization: authorized.authorization,
      clock: clock(),
      humanDecisions: new Map([[HUMAN_CRITERION, HUMAN_ALLOW]]),
      logSink: { async write() {} },
      manifest: authorized.manifest,
      principal: VERIFIER,
      sshRunner: {
        async captureCandidate() {
          captures += 1;
          if (captures === 1) {
            return { kind: "observed", observation: remoteObservation(harness) };
          }
          return {
            kind: "observed",
            observation: {
              ...remoteObservation(harness),
              entries: harness.entries.map((entry) => ({
                ...entry,
                new_blob_digest: sha256Digest(new TextEncoder().encode("mutated")),
              })),
            },
          };
        },
        async run() {
          return {
            exitCode: 0,
            kind: "exited",
            outputArtifactDigests: [],
            stderr: new Uint8Array(),
            stdout: new Uint8Array(),
          };
        },
      },
      state: authorized.state,
    });
    expect(result).toMatchObject({
      evidence: [expect.objectContaining({ status: "blocked" })],
      reason: "remote_verification_mutated_candidate",
      remoteWorktree: {
        cleanupResponsibility: "user",
        currentState: "drifted",
      },
      status: "blocked",
    });
  });

  test("classifies OpenSSH preflight failures as infrastructure errors", async () => {
    const harness = await makeVerificationHarness();
    const authorized = authorizeHarness(prepareSshHarnessArtifacts(harness));
    const result = await runSshVerification({
      activeArtifacts: authorized.active,
      authorization: authorized.authorization,
      clock: clock(),
      humanDecisions: new Map([[HUMAN_CRITERION, HUMAN_ALLOW]]),
      logSink: { async write() {} },
      manifest: authorized.manifest,
      principal: VERIFIER,
      sshRunner: {
        async captureCandidate() {
          return {
            error: "timeout",
            kind: "infra_error",
            stderr: new TextEncoder().encode("network timeout"),
            stdout: new Uint8Array(),
          };
        },
        async run() {
          throw new Error("must not execute");
        },
      },
      state: authorized.state,
    });
    expect(result).toMatchObject({
      reason: "remote_preflight_infra_error",
      remoteWorktree: {
        cleanupResponsibility: "user",
        currentState: "unknown",
      },
      status: "infra_error",
    });
  });

  test("keeps remote command timeout as infrastructure evidence", async () => {
    const harness = await makeVerificationHarness();
    const authorized = authorizeHarness(prepareSshHarnessArtifacts(harness));
    const result = await runSshVerification({
      activeArtifacts: authorized.active,
      authorization: authorized.authorization,
      clock: clock(),
      humanDecisions: new Map([[HUMAN_CRITERION, HUMAN_ALLOW]]),
      logSink: { async write() {} },
      manifest: authorized.manifest,
      principal: VERIFIER,
      sshRunner: {
        async captureCandidate() {
          return { kind: "observed", observation: remoteObservation(harness) };
        },
        async run() {
          return {
            error: "timeout",
            kind: "infra_error",
            stderr: new TextEncoder().encode("remote timeout"),
            stdout: new Uint8Array(),
          };
        },
      },
      state: authorized.state,
    });
    expect(result.status).toBe("infra_error");
    expect(result.evidence[0]?.command_results[0]).toMatchObject({
      infra_error: "timeout",
      status: "infra_error",
    });
  });

  test("centralizes quoting and never proposes synchronization or credential options", async () => {
    expect(quoteOpenSshPosixArgument("a'b;$(touch /tmp/not-run)")).toBe(
      "'a'\"'\"'b;$(touch /tmp/not-run)'",
    );
    const argv = buildOpenSshVerificationArgv({
      argv: ["runner", "a'b;$(touch /tmp/not-run)"],
      hostAlias: "verification-host",
      remoteCwd: "/srv/ys-craft-candidate",
      sshExecutable: "/usr/bin/ssh",
    });
    expect(argv.slice(0, 3)).toEqual(["/usr/bin/ssh", "--", "verification-host"]);
    expect(argv).toHaveLength(4);
    expect(argv.join(" ")).not.toMatch(/\s-(?:i|F|o)\s/u);
    expect(OPENSSH_REMOTE_CAPTURE_SCRIPT).not.toMatch(
      /\bgit\s+(?:clone|fetch|checkout)\b|\b(?:apply|rsync|scp|sync)\b/iu,
    );

    const harness = await makeVerificationHarness();
    const prepared = prepareSshHarnessArtifacts(harness).prepared.manifest;
    const serialized = JSON.stringify(prepared);
    expect(serialized).toContain('"host_alias":"verification-host"');
    expect(serialized).not.toMatch(/credential|identityfile|password|private[_-]?key|token/iu);

    expect(() =>
      prepareVerification({
        activeArtifacts: harness.activeArtifacts,
        at: "2026-07-24T11:06:00.000Z",
        config: sshRuntimeConfig(),
        logRootRealpath: harness.logRoot,
        previousManifests: [],
        principal: VERIFIER,
        proposal: {
          commands: [{ ...sshMachineCommand(), host_alias: "different-host" }],
          humanCriterionIds: [HUMAN_CRITERION],
          sourceType: "official",
        },
        state: harness.state,
      }),
    ).toThrow("differs from its configured proposal");
  });
});
