import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { canonicalizeJson, sealArtifact, sha256Digest } from "../artifacts/canonical";
import type {
  DiffEntry,
  DiffManifest,
  MutationAuthorization,
  PatchCandidate,
  PatchPlan,
  RepositoryBinding,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../artifacts/generated";
import {
  artifactRef,
  parseCraftContractBytes,
  validateCraftContractGraph,
} from "../artifacts/parser";
import type { JsonValue } from "../artifacts/strict-json";
import {
  auditTrustedPrincipal,
  principalsEqual,
  type TrustedPrincipal,
} from "../state-machine/principal";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const GIT_TIMEOUT_MS = 30_000;

export interface BinaryGitCommandResult {
  readonly exitCode: number;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
}

export interface BinaryGitRunner {
  readonly run: (
    argv: readonly string[],
    cwd: string,
    timeoutMs: number,
  ) => Promise<BinaryGitCommandResult>;
}

export interface CanonicalDiffSnapshot {
  readonly binaryPatchBytes: Uint8Array;
  readonly binaryPatchDigest: `sha256:${string}`;
  readonly diffContentDigest: `sha256:${string}`;
  readonly entries: DiffManifest["entries"];
}

export interface CapturedPatchCandidate extends CanonicalDiffSnapshot {
  readonly candidate: PatchCandidate;
  readonly diffManifest: DiffManifest;
}

export class CandidateCaptureError extends Error {
  readonly code = "CANDIDATE_CAPTURE_INVALID";

  constructor(message: string) {
    super(`CANDIDATE_CAPTURE_INVALID: ${message}`);
    this.name = "CandidateCaptureError";
  }
}

function fail(message: string): never {
  throw new CandidateCaptureError(message);
}

function seal<T extends YuanshengCraftContractV1>(payload: Omit<T, "artifact_digest">): T {
  const sealed = sealArtifact(payload as unknown as Record<string, JsonValue>) as unknown as T;
  const parsed = parseCraftContractBytes(canonicalizeJson(sealed).bytes);
  if (parsed.artifact_type !== sealed.artifact_type) {
    return fail(`Candidate capture produced an invalid ${sealed.artifact_type}`);
  }
  return parsed as T;
}

function decode(bytes: Uint8Array, label: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return fail(`${label} is not valid UTF-8`);
  }
}

function decodeError(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes).trim();
  } catch {
    return "<non-UTF-8 stderr>";
  }
}

async function git(
  runner: BinaryGitRunner,
  cwd: string,
  argv: readonly string[],
  acceptedExitCodes: readonly number[] = [0],
): Promise<BinaryGitCommandResult> {
  if (
    argv.length === 0 ||
    argv[0] !== "git" ||
    argv.some((argument) => argument.length === 0 || argument.includes("\0"))
  ) {
    return fail("Git capture accepts only explicit non-empty git argv");
  }
  const result = await runner.run(argv, cwd, GIT_TIMEOUT_MS);
  if (!acceptedExitCodes.includes(result.exitCode)) {
    return fail(
      `${argv.slice(0, 4).join(" ")} failed with ${result.exitCode}: ${decodeError(result.stderr)}`,
    );
  }
  return result;
}

function nulFields(bytes: Uint8Array, label: string): readonly string[] {
  const text = decode(bytes, label);
  if (text.length === 0) {
    return [];
  }
  if (!text.endsWith("\0")) {
    return fail(`${label} is not NUL terminated`);
  }
  return text.slice(0, -1).split("\0");
}

function assertCanonicalRelativePath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    path !== path.normalize("NFC")
  ) {
    fail(`Git returned a non-canonical product path: ${JSON.stringify(path)}`);
  }
}

interface ChangedPath {
  readonly operation: DiffEntry["operation"];
  readonly path: string;
  readonly sourcePath: string | null;
}

function parseTrackedChanges(bytes: Uint8Array): readonly ChangedPath[] {
  const fields = nulFields(bytes, "git diff --name-status");
  const changes: ChangedPath[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    const path = fields[index + 1];
    if (status === undefined || path === undefined) {
      return fail("Git name-status output ended inside an entry");
    }
    index += 2;
    assertCanonicalRelativePath(path);
    if (status.startsWith("R")) {
      const destination = fields[index];
      if (destination === undefined) {
        return fail("Git rename output omitted its destination");
      }
      index += 1;
      assertCanonicalRelativePath(destination);
      changes.push({ operation: "rename", path: destination, sourcePath: path });
    } else if (status === "A") {
      changes.push({ operation: "create", path, sourcePath: null });
    } else if (status === "D") {
      changes.push({ operation: "delete", path, sourcePath: null });
    } else if (status === "M" || status === "T") {
      changes.push({ operation: "modify", path, sourcePath: null });
    } else {
      return fail(`Unsupported Git change status: ${status}`);
    }
  }
  return changes;
}

function parseUntracked(bytes: Uint8Array): readonly ChangedPath[] {
  return nulFields(bytes, "git ls-files --others").map((path) => {
    assertCanonicalRelativePath(path);
    return { operation: "create" as const, path, sourcePath: null };
  });
}

function normalizeAuthorizedWorktreeRenames(
  tracked: readonly ChangedPath[],
  untracked: readonly ChangedPath[],
  authorization: MutationAuthorization,
): readonly ChangedPath[] {
  const changes = [...tracked, ...untracked];
  for (const approved of authorization.authorized_changes.filter(
    (change) => change.operation === "rename",
  )) {
    if (approved.source_path === null) {
      return fail("Approved rename omitted its source path");
    }
    if (
      changes.some(
        (change) =>
          change.operation === "rename" &&
          change.path === approved.path &&
          change.sourcePath === approved.source_path,
      )
    ) {
      continue;
    }
    const deletionIndex = changes.findIndex(
      (change) =>
        change.operation === "delete" &&
        change.path === approved.source_path &&
        change.sourcePath === null,
    );
    const creationIndex = changes.findIndex(
      (change) =>
        change.operation === "create" &&
        change.path === approved.path &&
        change.sourcePath === null,
    );
    if (deletionIndex < 0 || creationIndex < 0) {
      continue;
    }
    changes.splice(Math.max(deletionIndex, creationIndex), 1);
    changes.splice(Math.min(deletionIndex, creationIndex), 1);
    changes.push({
      operation: "rename",
      path: approved.path,
      sourcePath: approved.source_path,
    });
  }
  return changes;
}

function repositoryPath(binding: RepositoryBinding, productPath: string): string {
  const prefix = relative(binding.git_root_realpath, binding.product_root_realpath);
  if (prefix === ".." || prefix.startsWith(`..${sep}`)) {
    return fail("Product root escaped the bound Git root");
  }
  return prefix.length === 0 ? productPath : `${prefix.split(sep).join("/")}/${productPath}`;
}

function modeFromStat(mode: number): "100644" | "100755" {
  return (mode & 0o111) === 0 ? "100644" : "100755";
}

function binaryBytes(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, 8_000);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

async function readCurrentFile(
  binding: RepositoryBinding,
  path: string,
): Promise<{ readonly bytes: Uint8Array; readonly mode: "100644" | "100755" }> {
  const absolute = resolve(binding.product_root_realpath, path);
  const child = relative(binding.product_root_realpath, absolute);
  if (child === ".." || child.startsWith(`..${sep}`) || child.length === 0) {
    return fail("Current candidate path escaped the product root");
  }
  const stats = await lstat(absolute);
  if (stats.isSymbolicLink() || !stats.isFile() || (await realpath(absolute)) !== absolute) {
    return fail(`Candidate path is not a regular non-symlink file: ${path}`);
  }
  return {
    bytes: new Uint8Array(await readFile(absolute)),
    mode: modeFromStat(stats.mode),
  };
}

async function readBaselineFile(
  runner: BinaryGitRunner,
  binding: RepositoryBinding,
  path: string,
): Promise<{ readonly bytes: Uint8Array; readonly mode: "100644" | "100755" }> {
  const gitPath = repositoryPath(binding, path);
  const tree = await git(runner, binding.target_worktree_realpath, [
    "git",
    "ls-tree",
    "-z",
    binding.commit_sha,
    "--",
    gitPath,
  ]);
  const entry = nulFields(tree.stdout, "git ls-tree");
  if (entry.length !== 1) {
    return fail(`Baseline path does not resolve to exactly one Git object: ${path}`);
  }
  const match = /^(100644|100755) blob [0-9a-f]{40,64}\t/u.exec(entry[0] ?? "");
  if (match === null) {
    return fail(`Baseline path is not a regular file: ${path}`);
  }
  const content = await git(runner, binding.target_worktree_realpath, [
    "git",
    "show",
    `${binding.commit_sha}:${gitPath}`,
  ]);
  return {
    bytes: content.stdout,
    mode: match[1] as "100644" | "100755",
  };
}

async function buildEntry(
  runner: BinaryGitRunner,
  binding: RepositoryBinding,
  change: ChangedPath,
): Promise<DiffEntry> {
  const oldPath = change.operation === "rename" ? change.sourcePath : change.path;
  const oldFile =
    change.operation === "create" || oldPath === null
      ? null
      : await readBaselineFile(runner, binding, oldPath);
  const newFile =
    change.operation === "delete" ? null : await readCurrentFile(binding, change.path);
  return {
    binary:
      (oldFile !== null && binaryBytes(oldFile.bytes)) ||
      (newFile !== null && binaryBytes(newFile.bytes)),
    new_blob_digest: newFile === null ? null : sha256Digest(newFile.bytes),
    new_mode: newFile?.mode ?? null,
    old_blob_digest: oldFile === null ? null : sha256Digest(oldFile.bytes),
    old_mode: oldFile?.mode ?? null,
    operation: change.operation,
    path: change.path,
    source_path: change.sourcePath,
  };
}

function compareEntries(left: DiffEntry, right: DiffEntry): number {
  const leftKey = `${left.source_path ?? ""}\0${left.path}\0${left.operation}`;
  const rightKey = `${right.source_path ?? ""}\0${right.path}\0${right.operation}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function scopeKey(change: {
  readonly operation: string;
  readonly path: string;
  readonly source_path: string | null;
}): string {
  return `${change.operation}\0${change.source_path ?? ""}\0${change.path}`;
}

function assertExactAuthorizedDiff(
  entries: readonly DiffEntry[],
  authorization: MutationAuthorization,
): void {
  const expected = authorization.authorized_changes.map(scopeKey).sort();
  const actual = entries.map(scopeKey).sort();
  if (
    expected.length !== actual.length ||
    expected.some((value, index) => value !== actual[index])
  ) {
    fail(
      `Actual worktree diff does not exactly match the approved mutation scope: expected ${JSON.stringify(
        expected,
      )}, received ${JSON.stringify(actual)}`,
    );
  }
}

function normalizeAuthorizedEntryRenames(
  capturedEntries: readonly DiffEntry[],
  authorization: MutationAuthorization,
): DiffEntry[] {
  const entries = [...capturedEntries];
  for (const approved of authorization.authorized_changes.filter(
    (change) => change.operation === "rename",
  )) {
    if (approved.source_path === null) {
      return fail("Approved rename omitted its source path");
    }
    if (
      entries.some(
        (entry) =>
          entry.operation === "rename" &&
          entry.path === approved.path &&
          entry.source_path === approved.source_path,
      )
    ) {
      continue;
    }
    const deletionIndex = entries.findIndex(
      (entry) =>
        entry.operation === "delete" &&
        entry.path === approved.source_path &&
        entry.source_path === null,
    );
    const creationIndex = entries.findIndex(
      (entry) =>
        entry.operation === "create" && entry.path === approved.path && entry.source_path === null,
    );
    const deletion = entries[deletionIndex];
    const creation = entries[creationIndex];
    if (
      deletionIndex < 0 ||
      creationIndex < 0 ||
      deletion === undefined ||
      creation === undefined
    ) {
      continue;
    }
    entries.splice(Math.max(deletionIndex, creationIndex), 1);
    entries.splice(Math.min(deletionIndex, creationIndex), 1);
    entries.push({
      binary: deletion.binary || creation.binary,
      new_blob_digest: creation.new_blob_digest,
      new_mode: creation.new_mode,
      old_blob_digest: deletion.old_blob_digest,
      old_mode: deletion.old_mode,
      operation: "rename",
      path: approved.path,
      source_path: approved.source_path,
    });
  }
  return entries;
}

export function canonicalizeCapturedDiff(input: {
  readonly authorization: MutationAuthorization;
  readonly binaryPatchBytes: Uint8Array;
  readonly entries: readonly DiffEntry[];
}): CanonicalDiffSnapshot {
  if (input.entries.length === 0) {
    return fail("Cannot canonicalize an empty patch candidate");
  }
  const entries = normalizeAuthorizedEntryRenames(input.entries, input.authorization).sort(
    compareEntries,
  ) as DiffManifest["entries"];
  const paths = new Set<string>();
  for (const entry of entries) {
    assertCanonicalRelativePath(entry.path);
    if (entry.source_path !== null) {
      assertCanonicalRelativePath(entry.source_path);
    }
    if (paths.has(entry.path)) {
      return fail(`Candidate path appears more than once: ${entry.path}`);
    }
    paths.add(entry.path);
  }
  assertExactAuthorizedDiff(entries, input.authorization);
  const binaryPatchBytes = new Uint8Array(input.binaryPatchBytes);
  const binaryPatchDigest = sha256Digest(binaryPatchBytes);
  const diffContentDigest = canonicalizeJson({
    binary_patch_digest: binaryPatchDigest,
    entries,
  }).digest;
  return Object.freeze({
    binaryPatchBytes,
    binaryPatchDigest,
    diffContentDigest,
    entries,
  });
}

export async function captureCanonicalDiff(input: {
  readonly authorization: MutationAuthorization;
  readonly binding: RepositoryBinding;
  readonly gitRunner: BinaryGitRunner;
}): Promise<CanonicalDiffSnapshot> {
  if (
    input.authorization.baseline_commit !== input.binding.commit_sha ||
    input.authorization.target_worktree_realpath !== input.binding.target_worktree_realpath ||
    input.authorization.repository_binding_ref.digest !== input.binding.artifact_digest
  ) {
    return fail("Mutation authorization does not bind this baseline worktree");
  }
  const head = decode(
    (
      await git(input.gitRunner, input.binding.target_worktree_realpath, [
        "git",
        "rev-parse",
        "--verify",
        "HEAD",
      ])
    ).stdout,
    "git rev-parse",
  ).trim();
  if (head !== input.binding.commit_sha) {
    return fail(`Bound HEAD drifted from ${input.binding.commit_sha} to ${head}`);
  }
  const tracked = parseTrackedChanges(
    (
      await git(input.gitRunner, input.binding.product_root_realpath, [
        "git",
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
        "--",
        ".",
      ])
    ).stdout,
  );
  const untracked = parseUntracked(
    (
      await git(input.gitRunner, input.binding.product_root_realpath, [
        "git",
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
      ])
    ).stdout,
  );
  const changes = normalizeAuthorizedWorktreeRenames(tracked, untracked, input.authorization);
  if (changes.length === 0) {
    return fail("Cannot capture an empty patch candidate");
  }
  const duplicatePaths = new Set<string>();
  for (const change of changes) {
    if (duplicatePaths.has(change.path)) {
      return fail(`Git reported the candidate path more than once: ${change.path}`);
    }
    duplicatePaths.add(change.path);
  }
  const entries = (
    await Promise.all(changes.map((change) => buildEntry(input.gitRunner, input.binding, change)))
  ).sort(compareEntries) as DiffManifest["entries"];
  const trackedPatch = await git(input.gitRunner, input.binding.product_root_realpath, [
    "git",
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    "HEAD",
    "--",
    ".",
  ]);
  const untrackedPatches: Uint8Array[] = [];
  for (const path of [...untracked].map((change) => change.path).sort()) {
    const patch = await git(
      input.gitRunner,
      input.binding.product_root_realpath,
      [
        "git",
        "diff",
        "--no-index",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        "/dev/null",
        path,
      ],
      [0, 1],
    );
    untrackedPatches.push(patch.stdout);
  }
  const binaryPatchBytes = concatenate([trackedPatch.stdout, ...untrackedPatches]);
  return canonicalizeCapturedDiff({
    authorization: input.authorization,
    binaryPatchBytes,
    entries,
  });
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
    return fail(`Candidate capture requires exactly one active ${artifactType}`);
  }
  return matches[0] as Extract<YuanshengCraftContractV1, { artifact_type: T }>;
}

export async function capturePatchCandidate(input: {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly at: string;
  readonly gitRunner: BinaryGitRunner;
  readonly previousCandidates: readonly PatchCandidate[];
  readonly principal: TrustedPrincipal;
  readonly state: WorkflowState;
}): Promise<CapturedPatchCandidate> {
  validateCraftContractGraph(input.activeArtifacts);
  const expectedDigests = new Set(input.state.artifact_refs.map((reference) => reference.digest));
  const actualDigests = new Set(input.activeArtifacts.map((artifact) => artifact.artifact_digest));
  if (
    expectedDigests.size !== actualDigests.size ||
    [...expectedDigests].some((digest) => !actualDigests.has(digest))
  ) {
    return fail("Candidate capture requires the exact active artifact graph");
  }
  const principal = auditTrustedPrincipal(input.principal);
  if (
    principal.agent_id !== "ys-craft-patch-builder" ||
    input.state.phase !== "building" ||
    input.state.phase_principal === null ||
    !principalsEqual(input.state.phase_principal, principal)
  ) {
    return fail("Candidate capture requires the trusted builder bound to building");
  }
  const binding = requireOne(input.activeArtifacts, "repository-binding") as RepositoryBinding;
  const plan = requireOne(input.activeArtifacts, "patch-plan") as PatchPlan;
  const authorization = requireOne(
    input.activeArtifacts,
    "mutation-authorization",
  ) as MutationAuthorization;
  if (
    !principalsEqual(authorization.principal, principal) ||
    authorization.plan_ref.digest !== plan.artifact_digest
  ) {
    return fail("Candidate capture principal or plan differs from its authorization");
  }
  const snapshot = await captureCanonicalDiff({
    authorization,
    binding,
    gitRunner: input.gitRunner,
  });
  const previous = input.previousCandidates.filter(
    (candidate) =>
      candidate.workflow_id === input.state.workflow_id &&
      candidate.plan_ref.digest === plan.artifact_digest,
  );
  const candidateRevision =
    previous.reduce((maximum, candidate) => Math.max(maximum, candidate.candidate_revision), 0) + 1;
  const iteration =
    previous.reduce((maximum, candidate) => Math.max(maximum, candidate.iteration), 0) + 1;
  const diffManifest = seal<DiffManifest>({
    artifact_type: "diff-manifest",
    artifact_version: 1,
    binary_patch_digest: snapshot.binaryPatchDigest,
    created_at: input.at,
    diff_content_digest: snapshot.diffContentDigest,
    entries: snapshot.entries,
    mutation_authorization_ref: artifactRef(authorization),
    plan_ref: artifactRef(plan),
    repository_binding_ref: artifactRef(binding),
    workflow_id: input.state.workflow_id,
  });
  const candidate = seal<PatchCandidate>({
    artifact_type: "patch-candidate",
    artifact_version: 1,
    candidate_revision: candidateRevision,
    created_at: input.at,
    diff_content_digest: snapshot.diffContentDigest,
    diff_manifest_ref: artifactRef(diffManifest),
    iteration,
    plan_ref: artifactRef(plan),
    status: "ready-for-verification",
    workflow_id: input.state.workflow_id,
  });
  validateCraftContractGraph([...input.activeArtifacts, diffManifest, candidate]);
  return Object.freeze({
    ...snapshot,
    candidate,
    diffManifest,
  });
}

export async function assertCandidateWorktreeUnchanged(input: {
  readonly authorization: MutationAuthorization;
  readonly binding: RepositoryBinding;
  readonly candidate: PatchCandidate;
  readonly gitRunner: BinaryGitRunner;
}): Promise<void> {
  const actual = await captureCanonicalDiff(input);
  if (actual.diffContentDigest !== input.candidate.diff_content_digest) {
    return fail("Actual HEAD/status/diff drifted from the immutable patch candidate");
  }
}
