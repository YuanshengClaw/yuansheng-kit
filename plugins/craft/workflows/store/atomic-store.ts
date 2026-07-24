import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { canonicalizeJson, sealArtifact } from "../artifacts/canonical";
import type {
  ActionJournal,
  ArtifactRef,
  PrincipalAudit,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../artifacts/generated";
import {
  artifactRef,
  parseCraftContractBytes,
  validateCraftContractGraph,
} from "../artifacts/parser";
import type { JsonValue } from "../artifacts/strict-json";
import { rebindBlockedWorkflowCoordinator } from "../state-machine/engine";
import {
  auditTrustedPrincipal,
  principalsEqual,
  type TrustedPrincipal,
} from "../state-machine/principal";
import {
  anchorChildDirectory,
  anchorExistingDirectory,
  atomicReplaceFile,
  claimRegularFile,
  createAnchoredChildDirectoryExclusive,
  type DirectoryAnchor,
  ensureAnchoredChildDirectory,
  isExistingPathError,
  isMissingPathError,
  listDirectoryNames,
  type OwnedFile,
  readRegularFileIfPresent,
  readRegularFileNoFollow,
  StorePathError,
  unlinkOwnedFile,
  writeFileExclusive,
  writeImmutableFile,
} from "./filesystem";
import {
  artifactFileName,
  assertObservation,
  type BuildingLeaseRecord,
  commitFileName,
  encodeStoreRecord,
  leaseFileName,
  type OperationIntentRecord,
  type OperationResultRecord,
  type OperationStartedRecord,
  operationDirectoryName,
  parseBuildingLease,
  parseOperationIntent,
  parseOperationResult,
  parseOperationStarted,
  parseStoreIdentity,
  parseWorkflowCommit,
  parseWorkflowIdentity,
  parseWorkflowLock,
  parseWorkflowPointer,
  type ResumeCheckIssue,
  type ResumeRepositoryObservation,
  type ResumeWorkflowResult,
  recordDigest,
  repositoryBindingFrom,
  type SideEffectKind,
  type StoreIdentityRecord,
  type StoreResidue,
  sealStoreRecord,
  type WorkflowCommitRecord,
  type WorkflowIdentityRecord,
  type WorkflowLockRecord,
  type WorkflowPointerRecord,
  type WorkflowSnapshot,
  workflowDirectoryName,
} from "./records";

type StoredArtifact = Exclude<YuanshengCraftContractV1, WorkflowState | ActionJournal>;

export type WorkflowStoreErrorCode =
  | "BUILDING_LEASE_CONFLICT"
  | "JOURNAL_NOT_APPEND_ONLY"
  | "OPERATION_COLLISION"
  | "OPERATION_INVALID"
  | "REVISION_CONFLICT"
  | "STORE_CORRUPT"
  | "STORE_LOCKED"
  | "WORKFLOW_COLLISION"
  | "WORKFLOW_NOT_FOUND";

export class WorkflowStoreError extends Error {
  constructor(
    readonly code: WorkflowStoreErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "WorkflowStoreError";
  }
}

export interface InitializeWorkflowInput {
  readonly artifacts: readonly StoredArtifact[];
  readonly configDigest: `sha256:${string}`;
  readonly controllerRootRealpath: string;
  readonly journal: ActionJournal;
  readonly state: WorkflowState;
}

export interface CommitWorkflowInput {
  readonly artifacts: readonly StoredArtifact[];
  readonly expectedRevision: number;
  readonly journal: ActionJournal;
  readonly state: WorkflowState;
}

export interface RecordOperationIntentInput {
  readonly action: string;
  readonly at: string;
  readonly operationId: string;
  readonly principal: TrustedPrincipal;
  readonly sideEffect: SideEffectKind;
  readonly subjectRefs: readonly ArtifactRef[];
  readonly workflowId: string;
}

export interface RecordOperationResultInput {
  readonly at: string;
  readonly evidenceRefs: readonly ArtifactRef[];
  readonly operationId: string;
  readonly outcome: "failed" | "succeeded";
  readonly principal: TrustedPrincipal;
  readonly workflowId: string;
}

export interface ResumeExactWorkflowInput {
  readonly at: string;
  readonly observation: ResumeRepositoryObservation;
  readonly principal: TrustedPrincipal;
  readonly storeAnchor: string;
  readonly workflowId: string;
}

interface StoreLayout {
  readonly artifacts: DirectoryAnchor;
  readonly artifactsPath: string;
  readonly leases: DirectoryAnchor;
  readonly leasesPath: string;
  readonly root: DirectoryAnchor;
  readonly rootPath: string;
  readonly workflows: DirectoryAnchor;
  readonly workflowsPath: string;
}

interface WorkflowLayout {
  readonly commits: DirectoryAnchor;
  readonly commitsPath: string;
  readonly operations: DirectoryAnchor;
  readonly operationsPath: string;
  readonly workflow: DirectoryAnchor;
  readonly workflowPath: string;
}

interface OperationLayout {
  readonly operation: DirectoryAnchor;
  readonly operationPath: string;
}

interface LeaseAcquisition {
  readonly lease: BuildingLeaseRecord;
  readonly owned: OwnedFile | null;
}

const STORE_IDENTITY = "store.json";
const WORKFLOW_IDENTITY = "identity.json";
const CURRENT_POINTER = "current.json";
const WORKFLOW_LOCK = ".lock";

function holdsCandidateWorktreeLease(phase: WorkflowState["phase"]): boolean {
  return (
    phase === "building" || phase === "verifying" || phase === "reviewing" || phase === "delivering"
  );
}

export class AtomicWorkflowStore {
  private constructor(private readonly layout: StoreLayout) {}

  static async open(root: string): Promise<AtomicWorkflowStore> {
    const rootAnchor = await anchorExistingDirectory(root);
    const storeIdentity: StoreIdentityRecord = {
      format_version: 1,
      kind: "ys-craft-store",
      root_realpath: rootAnchor.realpath,
    };
    const identityPath = join(root, STORE_IDENTITY);
    const identityBytes = encodeStoreRecord(storeIdentity);
    try {
      await writeFileExclusive(identityPath, identityBytes, root, rootAnchor);
    } catch (error) {
      if (!isExistingPathError(error)) {
        throw error;
      }
      const parsed = parseStoreIdentity(
        await readRegularFileNoFollow(identityPath, root, rootAnchor),
      );
      if (
        parsed.root_realpath !== storeIdentity.root_realpath ||
        encodeStoreRecord(parsed).some((byte, index) => byte !== identityBytes[index]) ||
        encodeStoreRecord(parsed).length !== identityBytes.length
      ) {
        throw storeError("STORE_CORRUPT", "Store identity does not match its injected root");
      }
    }
    const workflowsPath = join(root, "workflows");
    const artifactsPath = join(root, "artifacts");
    const leasesPath = join(root, "leases");
    const workflows = await ensureAnchoredChildDirectory(root, rootAnchor, "workflows");
    const artifacts = await ensureAnchoredChildDirectory(root, rootAnchor, "artifacts");
    const leases = await ensureAnchoredChildDirectory(root, rootAnchor, "leases");
    return new AtomicWorkflowStore({
      artifacts,
      artifactsPath,
      leases,
      leasesPath,
      root: rootAnchor,
      rootPath: root,
      workflows,
      workflowsPath,
    });
  }

  get rootRealpath(): string {
    return this.layout.root.realpath;
  }

  async initializeWorkflow(input: InitializeWorkflowInput): Promise<WorkflowSnapshot> {
    validateSnapshotPayload(input.state, input.journal, input.artifacts);
    if (input.state.revision !== 0 || input.journal.revision !== 0) {
      throw storeError("REVISION_CONFLICT", "A new workflow must start at revision zero");
    }
    const binding = repositoryBindingFrom(input.state, input.artifacts);
    const workflowName = workflowDirectoryName(input.state.workflow_id);
    let workflowAnchor: DirectoryAnchor;
    try {
      workflowAnchor = await createAnchoredChildDirectoryExclusive(
        this.layout.workflowsPath,
        this.layout.workflows,
        workflowName,
      );
    } catch (error) {
      if (isExistingPathError(error)) {
        throw storeError(
          "WORKFLOW_COLLISION",
          `Workflow ${input.state.workflow_id} already exists or has recovery residue`,
        );
      }
      throw error;
    }
    const workflowPath = join(this.layout.workflowsPath, workflowName);
    const identity: WorkflowIdentityRecord = {
      config_digest: input.configDigest,
      controller_root_realpath: input.controllerRootRealpath,
      format_version: 1,
      kind: "workflow-identity",
      target_worktree_realpath: binding.target_worktree_realpath,
      workflow_id: input.state.workflow_id,
    };
    await writeFileExclusive(
      join(workflowPath, WORKFLOW_IDENTITY),
      encodeStoreRecord(identity),
      workflowPath,
      workflowAnchor,
    );
    const commits = await ensureAnchoredChildDirectory(workflowPath, workflowAnchor, "commits");
    const operations = await ensureAnchoredChildDirectory(
      workflowPath,
      workflowAnchor,
      "operations",
    );
    const workflow: WorkflowLayout = {
      commits,
      commitsPath: join(workflowPath, "commits"),
      operations,
      operationsPath: join(workflowPath, "operations"),
      workflow: workflowAnchor,
      workflowPath,
    };
    let lease: LeaseAcquisition | null = null;
    let pointerCommitted = false;
    try {
      if (holdsCandidateWorktreeLease(input.state.phase)) {
        lease = await this.acquireLease(
          binding.target_worktree_realpath,
          input.state.workflow_id,
          input.state.revision,
          input.state.updated_at,
        );
      }
      await this.persistCommit(workflow, input.state, input.journal, input.artifacts, null);
      pointerCommitted = true;
      return this.readSnapshotFromLayout(workflow, input.state.workflow_id);
    } catch (error) {
      if (!pointerCommitted && lease?.owned !== null && lease !== null) {
        await this.releaseOwnedLease(lease.owned);
      }
      throw error;
    }
  }

  async readExactWorkflow(workflowId: string): Promise<WorkflowSnapshot> {
    const workflow = await this.openWorkflowLayout(workflowId);
    return this.readSnapshotFromLayout(workflow, workflowId);
  }

  async commitWorkflow(input: CommitWorkflowInput): Promise<WorkflowSnapshot> {
    validateSnapshotPayload(input.state, input.journal, input.artifacts);
    const workflow = await this.openWorkflowLayout(input.state.workflow_id);
    const lock = await this.acquireWorkflowLock(
      workflow,
      input.state.workflow_id,
      input.state.updated_at,
    );
    let enteredLease: LeaseAcquisition | null = null;
    let pointerCommitted = false;
    try {
      const previous = await this.readSnapshotFromLayout(workflow, input.state.workflow_id);
      if (
        previous.state.revision !== input.expectedRevision ||
        input.state.revision !== input.expectedRevision + 1 ||
        input.journal.revision !== input.state.revision
      ) {
        throw storeError(
          "REVISION_CONFLICT",
          `Expected revision ${input.expectedRevision}, found ${previous.state.revision}`,
        );
      }
      assertJournalAppendOnly(previous.journal, input.journal);
      const identity = await this.readWorkflowIdentity(workflow);
      const binding = repositoryBindingFrom(input.state, input.artifacts);
      if (
        identity.workflow_id !== input.state.workflow_id ||
        identity.target_worktree_realpath !== binding.target_worktree_realpath
      ) {
        throw storeError("STORE_CORRUPT", "Workflow identity or worktree binding changed");
      }

      const previouslyHeldLease = holdsCandidateWorktreeLease(previous.state.phase);
      const nextHoldsLease = holdsCandidateWorktreeLease(input.state.phase);
      const enteredCandidateLifecycle = !previouslyHeldLease && nextHoldsLease;
      const remainedInCandidateLifecycle = previouslyHeldLease && nextHoldsLease;
      const leftCandidateLifecycle = previouslyHeldLease && !nextHoldsLease;
      if (enteredCandidateLifecycle) {
        enteredLease = await this.acquireLease(
          binding.target_worktree_realpath,
          input.state.workflow_id,
          input.state.revision,
          input.state.updated_at,
        );
      } else if (remainedInCandidateLifecycle) {
        await this.assertLeaseOwner(binding.target_worktree_realpath, input.state.workflow_id);
      }

      await this.persistCommit(
        workflow,
        input.state,
        input.journal,
        input.artifacts,
        previous.commitDigest,
      );
      pointerCommitted = true;
      if (leftCandidateLifecycle) {
        await this.releaseLease(binding.target_worktree_realpath, input.state.workflow_id);
      }
      return this.readSnapshotFromLayout(workflow, input.state.workflow_id);
    } catch (error) {
      if (!pointerCommitted && enteredLease?.owned !== null && enteredLease !== null) {
        await this.releaseOwnedLease(enteredLease.owned);
      }
      throw error;
    } finally {
      await unlinkOwnedFile(lock, workflow.workflowPath, workflow.workflow);
    }
  }

  async recordOperationIntent(input: RecordOperationIntentInput): Promise<OperationIntentRecord> {
    const snapshot = await this.readExactWorkflow(input.workflowId);
    const principal = auditTrustedPrincipal(input.principal);
    if (!isBoundPrincipal(snapshot.state, principal)) {
      throw storeError(
        "OPERATION_INVALID",
        "Operation intent principal is not bound to the exact workflow",
      );
    }
    const knownRefs = new Set(snapshot.artifacts.map((artifact) => artifact.artifact_digest));
    if (input.subjectRefs.some((ref) => !knownRefs.has(ref.digest))) {
      throw storeError("OPERATION_INVALID", "Operation intent references an unbound artifact");
    }
    const workflow = await this.openWorkflowLayout(input.workflowId);
    const operationName = operationDirectoryName(input.operationId);
    let operation: DirectoryAnchor;
    try {
      operation = await createAnchoredChildDirectoryExclusive(
        workflow.operationsPath,
        workflow.operations,
        operationName,
      );
    } catch (error) {
      if (isExistingPathError(error)) {
        throw storeError("OPERATION_COLLISION", `Operation ${input.operationId} already exists`);
      }
      throw error;
    }
    const operationPath = join(workflow.operationsPath, operationName);
    const intent: OperationIntentRecord = {
      action: input.action,
      created_at: input.at,
      format_version: 1,
      kind: "operation-intent",
      operation_id: input.operationId,
      principal,
      side_effect: input.sideEffect,
      subject_refs: [...input.subjectRefs],
      workflow_id: input.workflowId,
      workflow_revision: snapshot.state.revision,
    };
    const bytes = encodeStoreRecord(intent);
    await writeFileExclusive(join(operationPath, "intent.json"), bytes, operationPath, operation);
    return parseOperationIntent(bytes);
  }

  async markOperationStarted(input: {
    readonly at: string;
    readonly operationId: string;
    readonly workflowId: string;
  }): Promise<OperationStartedRecord> {
    const operation = await this.openOperationLayout(input.workflowId, input.operationId);
    const intentBytes = await readRegularFileNoFollow(
      join(operation.operationPath, "intent.json"),
      operation.operationPath,
      operation.operation,
    );
    const intent = parseOperationIntent(intentBytes);
    assertOperationIdentity(intent, input.workflowId, input.operationId);
    const started: OperationStartedRecord = {
      format_version: 1,
      intent_digest: recordDigest(intent),
      kind: "operation-started",
      operation_id: input.operationId,
      started_at: input.at,
      workflow_id: input.workflowId,
    };
    if (Date.parse(started.started_at) < Date.parse(intent.created_at)) {
      throw storeError("OPERATION_INVALID", "Operation cannot start before its intent");
    }
    const bytes = encodeStoreRecord(started);
    try {
      await writeFileExclusive(
        join(operation.operationPath, "started.json"),
        bytes,
        operation.operationPath,
        operation.operation,
      );
    } catch (error) {
      if (isExistingPathError(error)) {
        throw storeError("OPERATION_COLLISION", "Operation was already marked started");
      }
      throw error;
    }
    return parseOperationStarted(bytes);
  }

  async recordOperationResult(input: RecordOperationResultInput): Promise<OperationResultRecord> {
    const principal = auditTrustedPrincipal(input.principal);
    const operation = await this.openOperationLayout(input.workflowId, input.operationId);
    const intent = parseOperationIntent(
      await readRegularFileNoFollow(
        join(operation.operationPath, "intent.json"),
        operation.operationPath,
        operation.operation,
      ),
    );
    const started = parseOperationStarted(
      await readRegularFileNoFollow(
        join(operation.operationPath, "started.json"),
        operation.operationPath,
        operation.operation,
      ),
    );
    assertOperationIdentity(intent, input.workflowId, input.operationId);
    assertOperationIdentity(started, input.workflowId, input.operationId);
    if (principal.agent_id !== "ys-craft" && !principalsEqual(principal, intent.principal)) {
      throw storeError(
        "OPERATION_INVALID",
        "Operation result requires its exact executing principal or the trusted primary agent",
      );
    }
    if (
      started.intent_digest !== recordDigest(intent) ||
      Date.parse(input.at) < Date.parse(started.started_at)
    ) {
      throw storeError("OPERATION_INVALID", "Operation result does not bind its started intent");
    }
    const snapshot = await this.readExactWorkflow(input.workflowId);
    const knownRefs = new Set(snapshot.artifacts.map((artifact) => artifact.artifact_digest));
    if (input.evidenceRefs.some((ref) => !knownRefs.has(ref.digest))) {
      throw storeError("OPERATION_INVALID", "Operation result references unknown evidence");
    }
    const result: OperationResultRecord = {
      completed_at: input.at,
      evidence_refs: [...input.evidenceRefs],
      format_version: 1,
      intent_digest: started.intent_digest,
      kind: "operation-result",
      operation_id: input.operationId,
      outcome: input.outcome,
      workflow_id: input.workflowId,
    };
    const bytes = encodeStoreRecord(result);
    try {
      await writeFileExclusive(
        join(operation.operationPath, "result.json"),
        bytes,
        operation.operationPath,
        operation.operation,
      );
    } catch (error) {
      if (isExistingPathError(error)) {
        throw storeError("OPERATION_COLLISION", "Operation already has a result");
      }
      throw error;
    }
    return parseOperationResult(bytes);
  }

  async inspectResidues(workflowId: string): Promise<readonly StoreResidue[]> {
    const workflow = await this.openWorkflowLayout(workflowId);
    const residues: StoreResidue[] = [];
    await collectResidues(workflow.workflowPath, workflow.workflow, residues);
    await collectResidues(workflow.commitsPath, workflow.commits, residues);
    await collectResidues(this.layout.artifactsPath, this.layout.artifacts, residues);
    return Object.freeze(residues);
  }

  async resumeExactWorkflow(input: ResumeExactWorkflowInput): Promise<ResumeWorkflowResult> {
    assertObservation(input.observation);
    const principal = auditTrustedPrincipal(input.principal);
    if (principal.agent_id !== "ys-craft") {
      throw storeError(
        "OPERATION_INVALID",
        "Explicit resume requires the trusted Yuansheng Craft primary agent",
      );
    }
    const snapshot = await this.readExactWorkflow(input.workflowId);
    const workflow = await this.openWorkflowLayout(input.workflowId);
    const identity = await this.readWorkflowIdentity(workflow);
    const binding = repositoryBindingFrom(snapshot.state, snapshot.artifacts);
    const issues: ResumeCheckIssue[] = [];

    if (
      input.storeAnchor !== this.rootRealpath ||
      input.observation.storeRootRealpath !== this.rootRealpath
    ) {
      issues.push(
        resumeIssue(
          "STORE_ANCHOR_MISMATCH",
          "Explicit store anchor does not match the opened Store realpath",
          "Supply the exact canonical Store root selected by the platform adapter.",
        ),
      );
    }
    if (!input.observation.storeRootIgnored) {
      issues.push(
        resumeIssue(
          "STORE_NOT_IGNORED",
          "Store root is not ignored by the bound Git repository",
          "Add the platform Store path to the repository-local exclude file, then rerun preflight.",
        ),
      );
    }
    if (identity.config_digest !== input.observation.configDigest) {
      issues.push(
        resumeIssue(
          "CONFIG_DRIFT",
          "Current Yuansheng Craft configuration differs from workflow creation",
          "Restore the recorded configuration or start a new workflow with the current configuration.",
        ),
      );
    }
    if (identity.controller_root_realpath !== input.observation.controllerRootRealpath) {
      issues.push(
        resumeIssue(
          "CONFIG_DRIFT",
          "Current controller root differs from workflow creation",
          "Return to the exact controller worktree or start a new workflow from this controller.",
        ),
      );
    }
    if (
      identity.target_worktree_realpath !== binding.target_worktree_realpath ||
      binding.target_worktree_realpath !== input.observation.targetWorktreeRealpath ||
      binding.git_root_realpath !== input.observation.gitRootRealpath ||
      binding.product_root_realpath !== input.observation.productRootRealpath
    ) {
      issues.push(
        resumeIssue(
          "REPOSITORY_IDENTITY_DRIFT",
          "Repository or worktree realpath no longer matches the immutable binding",
          "Return to the exact bound worktree and product root; relocation requires a new workflow.",
        ),
      );
    }
    if (
      input.observation.headCommit !== binding.commit_sha ||
      input.observation.headTreeDigest !== binding.tree_digest
    ) {
      issues.push(
        resumeIssue(
          "HEAD_DRIFT",
          "HEAD or its baseline tree differs from the immutable repository binding",
          "Restore the recorded baseline commit without discarding unreviewed work, or start a new workflow.",
        ),
      );
    }
    verifyCandidateDrift(snapshot, input.observation, issues);
    verifyResumeContracts(snapshot, issues);

    const residues = await this.inspectResidues(input.workflowId);
    for (const residue of residues) {
      issues.push(
        resumeIssue(
          "STORE_RESIDUE",
          `Store contains ${residue.kind} residue at ${residue.path}`,
          residue.remediation,
        ),
      );
    }
    const ambiguousOperations = await this.ambiguousOperations(workflow, input.workflowId);
    for (const operationId of ambiguousOperations) {
      issues.push(
        resumeIssue(
          "AMBIGUOUS_SIDE_EFFECT",
          `Operation ${operationId} started without an accounted result`,
          "Inspect the external side effect and explicitly record its result; do not replay or reset automatically.",
        ),
      );
    }
    await this.verifyResumeLease(snapshot, binding.target_worktree_realpath, issues);
    const recoveredAmbiguity =
      ambiguousOperations.length !== 0 &&
      snapshot.state.status === "active" &&
      snapshot.state.phase !== "blocked" &&
      snapshot.state.phase !== "completed";
    if (recoveredAmbiguity) {
      await this.persistRecoveryBlock(snapshot, principal, input.at);
    } else if (snapshot.state.phase !== "blocked" || snapshot.state.blocked_context === null) {
      issues.push(
        resumeIssue(
          "WORKFLOW_NOT_BLOCKED",
          "Only an explicitly blocked workflow can be resumed",
          "Use normal lifecycle tools for an active workflow; completed workflows are terminal.",
        ),
      );
    }
    if (issues.length !== 0) {
      return Object.freeze({
        issues: Object.freeze(issues),
        status: "blocked" as const,
        workflowId: input.workflowId,
      });
    }

    const state = rebindBlockedWorkflowCoordinator({
      at: input.at,
      expectedRevision: snapshot.state.revision,
      principal: input.principal,
      state: snapshot.state,
    });
    const journal = appendResumeJournal(snapshot.journal, state, principal, input.at);
    const resumed = await this.commitWorkflow({
      artifacts: snapshot.artifacts,
      expectedRevision: snapshot.state.revision,
      journal,
      state,
    });
    return Object.freeze({
      snapshot: resumed,
      status: "resumed" as const,
      workflowId: input.workflowId,
    });
  }

  private async persistRecoveryBlock(
    snapshot: WorkflowSnapshot,
    principal: PrincipalAudit,
    at: string,
  ): Promise<void> {
    if (snapshot.state.phase === "blocked" || snapshot.state.phase === "completed") {
      return;
    }
    const { artifact_digest: _artifactDigest, ...payload } = snapshot.state;
    const state = parseWorkflowState(
      sealArtifact({
        ...payload,
        blocked_context: {
          from_phase: snapshot.state.phase,
          reason:
            "A side effect started but has no accounted result; human inspection is required.",
          remediation_phase: recoveryRemediationPhase(snapshot.state),
        },
        phase: "blocked",
        phase_principal: null,
        revision: snapshot.state.revision + 1,
        status: "blocked",
        updated_at: at,
      } as unknown as Record<string, JsonValue>) as unknown as WorkflowState,
    );
    const journal = appendJournalEntry(snapshot.journal, state, principal, at, "blocked");
    await this.commitWorkflow({
      artifacts: snapshot.artifacts,
      expectedRevision: snapshot.state.revision,
      journal,
      state,
    });
  }

  private async persistCommit(
    workflow: WorkflowLayout,
    state: WorkflowState,
    journal: ActionJournal,
    artifacts: readonly StoredArtifact[],
    previousCommitDigest: `sha256:${string}` | null,
  ): Promise<void> {
    for (const artifact of [...artifacts, state, journal]) {
      await writeImmutableFile(
        join(this.layout.artifactsPath, artifactFileName(artifact.artifact_digest)),
        canonicalizeJson(artifact).bytes,
        this.layout.artifactsPath,
        this.layout.artifacts,
      );
    }
    const commit = sealStoreRecord({
      artifact_refs: sortRefs(artifacts.map(artifactRef)),
      committed_at: state.updated_at,
      format_version: 1,
      journal_ref: artifactRef(journal),
      kind: "workflow-commit",
      previous_commit_digest: previousCommitDigest,
      revision: state.revision,
      state_ref: artifactRef(state),
      workflow_id: state.workflow_id,
    } as unknown as Record<string, JsonValue>) as unknown as WorkflowCommitRecord;
    const commitBytes = encodeStoreRecord(commit);
    await writeImmutableFile(
      join(workflow.commitsPath, commitFileName(state.revision)),
      commitBytes,
      workflow.commitsPath,
      workflow.commits,
    );
    const pointer: WorkflowPointerRecord = {
      commit_digest: commit.record_digest,
      format_version: 1,
      kind: "workflow-pointer",
      revision: state.revision,
      workflow_id: state.workflow_id,
    };
    await atomicReplaceFile(
      join(workflow.workflowPath, CURRENT_POINTER),
      encodeStoreRecord(pointer),
      workflow.workflowPath,
      workflow.workflow,
    );
  }

  private async readSnapshotFromLayout(
    workflow: WorkflowLayout,
    workflowId: string,
  ): Promise<WorkflowSnapshot> {
    let pointer: WorkflowPointerRecord;
    try {
      pointer = parseWorkflowPointer(
        await readRegularFileNoFollow(
          join(workflow.workflowPath, CURRENT_POINTER),
          workflow.workflowPath,
          workflow.workflow,
        ),
      );
    } catch (error) {
      if (isMissingPathError(error)) {
        throw storeError("WORKFLOW_NOT_FOUND", `Workflow ${workflowId} has no committed state`);
      }
      throw corrupt(error, "Invalid workflow pointer");
    }
    if (pointer.workflow_id !== workflowId) {
      throw storeError("STORE_CORRUPT", "Workflow pointer ID does not match exact lookup");
    }
    const commit = await this.readCommit(workflow, pointer.revision);
    if (
      commit.workflow_id !== workflowId ||
      commit.revision !== pointer.revision ||
      commit.record_digest !== pointer.commit_digest
    ) {
      throw storeError("STORE_CORRUPT", "Workflow pointer does not bind its exact commit");
    }
    await this.verifyCommitChain(workflow, commit);
    const contracts = await Promise.all(
      [...commit.artifact_refs, commit.state_ref, commit.journal_ref].map((ref) =>
        this.readArtifact(ref),
      ),
    );
    const state = contracts.find(
      (contract): contract is WorkflowState =>
        contract.artifact_digest === commit.state_ref.digest &&
        contract.artifact_type === "workflow-state",
    );
    const journal = contracts.find(
      (contract): contract is ActionJournal =>
        contract.artifact_digest === commit.journal_ref.digest &&
        contract.artifact_type === "action-journal",
    );
    if (state === undefined || journal === undefined) {
      throw storeError("STORE_CORRUPT", "Workflow commit omitted state or journal");
    }
    const artifacts = contracts.filter(
      (contract): contract is StoredArtifact =>
        contract.artifact_type !== "workflow-state" && contract.artifact_type !== "action-journal",
    );
    try {
      validateSnapshotPayload(state, journal, artifacts);
    } catch (error) {
      throw corrupt(error, "Committed workflow snapshot is invalid");
    }
    if (
      state.revision !== pointer.revision ||
      journal.revision !== pointer.revision ||
      state.workflow_id !== workflowId ||
      journal.workflow_id !== workflowId
    ) {
      throw storeError("STORE_CORRUPT", "Committed state and journal revision differ");
    }
    return Object.freeze({
      artifacts: Object.freeze(artifacts),
      commitDigest: commit.record_digest,
      journal,
      state,
    });
  }

  private async readArtifact(ref: ArtifactRef): Promise<YuanshengCraftContractV1> {
    let contract: YuanshengCraftContractV1;
    try {
      contract = parseCraftContractBytes(
        await readRegularFileNoFollow(
          join(this.layout.artifactsPath, artifactFileName(ref.digest)),
          this.layout.artifactsPath,
          this.layout.artifacts,
        ),
      );
    } catch (error) {
      throw corrupt(error, `Cannot read immutable ${ref.artifact_type} ${ref.digest}`);
    }
    if (
      contract.artifact_digest !== ref.digest ||
      contract.artifact_type !== ref.artifact_type ||
      contract.artifact_version !== ref.artifact_version
    ) {
      throw storeError("STORE_CORRUPT", `Artifact reference mismatch for ${ref.digest}`);
    }
    return contract;
  }

  private async readCommit(
    workflow: WorkflowLayout,
    revision: number,
  ): Promise<WorkflowCommitRecord> {
    try {
      return parseWorkflowCommit(
        await readRegularFileNoFollow(
          join(workflow.commitsPath, commitFileName(revision)),
          workflow.commitsPath,
          workflow.commits,
        ),
      );
    } catch (error) {
      throw corrupt(error, `Cannot read workflow commit revision ${revision}`);
    }
  }

  private async verifyCommitChain(
    workflow: WorkflowLayout,
    current: WorkflowCommitRecord,
  ): Promise<void> {
    let commit = current;
    while (commit.revision > 0) {
      const previous = await this.readCommit(workflow, commit.revision - 1);
      if (
        commit.previous_commit_digest !== previous.record_digest ||
        previous.workflow_id !== commit.workflow_id ||
        previous.revision + 1 !== commit.revision
      ) {
        throw storeError("STORE_CORRUPT", "Workflow commit chain is discontinuous");
      }
      commit = previous;
    }
    if (commit.previous_commit_digest !== null) {
      throw storeError("STORE_CORRUPT", "Initial workflow commit has a predecessor");
    }
  }

  private async openWorkflowLayout(workflowId: string): Promise<WorkflowLayout> {
    const workflowName = workflowDirectoryName(workflowId);
    const workflowPath = join(this.layout.workflowsPath, workflowName);
    let workflow: DirectoryAnchor;
    try {
      workflow = await anchorChildDirectory(
        this.layout.workflowsPath,
        this.layout.workflows,
        workflowPath,
      );
    } catch (error) {
      if (isMissingPathError(error)) {
        throw storeError("WORKFLOW_NOT_FOUND", `Unknown exact workflow ID ${workflowId}`);
      }
      throw error;
    }
    const identity = parseWorkflowIdentity(
      await readRegularFileNoFollow(join(workflowPath, WORKFLOW_IDENTITY), workflowPath, workflow),
    );
    if (identity.workflow_id !== workflowId) {
      throw storeError("STORE_CORRUPT", "Hashed workflow directory has an ID collision");
    }
    const commitsPath = join(workflowPath, "commits");
    const operationsPath = join(workflowPath, "operations");
    const commits = await anchorChildDirectory(workflowPath, workflow, commitsPath);
    const operations = await anchorChildDirectory(workflowPath, workflow, operationsPath);
    return {
      commits,
      commitsPath,
      operations,
      operationsPath,
      workflow,
      workflowPath,
    };
  }

  private async readWorkflowIdentity(workflow: WorkflowLayout): Promise<WorkflowIdentityRecord> {
    return parseWorkflowIdentity(
      await readRegularFileNoFollow(
        join(workflow.workflowPath, WORKFLOW_IDENTITY),
        workflow.workflowPath,
        workflow.workflow,
      ),
    );
  }

  private async acquireWorkflowLock(
    workflow: WorkflowLayout,
    workflowId: string,
    at: string,
  ): Promise<OwnedFile> {
    const lock: WorkflowLockRecord = {
      acquired_at: at,
      format_version: 1,
      kind: "workflow-lock",
      token: `lock:${randomUUID()}`,
      workflow_id: workflowId,
    };
    const bytes = encodeStoreRecord(lock);
    try {
      const owned = await writeFileExclusive(
        join(workflow.workflowPath, WORKFLOW_LOCK),
        bytes,
        workflow.workflowPath,
        workflow.workflow,
      );
      parseWorkflowLock(owned.bytes);
      return owned;
    } catch (error) {
      if (isExistingPathError(error)) {
        throw storeError(
          "STORE_LOCKED",
          `Workflow ${workflowId} has an active or residual Store lock`,
        );
      }
      throw error;
    }
  }

  private async acquireLease(
    targetWorktreeRealpath: string,
    workflowId: string,
    targetRevision: number,
    at: string,
  ): Promise<LeaseAcquisition> {
    const lease: BuildingLeaseRecord = {
      acquired_at: at,
      format_version: 1,
      kind: "building-lease",
      target_revision: targetRevision,
      target_worktree_realpath: targetWorktreeRealpath,
      workflow_id: workflowId,
    };
    const path = join(this.layout.leasesPath, leaseFileName(targetWorktreeRealpath));
    try {
      const owned = await writeFileExclusive(
        path,
        encodeStoreRecord(lease),
        this.layout.leasesPath,
        this.layout.leases,
      );
      return { lease, owned };
    } catch (error) {
      if (!isExistingPathError(error)) {
        throw error;
      }
      const existing = parseBuildingLease(
        await readRegularFileNoFollow(path, this.layout.leasesPath, this.layout.leases),
      );
      if (
        existing.workflow_id === workflowId &&
        existing.target_worktree_realpath === targetWorktreeRealpath &&
        existing.target_revision === targetRevision
      ) {
        return { lease: existing, owned: null };
      }
      throw storeError(
        "BUILDING_LEASE_CONFLICT",
        `Worktree is already leased by workflow ${existing.workflow_id}`,
      );
    }
  }

  private async assertLeaseOwner(
    targetWorktreeRealpath: string,
    workflowId: string,
  ): Promise<void> {
    const path = join(this.layout.leasesPath, leaseFileName(targetWorktreeRealpath));
    let lease: BuildingLeaseRecord;
    try {
      lease = parseBuildingLease(
        await readRegularFileNoFollow(path, this.layout.leasesPath, this.layout.leases),
      );
    } catch (error) {
      if (isMissingPathError(error)) {
        throw storeError(
          "BUILDING_LEASE_CONFLICT",
          "Building workflow has no exclusive worktree lease",
        );
      }
      throw error;
    }
    if (
      lease.workflow_id !== workflowId ||
      lease.target_worktree_realpath !== targetWorktreeRealpath
    ) {
      throw storeError(
        "BUILDING_LEASE_CONFLICT",
        `Worktree lease belongs to workflow ${lease.workflow_id}`,
      );
    }
  }

  private async releaseLease(targetWorktreeRealpath: string, workflowId: string): Promise<void> {
    const path = join(this.layout.leasesPath, leaseFileName(targetWorktreeRealpath));
    const owned = await claimRegularFile(path, this.layout.leasesPath, this.layout.leases);
    const lease = parseBuildingLease(owned.bytes);
    if (
      lease.workflow_id !== workflowId ||
      lease.target_worktree_realpath !== targetWorktreeRealpath
    ) {
      throw storeError(
        "BUILDING_LEASE_CONFLICT",
        `Refusing to release lease owned by workflow ${lease.workflow_id}`,
      );
    }
    await this.releaseOwnedLease(owned);
  }

  private async releaseOwnedLease(owned: OwnedFile): Promise<void> {
    await unlinkOwnedFile(owned, this.layout.leasesPath, this.layout.leases);
  }

  private async openOperationLayout(
    workflowId: string,
    operationId: string,
  ): Promise<OperationLayout> {
    const workflow = await this.openWorkflowLayout(workflowId);
    const operationPath = join(workflow.operationsPath, operationDirectoryName(operationId));
    let operation: DirectoryAnchor;
    try {
      operation = await anchorChildDirectory(
        workflow.operationsPath,
        workflow.operations,
        operationPath,
      );
    } catch (error) {
      if (isMissingPathError(error)) {
        throw storeError("OPERATION_INVALID", `Unknown exact operation ID ${operationId}`);
      }
      throw error;
    }
    return { operation, operationPath };
  }

  private async ambiguousOperations(
    workflow: WorkflowLayout,
    workflowId: string,
  ): Promise<readonly string[]> {
    const ambiguous: string[] = [];
    for (const name of await listDirectoryNames(workflow.operationsPath, workflow.operations)) {
      if (!/^[0-9a-f]{64}$/u.test(name)) {
        throw storeError("STORE_CORRUPT", `Unexpected operation directory ${name}`);
      }
      const operationPath = join(workflow.operationsPath, name);
      const operation = await anchorChildDirectory(
        workflow.operationsPath,
        workflow.operations,
        operationPath,
      );
      const intent = parseOperationIntent(
        await readRegularFileNoFollow(join(operationPath, "intent.json"), operationPath, operation),
      );
      if (
        intent.workflow_id !== workflowId ||
        operationDirectoryName(intent.operation_id) !== name
      ) {
        throw storeError("STORE_CORRUPT", "Operation directory identity mismatch");
      }
      const startedBytes = await readRegularFileIfPresent(
        join(operationPath, "started.json"),
        operationPath,
        operation,
      );
      const resultBytes = await readRegularFileIfPresent(
        join(operationPath, "result.json"),
        operationPath,
        operation,
      );
      if (startedBytes === null && resultBytes !== null) {
        throw storeError("STORE_CORRUPT", "Operation result exists without a started record");
      }
      if (startedBytes !== null) {
        const started = parseOperationStarted(startedBytes);
        assertOperationIdentity(started, workflowId, intent.operation_id);
        if (started.intent_digest !== recordDigest(intent)) {
          throw storeError("STORE_CORRUPT", "Operation started record has wrong intent digest");
        }
        if (resultBytes === null) {
          ambiguous.push(intent.operation_id);
        } else {
          const result = parseOperationResult(resultBytes);
          assertOperationIdentity(result, workflowId, intent.operation_id);
          if (result.intent_digest !== started.intent_digest) {
            throw storeError("STORE_CORRUPT", "Operation result has wrong intent digest");
          }
        }
      }
    }
    return Object.freeze(ambiguous);
  }

  private async verifyResumeLease(
    snapshot: WorkflowSnapshot,
    targetWorktreeRealpath: string,
    issues: ResumeCheckIssue[],
  ): Promise<void> {
    const path = join(this.layout.leasesPath, leaseFileName(targetWorktreeRealpath));
    const bytes = await readRegularFileIfPresent(path, this.layout.leasesPath, this.layout.leases);
    if (bytes === null) {
      if (holdsCandidateWorktreeLease(snapshot.state.phase)) {
        issues.push(
          resumeIssue(
            "BUILDING_LEASE_INVALID",
            "Active candidate workflow has no worktree lease",
            "Do not continue mutation; inspect Store recovery residue and reacquire through an explicit transition.",
          ),
        );
      }
      return;
    }
    const lease = parseBuildingLease(bytes);
    if (
      !holdsCandidateWorktreeLease(snapshot.state.phase) ||
      lease.workflow_id !== snapshot.state.workflow_id
    ) {
      issues.push(
        resumeIssue(
          "BUILDING_LEASE_INVALID",
          `Worktree lease is held by workflow ${lease.workflow_id}`,
          "Finish or explicitly block the lease owner before resuming this workflow.",
        ),
      );
    }
  }
}

export async function openAtomicWorkflowStore(root: string): Promise<AtomicWorkflowStore> {
  return AtomicWorkflowStore.open(root);
}

function validateSnapshotPayload(
  state: WorkflowState,
  journal: ActionJournal,
  artifacts: readonly StoredArtifact[],
): void {
  const all: YuanshengCraftContractV1[] = [...artifacts, state, journal];
  for (const contract of all) {
    const parsed = parseCraftContractBytes(canonicalizeJson(contract).bytes);
    if (parsed.artifact_digest !== contract.artifact_digest) {
      throw storeError("STORE_CORRUPT", "Snapshot contains a non-canonical contract");
    }
    if ("workflow_id" in contract && contract.workflow_id !== state.workflow_id) {
      throw storeError("STORE_CORRUPT", "Snapshot contracts belong to different workflows");
    }
  }
  if (journal.workflow_id !== state.workflow_id || journal.revision !== state.revision) {
    throw storeError("REVISION_CONFLICT", "State and action journal revisions must match");
  }
  const references = new Set(
    [
      ...state.artifact_refs,
      ...state.stale_artifact_refs,
      ...journal.entries.flatMap((entry) => entry.subject_refs),
    ].map((ref) => ref.digest),
  );
  const stored = new Set(artifacts.map((artifact) => artifact.artifact_digest));
  if ([...references].some((digest) => !stored.has(digest))) {
    throw storeError("STORE_CORRUPT", "Snapshot omits a referenced immutable artifact");
  }
  validateCraftContractGraph(all);
}

function assertJournalAppendOnly(previous: ActionJournal, next: ActionJournal): void {
  if (
    next.entries.length < previous.entries.length ||
    previous.entries.some(
      (entry, index) => canonicalizeJson(entry).text !== canonicalizeJson(next.entries[index]).text,
    )
  ) {
    throw storeError(
      "JOURNAL_NOT_APPEND_ONLY",
      "Action journal history cannot be removed or rewritten",
    );
  }
}

function verifyCandidateDrift(
  snapshot: WorkflowSnapshot,
  observation: ResumeRepositoryObservation,
  issues: ResumeCheckIssue[],
): void {
  const activeDigests = new Set(snapshot.state.artifact_refs.map((ref) => ref.digest));
  const candidates = snapshot.artifacts.filter(
    (artifact): artifact is Extract<StoredArtifact, { artifact_type: "patch-candidate" }> =>
      artifact.artifact_type === "patch-candidate" && activeDigests.has(artifact.artifact_digest),
  );
  if (candidates.length > 1) {
    issues.push(
      resumeIssue(
        "ARTIFACT_CHAIN_INVALID",
        "Workflow has multiple active patch candidates",
        "Inspect the immutable artifact chain and block the workflow for manual repair.",
      ),
    );
    return;
  }
  const candidate = candidates[0];
  if (candidate === undefined) {
    if (observation.status !== "clean" || observation.diffContentDigest !== null) {
      issues.push(
        resumeIssue(
          "CANDIDATE_DRIFT",
          "Worktree is dirty before an immutable patch candidate exists",
          "Preserve and inspect the user changes; do not clean them automatically. Start a new workflow or bind an explicit candidate.",
        ),
      );
    }
    return;
  }
  if (
    observation.status !== "dirty" ||
    observation.diffContentDigest !== candidate.diff_content_digest
  ) {
    issues.push(
      resumeIssue(
        "CANDIDATE_DRIFT",
        "Actual worktree diff differs from the recorded patch candidate",
        "Preserve the worktree and reconcile the extra or missing drift manually; never reset automatically.",
      ),
    );
  }
}

function verifyResumeContracts(snapshot: WorkflowSnapshot, issues: ResumeCheckIssue[]): void {
  const activeDigests = new Set(snapshot.state.artifact_refs.map((ref) => ref.digest));
  const active = snapshot.artifacts.filter((artifact) =>
    activeDigests.has(artifact.artifact_digest),
  );
  const entryContext = snapshot.state.entry_context;
  if (entryContext.strategy === "root-cause-import") {
    const attestations = active.filter(
      (
        artifact,
      ): artifact is Extract<StoredArtifact, { artifact_type: "blueprint-review-attestation" }> =>
        artifact.artifact_type === "blueprint-review-attestation" &&
        artifact.artifact_digest === entryContext.attestation_ref.digest,
    );
    if (attestations.length !== 1 || attestations[0]?.action !== "allow") {
      issues.push(
        resumeIssue(
          "ARTIFACT_CHAIN_INVALID",
          "Imported workflow lacks its exact allowed Blueprint attestation",
          "Restore the immutable reviewed import chain or start a new workflow.",
        ),
      );
    }
  }
  const candidates = active.filter((artifact) => artifact.artifact_type === "patch-candidate");
  const manifests = active.filter((artifact) => artifact.artifact_type === "verification-manifest");
  const authorizations = active.filter(
    (artifact) => artifact.artifact_type === "verification-authorization",
  );
  if (manifests.length !== 0) {
    const manifest = manifests[0];
    const candidate = candidates[0];
    const matching =
      manifest === undefined || candidate === undefined
        ? []
        : authorizations.filter(
            (authorization) =>
              authorization.action === "allow" &&
              authorization.manifest_ref.digest === manifest.artifact_digest &&
              authorization.candidate_ref.digest === candidate.artifact_digest,
          );
    if (manifests.length !== 1 || candidates.length !== 1 || matching.length !== 1) {
      issues.push(
        resumeIssue(
          "ARTIFACT_CHAIN_INVALID",
          "Verification manifest lacks one exact allowed candidate authorization",
          "Create a new immutable authorization for the exact candidate manifest.",
        ),
      );
    }
  }
  const phaseManifests = active.filter(
    (artifact) => artifact.artifact_type === "phase-command-manifest",
  );
  for (const manifest of phaseManifests) {
    const matching = active.filter(
      (artifact) =>
        artifact.artifact_type === "phase-command-authorization" &&
        artifact.action === "allow" &&
        artifact.manifest_ref.digest === manifest.artifact_digest,
    );
    if (matching.length !== 1) {
      issues.push(
        resumeIssue(
          "ARTIFACT_CHAIN_INVALID",
          `Phase command manifest ${manifest.artifact_digest} lacks one exact allow`,
          "Request a fresh authorization for the immutable manifest.",
        ),
      );
    }
  }
  const builderSessions = new Set(
    active
      .filter((artifact) => artifact.artifact_type === "mutation-authorization")
      .map((artifact) => artifact.principal.session_id),
  );
  const reviews = active.filter((artifact) => artifact.artifact_type === "patch-review");
  if (reviews.some((review) => builderSessions.has(review.reviewer.session_id))) {
    issues.push(
      resumeIssue(
        "ARTIFACT_CHAIN_INVALID",
        "Patch reviewer session is not independent from the builder",
        "Obtain a review from a distinct real platform session.",
      ),
    );
  }
}

function appendResumeJournal(
  journal: ActionJournal,
  state: WorkflowState,
  principal: PrincipalAudit,
  at: string,
): ActionJournal {
  return appendJournalEntry(journal, state, principal, at, "succeeded");
}

function appendJournalEntry(
  journal: ActionJournal,
  state: WorkflowState,
  principal: PrincipalAudit,
  at: string,
  result: "blocked" | "succeeded",
): ActionJournal {
  const next = sealArtifact({
    artifact_type: "action-journal",
    artifact_version: 1,
    created_at: journal.created_at,
    entries: [
      ...journal.entries,
      {
        action: "ys_craft_resume",
        at,
        principal,
        result,
        sequence: journal.entries.length + 1,
        subject_refs: [],
      },
    ],
    revision: state.revision,
    workflow_id: state.workflow_id,
  } as unknown as Record<string, JsonValue>) as unknown as ActionJournal;
  const parsed = parseCraftContractBytes(canonicalizeJson(next).bytes);
  if (parsed.artifact_type !== "action-journal") {
    throw storeError("STORE_CORRUPT", "Resume journal did not produce an action journal");
  }
  return parsed;
}

function parseWorkflowState(state: WorkflowState): WorkflowState {
  const parsed = parseCraftContractBytes(canonicalizeJson(state).bytes);
  if (parsed.artifact_type !== "workflow-state") {
    throw storeError("STORE_CORRUPT", "Recovery block did not produce a workflow state");
  }
  return parsed;
}

function recoveryRemediationPhase(
  state: WorkflowState,
): "building" | "planning" | "root_cause" | "verifying" {
  switch (state.phase) {
    case "building":
      return "building";
    case "planning":
      return "planning";
    case "root_cause":
      return state.entry_strategy === "root-cause-import" ? "planning" : "root_cause";
    case "intake":
      return "root_cause";
    case "delivering":
    case "reviewing":
    case "verifying":
      return "verifying";
    case "blocked":
    case "completed":
      throw storeError("STORE_CORRUPT", "Terminal workflow cannot enter a recovery block");
  }
}

async function collectResidues(
  path: string,
  anchor: DirectoryAnchor,
  residues: StoreResidue[],
): Promise<void> {
  for (const name of await listDirectoryNames(path, anchor)) {
    if (name === WORKFLOW_LOCK || name.endsWith(".lock")) {
      residues.push({
        kind: "lock",
        path: join(path, name),
        remediation:
          "Confirm no Store writer is running, then remove only this exact lock after verifying its recorded identity.",
      });
    } else if (name.includes(".stage")) {
      residues.push({
        kind: "stage",
        path: join(path, name),
        remediation:
          "Treat current.json as authoritative; inspect and remove only the unreferenced stage without promoting it.",
      });
    } else if (name.includes(".backup") || name.endsWith(".bak")) {
      residues.push({
        kind: "backup",
        path: join(path, name),
        remediation:
          "Do not restore automatically; compare the backup with the immutable commit chain and resolve manually.",
      });
    }
  }
}

function sortRefs(refs: readonly ArtifactRef[]): ArtifactRef[] {
  return [...refs].sort((left, right) =>
    left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0,
  );
}

function isBoundPrincipal(state: WorkflowState, principal: PrincipalAudit): boolean {
  return (
    principalsEqual(state.coordinator, principal) ||
    (state.phase_principal !== null && principalsEqual(state.phase_principal, principal))
  );
}

function assertOperationIdentity(
  record: {
    readonly operation_id: string;
    readonly workflow_id: string;
  },
  workflowId: string,
  operationId: string,
): void {
  if (record.workflow_id !== workflowId || record.operation_id !== operationId) {
    throw storeError("OPERATION_INVALID", "Operation record identity mismatch");
  }
}

function resumeIssue(
  code: ResumeCheckIssue["code"],
  message: string,
  remediation: string,
): ResumeCheckIssue {
  return Object.freeze({ code, message, remediation });
}

function storeError(code: WorkflowStoreErrorCode, message: string): WorkflowStoreError {
  return new WorkflowStoreError(code, message);
}

function corrupt(error: unknown, context: string): WorkflowStoreError {
  if (error instanceof WorkflowStoreError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return storeError("STORE_CORRUPT", `${context}: ${message}`);
}

export { StorePathError };
