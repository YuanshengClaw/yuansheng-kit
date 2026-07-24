import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";

import { canonicalizeJson, sha256Digest } from "../../workflows/artifacts/canonical";
import type {
  ArtifactRef,
  MutationAuthorization,
  PatchCandidate,
  VerificationCommand,
  VerificationManifest,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../../workflows/artifacts/generated";
import { artifactRef, parseCraftContractBytes } from "../../workflows/artifacts/parser";
import { type JsonValue, parseStrictJson } from "../../workflows/artifacts/strict-json";
import {
  snapshotVerifiedSealedBlueprint,
  verifySealedBlueprintDirectory,
} from "../../workflows/blueprint-import/sealed-verifier";
import {
  buildBlueprintReviewSubject,
  reviewBlueprintForImport,
} from "../../workflows/blueprint-import/transaction";
import {
  type BinaryGitRunner,
  captureCanonicalDiff,
  capturePatchCandidate,
} from "../../workflows/building/candidate-capture";
import { approvePatchPlan } from "../../workflows/building/plan-authorization";
import {
  buildManagedRepositoryPreparationPlan,
  executeManagedRepositoryPreparation,
  type GitRunner,
  type ManagedRepositoryPreparationPlan,
  type ManagedRepositoryPreparationResult,
  prepareRepositoryPreflight,
  type RepositoryExpectation,
  type RepositoryPreflightReceipt,
} from "../../workflows/repository-preflight/preflight";
import {
  prepareDelivery,
  requestPatchChanges,
  reviewPatch,
} from "../../workflows/review-delivery/review-delivery";
import {
  bindPhasePrincipal,
  createBlueprintWorkflowState,
  createProblemWorkflowState,
  recordPhaseArtifact,
  remediateBlockedWorkflow,
  returnWorkflowToPhase,
  transitionWorkflow,
} from "../../workflows/state-machine/engine";
import {
  type ActiveWorkflowPhase,
  isActiveWorkflowPhase,
  isYsCraftAgentId,
  PHASE_OWNER,
  WORKFLOW_PHASES,
  type WorkflowPhase,
} from "../../workflows/state-machine/phases";
import {
  auditTrustedPrincipal,
  type TrustedPrincipal,
} from "../../workflows/state-machine/principal";
import { evaluateStopGate } from "../../workflows/state-machine/stop-gate";
import {
  type AtomicWorkflowStore,
  appendActionJournal,
  createActionJournal,
  openAtomicWorkflowStore,
  type WorkflowSnapshot,
} from "../../workflows/store";
import { CRAFT_TOOL_SURFACE, type CraftToolId } from "../../workflows/tool-surface";
import {
  approveVerification,
  type LocalProcessRunner,
  prepareVerification,
  runLocalVerification,
  sealHumanCriterionEvidence,
  type VerificationLogSink,
  type VerificationSourceProposal,
} from "../../workflows/verification/local-verification";
import {
  runSshVerification,
  type SshVerificationExecutor,
} from "../../workflows/verification/ssh-verification";
import type { OpenCodeCraftController } from "./controller-runtime";
import { canonicalOpenCodeSessionId, issueOpenCodePrincipal } from "./platform-principal";

type StoredArtifact = Exclude<
  YuanshengCraftContractV1,
  WorkflowState | Extract<YuanshengCraftContractV1, { artifact_type: "action-journal" }>
>;

export interface OpenCodeCraftRuntimeDependencies {
  readonly binaryGit: BinaryGitRunner;
  readonly builderWrite: {
    readonly activate: (
      context: ToolContext,
      state: WorkflowState,
      activeArtifacts: readonly YuanshengCraftContractV1[],
    ) => void;
  };
  readonly clock: { readonly now: () => string };
  readonly controller: OpenCodeCraftController;
  readonly git: GitRunner;
  readonly id: { readonly next: (prefix: "operation" | "workflow") => string };
  readonly localProcess: LocalProcessRunner;
  readonly logSink: VerificationLogSink;
  readonly reloadController: () => Promise<OpenCodeCraftController>;
  readonly ssh: () => Promise<SshVerificationExecutor>;
}

export interface OpenCodeCraftStatus {
  readonly blocked_remediation: WorkflowState["blocked_context"];
  readonly current_artifacts: readonly ArtifactRef[];
  readonly pending_repository_preflight: PendingRepositoryPreflight | null;
  readonly phase: WorkflowPhase;
  readonly revision: number;
  readonly session_binding: {
    readonly coordinator: WorkflowState["coordinator"];
    readonly phase_principal: WorkflowState["phase_principal"];
  };
  readonly stale_refs: readonly ArtifactRef[];
  readonly status: WorkflowState["status"];
  readonly verification_source: ArtifactRef | null;
  readonly workflow_id: string;
}

interface PendingRepositoryPreflight {
  readonly plan: ManagedRepositoryPreparationPlan | null;
  readonly request_id: string;
  readonly status: "decision-required" | "ready";
  readonly target_worktree: string;
  readonly workflow_id: string;
}

interface PreparedManagedRepository {
  readonly plan: ManagedRepositoryPreparationPlan;
  readonly result: ManagedRepositoryPreparationResult;
}

interface SessionPointer {
  readonly agent: string;
  readonly workflowId: string;
}

interface RuntimeEvent {
  readonly properties?: unknown;
  readonly type: string;
}

const TOOL_BY_ID = new Map(CRAFT_TOOL_SURFACE.map((definition) => [definition.id, definition]));
const UTF8 = new TextEncoder();

function fail(message: string): never {
  throw new Error(`YS_CRAFT_OPENCODE_DENIED: ${message}`);
}

function requireAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    return fail(`${label} must be a canonical absolute path`);
  }
  return path;
}

function requireRecord(value: JsonValue, label: string): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(`${label} must be an object`);
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return fail(`${label} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") {
    return fail(`${label} must be a boolean`);
  }
  return value;
}

function requireNumber(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(`${label} must be a finite number`);
  }
  return value;
}

function requireStringArray(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return fail(`${label} must be a string array`);
  }
  return [...value] as string[];
}

function exactKeys(
  record: Readonly<Record<string, JsonValue>>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} contains an unknown or missing field`);
  }
}

function parseVerificationProposal(source: string): VerificationSourceProposal {
  const root = requireRecord(parseStrictJson(UTF8.encode(source)), "verification source");
  exactKeys(root, ["commands", "humanCriterionIds", "sourceType"], "verification source");
  if (!Array.isArray(root.commands)) {
    return fail("verification source commands must be an array");
  }
  const commands = root.commands.map((item, index): VerificationCommand => {
    const command = requireRecord(item, `verification command ${index}`);
    exactKeys(
      command,
      [
        "argv",
        "command_id",
        "criterion_id",
        "cwd",
        "environment_allowlist",
        "host_alias",
        "log_path",
        "required",
        "runner_id",
        "runner_type",
        "timeout_seconds",
      ],
      `verification command ${index}`,
    );
    const argv = requireStringArray(command.argv, `verification command ${index} argv`);
    const first = argv[0];
    if (first === undefined) {
      return fail(`verification command ${index} argv must not be empty`);
    }
    const hostAlias = command.host_alias;
    if (hostAlias !== null && typeof hostAlias !== "string") {
      return fail(`verification command ${index} host_alias must be string or null`);
    }
    const runnerType = command.runner_type;
    if (runnerType !== "local" && runnerType !== "ssh") {
      return fail(`verification command ${index} runner_type is invalid`);
    }
    return {
      argv: [first, ...argv.slice(1)],
      command_id: requireString(command.command_id, "command_id"),
      criterion_id: requireString(command.criterion_id, "criterion_id"),
      cwd: requireString(command.cwd, "cwd"),
      environment_allowlist: requireStringArray(
        command.environment_allowlist,
        "environment_allowlist",
      ),
      host_alias: hostAlias,
      log_path: requireString(command.log_path, "log_path"),
      required: requireBoolean(command.required, "required"),
      runner_id: requireString(command.runner_id, "runner_id"),
      runner_type: runnerType,
      timeout_seconds: requireNumber(command.timeout_seconds, "timeout_seconds"),
    };
  });
  const sourceType = root.sourceType;
  if (sourceType !== "official" && sourceType !== "user-provided") {
    return fail("verification sourceType is invalid");
  }
  return Object.freeze({
    commands: Object.freeze(commands),
    humanCriterionIds: Object.freeze(
      requireStringArray(root.humanCriterionIds, "humanCriterionIds"),
    ),
    sourceType,
  });
}

function activeArtifacts(snapshot: WorkflowSnapshot): readonly StoredArtifact[] {
  const active = new Set(snapshot.state.artifact_refs.map((reference) => reference.digest));
  return snapshot.artifacts.filter((artifact) => active.has(artifact.artifact_digest));
}

function oneArtifact<T extends StoredArtifact["artifact_type"]>(
  artifacts: readonly StoredArtifact[],
  artifactType: T,
): Extract<StoredArtifact, { artifact_type: T }> {
  const matches = artifacts.filter(
    (artifact): artifact is Extract<StoredArtifact, { artifact_type: T }> =>
      artifact.artifact_type === artifactType,
  );
  if (matches.length !== 1) {
    return fail(`exactly one active ${artifactType} is required`);
  }
  return matches[0] as Extract<StoredArtifact, { artifact_type: T }>;
}

async function gitLine(
  git: GitRunner,
  targetWorktree: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  const result = await git.run(
    ["git", "-c", "core.hooksPath=/dev/null", "-C", targetWorktree, ...args],
    timeoutMs,
  );
  const value = result.stdout.trim();
  if (result.exitCode !== 0 || value.length === 0 || value.includes("\n")) {
    return fail(result.stderr.trim() || `Git ${args.join(" ")} failed`);
  }
  return value;
}

async function inspectExpectation(
  git: GitRunner,
  targetWorktree: string,
  timeoutMs: number,
): Promise<RepositoryExpectation> {
  return Object.freeze({
    commitSha: await gitLine(git, targetWorktree, ["rev-parse", "--verify", "HEAD"], timeoutMs),
    repositoryUrl: await gitLine(git, targetWorktree, ["remote", "get-url", "origin"], timeoutMs),
  });
}

function defaultId(prefix: "operation" | "workflow"): string {
  return `${prefix}:${randomUUID().replaceAll("-", "")}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function createDefaultOpenCodeCraftRuntimeDependencies(input: {
  readonly binaryGit: BinaryGitRunner;
  readonly builderWrite: OpenCodeCraftRuntimeDependencies["builderWrite"];
  readonly controller: OpenCodeCraftController;
  readonly git: GitRunner;
  readonly localProcess: LocalProcessRunner;
  readonly logSink: VerificationLogSink;
  readonly reloadController: () => Promise<OpenCodeCraftController>;
  readonly ssh: () => Promise<SshVerificationExecutor>;
}): OpenCodeCraftRuntimeDependencies {
  return Object.freeze({
    ...input,
    clock: Object.freeze({ now: () => new Date().toISOString() }),
    id: Object.freeze({ next: defaultId }),
  });
}

export class OpenCodeCraftRuntime {
  readonly #dependencies: OpenCodeCraftRuntimeDependencies;
  readonly #managed = new Map<string, PreparedManagedRepository>();
  readonly #pending = new Map<string, PendingRepositoryPreflight>();
  readonly #pointers = new Map<string, SessionPointer>();
  readonly #sessionAgents = new Map<string, string>();

  constructor(dependencies: OpenCodeCraftRuntimeDependencies) {
    this.#dependencies = dependencies;
  }

  observeChatAgent(sessionId: string, agent: string): void {
    const previous = this.#sessionAgents.get(sessionId);
    if (previous !== undefined && previous !== agent) {
      fail("one OpenCode session cannot change agent identity");
    }
    if (!isYsCraftAgentId(agent)) {
      fail("OpenCode supplied an unsupported Yuansheng Craft agent identity");
    }
    this.#sessionAgents.set(sessionId, agent);
  }

  compactionPointer(sessionId: string): string | null {
    const pointer = this.#pointers.get(sessionId);
    return pointer === undefined
      ? null
      : canonicalizeJson({
          kind: "ys-craft-compaction-pointer",
          version: 1,
          workflow_id: pointer.workflowId,
        }).text;
  }

  async handleEvent(event: RuntimeEvent): Promise<void> {
    const properties =
      typeof event.properties === "object" &&
      event.properties !== null &&
      !Array.isArray(event.properties)
        ? (event.properties as Readonly<Record<string, unknown>>)
        : null;
    const sessionId = typeof properties?.sessionID === "string" ? properties.sessionID : undefined;
    if (sessionId === undefined || event.type === "session.compacted") {
      return;
    }
    if (event.type !== "session.idle") {
      return;
    }
    const pointer = this.#pointers.get(sessionId);
    const agent = this.#sessionAgents.get(sessionId);
    if (pointer === undefined || agent === undefined) {
      return;
    }
    const principal = issueOpenCodePrincipal({ agentId: agent, sessionId });
    const snapshot = await (await this.#openStore()).readExactWorkflow(pointer.workflowId);
    const result = evaluateStopGate({ principal, state: snapshot.state });
    if (!result.allowStop) {
      fail(
        `session cannot stop while ${result.workflowId} is active: ${result.missingGates.join(", ")}`,
      );
    }
  }

  async startProblem(
    input: { readonly problem: string; readonly target_worktree: string },
    context: ToolContext,
  ): Promise<string> {
    const principal = this.#principal(context, "ys-craft");
    const workflowId = this.#dependencies.id.next("workflow");
    const receipt = await this.#manualPreflight(
      workflowId,
      requireAbsolutePath(input.target_worktree, "target_worktree"),
      context,
      [],
    );
    const at = this.#dependencies.clock.now();
    const state = createProblemWorkflowState({
      at,
      coordinator: principal,
      problem: input.problem,
      repositoryBinding: receipt.repository_binding,
      workflowId,
    });
    const journal = createActionJournal({
      action: "ys_craft_start_problem",
      at,
      principal: auditTrustedPrincipal(principal),
      result: "succeeded",
      state,
      subjectRefs: [artifactRef(receipt.repository_binding)],
    });
    const snapshot = await (await this.#openStore()).initializeWorkflow({
      artifacts: [receipt.repository_binding],
      configDigest: receipt.config_digest,
      controllerRootRealpath: receipt.controller_root_realpath,
      journal,
      state,
    });
    this.#bindPointer(context, snapshot.state.workflow_id);
    this.#pending.delete(workflowId);
    return canonicalizeJson(this.#statusOf(snapshot)).text;
  }

  async reviewBlueprint(
    input: {
      readonly sealed_function_directory: string;
      readonly target_worktree: string;
    },
    context: ToolContext,
  ): Promise<string> {
    const principal = this.#principal(context, "ys-craft");
    const workflowId = this.#dependencies.id.next("workflow");
    const sealedDirectory = requireAbsolutePath(
      input.sealed_function_directory,
      "sealed_function_directory",
    );
    const targetWorktree = requireAbsolutePath(input.target_worktree, "target_worktree");
    await context.ask({
      always: [],
      metadata: {
        config_digest: this.#dependencies.controller.configDocument.configDigest,
        controller_root: this.#dependencies.controller.controllerRoot,
        expected_create_or_update: [this.#dependencies.controller.stateRootPath],
        sealed_function_directory: sealedDirectory,
        state_root: this.#dependencies.controller.stateRootPath,
        target_worktree: targetWorktree,
        workflow_id: workflowId,
      },
      patterns: [targetWorktree, sealedDirectory],
      permission: "ys_craft_external_directory",
    });
    const verified = await verifySealedBlueprintDirectory(sealedDirectory);
    const blueprint = snapshotVerifiedSealedBlueprint(verified).blueprint;
    const expectation =
      blueprint.section1_basic_info.repository_url === null ||
      blueprint.section1_basic_info.commit_hash === null
        ? null
        : Object.freeze({
            commitSha: blueprint.section1_basic_info.commit_hash,
            repositoryUrl: blueprint.section1_basic_info.repository_url,
          });
    if (!(await pathExists(targetWorktree))) {
      if (
        expectation === null ||
        this.#dependencies.controller.configDocument.config.repository.preparation_policy !==
          "manual-or-managed"
      ) {
        return fail(
          "missing target worktree requires Blueprint repository identity and managed preparation policy",
        );
      }
      const requestId = this.#dependencies.id.next("operation");
      const plan = buildManagedRepositoryPreparationPlan({
        config: this.#dependencies.controller.configDocument.config,
        controllerRoot: this.#dependencies.controller.controllerRoot,
        destination: targetWorktree,
        expectation,
        requestId,
        stateRootPath: this.#dependencies.controller.stateRootPath,
      });
      const pending = Object.freeze({
        plan,
        request_id: requestId,
        status: "decision-required" as const,
        target_worktree: targetWorktree,
        workflow_id: workflowId,
      });
      this.#pending.set(workflowId, pending);
      return canonicalizeJson({
        pending_repository_preflight: pending,
        workflow_id: workflowId,
      }).text;
    }
    const prepared = this.#managed.get(targetWorktree);
    const receipt =
      prepared === undefined
        ? await this.#manualPreflight(
            workflowId,
            targetWorktree,
            context,
            [sealedDirectory],
            expectation ?? undefined,
            true,
          )
        : await this.#managedPreflight(workflowId, targetWorktree, expectation, prepared);
    const subject = buildBlueprintReviewSubject(verified, receipt.repository_binding);
    await context.ask({
      always: [],
      metadata: {
        repository_binding_digest: receipt.repository_binding.artifact_digest,
        sealed_function_directory: sealedDirectory,
        subject_digest: subject.artifact_digest,
        workflow_id: workflowId,
      },
      patterns: [subject.artifact_digest],
      permission: "ys_craft_blueprint_review",
    });
    const at = this.#dependencies.clock.now();
    const outcome = reviewBlueprintForImport({
      binding: receipt.repository_binding,
      context: {
        action: "allow",
        reviewedAt: at,
        reviewerSessionId: canonicalOpenCodeSessionId(context.sessionID),
      },
      subject,
      verified,
      workflowId,
    });
    if (outcome.decision !== "allow") {
      return fail("Blueprint review was not allowed");
    }
    const state = createBlueprintWorkflowState({
      at,
      coordinator: principal,
      repositoryBinding: receipt.repository_binding,
      transaction: outcome.transaction,
      workflowId,
    });
    const artifacts = [receipt.repository_binding, ...outcome.transaction.contracts] as const;
    const journal = createActionJournal({
      action: "ys_craft_review_blueprint",
      at,
      principal: auditTrustedPrincipal(principal),
      result: "succeeded",
      state,
      subjectRefs: artifacts.map(artifactRef),
    });
    const snapshot = await (await this.#openStore()).initializeWorkflow({
      artifacts,
      configDigest: receipt.config_digest,
      controllerRootRealpath: receipt.controller_root_realpath,
      journal,
      state,
    });
    this.#bindPointer(context, snapshot.state.workflow_id);
    this.#pending.delete(workflowId);
    this.#managed.delete(targetWorktree);
    return canonicalizeJson(this.#statusOf(snapshot)).text;
  }

  async status(workflowId: string, context: ToolContext): Promise<string> {
    const principal = this.#principal(context);
    const pending = this.#pending.get(workflowId);
    if (pending !== undefined) {
      return canonicalizeJson({
        pending_repository_preflight: pending,
        workflow_id: workflowId,
      }).text;
    }
    let snapshot = await (await this.#openStore()).readExactWorkflow(workflowId);
    this.#assertToolPhase("ys_craft_status", snapshot.state.phase);
    if (
      isActiveWorkflowPhase(snapshot.state.phase) &&
      PHASE_OWNER[snapshot.state.phase] === context.agent
    ) {
      snapshot = await this.#ensurePhaseBinding(snapshot, principal, "ys_craft_status");
      if (snapshot.state.phase === "building") {
        this.#dependencies.builderWrite.activate(
          context,
          snapshot.state,
          activeArtifacts(snapshot),
        );
      }
    }
    this.#bindPointer(context, workflowId);
    return canonicalizeJson(this.#statusOf(snapshot)).text;
  }

  async resume(
    input: { readonly store_anchor: string; readonly workflow_id: string },
    context: ToolContext,
  ): Promise<string> {
    const principal = this.#principal(context, "ys-craft");
    const store = await this.#openStore();
    const snapshot = await store.readExactWorkflow(input.workflow_id);
    this.#assertToolPhase("ys_craft_resume", snapshot.state.phase);
    const binding = oneArtifact(activeArtifacts(snapshot), "repository-binding");
    await context.ask({
      always: [],
      metadata: {
        state_root: this.#dependencies.controller.stateRootPath,
        target_worktree: binding.target_worktree_realpath,
        workflow_id: input.workflow_id,
      },
      patterns: [binding.target_worktree_realpath],
      permission: "ys_craft_external_directory",
    });
    const currentController = await this.#dependencies.reloadController();
    const timeoutMs = currentController.configDocument.config.repository.timeout_ms;
    const headCommit = await gitLine(
      this.#dependencies.git,
      binding.target_worktree_realpath,
      ["rev-parse", "--verify", "HEAD"],
      timeoutMs,
    );
    const treeObjectId = await gitLine(
      this.#dependencies.git,
      binding.target_worktree_realpath,
      ["rev-parse", "--verify", "HEAD^{tree}"],
      timeoutMs,
    );
    const statusResult = await this.#dependencies.git.run(
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        binding.target_worktree_realpath,
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
      ],
      timeoutMs,
    );
    if (statusResult.exitCode !== 0) {
      return fail(statusResult.stderr.trim() || "Git status failed during resume");
    }
    const ignoreResult = await this.#dependencies.git.run(
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        currentController.controllerRoot,
        "check-ignore",
        "--no-index",
        "-q",
        "--",
        join(currentController.stateRootPath, ".ys-craft-ignore-probe"),
      ],
      timeoutMs,
    );
    if (ignoreResult.exitCode !== 0 && ignoreResult.exitCode !== 1) {
      return fail(ignoreResult.stderr.trim() || "Git ignore inspection failed during resume");
    }
    const candidate = activeArtifacts(snapshot).find(
      (artifact): artifact is PatchCandidate => artifact.artifact_type === "patch-candidate",
    );
    let diffContentDigest: `sha256:${string}` | null = null;
    if (candidate !== undefined) {
      const authorization = oneArtifact(
        activeArtifacts(snapshot),
        "mutation-authorization",
      ) as MutationAuthorization;
      diffContentDigest = (
        await captureCanonicalDiff({
          authorization,
          binding,
          gitRunner: this.#dependencies.binaryGit,
        })
      ).diffContentDigest;
    }
    const result = await store.resumeExactWorkflow({
      at: this.#dependencies.clock.now(),
      observation: {
        configDigest: currentController.configDocument.configDigest,
        controllerRootRealpath: currentController.controllerRoot,
        diffContentDigest,
        gitRootRealpath: await realpath(binding.git_root_realpath),
        headCommit,
        headTreeDigest: sha256Digest(UTF8.encode(treeObjectId)),
        productRootRealpath: await realpath(binding.product_root_realpath),
        status: statusResult.stdout.length === 0 ? "clean" : "dirty",
        storeRootIgnored: ignoreResult.exitCode === 0,
        storeRootRealpath: store.rootRealpath,
        targetWorktreeRealpath: await realpath(binding.target_worktree_realpath),
      },
      principal,
      storeAnchor: requireAbsolutePath(input.store_anchor, "store_anchor"),
      workflowId: input.workflow_id,
    });
    if (result.status === "resumed") {
      this.#bindPointer(context, input.workflow_id);
    }
    return canonicalizeJson(
      result.status === "resumed"
        ? this.#statusOf(result.snapshot)
        : {
            issues: result.issues,
            status: result.status,
            workflow_id: result.workflowId,
          },
    ).text;
  }

  async prepareRepository(requestId: string, context: ToolContext): Promise<string> {
    this.#principal(context, "ys-craft");
    const pending = [...this.#pending.values()].find((item) => item.request_id === requestId);
    if (pending === undefined || pending.plan === null || pending.status !== "decision-required") {
      return fail("unknown repository preparation request");
    }
    const { plan } = pending;
    await context.ask({
      always: [],
      metadata: {
        commit_sha: plan.commit_sha,
        destination: plan.destination,
        git_argv: plan.git_argv.map((argv) => [...argv]),
        network: plan.network,
        plan_digest: plan.plan_digest,
        repository_url: plan.repository_url,
        request_id: plan.request_id,
        workflow_id: pending.workflow_id,
      },
      patterns: [plan.plan_digest],
      permission: "ys_craft_repository_preparation",
    });
    const result = await executeManagedRepositoryPreparation({
      authorization: {
        decision: "allow",
        plan_digest: plan.plan_digest,
        request_id: plan.request_id,
      },
      config: this.#dependencies.controller.configDocument.config,
      controllerRoot: this.#dependencies.controller.controllerRoot,
      git: this.#dependencies.git,
      plan,
      stateRootPath: this.#dependencies.controller.stateRootPath,
    });
    const ready = Object.freeze({
      ...pending,
      status: "ready" as const,
    });
    this.#managed.set(
      plan.destination,
      Object.freeze({
        plan,
        result,
      }),
    );
    this.#pending.set(pending.workflow_id, ready);
    return canonicalizeJson({
      ...ready,
      created_or_updated_paths: result.created_or_updated_paths,
      residual_paths: result.residual_paths,
    }).text;
  }

  async recordArtifact(
    input: {
      readonly artifact_kind: string;
      readonly artifact_payload: string;
      readonly workflow_id: string;
    },
    context: ToolContext,
  ): Promise<string> {
    const principal = this.#principal(context);
    let snapshot = await (await this.#openStore()).readExactWorkflow(input.workflow_id);
    this.#assertToolPhase("ys_craft_record_artifact", snapshot.state.phase);
    snapshot = await this.#ensurePhaseBinding(snapshot, principal, "ys_craft_record_artifact");
    const artifact = parseCraftContractBytes(UTF8.encode(input.artifact_payload));
    if (
      artifact.artifact_type !== input.artifact_kind ||
      artifact.artifact_type === "workflow-state" ||
      artifact.artifact_type === "action-journal"
    ) {
      return fail("artifact kind and canonical payload do not identify a recordable contract");
    }
    if (artifact.artifact_type === "mutation-authorization") {
      return fail("mutation authorization is created only by one platform-approved patch plan");
    }
    if (
      artifact.artifact_type === "diff-manifest" ||
      artifact.artifact_type === "patch-candidate" ||
      artifact.artifact_type === "verification-authorization" ||
      artifact.artifact_type === "verification-manifest" ||
      artifact.artifact_type === "verification-source"
    ) {
      return fail(`${artifact.artifact_type} is created only by its dedicated lifecycle tool`);
    }
    if (artifact.artifact_type === "criterion-evidence") {
      if (artifact.evidence_kind !== "human") {
        return fail("machine criterion evidence is created only by a verification runner");
      }
      const active = activeArtifacts(snapshot);
      const manifest = oneArtifact(active, "verification-manifest");
      const candidate = oneArtifact(active, "patch-candidate");
      if (!manifest.human_criterion_ids.includes(artifact.criterion_id)) {
        return fail("criterion is not an approved human criterion in the active manifest");
      }
      const startedAt = this.#dependencies.clock.now();
      await context.ask({
        always: [],
        metadata: {
          candidate_digest: candidate.artifact_digest,
          criterion_id: artifact.criterion_id,
          manifest_digest: manifest.artifact_digest,
          workflow_id: input.workflow_id,
        },
        patterns: [`${manifest.artifact_digest}:${artifact.criterion_id}`],
        permission: "ys_craft_human_criterion",
      });
      const finishedAt = this.#dependencies.clock.now();
      const evidence = sealHumanCriterionEvidence({
        candidate,
        criterionId: artifact.criterion_id,
        decision: {
          action: "allow",
          confirmationDigest: canonicalizeJson({
            action: "allow",
            candidate_digest: candidate.artifact_digest,
            criterion_id: artifact.criterion_id,
            finished_at: finishedAt,
            manifest_digest: manifest.artifact_digest,
            session_id: canonicalOpenCodeSessionId(context.sessionID),
            started_at: startedAt,
          }).digest,
          finishedAt,
          sessionId: canonicalOpenCodeSessionId(context.sessionID),
          startedAt,
        },
        manifest,
        workflowId: input.workflow_id,
      });
      snapshot = await this.#recordContract(
        snapshot,
        principal,
        evidence,
        "ys_craft_record_artifact",
      );
      this.#bindPointer(context, input.workflow_id);
      return canonicalizeJson(this.#statusOf(snapshot)).text;
    }
    if (artifact.artifact_type === "patch-plan") {
      const builderPrincipal = this.#builderPrincipalForWorkflow(input.workflow_id);
      await context.ask({
        always: [],
        metadata: {
          builder: auditTrustedPrincipal(builderPrincipal),
          changes: artifact.changes,
          criterion_ids: artifact.criterion_ids,
          non_goals: artifact.non_goals,
          objectives: artifact.objectives,
          plan_revision: artifact.plan_revision,
          workflow_id: input.workflow_id,
        },
        patterns: [artifact.artifact_digest],
        permission: "ys_craft_patch_plan",
      });
      const approved = approvePatchPlan({
        activeArtifacts: activeArtifacts(snapshot),
        approved: true,
        at: this.#dependencies.clock.now(),
        builderPrincipal,
        proposal: {
          changes: artifact.changes,
          criterionIds: artifact.criterion_ids,
          nonGoals: artifact.non_goals,
          objectives: artifact.objectives,
          planRevision: artifact.plan_revision,
        },
        workflowId: input.workflow_id,
      });
      if (approved.status !== "approved") {
        return fail("patch plan was not approved");
      }
      snapshot = await this.#recordContract(
        snapshot,
        principal,
        approved.plan,
        "ys_craft_record_artifact",
      );
      snapshot = await this.#recordContract(
        snapshot,
        principal,
        approved.authorization,
        "ys_craft_record_artifact",
      );
      this.#bindPointer(context, input.workflow_id);
      return canonicalizeJson(this.#statusOf(snapshot)).text;
    }
    if (artifact.artifact_type === "patch-review") {
      const reviewed = await reviewPatch({
        activeArtifacts: activeArtifacts(snapshot),
        at: this.#dependencies.clock.now(),
        candidateObserver: this.#candidateObserver(snapshot),
        principal,
        proposal: {
          findings: artifact.findings,
          rootCauseEliminated: artifact.root_cause_eliminated,
          verificationSufficient: artifact.verification_sufficient,
          withinApprovedScope: artifact.within_approved_scope,
        },
        state: snapshot.state,
      });
      snapshot = await this.#recordContract(
        snapshot,
        principal,
        reviewed.review,
        "ys_craft_record_artifact",
      );
      this.#bindPointer(context, input.workflow_id);
      return canonicalizeJson({
        outcome: reviewed.outcome,
        ...this.#statusOf(snapshot),
      }).text;
    }
    if (artifact.artifact_type === "delivery") {
      const prepared = await prepareDelivery({
        activeArtifacts: activeArtifacts(snapshot),
        at: this.#dependencies.clock.now(),
        candidateObserver: this.#candidateObserver(snapshot),
        principal,
        proposal: {
          followUpSteps: artifact.follow_up_steps,
          residualRisks: artifact.residual_risks,
          summary: artifact.summary,
        },
        state: snapshot.state,
      });
      snapshot = await this.#recordContract(
        snapshot,
        principal,
        prepared.delivery,
        "ys_craft_record_artifact",
      );
      this.#bindPointer(context, input.workflow_id);
      return canonicalizeJson({
        observed_diff_content_digest: prepared.observedDiffContentDigest,
        ...this.#statusOf(snapshot),
      }).text;
    }
    snapshot = await this.#recordContract(
      snapshot,
      principal,
      artifact,
      "ys_craft_record_artifact",
    );
    this.#bindPointer(context, input.workflow_id);
    return canonicalizeJson(this.#statusOf(snapshot)).text;
  }

  async captureCandidate(
    input: { readonly expected_revision: number; readonly workflow_id: string },
    context: ToolContext,
  ): Promise<string> {
    const principal = this.#principal(context, "ys-craft-patch-builder");
    let snapshot = await (await this.#openStore()).readExactWorkflow(input.workflow_id);
    this.#assertExpectedRevision(snapshot, input.expected_revision);
    this.#assertToolPhase("ys_craft_capture_candidate", snapshot.state.phase);
    snapshot = await this.#ensurePhaseBinding(snapshot, principal, "ys_craft_capture_candidate");
    const captured = await capturePatchCandidate({
      activeArtifacts: activeArtifacts(snapshot),
      at: this.#dependencies.clock.now(),
      gitRunner: this.#dependencies.binaryGit,
      previousCandidates: snapshot.artifacts.filter(
        (artifact): artifact is PatchCandidate => artifact.artifact_type === "patch-candidate",
      ),
      principal,
      state: snapshot.state,
    });
    snapshot = await this.#recordContract(
      snapshot,
      principal,
      captured.diffManifest,
      "ys_craft_capture_candidate",
    );
    snapshot = await this.#recordContract(
      snapshot,
      principal,
      captured.candidate,
      "ys_craft_capture_candidate",
    );
    this.#bindPointer(context, input.workflow_id);
    return canonicalizeJson({
      binary_patch_digest: captured.binaryPatchDigest,
      candidate_ref: artifactRef(captured.candidate),
      diff_content_digest: captured.diffContentDigest,
      revision: snapshot.state.revision,
      workflow_id: input.workflow_id,
    }).text;
  }

  async prepareVerification(
    input: { readonly source: string; readonly workflow_id: string },
    context: ToolContext,
  ): Promise<string> {
    const principal = this.#principal(context, "ys-craft-regression-verifier");
    let snapshot = await (await this.#openStore()).readExactWorkflow(input.workflow_id);
    this.#assertToolPhase("ys_craft_prepare_verification", snapshot.state.phase);
    snapshot = await this.#ensurePhaseBinding(snapshot, principal, "ys_craft_prepare_verification");
    const logRoot = await this.#ensureLogRoot(input.workflow_id);
    const prepared = prepareVerification({
      activeArtifacts: activeArtifacts(snapshot),
      at: this.#dependencies.clock.now(),
      config: this.#dependencies.controller.configDocument,
      logRootRealpath: logRoot,
      previousManifests: snapshot.artifacts.filter(
        (artifact): artifact is VerificationManifest =>
          artifact.artifact_type === "verification-manifest",
      ),
      principal,
      proposal: parseVerificationProposal(input.source),
      state: snapshot.state,
    });
    snapshot = await this.#recordContract(
      snapshot,
      principal,
      prepared.source,
      "ys_craft_prepare_verification",
    );
    snapshot = await this.#recordContract(
      snapshot,
      principal,
      prepared.manifest,
      "ys_craft_prepare_verification",
    );
    this.#bindPointer(context, input.workflow_id);
    return canonicalizeJson({
      manifest_ref: artifactRef(prepared.manifest),
      revision: snapshot.state.revision,
      source_ref: artifactRef(prepared.source),
      workflow_id: input.workflow_id,
    }).text;
  }

  async runVerification(
    input: { readonly expected_revision: number; readonly workflow_id: string },
    context: ToolContext,
  ): Promise<string> {
    const principal = this.#principal(context, "ys-craft-regression-verifier");
    const store = await this.#openStore();
    let snapshot = await store.readExactWorkflow(input.workflow_id);
    this.#assertExpectedRevision(snapshot, input.expected_revision);
    this.#assertToolPhase("ys_craft_run_verification", snapshot.state.phase);
    snapshot = await this.#ensurePhaseBinding(snapshot, principal, "ys_craft_run_verification");
    const beforeAskRevision = snapshot.state.revision;
    const activeBeforeAsk = activeArtifacts(snapshot);
    const manifest = oneArtifact(activeBeforeAsk, "verification-manifest");
    const candidate = oneArtifact(activeBeforeAsk, "patch-candidate");
    await context.ask({
      always: [],
      metadata: {
        candidate_digest: candidate.artifact_digest,
        commands: manifest.commands.map((command) => ({
          argv: [...command.argv],
          cwd: command.cwd,
          host_alias: command.host_alias,
          runner_type: command.runner_type,
          timeout_seconds: command.timeout_seconds,
        })),
        manifest_digest: manifest.artifact_digest,
        workflow_id: input.workflow_id,
        workflow_revision: beforeAskRevision,
      },
      patterns: [manifest.artifact_digest],
      permission: "ys_craft_verification_manifest",
    });
    snapshot = await store.readExactWorkflow(input.workflow_id);
    if (snapshot.state.revision !== beforeAskRevision) {
      return fail("workflow changed while verification permission was pending");
    }
    const activeAfterAsk = activeArtifacts(snapshot);
    if (
      oneArtifact(activeAfterAsk, "verification-manifest").artifact_digest !==
        manifest.artifact_digest ||
      oneArtifact(activeAfterAsk, "patch-candidate").artifact_digest !== candidate.artifact_digest
    ) {
      return fail("candidate or verification manifest changed after permission");
    }
    const approval = approveVerification({
      activeArtifacts: activeAfterAsk,
      approved: true,
      at: this.#dependencies.clock.now(),
      manifest,
      principal,
      state: snapshot.state,
    });
    if (approval.status !== "approved") {
      return fail("verification manifest was not approved");
    }
    snapshot = await this.#recordContract(
      snapshot,
      principal,
      approval.authorization,
      "ys_craft_run_verification",
    );
    await this.#ensureLogParents(manifest);
    const runActive = activeArtifacts(snapshot);
    const runnerTypes = new Set(manifest.commands.map((command) => command.runner_type));
    if (runnerTypes.size !== 1) {
      return fail("one verification manifest cannot mix local and SSH operations");
    }
    const runnerType = manifest.commands[0]?.runner_type;
    const operationId = this.#dependencies.id.next("operation");
    await store.recordOperationIntent({
      action: "ys_craft_run_verification",
      at: this.#dependencies.clock.now(),
      operationId,
      principal,
      sideEffect: "verification-command",
      subjectRefs: [artifactRef(manifest), artifactRef(candidate)],
      workflowId: input.workflow_id,
    });
    await store.markOperationStarted({
      at: this.#dependencies.clock.now(),
      operationId,
      workflowId: input.workflow_id,
    });
    const common = {
      activeArtifacts: runActive,
      authorization: approval.authorization,
      clock: this.#dependencies.clock,
      humanDecisions: new Map(),
      logSink: this.#dependencies.logSink,
      manifest,
      principal,
      state: snapshot.state,
    } as const;
    const result =
      runnerType === "local"
        ? await runLocalVerification({
            ...common,
            candidateObserver: {
              observeDiffContentDigest: async () => {
                const binding = oneArtifact(activeArtifacts(snapshot), "repository-binding");
                const authorization = oneArtifact(
                  activeArtifacts(snapshot),
                  "mutation-authorization",
                );
                return (
                  await captureCanonicalDiff({
                    authorization,
                    binding,
                    gitRunner: this.#dependencies.binaryGit,
                  })
                ).diffContentDigest;
              },
            },
            environment: process.env,
            processRunner: this.#dependencies.localProcess,
          })
        : runnerType === "ssh"
          ? await runSshVerification({
              ...common,
              sshRunner: await this.#dependencies.ssh(),
            })
          : fail("verification manifest contains no operation");
    for (const evidence of result.evidence) {
      snapshot = await this.#recordContract(
        snapshot,
        principal,
        evidence,
        "ys_craft_run_verification",
      );
    }
    await store.recordOperationResult({
      at: this.#dependencies.clock.now(),
      evidenceRefs: result.evidence.map(artifactRef),
      operationId,
      outcome: "succeeded",
      principal,
      workflowId: input.workflow_id,
    });
    this.#bindPointer(context, input.workflow_id);
    return canonicalizeJson({
      evidence_refs: result.evidence.map(artifactRef),
      observed_diff_content_digest: result.observedDiffContentDigest,
      operation_id: operationId,
      revision: snapshot.state.revision,
      status: result.status,
      workflow_id: input.workflow_id,
    }).text;
  }

  async transition(
    input: {
      readonly expected_revision: number;
      readonly target_phase: string;
      readonly workflow_id: string;
    },
    context: ToolContext,
  ): Promise<string> {
    const principal = this.#principal(context);
    let snapshot = await (await this.#openStore()).readExactWorkflow(input.workflow_id);
    this.#assertExpectedRevision(snapshot, input.expected_revision);
    this.#assertToolPhase("ys_craft_transition", snapshot.state.phase);
    const targetPhase = this.#workflowPhase(input.target_phase);
    if (snapshot.state.phase === "blocked") {
      if (auditTrustedPrincipal(principal).agent_id !== "ys-craft") {
        return fail("blocked remediation requires the trusted Yuansheng Craft primary agent");
      }
      const state = remediateBlockedWorkflow({
        at: this.#dependencies.clock.now(),
        expectedRevision: snapshot.state.revision,
        principal,
        state: snapshot.state,
      });
      if (state.phase !== targetPhase) {
        return fail("target_phase must equal the workflow's explicit remediation phase");
      }
      snapshot = await this.#commitState(snapshot, state, principal, "ys_craft_transition", []);
      this.#bindPointer(context, input.workflow_id);
      return canonicalizeJson(this.#statusOf(snapshot)).text;
    }
    snapshot = await this.#ensurePhaseBinding(snapshot, principal, "ys_craft_transition");
    const state = transitionWorkflow({
      activeArtifacts: activeArtifacts(snapshot),
      at: this.#dependencies.clock.now(),
      expectedRevision: snapshot.state.revision,
      principal,
      state: snapshot.state,
      targetPhase,
    });
    snapshot = await this.#commitState(snapshot, state, principal, "ys_craft_transition", []);
    this.#bindPointer(context, input.workflow_id);
    return canonicalizeJson(this.#statusOf(snapshot)).text;
  }

  async returnToPhase(
    input: {
      readonly expected_revision: number;
      readonly reason: string;
      readonly target_phase: string;
      readonly workflow_id: string;
    },
    context: ToolContext,
  ): Promise<string> {
    const principal = this.#principal(context);
    let snapshot = await (await this.#openStore()).readExactWorkflow(input.workflow_id);
    this.#assertExpectedRevision(snapshot, input.expected_revision);
    this.#assertToolPhase("ys_craft_return_to_phase", snapshot.state.phase);
    snapshot = await this.#ensurePhaseBinding(snapshot, principal, "ys_craft_return_to_phase");
    const targetPhase = this.#activePhase(input.target_phase);
    const state =
      snapshot.state.phase === "reviewing"
        ? requestPatchChanges({
            activeArtifacts: activeArtifacts(snapshot),
            at: this.#dependencies.clock.now(),
            expectedRevision: snapshot.state.revision,
            principal,
            reason: input.reason,
            review: oneArtifact(activeArtifacts(snapshot), "patch-review"),
            state: snapshot.state,
            targetPhase:
              targetPhase === "planning" || targetPhase === "building"
                ? targetPhase
                : fail("failed review may return only to planning or building"),
          })
        : returnWorkflowToPhase({
            at: this.#dependencies.clock.now(),
            expectedRevision: snapshot.state.revision,
            principal,
            reason: input.reason,
            state: snapshot.state,
            targetPhase,
          });
    snapshot = await this.#commitState(snapshot, state, principal, "ys_craft_return_to_phase", []);
    this.#bindPointer(context, input.workflow_id);
    return canonicalizeJson(this.#statusOf(snapshot)).text;
  }

  async complete(
    input: { readonly expected_revision: number; readonly workflow_id: string },
    context: ToolContext,
  ): Promise<string> {
    const principal = this.#principal(context, "ys-craft-delivery-coordinator");
    let snapshot = await (await this.#openStore()).readExactWorkflow(input.workflow_id);
    this.#assertExpectedRevision(snapshot, input.expected_revision);
    this.#assertToolPhase("ys_craft_complete", snapshot.state.phase);
    snapshot = await this.#ensurePhaseBinding(snapshot, principal, "ys_craft_complete");
    const state = transitionWorkflow({
      activeArtifacts: activeArtifacts(snapshot),
      at: this.#dependencies.clock.now(),
      expectedRevision: snapshot.state.revision,
      principal,
      state: snapshot.state,
      targetPhase: "completed",
    });
    snapshot = await this.#commitState(snapshot, state, principal, "ys_craft_complete", []);
    this.#bindPointer(context, input.workflow_id);
    return canonicalizeJson(this.#statusOf(snapshot)).text;
  }

  #principal(context: ToolContext, expectedAgent?: string): TrustedPrincipal {
    if (
      context.sessionID.length === 0 ||
      context.agent.length === 0 ||
      typeof context.ask !== "function" ||
      typeof context.metadata !== "function"
    ) {
      return fail("ToolContext is missing trusted platform identity or permission functions");
    }
    const observedAgent = this.#sessionAgents.get(context.sessionID);
    if (observedAgent === undefined || observedAgent !== context.agent) {
      return fail("ToolContext does not match the observed OpenCode chat identity");
    }
    if (expectedAgent !== undefined && context.agent !== expectedAgent) {
      return fail(`${context.agent} cannot perform this operation`);
    }
    return issueOpenCodePrincipal({
      agentId: context.agent,
      sessionId: context.sessionID,
    });
  }

  async #manualPreflight(
    workflowId: string,
    targetWorktree: string,
    context: ToolContext,
    additionalPaths: readonly string[],
    expectation?: RepositoryExpectation,
    permissionGranted = false,
  ): Promise<RepositoryPreflightReceipt> {
    const requestId = this.#dependencies.id.next("operation");
    const pending = Object.freeze({
      plan: null,
      request_id: requestId,
      status: "decision-required" as const,
      target_worktree: targetWorktree,
      workflow_id: workflowId,
    });
    this.#pending.set(workflowId, pending);
    if (!permissionGranted) {
      await context.ask({
        always: [],
        metadata: {
          config_digest: this.#dependencies.controller.configDocument.configDigest,
          controller_root: this.#dependencies.controller.controllerRoot,
          expected_create_or_update: [this.#dependencies.controller.stateRootPath],
          state_root: this.#dependencies.controller.stateRootPath,
          target_worktree: targetWorktree,
          workflow_id: workflowId,
        },
        patterns: [targetWorktree, ...additionalPaths],
        permission: "ys_craft_external_directory",
      });
    }
    const repositoryExpectation =
      expectation ??
      (await inspectExpectation(
        this.#dependencies.git,
        targetWorktree,
        this.#dependencies.controller.configDocument.config.repository.timeout_ms,
      ));
    const receipt = await prepareRepositoryPreflight({
      configDocument: this.#dependencies.controller.configDocument,
      configPath: this.#dependencies.controller.configPath,
      controllerRoot: this.#dependencies.controller.controllerRoot,
      createdAt: this.#dependencies.clock.now(),
      expectation: repositoryExpectation,
      git: this.#dependencies.git,
      preparationMode: "manual",
      stateRootPath: this.#dependencies.controller.stateRootPath,
      targetWorktree,
    });
    await mkdir(receipt.state_root_path, { recursive: true, mode: 0o700 });
    if ((await realpath(receipt.state_root_path)) !== receipt.state_root_path) {
      return fail("state root creation did not preserve its canonical path");
    }
    return receipt;
  }

  async #managedPreflight(
    workflowId: string,
    targetWorktree: string,
    expectation: RepositoryExpectation | null,
    prepared: PreparedManagedRepository,
  ): Promise<RepositoryPreflightReceipt> {
    if (
      expectation === null ||
      prepared.plan.destination !== targetWorktree ||
      prepared.result.destination !== targetWorktree ||
      prepared.plan.commit_sha !== expectation.commitSha ||
      prepared.plan.repository_url !== expectation.repositoryUrl
    ) {
      return fail("prepared repository does not match the current Blueprint");
    }
    const receipt = await prepareRepositoryPreflight({
      configDocument: this.#dependencies.controller.configDocument,
      configPath: this.#dependencies.controller.configPath,
      controllerRoot: this.#dependencies.controller.controllerRoot,
      createdAt: this.#dependencies.clock.now(),
      createdOrUpdatedPaths: prepared.result.created_or_updated_paths,
      expectation,
      git: this.#dependencies.git,
      preparationMode: "managed",
      stateRootPath: this.#dependencies.controller.stateRootPath,
      targetWorktree,
    });
    await mkdir(receipt.state_root_path, { recursive: true, mode: 0o700 });
    if ((await realpath(receipt.state_root_path)) !== receipt.state_root_path) {
      return fail("state root creation did not preserve its canonical path");
    }
    const requestId = prepared.plan.request_id;
    for (const [pendingWorkflowId, pending] of this.#pending) {
      if (
        pending.request_id === requestId &&
        pending.status === "ready" &&
        pending.target_worktree === targetWorktree
      ) {
        this.#pending.delete(pendingWorkflowId);
      }
    }
    this.#pending.delete(workflowId);
    return receipt;
  }

  async #openStore(): Promise<AtomicWorkflowStore> {
    return openAtomicWorkflowStore(this.#dependencies.controller.stateRootPath);
  }

  #bindPointer(context: ToolContext, workflowId: string): void {
    this.#pointers.set(context.sessionID, Object.freeze({ agent: context.agent, workflowId }));
  }

  #builderPrincipalForWorkflow(workflowId: string): TrustedPrincipal {
    const sessions = [...this.#pointers.entries()].filter(
      ([sessionId, pointer]) =>
        pointer.workflowId === workflowId &&
        pointer.agent === "ys-craft-patch-builder" &&
        this.#sessionAgents.get(sessionId) === pointer.agent,
    );
    if (sessions.length !== 1) {
      return fail(
        "patch plan approval requires exactly one observed builder session pointing at this workflow",
      );
    }
    const sessionId = sessions[0]?.[0];
    if (sessionId === undefined) {
      return fail("builder session disappeared during patch plan approval");
    }
    return issueOpenCodePrincipal({
      agentId: "ys-craft-patch-builder",
      sessionId,
    });
  }

  #candidateObserver(snapshot: WorkflowSnapshot): {
    readonly observeDiffContentDigest: () => Promise<string>;
  } {
    const active = activeArtifacts(snapshot);
    const binding = oneArtifact(active, "repository-binding");
    const authorization = oneArtifact(active, "mutation-authorization");
    return Object.freeze({
      observeDiffContentDigest: async () =>
        (
          await captureCanonicalDiff({
            authorization,
            binding,
            gitRunner: this.#dependencies.binaryGit,
          })
        ).diffContentDigest,
    });
  }

  #assertToolPhase(toolId: CraftToolId, phase: WorkflowPhase): void {
    const definition = TOOL_BY_ID.get(toolId);
    if (
      definition === undefined ||
      !(definition.allowedPhases as readonly string[]).includes(phase)
    ) {
      fail(`${toolId} is not available in ${phase}`);
    }
  }

  #assertExpectedRevision(snapshot: WorkflowSnapshot, expectedRevision: number): void {
    if (snapshot.state.revision !== expectedRevision) {
      fail(`expected workflow revision ${expectedRevision}, found ${snapshot.state.revision}`);
    }
  }

  async #ensurePhaseBinding(
    snapshot: WorkflowSnapshot,
    principal: TrustedPrincipal,
    action: CraftToolId,
  ): Promise<WorkflowSnapshot> {
    if (!isActiveWorkflowPhase(snapshot.state.phase)) {
      return fail("terminal workflow cannot bind a phase principal");
    }
    const audit = auditTrustedPrincipal(principal);
    if (PHASE_OWNER[snapshot.state.phase] !== audit.agent_id) {
      return fail(`${audit.agent_id} does not own ${snapshot.state.phase}`);
    }
    if (snapshot.state.phase_principal !== null) {
      if (
        snapshot.state.phase_principal.agent_id !== audit.agent_id ||
        snapshot.state.phase_principal.session_id !== audit.session_id
      ) {
        return fail("phase is bound to a different real OpenCode session");
      }
      return snapshot;
    }
    const state = bindPhasePrincipal({
      activeArtifacts: activeArtifacts(snapshot),
      at: this.#dependencies.clock.now(),
      expectedRevision: snapshot.state.revision,
      principal,
      state: snapshot.state,
    });
    return this.#commitState(snapshot, state, principal, `${action}_bind`, []);
  }

  async #recordContract(
    snapshot: WorkflowSnapshot,
    principal: TrustedPrincipal,
    artifact: StoredArtifact,
    action: CraftToolId,
  ): Promise<WorkflowSnapshot> {
    const active = [...activeArtifacts(snapshot), artifact];
    const state = recordPhaseArtifact({
      activeArtifacts: active,
      artifact,
      at: this.#dependencies.clock.now(),
      expectedRevision: snapshot.state.revision,
      principal,
      state: snapshot.state,
    });
    return this.#commitState(
      snapshot,
      state,
      principal,
      action,
      [artifactRef(artifact)],
      [...snapshot.artifacts, artifact],
    );
  }

  async #commitState(
    snapshot: WorkflowSnapshot,
    state: WorkflowState,
    principal: TrustedPrincipal,
    action: string,
    subjectRefs: readonly ArtifactRef[],
    artifacts: readonly StoredArtifact[] = snapshot.artifacts,
  ): Promise<WorkflowSnapshot> {
    const journal = appendActionJournal({
      action,
      at: state.updated_at,
      journal: snapshot.journal,
      principal: auditTrustedPrincipal(principal),
      result: "succeeded",
      state,
      subjectRefs,
    });
    return (await this.#openStore()).commitWorkflow({
      artifacts,
      expectedRevision: snapshot.state.revision,
      journal,
      state,
    });
  }

  #statusOf(snapshot: WorkflowSnapshot): OpenCodeCraftStatus {
    const verificationSource = snapshot.state.artifact_refs.find(
      (reference) => reference.artifact_type === "verification-source",
    );
    return Object.freeze({
      blocked_remediation: snapshot.state.blocked_context,
      current_artifacts: Object.freeze([...snapshot.state.artifact_refs]),
      pending_repository_preflight: this.#pending.get(snapshot.state.workflow_id) ?? null,
      phase: snapshot.state.phase,
      revision: snapshot.state.revision,
      session_binding: Object.freeze({
        coordinator: snapshot.state.coordinator,
        phase_principal: snapshot.state.phase_principal,
      }),
      stale_refs: Object.freeze([...snapshot.state.stale_artifact_refs]),
      status: snapshot.state.status,
      verification_source: verificationSource ?? null,
      workflow_id: snapshot.state.workflow_id,
    });
  }

  #workflowPhase(value: string): WorkflowPhase {
    if (!(WORKFLOW_PHASES as readonly string[]).includes(value)) {
      return fail("target_phase is not a workflow phase");
    }
    return value as WorkflowPhase;
  }

  #activePhase(value: string): ActiveWorkflowPhase {
    const phase = this.#workflowPhase(value);
    if (!isActiveWorkflowPhase(phase)) {
      return fail("target_phase is not an active workflow phase");
    }
    return phase;
  }

  async #ensureLogRoot(workflowId: string): Promise<string> {
    const directory = join(
      this.#dependencies.controller.stateRootPath,
      "logs",
      workflowId.replaceAll(/[^A-Za-z0-9_-]/gu, "_"),
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const resolved = await realpath(directory);
    if (resolved !== directory) {
      return fail("verification log root must not traverse a symlink");
    }
    return resolved;
  }

  async #ensureLogParents(manifest: VerificationManifest): Promise<void> {
    for (const command of manifest.commands) {
      const parent = dirname(join(manifest.log_root_realpath, command.log_path));
      await mkdir(parent, { recursive: true, mode: 0o700 });
      if ((await realpath(parent)) !== parent) {
        return fail("verification log parent must not traverse a symlink");
      }
    }
  }
}
