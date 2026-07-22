import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";

import {
  canonicalizeJson,
  sha256Hex,
} from "../../../tools/yuansheng-root-cause-blueprint/src/canonical-json";
import type {
  ArtifactIdentity,
  CandidateReviewEvidence,
  SealedBlueprintCandidate,
} from "./blueprint-pipeline";
import {
  markBlueprintCandidatePublished,
  resolveTraceFunctionExecutionContext,
  verifySealedBlueprintCandidate,
  verifySealedBlueprintCandidateTarget,
} from "./blueprint-pipeline";
import type { TraceFunctionExecutionContext } from "./trace-workflow";

const SAFE_DIRECTORY_MODE = 0o700;
const SAFE_FILE_MODE = 0o600;
const SHA256 = /^[0-9a-f]{64}$/u;
const RANK = /^[0-9]{3}$/u;
const UTF8_ENCODER = new TextEncoder();

const FAILURE_EVIDENCE_DESTINATIONS = {
  annotate: "evidence/annotate.txt",
  hardware_profile: "evidence/hardware-profile.json",
  metadata: "evidence/metadata.json",
  perf_stat: "evidence/perf-stat.txt",
} as const;

export interface AvailableArtifactTarget {
  readonly kind: "artifact_target_available";
  readonly targetPath: string;
}

export interface ArtifactConflict {
  readonly existingTreeSha256: string;
  readonly kind: "artifact_conflict";
  readonly reason: "authorization_stale" | "target_exists";
  readonly targetPath: string;
}

export type ArtifactTargetInspection = AvailableArtifactTarget | ArtifactConflict;

export interface ReplacementDecision {
  readonly candidateArtifactSha256: string;
  readonly decision: "replace";
  readonly existingTreeSha256: string;
  readonly targetPath: string;
}

export interface ArtifactTargetAddress {
  readonly context: TraceFunctionExecutionContext;
}

export interface ArtifactReplacementAuthorization {
  readonly kind: "artifact_replacement_authorization";
  readonly targetPath: string;
}

export interface PublishedArtifact {
  readonly artifactSha256: string;
  readonly backupRecoveryPath?: string;
  readonly kind: "artifact_published";
  readonly replacedExisting: boolean;
  readonly targetPath: string;
  readonly warnings?: readonly ArtifactTransactionWarning[];
}

export interface ArtifactTransactionWarning {
  readonly code: "artifact_parent_sync_failed" | "backup_cleanup_failed" | "lock_cleanup_failed";
  readonly message: string;
  readonly recoveryPath?: string;
}

export type PublishArtifactResult = ArtifactConflict | PublishedArtifact;

export type ArtifactFailurePhase =
  | "analysis"
  | "candidate_creation"
  | "machine_validation"
  | "publication"
  | "semantic_validation";

export interface RecordArtifactFailureInput {
  readonly code: string;
  readonly context: TraceFunctionExecutionContext;
  readonly diagnosticLog?: Uint8Array;
  readonly evidence?: readonly CandidateReviewEvidence[];
  readonly message: string;
  readonly phase: ArtifactFailurePhase;
}

export interface ArtifactFailureRecord {
  readonly directory: string;
  readonly failureId: string;
  readonly kind: "artifact_failure_recorded";
  readonly sha256: string;
  readonly warnings?: readonly ArtifactTransactionWarning[];
}

interface ConflictState {
  readonly existingTreeSha256: string;
  readonly targetPath: string;
}

interface AuthorizationState extends ConflictState {
  readonly artifactSha256: string;
  readonly candidate: SealedBlueprintCandidate;
}

interface TreeFileEntry {
  readonly bytes: string;
  readonly path: string;
  readonly sha256: string;
  readonly type: "file";
}

interface TreeDirectoryEntry {
  readonly path: string;
  readonly type: "directory";
}

type TreeEntry = TreeDirectoryEntry | TreeFileEntry;

interface FileDigest {
  readonly bytes: string;
  readonly path: string;
  readonly sha256: string;
}

const conflictStates = new WeakMap<ArtifactConflict, ConflictState>();
const authorizationStates = new WeakMap<ArtifactReplacementAuthorization, AuthorizationState>();

export class ArtifactTransactionError extends Error {
  readonly code: string;
  readonly recoveryPath: string | undefined;

  constructor(code: string, message: string, recoveryPath?: string) {
    super(message);
    this.name = "ArtifactTransactionError";
    this.code = code;
    this.recoveryPath = recoveryPath;
  }
}

function fail(code: string, message: string, recoveryPath?: string): never {
  throw new ArtifactTransactionError(code, message, recoveryPath);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function assertPathSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    hasControlCharacter(value) ||
    value.normalize("NFC") !== value ||
    UTF8_ENCODER.encode(value).length > 255
  ) {
    fail("invalid_path_segment", `${label} is not a safe normalized path segment`);
  }
}

function assertIdentity(identity: ArtifactIdentity): void {
  assertPathSegment(identity.software, "software");
  assertPathSegment(identity.testCase, "testCase");
  assertPathSegment(identity.functionName, "functionName");
  if (!RANK.test(identity.rank)) {
    fail("invalid_rank", "rank must contain exactly three ASCII digits");
  }
}

function assertNormalizedAbsolutePath(path: string, label: string): void {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    resolve(path) !== path ||
    parse(path).root === path
  ) {
    fail("unresolved_absolute_path", `${label} must be an already-resolved absolute path`);
  }
}

async function ensureRealDirectory(path: string, label: string): Promise<void> {
  assertNormalizedAbsolutePath(path, label);
  const root = parse(path).root;
  const segments = relative(root, path)
    .split(sep)
    .filter((segment) => segment.length > 0);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let status = await lstat(current).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (status === undefined) {
      await mkdir(current, { mode: SAFE_DIRECTORY_MODE }).catch((error: unknown) => {
        if (!isNodeError(error, "EEXIST")) {
          throw error;
        }
      });
      status = await lstat(current);
    }
    if (status.isSymbolicLink() || !status.isDirectory()) {
      fail("symlink_path_forbidden", `${label} contains a symlink or non-directory component`);
    }
  }
  if ((await realpath(path)) !== path) {
    fail("symlink_path_forbidden", `${label} must not contain a symbolic-link alias`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", SAFE_FILE_MODE);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function assertSafeExistingName(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    hasControlCharacter(name)
  ) {
    fail("unsafe_existing_entry_name", "Existing artifact contains an unsafe entry name");
  }
}

async function readStableFile(path: string): Promise<Uint8Array> {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    fail("special_file_forbidden", `Artifact tree contains a non-regular file: ${path}`);
  }
  const bytes = new Uint8Array(await readFile(path));
  const after = await lstat(path, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    fail("artifact_tree_changed", `Artifact tree changed while hashing: ${path}`);
  }
  return bytes;
}

function directorySignature(
  entries: readonly { readonly name: string; readonly type: string }[],
): string {
  return canonicalizeJson(entries).text;
}

async function scanTree(root: string, current: string, entries: TreeEntry[]): Promise<void> {
  const beforeEntries = (await readdir(current, { withFileTypes: true }))
    .map((entry) => ({
      dirent: entry,
      name: entry.name,
      type: entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : entry.isSymbolicLink()
            ? "symlink"
            : "special",
    }))
    .sort((left, right) => compareText(left.name, right.name));
  for (const entry of beforeEntries) {
    assertSafeExistingName(entry.name);
    const path = join(current, entry.name);
    const logicalPath = relative(root, path).split(sep).join("/");
    if (entry.type === "symlink") {
      fail("symlink_path_forbidden", `Artifact tree contains a symbolic link: ${logicalPath}`);
    }
    if (entry.type === "special") {
      fail("special_file_forbidden", `Artifact tree contains a special file: ${logicalPath}`);
    }
    if (entry.type === "directory") {
      entries.push({ path: logicalPath, type: "directory" });
      await scanTree(root, path, entries);
      continue;
    }
    const bytes = await readStableFile(path);
    entries.push({
      bytes: String(bytes.length),
      path: logicalPath,
      sha256: sha256Hex(bytes),
      type: "file",
    });
  }
  const afterEntries = (await readdir(current, { withFileTypes: true }))
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : entry.isSymbolicLink()
            ? "symlink"
            : "special",
    }))
    .sort((left, right) => compareText(left.name, right.name));
  const beforeSignature = beforeEntries.map(({ name, type }) => ({ name, type }));
  if (directorySignature(beforeSignature) !== directorySignature(afterEntries)) {
    fail("artifact_tree_changed", `Artifact directory changed while hashing: ${current}`);
  }
}

async function hashDirectoryTree(path: string): Promise<string> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    fail("artifact_target_not_directory", "An artifact target must be a non-symlink directory");
  }
  const entries: TreeEntry[] = [];
  await scanTree(path, path, entries);
  entries.sort((left, right) => compareText(left.path, right.path));
  return canonicalizeJson({ entries, format_version: 1, kind: "directory_tree" }).sha256;
}

async function targetExists(path: string): Promise<boolean> {
  const status = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (status === undefined) {
    return false;
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    fail("artifact_target_not_directory", "An artifact target must be a non-symlink directory");
  }
  return true;
}

function makeConflict(
  targetPath: string,
  existingTreeSha256: string,
  reason: ArtifactConflict["reason"],
): ArtifactConflict {
  const conflict = Object.freeze({
    existingTreeSha256,
    kind: "artifact_conflict" as const,
    reason,
    targetPath,
  });
  conflictStates.set(conflict, { existingTreeSha256, targetPath });
  return conflict;
}

async function deriveTargetPath(address: ArtifactTargetAddress): Promise<string> {
  const context = resolveTraceFunctionExecutionContext(address.context);
  assertIdentity(context.identity);
  await ensureRealDirectory(context.artifactRoot, "artifactRoot");
  let current = context.artifactRoot;
  for (const segment of [context.identity.software, context.identity.testCase]) {
    current = join(current, segment);
    const status = await lstat(current).catch((error: unknown) => {
      if (isNodeError(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    if (status === undefined) {
      break;
    }
    if (status.isSymbolicLink() || !status.isDirectory() || (await realpath(current)) !== current) {
      fail("artifact_parent_not_directory", "Artifact target parent must be a real directory");
    }
  }
  return context.targetPath;
}

export async function inspectArtifactAddress(
  address: ArtifactTargetAddress,
): Promise<ArtifactTargetInspection> {
  const targetPath = await deriveTargetPath(address);
  if (!(await targetExists(targetPath))) {
    return Object.freeze({ kind: "artifact_target_available" as const, targetPath });
  }
  return makeConflict(targetPath, await hashDirectoryTree(targetPath), "target_exists");
}

export async function inspectArtifactTarget(
  candidate: SealedBlueprintCandidate,
): Promise<ArtifactTargetInspection> {
  const verified = await verifySealedBlueprintCandidate(candidate);
  if (!(await targetExists(verified.targetPath))) {
    return Object.freeze({
      kind: "artifact_target_available" as const,
      targetPath: verified.targetPath,
    });
  }
  return makeConflict(
    verified.targetPath,
    await hashDirectoryTree(verified.targetPath),
    "target_exists",
  );
}

export function authorizeArtifactReplacement(
  conflict: ArtifactConflict,
  candidate: SealedBlueprintCandidate,
  decision: ReplacementDecision,
): ArtifactReplacementAuthorization {
  const state = conflictStates.get(conflict);
  if (state === undefined) {
    fail("invalid_conflict_handle", "Replacement authorization requires an inspected conflict");
  }
  if (
    candidate.targetPath !== state.targetPath ||
    decision.decision !== "replace" ||
    decision.targetPath !== state.targetPath ||
    decision.existingTreeSha256 !== state.existingTreeSha256 ||
    decision.candidateArtifactSha256 !== candidate.artifactSha256
  ) {
    fail(
      "replacement_decision_scope_mismatch",
      "Replacement decision must echo the exact displayed target, existing hash, and candidate hash",
    );
  }
  const authorization = Object.freeze({
    kind: "artifact_replacement_authorization" as const,
    targetPath: state.targetPath,
  });
  authorizationStates.set(authorization, {
    ...state,
    artifactSha256: candidate.artifactSha256,
    candidate,
  });
  return authorization;
}

async function acquireTargetLock(targetPath: string): Promise<string> {
  const parent = dirname(targetPath);
  const lockName = `.ys-trace-lock-${sha256Hex(UTF8_ENCODER.encode(targetPath)).slice(0, 32)}`;
  const lockPath = join(parent, lockName);
  await mkdir(lockPath, { mode: SAFE_DIRECTORY_MODE }).catch((error: unknown) => {
    if (isNodeError(error, "EEXIST")) {
      fail(
        "artifact_target_locked",
        `Another artifact transaction holds the target lock: ${lockPath}`,
      );
    }
    throw error;
  });
  await syncDirectory(parent);
  return lockPath;
}

async function releaseTargetLock(lockPath: string): Promise<void> {
  const parent = dirname(lockPath);
  await rm(lockPath, { recursive: true });
  await syncDirectory(parent);
}

function consumeAuthorization(
  authorization: ArtifactReplacementAuthorization,
  candidate: SealedBlueprintCandidate,
): AuthorizationState {
  const state = authorizationStates.get(authorization);
  authorizationStates.delete(authorization);
  if (
    state === undefined ||
    state.candidate !== candidate ||
    state.targetPath !== candidate.targetPath ||
    state.artifactSha256 !== candidate.artifactSha256
  ) {
    fail(
      "replacement_authorization_scope_mismatch",
      "Replacement authorization is unknown, consumed, or scoped to another candidate",
    );
  }
  return state;
}

async function restoreBackupTarget(
  targetPath: string,
  backupPath: string,
  operationError: unknown,
): Promise<void> {
  let targetRestored = false;
  try {
    await rename(backupPath, targetPath);
    targetRestored = true;
    await syncDirectory(dirname(targetPath));
  } catch (rollbackError) {
    if (targetRestored) {
      fail(
        "artifact_replacement_rollback_sync_failed_old_restored",
        `The previous artifact was restored, but restoration durability could not be confirmed: ${String(operationError)}; ${String(rollbackError)}`,
        targetPath,
      );
    }
    fail(
      "artifact_replacement_rollback_failed",
      `Artifact operation failed and automatic rollback failed: ${String(operationError)}; ${String(rollbackError)}`,
      backupPath,
    );
  }
}

function appendPublicationWarning(
  result: PublishedArtifact,
  warning: ArtifactTransactionWarning,
): PublishedArtifact {
  return {
    ...result,
    warnings: [...(result.warnings ?? []), warning],
  };
}

/**
 * Publishes only complete candidate directories. Replacing an existing directory uses a
 * portable backup/rename transaction: readers may briefly observe an absent target, while
 * they can never observe a partially populated formal artifact directory.
 */
export async function publishBlueprintCandidate(
  candidate: SealedBlueprintCandidate,
  authorization?: ArtifactReplacementAuthorization,
): Promise<PublishArtifactResult> {
  let verified = await verifySealedBlueprintCandidate(candidate);
  const lockPath = await acquireTargetLock(verified.targetPath);
  let result: PublishArtifactResult | undefined;
  let operationError: unknown;
  try {
    verified = await verifySealedBlueprintCandidate(candidate);
    const exists = await targetExists(verified.targetPath);
    if (!exists) {
      if (authorization !== undefined) {
        consumeAuthorization(authorization, candidate);
        fail(
          "replacement_authorization_stale",
          "The authorized existing artifact disappeared; inspect the target again",
        );
      }
      await rename(verified.stagingPath, verified.targetPath);
      try {
        await syncDirectory(dirname(verified.targetPath));
      } catch (syncError) {
        try {
          await rename(verified.targetPath, verified.stagingPath);
          await syncDirectory(dirname(verified.targetPath));
        } catch (rollbackError) {
          try {
            await verifySealedBlueprintCandidateTarget(candidate);
          } catch (verificationError) {
            if (!(await targetExists(verified.targetPath))) {
              fail(
                "artifact_publication_sync_failed_rolled_back",
                `Artifact publication left no formal target after its parent directory could not be synchronized: ${String(syncError)}; ${String(rollbackError)}`,
              );
            }
            fail(
              "artifact_publication_outcome_uncertain",
              `Artifact parent sync and rollback failed, and no complete formal artifact could be verified: ${String(syncError)}; ${String(rollbackError)}; ${String(verificationError)}`,
              verified.targetPath,
            );
          }
          markBlueprintCandidatePublished(candidate);
          result = {
            artifactSha256: verified.artifactSha256,
            kind: "artifact_published",
            replacedExisting: false,
            targetPath: verified.targetPath,
            warnings: [
              {
                code: "artifact_parent_sync_failed",
                message:
                  "The complete artifact is present, but publication durability could not be confirmed",
                recoveryPath: dirname(verified.targetPath),
              },
            ],
          };
        }
        if (result === undefined) {
          fail(
            "artifact_publication_sync_failed_rolled_back",
            `Artifact publication was rolled back after its parent directory could not be synchronized: ${String(syncError)}`,
          );
        }
      }
      if (result === undefined) {
        markBlueprintCandidatePublished(candidate);
        result = {
          artifactSha256: verified.artifactSha256,
          kind: "artifact_published",
          replacedExisting: false,
          targetPath: verified.targetPath,
        };
      }
    } else if (authorization === undefined) {
      result = makeConflict(
        verified.targetPath,
        await hashDirectoryTree(verified.targetPath),
        "target_exists",
      );
    } else {
      const authorizationState = consumeAuthorization(authorization, candidate);
      const currentTreeSha256 = await hashDirectoryTree(verified.targetPath);
      if (currentTreeSha256 !== authorizationState.existingTreeSha256) {
        result = makeConflict(verified.targetPath, currentTreeSha256, "authorization_stale");
      } else {
        verified = await verifySealedBlueprintCandidate(candidate);
        const backupPath = join(dirname(verified.targetPath), `.ys-trace-backup-${randomUUID()}`);
        await rename(verified.targetPath, backupPath);
        try {
          await syncDirectory(dirname(verified.targetPath));
        } catch (isolationSyncError) {
          await restoreBackupTarget(verified.targetPath, backupPath, isolationSyncError);
          fail(
            "artifact_replacement_failed_old_restored",
            `Replacement did not begin because target isolation could not be synchronized; the previous artifact was restored: ${String(isolationSyncError)}`,
          );
        }
        let backupTreeSha256: string;
        try {
          backupTreeSha256 = await hashDirectoryTree(backupPath);
        } catch (verificationError) {
          await restoreBackupTarget(verified.targetPath, backupPath, verificationError);
          fail(
            "replacement_authorization_stale",
            `The authorized artifact could not be verified after it was isolated: ${String(verificationError)}`,
          );
        }
        if (backupTreeSha256 !== authorizationState.existingTreeSha256) {
          await restoreBackupTarget(
            verified.targetPath,
            backupPath,
            "post-rename authorization verification failed",
          );
          result = makeConflict(verified.targetPath, backupTreeSha256, "authorization_stale");
        } else {
          let candidateMoved = false;
          try {
            await rename(verified.stagingPath, verified.targetPath);
            candidateMoved = true;
            await syncDirectory(dirname(verified.targetPath));
          } catch (publishError) {
            try {
              if (candidateMoved) {
                await rename(verified.targetPath, verified.stagingPath);
              }
            } catch (candidateRestoreError) {
              try {
                await verifySealedBlueprintCandidateTarget(candidate);
              } catch (verificationError) {
                fail(
                  "artifact_replacement_outcome_uncertain",
                  `Replacement failed, candidate rollback failed, and no complete formal artifact could be verified: ${String(publishError)}; ${String(candidateRestoreError)}; ${String(verificationError)}`,
                  backupPath,
                );
              }
              markBlueprintCandidatePublished(candidate);
              result = {
                artifactSha256: verified.artifactSha256,
                backupRecoveryPath: backupPath,
                kind: "artifact_published",
                replacedExisting: true,
                targetPath: verified.targetPath,
                warnings: [
                  {
                    code: "artifact_parent_sync_failed",
                    message:
                      "The complete replacement is present, but publication durability could not be confirmed",
                    recoveryPath: dirname(verified.targetPath),
                  },
                  {
                    code: "backup_cleanup_failed",
                    message:
                      "The previous artifact backup was retained because candidate rollback failed",
                    recoveryPath: backupPath,
                  },
                ],
              };
            }
            if (result === undefined) {
              await restoreBackupTarget(verified.targetPath, backupPath, publishError);
              fail(
                "artifact_replacement_failed_old_restored",
                `Replacement failed; the previous artifact was restored: ${String(publishError)}`,
              );
            }
          }
          if (result === undefined) {
            markBlueprintCandidatePublished(candidate);
            let backupRecoveryPath: string | undefined;
            const warnings: ArtifactTransactionWarning[] = [];
            await rm(backupPath, { force: true, recursive: true }).catch(() => {
              backupRecoveryPath = backupPath;
              warnings.push({
                code: "backup_cleanup_failed",
                message: "The previous artifact backup remains after successful publication",
                recoveryPath: backupPath,
              });
            });
            await syncDirectory(dirname(verified.targetPath)).catch((syncError: unknown) => {
              warnings.push({
                code: "artifact_parent_sync_failed",
                message: `The replacement is complete, but cleanup durability could not be confirmed: ${String(syncError)}`,
                recoveryPath: dirname(verified.targetPath),
              });
            });
            result = {
              artifactSha256: verified.artifactSha256,
              ...(backupRecoveryPath === undefined ? {} : { backupRecoveryPath }),
              kind: "artifact_published",
              replacedExisting: true,
              targetPath: verified.targetPath,
              ...(warnings.length === 0 ? {} : { warnings }),
            };
          }
        }
      }
    }
  } catch (error) {
    operationError = error;
  }

  let lockError: unknown;
  await releaseTargetLock(lockPath).catch((error: unknown) => {
    lockError = error;
  });
  if (operationError !== undefined) {
    throw operationError;
  }
  if (lockError !== undefined) {
    if (result?.kind === "artifact_published") {
      return appendPublicationWarning(result, {
        code: "lock_cleanup_failed",
        message: `The artifact is published, but transaction lock cleanup failed: ${String(lockError)}`,
        recoveryPath: lockPath,
      });
    }
    fail("artifact_lock_cleanup_failed", `Artifact transaction left a lock: ${lockPath}`, lockPath);
  }
  if (result === undefined) {
    return fail("artifact_transaction_incomplete", "Artifact transaction produced no result");
  }
  return result;
}

async function failureFileDigests(
  root: string,
  paths: readonly string[],
): Promise<readonly FileDigest[]> {
  const digests: FileDigest[] = [];
  for (const path of [...paths].sort(compareText)) {
    const bytes = new Uint8Array(await readFile(join(root, ...path.split("/"))));
    digests.push({ bytes: String(bytes.length), path, sha256: sha256Hex(bytes) });
  }
  return digests;
}

export async function recordArtifactFailure(
  input: RecordArtifactFailureInput,
): Promise<ArtifactFailureRecord> {
  const context = resolveTraceFunctionExecutionContext(input.context);
  const artifactRoot = context.artifactRoot;
  const code = input.code;
  const diagnosticLog =
    input.diagnosticLog === undefined ? undefined : Uint8Array.from(input.diagnosticLog);
  const evidence = input.evidence?.map((item) => ({
    ...item,
    bytes: Uint8Array.from(item.bytes),
  }));
  const identity = { ...context.identity };
  const message = input.message;
  const phase = input.phase;

  assertIdentity(identity);
  await ensureRealDirectory(artifactRoot, "artifactRoot");
  if (code.length === 0 || message.length === 0) {
    fail("invalid_failure_record", "Failure code and message must not be empty");
  }
  const failedRoot = join(artifactRoot, ".failed");
  await mkdir(failedRoot, { mode: SAFE_DIRECTORY_MODE }).catch((error: unknown) => {
    if (!isNodeError(error, "EEXIST")) {
      throw error;
    }
  });
  const failedStatus = await lstat(failedRoot);
  if (
    failedStatus.isSymbolicLink() ||
    !failedStatus.isDirectory() ||
    (await realpath(failedRoot)) !== failedRoot
  ) {
    fail("failed_root_not_directory", "The failure-record root must be a real directory");
  }

  const failureId = randomUUID();
  const stagingPath = join(failedRoot, `.tmp-${failureId}`);
  const finalPath = join(failedRoot, failureId);
  await mkdir(stagingPath, { mode: SAFE_DIRECTORY_MODE });
  try {
    const failureBytes = canonicalizeJson({
      error: { code, message },
      failure_id: failureId,
      format_version: 1,
      function: identity.functionName,
      kind: "artifact_failure",
      phase,
      rank: identity.rank,
      software: identity.software,
      test_case: identity.testCase,
    }).bytes;
    await writeExclusive(join(stagingPath, "failure.json"), failureBytes);
    const paths = ["failure.json"];
    if (diagnosticLog !== undefined) {
      await writeExclusive(join(stagingPath, "diagnostic.log"), diagnosticLog);
      paths.push("diagnostic.log");
    }
    if (evidence !== undefined && evidence.length > 0) {
      const evidenceRoot = join(stagingPath, "evidence");
      await mkdir(evidenceRoot, { mode: SAFE_DIRECTORY_MODE });
      const seenKinds = new Set<string>();
      for (const item of evidence) {
        if (seenKinds.has(item.kind)) {
          fail("duplicate_failure_evidence", `Failure evidence repeats kind: ${item.kind}`);
        }
        seenKinds.add(item.kind);
        if (!SHA256.test(item.sha256) || sha256Hex(item.bytes) !== item.sha256) {
          fail("failure_evidence_hash_mismatch", `Failure evidence hash differs: ${item.kind}`);
        }
        const destination = FAILURE_EVIDENCE_DESTINATIONS[item.kind];
        await writeExclusive(join(stagingPath, ...destination.split("/")), item.bytes);
        paths.push(destination);
      }
      await syncDirectory(evidenceRoot);
    }
    const checksumBytes = canonicalizeJson({
      files: await failureFileDigests(stagingPath, paths),
      format_version: 1,
      kind: "failure_checksums",
    }).bytes;
    await writeExclusive(join(stagingPath, "checksums.json"), checksumBytes);
    await syncDirectory(stagingPath);
    await rename(stagingPath, finalPath);
    const warnings: ArtifactTransactionWarning[] = [];
    await syncDirectory(failedRoot).catch((syncError: unknown) => {
      warnings.push({
        code: "artifact_parent_sync_failed",
        message: `The complete failure record is present, but publication durability could not be confirmed: ${String(syncError)}`,
        recoveryPath: failedRoot,
      });
    });
    return {
      directory: finalPath,
      failureId,
      kind: "artifact_failure_recorded",
      sha256: sha256Hex(checksumBytes),
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  } catch (error) {
    await rm(stagingPath, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}
