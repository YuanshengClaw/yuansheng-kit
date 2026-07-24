import { canonicalizeJson, sha256Digest } from "../artifacts/canonical";
import type {
  ArtifactRef,
  PrincipalAudit,
  RepositoryBinding,
  WorkflowState,
} from "../artifacts/generated";
import { type JsonValue, parseStrictJson } from "../artifacts/strict-json";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const OPAQUE_ID = /^[a-z][a-z0-9-]*:[A-Za-z0-9_-]{16,128}$/u;
const UTC_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u;

export interface StoreIdentityRecord {
  readonly format_version: 1;
  readonly kind: "ys-craft-store";
  readonly root_realpath: string;
}

export interface WorkflowIdentityRecord {
  readonly config_digest: `sha256:${string}`;
  readonly controller_root_realpath: string;
  readonly format_version: 1;
  readonly kind: "workflow-identity";
  readonly target_worktree_realpath: string;
  readonly workflow_id: string;
}

export interface WorkflowCommitRecord {
  readonly artifact_refs: readonly ArtifactRef[];
  readonly committed_at: string;
  readonly format_version: 1;
  readonly journal_ref: ArtifactRef;
  readonly kind: "workflow-commit";
  readonly previous_commit_digest: `sha256:${string}` | null;
  readonly record_digest: `sha256:${string}`;
  readonly revision: number;
  readonly state_ref: ArtifactRef;
  readonly workflow_id: string;
}

export interface WorkflowPointerRecord {
  readonly commit_digest: `sha256:${string}`;
  readonly format_version: 1;
  readonly kind: "workflow-pointer";
  readonly revision: number;
  readonly workflow_id: string;
}

export interface BuildingLeaseRecord {
  readonly acquired_at: string;
  readonly format_version: 1;
  readonly kind: "building-lease";
  readonly target_revision: number;
  readonly target_worktree_realpath: string;
  readonly workflow_id: string;
}

export interface WorkflowLockRecord {
  readonly acquired_at: string;
  readonly format_version: 1;
  readonly kind: "workflow-lock";
  readonly token: string;
  readonly workflow_id: string;
}

export type SideEffectKind =
  | "filesystem-mutation"
  | "git-mutation"
  | "network-request"
  | "process-execution"
  | "verification-command";

export interface OperationIntentRecord {
  readonly action: string;
  readonly created_at: string;
  readonly format_version: 1;
  readonly kind: "operation-intent";
  readonly operation_id: string;
  readonly principal: PrincipalAudit;
  readonly side_effect: SideEffectKind;
  readonly subject_refs: readonly ArtifactRef[];
  readonly workflow_id: string;
  readonly workflow_revision: number;
}

export interface OperationStartedRecord {
  readonly format_version: 1;
  readonly intent_digest: `sha256:${string}`;
  readonly kind: "operation-started";
  readonly operation_id: string;
  readonly started_at: string;
  readonly workflow_id: string;
}

export interface OperationResultRecord {
  readonly completed_at: string;
  readonly evidence_refs: readonly ArtifactRef[];
  readonly format_version: 1;
  readonly intent_digest: `sha256:${string}`;
  readonly kind: "operation-result";
  readonly operation_id: string;
  readonly outcome: "failed" | "succeeded";
  readonly workflow_id: string;
}

export interface ResumeRepositoryObservation {
  readonly configDigest: `sha256:${string}`;
  readonly controllerRootRealpath: string;
  readonly diffContentDigest: `sha256:${string}` | null;
  readonly gitRootRealpath: string;
  readonly headCommit: string;
  readonly headTreeDigest: `sha256:${string}`;
  readonly productRootRealpath: string;
  readonly status: "clean" | "dirty";
  readonly storeRootIgnored: boolean;
  readonly storeRootRealpath: string;
  readonly targetWorktreeRealpath: string;
}

export interface WorkflowSnapshot {
  readonly artifacts: readonly Exclude<
    import("../artifacts/generated").YuanshengCraftContractV1,
    WorkflowState | import("../artifacts/generated").ActionJournal
  >[];
  readonly commitDigest: `sha256:${string}`;
  readonly journal: import("../artifacts/generated").ActionJournal;
  readonly state: WorkflowState;
}

export interface StoreResidue {
  readonly kind: "backup" | "lock" | "stage";
  readonly path: string;
  readonly remediation: string;
}

export type ResumeCheckCode =
  | "AMBIGUOUS_SIDE_EFFECT"
  | "ARTIFACT_CHAIN_INVALID"
  | "BUILDING_LEASE_INVALID"
  | "CANDIDATE_DRIFT"
  | "CONFIG_DRIFT"
  | "HEAD_DRIFT"
  | "REPOSITORY_IDENTITY_DRIFT"
  | "STORE_ANCHOR_MISMATCH"
  | "STORE_NOT_IGNORED"
  | "STORE_RESIDUE"
  | "WORKFLOW_NOT_BLOCKED";

export interface ResumeCheckIssue {
  readonly code: ResumeCheckCode;
  readonly message: string;
  readonly remediation: string;
}

export type ResumeWorkflowResult =
  | {
      readonly issues: readonly ResumeCheckIssue[];
      readonly status: "blocked";
      readonly workflowId: string;
    }
  | {
      readonly snapshot: WorkflowSnapshot;
      readonly status: "resumed";
      readonly workflowId: string;
    };

export function workflowDirectoryName(workflowId: string): string {
  assertOpaqueId(workflowId, "workflow ID");
  return sha256Digest(new TextEncoder().encode(workflowId)).slice("sha256:".length);
}

export function operationDirectoryName(operationId: string): string {
  assertOpaqueId(operationId, "operation ID");
  return sha256Digest(new TextEncoder().encode(operationId)).slice("sha256:".length);
}

export function leaseFileName(targetWorktreeRealpath: string): string {
  assertRealpath(targetWorktreeRealpath, "target worktree realpath");
  return `${sha256Digest(new TextEncoder().encode(targetWorktreeRealpath)).slice(
    "sha256:".length,
  )}.json`;
}

export function artifactFileName(digest: string): string {
  assertDigest(digest, "artifact digest");
  return `${digest.slice("sha256:".length)}.json`;
}

export function commitFileName(revision: number): string {
  assertRevision(revision, "commit revision");
  return `${revision.toString().padStart(16, "0")}.json`;
}

export function sealStoreRecord<T extends Record<string, JsonValue>>(
  record: T,
): T & { readonly record_digest: `sha256:${string}` } {
  return {
    ...record,
    record_digest: canonicalizeJson(record).digest,
  };
}

export function recordDigest(record: unknown): `sha256:${string}` {
  return canonicalizeJson(record).digest;
}

export function encodeStoreRecord(record: unknown): Uint8Array {
  return canonicalizeJson(record).bytes;
}

export function parseStoreIdentity(bytes: Uint8Array): StoreIdentityRecord {
  const value = parseRecord(bytes, ["format_version", "kind", "root_realpath"]);
  assertLiteral(value.format_version, 1, "store format version");
  assertLiteral(value.kind, "ys-craft-store", "store record kind");
  assertRealpath(value.root_realpath, "store root realpath");
  return value as unknown as StoreIdentityRecord;
}

export function parseWorkflowIdentity(bytes: Uint8Array): WorkflowIdentityRecord {
  const value = parseRecord(bytes, [
    "config_digest",
    "controller_root_realpath",
    "format_version",
    "kind",
    "target_worktree_realpath",
    "workflow_id",
  ]);
  assertLiteral(value.format_version, 1, "workflow identity format version");
  assertLiteral(value.kind, "workflow-identity", "workflow identity kind");
  assertDigest(value.config_digest, "workflow config digest");
  assertRealpath(value.controller_root_realpath, "workflow controller root");
  assertRealpath(value.target_worktree_realpath, "workflow target worktree");
  assertOpaqueId(value.workflow_id, "workflow ID");
  return value as unknown as WorkflowIdentityRecord;
}

export function parseWorkflowPointer(bytes: Uint8Array): WorkflowPointerRecord {
  const value = parseRecord(bytes, [
    "commit_digest",
    "format_version",
    "kind",
    "revision",
    "workflow_id",
  ]);
  assertDigest(value.commit_digest, "workflow commit digest");
  assertLiteral(value.format_version, 1, "workflow pointer format version");
  assertLiteral(value.kind, "workflow-pointer", "workflow pointer kind");
  assertRevision(value.revision, "workflow pointer revision");
  assertOpaqueId(value.workflow_id, "workflow ID");
  return value as unknown as WorkflowPointerRecord;
}

export function parseWorkflowCommit(bytes: Uint8Array): WorkflowCommitRecord {
  const value = parseRecord(bytes, [
    "artifact_refs",
    "committed_at",
    "format_version",
    "journal_ref",
    "kind",
    "previous_commit_digest",
    "record_digest",
    "revision",
    "state_ref",
    "workflow_id",
  ]);
  assertLiteral(value.format_version, 1, "workflow commit format version");
  assertLiteral(value.kind, "workflow-commit", "workflow commit kind");
  assertDigest(value.record_digest, "workflow commit record digest");
  assertNullableDigest(value.previous_commit_digest, "previous workflow commit digest");
  assertRevision(value.revision, "workflow commit revision");
  assertUtcTime(value.committed_at, "workflow commit time");
  assertOpaqueId(value.workflow_id, "workflow ID");
  assertArtifactRef(value.state_ref, "workflow state ref");
  assertArtifactRef(value.journal_ref, "workflow journal ref");
  assertArtifactRefs(value.artifact_refs, "workflow artifact refs");
  if (
    (value.state_ref as ArtifactRef).artifact_type !== "workflow-state" ||
    (value.journal_ref as ArtifactRef).artifact_type !== "action-journal"
  ) {
    throw new TypeError("Workflow commit state and journal references have invalid types");
  }
  const payload = { ...value };
  delete payload.record_digest;
  if (canonicalizeJson(payload).digest !== value.record_digest) {
    throw new TypeError("Workflow commit record digest mismatch");
  }
  return value as unknown as WorkflowCommitRecord;
}

export function parseBuildingLease(bytes: Uint8Array): BuildingLeaseRecord {
  const value = parseRecord(bytes, [
    "acquired_at",
    "format_version",
    "kind",
    "target_revision",
    "target_worktree_realpath",
    "workflow_id",
  ]);
  assertUtcTime(value.acquired_at, "lease acquisition time");
  assertLiteral(value.format_version, 1, "building lease format version");
  assertLiteral(value.kind, "building-lease", "building lease kind");
  assertRevision(value.target_revision, "building lease target revision");
  assertRealpath(value.target_worktree_realpath, "building lease worktree");
  assertOpaqueId(value.workflow_id, "building lease workflow ID");
  return value as unknown as BuildingLeaseRecord;
}

export function parseWorkflowLock(bytes: Uint8Array): WorkflowLockRecord {
  const value = parseRecord(bytes, [
    "acquired_at",
    "format_version",
    "kind",
    "token",
    "workflow_id",
  ]);
  assertUtcTime(value.acquired_at, "workflow lock acquisition time");
  assertLiteral(value.format_version, 1, "workflow lock format version");
  assertLiteral(value.kind, "workflow-lock", "workflow lock kind");
  assertOpaqueId(value.token, "workflow lock token");
  assertOpaqueId(value.workflow_id, "workflow lock workflow ID");
  return value as unknown as WorkflowLockRecord;
}

export function parseOperationIntent(bytes: Uint8Array): OperationIntentRecord {
  const value = parseRecord(bytes, [
    "action",
    "created_at",
    "format_version",
    "kind",
    "operation_id",
    "principal",
    "side_effect",
    "subject_refs",
    "workflow_id",
    "workflow_revision",
  ]);
  assertAction(value.action);
  assertUtcTime(value.created_at, "operation intent time");
  assertLiteral(value.format_version, 1, "operation intent format version");
  assertLiteral(value.kind, "operation-intent", "operation intent kind");
  assertOpaqueId(value.operation_id, "operation ID");
  assertPrincipal(value.principal);
  assertSideEffect(value.side_effect);
  assertArtifactRefs(value.subject_refs, "operation subject refs");
  assertOpaqueId(value.workflow_id, "workflow ID");
  assertRevision(value.workflow_revision, "operation workflow revision");
  return value as unknown as OperationIntentRecord;
}

export function parseOperationStarted(bytes: Uint8Array): OperationStartedRecord {
  const value = parseRecord(bytes, [
    "format_version",
    "intent_digest",
    "kind",
    "operation_id",
    "started_at",
    "workflow_id",
  ]);
  assertLiteral(value.format_version, 1, "operation started format version");
  assertDigest(value.intent_digest, "operation intent digest");
  assertLiteral(value.kind, "operation-started", "operation started kind");
  assertOpaqueId(value.operation_id, "operation ID");
  assertUtcTime(value.started_at, "operation start time");
  assertOpaqueId(value.workflow_id, "workflow ID");
  return value as unknown as OperationStartedRecord;
}

export function parseOperationResult(bytes: Uint8Array): OperationResultRecord {
  const value = parseRecord(bytes, [
    "completed_at",
    "evidence_refs",
    "format_version",
    "intent_digest",
    "kind",
    "operation_id",
    "outcome",
    "workflow_id",
  ]);
  assertUtcTime(value.completed_at, "operation completion time");
  assertArtifactRefs(value.evidence_refs, "operation evidence refs");
  assertLiteral(value.format_version, 1, "operation result format version");
  assertDigest(value.intent_digest, "operation intent digest");
  assertLiteral(value.kind, "operation-result", "operation result kind");
  assertOpaqueId(value.operation_id, "operation ID");
  if (value.outcome !== "failed" && value.outcome !== "succeeded") {
    throw new TypeError("Operation outcome must be failed or succeeded");
  }
  assertOpaqueId(value.workflow_id, "workflow ID");
  return value as unknown as OperationResultRecord;
}

export function assertObservation(
  observation: ResumeRepositoryObservation,
): ResumeRepositoryObservation {
  assertDigest(observation.configDigest, "observed config digest");
  assertRealpath(observation.controllerRootRealpath, "observed controller root");
  if (observation.diffContentDigest !== null) {
    assertDigest(observation.diffContentDigest, "observed diff digest");
  }
  assertRealpath(observation.gitRootRealpath, "observed Git root");
  assertCommit(observation.headCommit, "observed HEAD");
  assertDigest(observation.headTreeDigest, "observed HEAD tree digest");
  assertRealpath(observation.productRootRealpath, "observed product root");
  if (observation.status !== "clean" && observation.status !== "dirty") {
    throw new TypeError("Observed repository status must be clean or dirty");
  }
  if (typeof observation.storeRootIgnored !== "boolean") {
    throw new TypeError("Observed store ignore result must be boolean");
  }
  assertRealpath(observation.storeRootRealpath, "observed store root");
  assertRealpath(observation.targetWorktreeRealpath, "observed target worktree");
  return observation;
}

export function repositoryBindingFrom(
  state: WorkflowState,
  artifacts: readonly import("../artifacts/generated").YuanshengCraftContractV1[],
): RepositoryBinding {
  const digest = state.entry_context.repository_binding_ref.digest;
  const matches = artifacts.filter(
    (artifact): artifact is RepositoryBinding =>
      artifact.artifact_type === "repository-binding" && artifact.artifact_digest === digest,
  );
  const binding = matches[0];
  if (matches.length !== 1 || binding === undefined) {
    throw new TypeError("Workflow snapshot does not contain its exact repository binding");
  }
  return binding;
}

function parseRecord(
  bytes: Uint8Array,
  expectedKeys: readonly string[],
): Record<string, JsonValue> {
  const value = parseStrictJson(bytes);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Store record must be a JSON object");
  }
  const canonical = canonicalizeJson(value).bytes;
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) {
    throw new TypeError("Store records must use exact RFC 8785 canonical bytes");
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(`Store record must contain exactly ${sortedExpected.join(", ")}`);
  }
  return value as Record<string, JsonValue>;
}

function assertLiteral<T extends boolean | number | string>(
  value: unknown,
  expected: T,
  label: string,
): asserts value is T {
  if (value !== expected) {
    throw new TypeError(`${label} must be ${JSON.stringify(expected)}`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is `sha256:${string}` {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 digest`);
  }
}

function assertNullableDigest(
  value: unknown,
  label: string,
): asserts value is `sha256:${string}` | null {
  if (value !== null) {
    assertDigest(value, label);
  }
}

function assertOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new TypeError(`${label} must be a valid opaque ID`);
  }
}

function assertRevision(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function assertUtcTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UTC_TIME.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
}

function assertRealpath(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    !value.startsWith("/") ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes("//") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new TypeError(`${label} must be a canonical absolute realpath`);
  }
}

function assertCommit(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/u.test(value)) {
    throw new TypeError(`${label} must be a canonical Git object ID`);
  }
}

function assertAction(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^ys_craft_[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(value)) {
    throw new TypeError("Operation action must be a Yuansheng Craft tool ID");
  }
}

function assertPrincipal(value: unknown): asserts value is PrincipalAudit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Operation principal must be an object");
  }
  const principal = value as Record<string, unknown>;
  if (
    Object.keys(principal).sort().join("\0") !== "agent_id\0session_id" ||
    typeof principal.agent_id !== "string" ||
    !/^ys-craft(?:-[a-z][a-z0-9-]*)?$/u.test(principal.agent_id)
  ) {
    throw new TypeError("Operation principal has an invalid agent identity");
  }
  assertOpaqueId(principal.session_id, "operation principal session ID");
}

function assertArtifactRef(value: unknown, label: string): asserts value is ArtifactRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an artifact reference`);
  }
  const ref = value as Record<string, unknown>;
  if (
    Object.keys(ref).sort().join("\0") !== "artifact_type\0artifact_version\0digest" ||
    typeof ref.artifact_type !== "string" ||
    ref.artifact_version !== 1
  ) {
    throw new TypeError(`${label} has invalid reference metadata`);
  }
  assertDigest(ref.digest, `${label} digest`);
}

function assertArtifactRefs(value: unknown, label: string): asserts value is ArtifactRef[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const digests = new Set<string>();
  for (const [index, ref] of value.entries()) {
    assertArtifactRef(ref, `${label}[${index}]`);
    if (digests.has(ref.digest)) {
      throw new TypeError(`${label} must not contain duplicate digests`);
    }
    digests.add(ref.digest);
  }
}

function assertSideEffect(value: unknown): asserts value is SideEffectKind {
  if (
    value !== "filesystem-mutation" &&
    value !== "git-mutation" &&
    value !== "network-request" &&
    value !== "process-execution" &&
    value !== "verification-command"
  ) {
    throw new TypeError("Operation side effect kind is invalid");
  }
}
