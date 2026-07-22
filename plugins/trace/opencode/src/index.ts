import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Plugin, tool } from "@opencode-ai/plugin";

import { canonicalizeJson } from "../../../../tools/yuansheng-root-cause-blueprint/src/canonical-json";
import {
  createSshRemoteCleanupLease,
  createSshTransportPlan,
  createSshTransportState,
  parseSshCleanup,
  parseSshInventory,
  parseSshStage,
  SSH_TRANSPORT_PROTOCOL_MARKERS,
  type SshCleanupStatus,
  type SshStageRejection,
  SshTransportError,
  type SshTransportLimits,
  type SshTransportState,
  transitionSshTransport,
} from "../../transport/ssh-transport";
import { parseSg2044HardwareProfile } from "../../workflows/hardware-profile";
import { parsePerfDataValidationReportV1 } from "../../workflows/perf-data-validation-report";
import {
  startTraceWorkflow,
  type TraceTransition,
  transitionTraceWorkflow,
} from "../../workflows/trace-workflow";
import {
  cleanupLocalSshSnapshot,
  createLocalSshSnapshot,
  LocalSshSnapshotError,
  type LocalSshSnapshotHandle,
  materializeLocalSshSnapshot,
} from "./local-ssh-snapshot";
import {
  discoverOpenSshExecutables,
  OpenSshRuntimeError,
  runApprovedSftpDownload,
  runApprovedSshCleanup,
  runApprovedSshOperation,
  runApprovedSshPostInventory,
  runApprovedSshPostInventoryCleanup,
  runApprovedSshStage,
} from "./openssh-runtime";

const DEFAULT_ARTIFACT_ROOT = ".opencode/yuansheng/blueprint";
const REPORT_FILENAME = "perf-data-validation-report-v1.json";
const REPORT_PATH_SEGMENTS = ["yuansheng-kit", "ys-trace", "reports"] as const;
const SSH_STAGING_PATH_SEGMENTS = ["yuansheng-kit", "ys-trace", "ssh"] as const;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_FILES = 4096;
const MAX_TOOL_TREE_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const RUN_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const UTF8_ENCODER = new TextEncoder();
const SG2044_PROFILE_URL = new URL(
  "../yuansheng/resources/hardware-profiles/sg2044.json",
  import.meta.url,
);
const VALIDATOR_DIRECTORY = resolve(
  fileURLToPath(new URL("../yuansheng/tools/perf-data-validator/", import.meta.url)),
);

type RuntimeErrorCode =
  | "invalid_path"
  | "invalid_run"
  | "operation_cancelled"
  | "report_cleanup_failed"
  | "report_not_canonical"
  | "report_receipt_mismatch"
  | "report_rejected"
  | "report_unavailable"
  | "remote_transport_failed"
  | "validator_unavailable";

type ToolFileMode = "0644" | "0755";

interface ToolFileRecord {
  readonly bytes: string;
  readonly mode: ToolFileMode;
  readonly path: string;
  readonly sha256: string;
}

interface InstalledValidator {
  readonly directory: string;
  readonly requirementsPath: string;
  readonly requirementsSha256: string;
  readonly toolTreeSha256: string;
}

interface RunRecord {
  readonly evidenceRoot: string;
  readonly reportDirectory: string;
  readonly reportParent: string;
  readonly reportPath: string;
  reportInFlight: boolean;
  transition: TraceTransition;
}

interface PendingRemoteRun {
  readonly artifactRoot: string;
  readonly cleanupSafety: RemoteCleanupSafety;
  inventoryInFlight: boolean;
  readonly lifecycleAbort: AbortController;
  readonly localResidualPaths: Set<string>;
  localSnapshot?: LocalSshSnapshotHandle;
  operation?: RemoteOperation;
  readonly software: string;
  transport: SshTransportState;
  transferInFlight: boolean;
}

interface RemoteCleanupSafety {
  local: boolean;
  remoteInventory: boolean;
  remoteStage: boolean;
}

interface RemoteOperation {
  readonly controller: AbortController;
  readonly detach: () => void;
  readonly done: Promise<void>;
  phase: "awaiting_authorization" | "running";
  readonly resolveDone: () => void;
}

interface BoundReportDirectory {
  readonly parentHandle: FileHandle;
  readonly parentIdentity: Awaited<ReturnType<FileHandle["stat"]>>;
  readonly parentPath: string;
  readonly reportEntryPath: string;
  readonly runEntryPath: string;
  readonly runHandle: FileHandle;
  readonly runIdentity: Awaited<ReturnType<FileHandle["stat"]>>;
  readonly runPath: string;
}

class TraceRuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TraceRuntimeError";
  }
}

function fail(code: RuntimeErrorCode, message: string): never {
  throw new TraceRuntimeError(code, message);
}

function boundedError(error: unknown, code: RuntimeErrorCode, message: string): TraceRuntimeError {
  return error instanceof TraceRuntimeError ? error : new TraceRuntimeError(code, message);
}

function boundedTransportError(error: unknown, message: string): TraceRuntimeError {
  if (error instanceof TraceRuntimeError) {
    return error;
  }
  if (error instanceof OpenSshRuntimeError || error instanceof SshTransportError) {
    return new TraceRuntimeError("remote_transport_failed", error.message);
  }
  return new TraceRuntimeError("remote_transport_failed", message);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    fail("operation_cancelled", "Yuansheng Trace operation was cancelled");
  }
}

function requireRemoteSoftware(value: string): string {
  if (
    value.trim().length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.normalize("NFC") !== value ||
    UTF8_ENCODER.encode(value).byteLength > 255
  ) {
    fail("invalid_path", "software must be a single safe artifact path segment");
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      fail("invalid_path", "software must not contain control characters");
    }
  }
  return value;
}

function sshLimits(input: {
  readonly command_timeout_milliseconds?: number | undefined;
  readonly max_depth?: number | undefined;
  readonly max_entries?: number | undefined;
  readonly max_file_bytes?: number | undefined;
  readonly max_files?: number | undefined;
  readonly max_path_bytes?: number | undefined;
  readonly max_total_bytes?: number | undefined;
}): Partial<SshTransportLimits> {
  return {
    ...(input.command_timeout_milliseconds === undefined
      ? {}
      : { commandTimeoutMilliseconds: input.command_timeout_milliseconds }),
    ...(input.max_depth === undefined ? {} : { maxDepth: input.max_depth }),
    ...(input.max_entries === undefined ? {} : { maxEntries: input.max_entries }),
    ...(input.max_file_bytes === undefined ? {} : { maxFileBytes: input.max_file_bytes }),
    ...(input.max_files === undefined ? {} : { maxFiles: input.max_files }),
    ...(input.max_path_bytes === undefined ? {} : { maxPathBytes: input.max_path_bytes }),
    ...(input.max_total_bytes === undefined ? {} : { maxTotalBytes: input.max_total_bytes }),
  };
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const commonLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function sameFileIdentity(
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function readBoundedFileHandle(
  handle: FileHandle,
  expectedBytes: number,
  unavailableCode: "report_unavailable" | "validator_unavailable",
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(expectedBytes);
  let offset = 0;
  while (offset < bytes.byteLength) {
    checkCancelled(signal);
    const length = Math.min(READ_CHUNK_BYTES, bytes.byteLength - offset);
    const result = await handle.read(bytes, offset, length, offset);
    if (result.bytesRead === 0) {
      fail(unavailableCode, "A file changed while Yuansheng Trace was reading it");
    }
    offset += result.bytesRead;
  }

  checkCancelled(signal);
  const extra = new Uint8Array(1);
  const tail = await handle.read(extra, 0, 1, expectedBytes);
  if (tail.bytesRead !== 0) {
    fail(unavailableCode, "A file changed while Yuansheng Trace was reading it");
  }
  return bytes;
}

async function readStableRegularFile(
  path: string,
  maximumBytes: number,
  unavailableCode: "report_unavailable" | "validator_unavailable",
  signal?: AbortSignal,
): Promise<
  Readonly<{
    bytes: Uint8Array;
    identity: Awaited<ReturnType<FileHandle["stat"]>>;
    permissions: number;
  }>
> {
  checkCancelled(signal);
  const pathBefore = await lstat(path, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    fail(unavailableCode, "Yuansheng Trace expected a regular non-symlink file");
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(pathBefore, opened)) {
      fail(unavailableCode, "A file changed before Yuansheng Trace could read it");
    }
    if (opened.size > BigInt(maximumBytes)) {
      fail(unavailableCode, "A file exceeds the Yuansheng Trace size limit");
    }

    const bytes = await readBoundedFileHandle(handle, Number(opened.size), unavailableCode, signal);
    const openedAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameFileIdentity(opened, openedAfter) ||
      !sameFileIdentity(opened, pathAfter)
    ) {
      fail(unavailableCode, "A file changed while Yuansheng Trace was reading it");
    }

    return { bytes, identity: opened, permissions: Number(opened.mode & 0o777n) };
  } finally {
    await handle.close();
  }
}

function requireSafeTreeEntry(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.normalize("NFC") !== name
  ) {
    fail("validator_unavailable", "The installed validator contains an unsafe path");
  }
}

async function scanToolTree(
  root: string,
  current: string,
  relativeDirectory: string,
  records: ToolFileRecord[],
  totalBytes: { value: number },
  signal: AbortSignal,
): Promise<void> {
  checkCancelled(signal);
  const directoryBefore = await lstat(current, { bigint: true });
  if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
    fail("validator_unavailable", "The installed validator must be a non-symlink directory tree");
  }
  if ((directoryBefore.mode & 0o222n) !== 0n) {
    fail("validator_unavailable", "The installed validator directory must be read-only");
  }

  const entriesBefore = (await readdir(current, { withFileTypes: true }))
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
    .sort((left, right) => compareUtf8(left.name, right.name));

  for (const item of entriesBefore) {
    checkCancelled(signal);
    requireSafeTreeEntry(item.name);
    if (item.type === "symlink" || item.type === "special") {
      fail("validator_unavailable", "The installed validator contains a non-regular entry");
    }
    const path = join(current, item.name);
    const relativePath =
      relativeDirectory.length === 0 ? item.name : `${relativeDirectory}/${item.name}`;
    if (item.type === "directory") {
      await scanToolTree(root, path, relativePath, records, totalBytes, signal);
      continue;
    }

    if (records.length >= MAX_TOOL_FILES) {
      fail("validator_unavailable", "The installed validator contains too many files");
    }
    const stable = await readStableRegularFile(
      path,
      MAX_TOOL_FILE_BYTES,
      "validator_unavailable",
      signal,
    );
    if ((stable.permissions & 0o222) !== 0 || (stable.permissions & 0o444) !== 0o444) {
      fail("validator_unavailable", "An installed validator file must be read-only");
    }
    const executableBits = stable.permissions & 0o111;
    if (executableBits !== 0 && executableBits !== 0o111) {
      fail("validator_unavailable", "An installed validator file has an unsupported mode");
    }
    totalBytes.value += stable.bytes.byteLength;
    if (totalBytes.value > MAX_TOOL_TREE_BYTES) {
      fail("validator_unavailable", "The installed validator exceeds its content size limit");
    }
    records.push({
      bytes: String(stable.bytes.byteLength),
      mode: executableBits === 0 ? "0644" : "0755",
      path: relativePath,
      sha256: sha256Hex(stable.bytes),
    });
  }

  const entriesAfter = (await readdir(current, { withFileTypes: true }))
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
    .sort((left, right) => compareUtf8(left.name, right.name));
  const directoryAfter = await lstat(current, { bigint: true });
  const beforeSignature = entriesBefore.map(({ name, type }) => ({ name, type }));
  if (
    directoryAfter.isSymbolicLink() ||
    !directoryAfter.isDirectory() ||
    !sameFileIdentity(directoryBefore, directoryAfter) ||
    canonicalizeJson(beforeSignature).text !== canonicalizeJson(entriesAfter).text
  ) {
    fail("validator_unavailable", "The installed validator changed while it was inspected");
  }

  if (current === root && records.length === 0) {
    fail("validator_unavailable", "The installed validator directory is empty");
  }
}

async function inspectInstalledValidator(signal: AbortSignal): Promise<InstalledValidator> {
  try {
    const records: ToolFileRecord[] = [];
    await scanToolTree(VALIDATOR_DIRECTORY, VALIDATOR_DIRECTORY, "", records, { value: 0 }, signal);
    records.sort((left, right) => compareUtf8(left.path, right.path));
    const requirements = records.find((record) => record.path === "requirements.txt");
    if (requirements === undefined) {
      fail("validator_unavailable", "The installed validator has no requirements.txt");
    }
    return {
      directory: VALIDATOR_DIRECTORY,
      requirementsPath: join(VALIDATOR_DIRECTORY, "requirements.txt"),
      requirementsSha256: requirements.sha256,
      toolTreeSha256: canonicalizeJson(records).sha256,
    };
  } catch (error) {
    throw boundedError(
      error,
      "validator_unavailable",
      "The installed perf data validator is unavailable",
    );
  }
}

function requireProjectRoot(worktree: string, directory: string): string {
  for (const candidate of [worktree, directory]) {
    if (candidate.length === 0 || !isAbsolute(candidate)) {
      continue;
    }
    const normalized = resolve(candidate);
    if (parsePath(normalized).root !== normalized) {
      return normalized;
    }
  }
  throw new TypeError("OpenCode did not provide a usable project or worktree directory");
}

function resolveArtifactRoot(projectRoot: string, override: string | undefined): string {
  if (override === undefined) {
    return resolve(projectRoot, DEFAULT_ARTIFACT_ROOT);
  }
  if (override.trim().length === 0 || override.includes("\0")) {
    throw new TypeError("artifact_root must be a non-empty path");
  }
  return isAbsolute(override) ? resolve(override) : resolve(projectRoot, override);
}

function resolvePerfDataRoot(projectRoot: string, requested: string): string {
  if (requested.trim().length === 0 || requested.includes("\0")) {
    fail("invalid_path", "perf_data_root must be a non-empty path");
  }
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(projectRoot, requested);
  if (parsePath(absolute).root === absolute) {
    fail("invalid_path", "perf_data_root must not resolve to a filesystem root");
  }
  return absolute;
}

function requireAbsoluteNonRoot(value: string, label: string): string {
  if (value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    fail("invalid_path", `${label} must be an absolute path`);
  }
  const absolute = resolve(value);
  if (parsePath(absolute).root === absolute) {
    fail("invalid_path", `${label} must not be a filesystem root`);
  }
  return absolute;
}

function optionalEnvironmentDirectory(
  name: "XDG_CACHE_HOME" | "XDG_RUNTIME_DIR",
): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.includes("\0") || !isAbsolute(value)) {
    return undefined;
  }
  const absolute = resolve(value);
  return parsePath(absolute).root === absolute ? undefined : absolute;
}

function reportBaseDirectory(): string {
  const runtime = optionalEnvironmentDirectory("XDG_RUNTIME_DIR");
  if (runtime !== undefined) {
    return runtime;
  }
  const cache = optionalEnvironmentDirectory("XDG_CACHE_HOME");
  if (cache !== undefined) {
    return cache;
  }
  const home = requireAbsoluteNonRoot(process.env.HOME ?? "", "HOME");
  return resolve(home, ".cache");
}

function reportPaths(runId: string): Readonly<{ directory: string; parent: string; path: string }> {
  const parent = resolve(reportBaseDirectory(), ...REPORT_PATH_SEGMENTS);
  const directory = join(parent, runId);
  return { directory, parent, path: join(directory, REPORT_FILENAME) };
}

function sshStagingRoot(runId: string): string {
  return resolve(reportBaseDirectory(), ...SSH_STAGING_PATH_SEGMENTS, runId);
}

function requireExactReportPath(received: string, expected: string): void {
  if (
    received.length === 0 ||
    received.includes("\0") ||
    !isAbsolute(received) ||
    resolve(received) !== received ||
    received !== expected
  ) {
    fail("invalid_path", "report_path does not match the path bound to this trace run");
  }
}

function descriptorPath(handle: FileHandle): string {
  return join(parsePath(process.execPath).root, "proc", "self", "fd", String(handle.fd));
}

async function openBoundDirectory(
  openPath: string,
  expectedPath: string,
  label: string,
): Promise<
  Readonly<{
    handle: FileHandle;
    identity: Awaited<ReturnType<FileHandle["stat"]>>;
  }>
> {
  const pathBefore = await lstat(expectedPath, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isDirectory()) {
    fail("report_unavailable", `${label} is not a regular directory`);
  }

  const handle = await open(
    openPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const pathAfter = await lstat(expectedPath, { bigint: true });
    if (
      !opened.isDirectory() ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isDirectory() ||
      !sameFileIdentity(pathBefore, opened) ||
      !sameFileIdentity(opened, pathAfter) ||
      (await realpath(descriptorPath(handle))) !== expectedPath
    ) {
      fail("report_unavailable", `${label} does not resolve to its bound directory`);
    }
    return { handle, identity: opened };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openBoundReportDirectory(run: RunRecord): Promise<BoundReportDirectory> {
  const parent = await openBoundDirectory(run.reportParent, run.reportParent, "The report parent");
  try {
    const runEntryPath = join(descriptorPath(parent.handle), basename(run.reportDirectory));
    const directory = await openBoundDirectory(
      runEntryPath,
      run.reportDirectory,
      "The validation report directory",
    );
    return {
      parentHandle: parent.handle,
      parentIdentity: parent.identity,
      parentPath: run.reportParent,
      reportEntryPath: join(descriptorPath(directory.handle), REPORT_FILENAME),
      runEntryPath,
      runHandle: directory.handle,
      runIdentity: directory.identity,
      runPath: run.reportDirectory,
    };
  } catch (error) {
    await parent.handle.close().catch(() => undefined);
    throw error;
  }
}

function sameDirectoryObject(
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return (
    left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino
  );
}

async function boundDirectoryLocationsMatch(bound: BoundReportDirectory): Promise<boolean> {
  try {
    const [parentHandle, runHandle, parentPath, runPath, parentActual, runActual] =
      await Promise.all([
        bound.parentHandle.stat({ bigint: true }),
        bound.runHandle.stat({ bigint: true }),
        lstat(bound.parentPath, { bigint: true }),
        lstat(bound.runPath, { bigint: true }),
        realpath(descriptorPath(bound.parentHandle)),
        realpath(descriptorPath(bound.runHandle)),
      ]);
    return (
      !parentPath.isSymbolicLink() &&
      !runPath.isSymbolicLink() &&
      sameDirectoryObject(bound.parentIdentity, parentHandle) &&
      sameDirectoryObject(bound.parentIdentity, parentPath) &&
      sameDirectoryObject(bound.runIdentity, runHandle) &&
      sameDirectoryObject(bound.runIdentity, runPath) &&
      parentActual === bound.parentPath &&
      runActual === bound.runPath
    );
  } catch {
    return false;
  }
}

async function assertBoundDirectoriesUnchanged(bound: BoundReportDirectory): Promise<void> {
  const [parentHandle, runHandle, parentPath, runPath] = await Promise.all([
    bound.parentHandle.stat({ bigint: true }),
    bound.runHandle.stat({ bigint: true }),
    lstat(bound.parentPath, { bigint: true }),
    lstat(bound.runPath, { bigint: true }),
  ]);
  if (
    !(await boundDirectoryLocationsMatch(bound)) ||
    !sameFileIdentity(bound.parentIdentity, parentHandle) ||
    !sameFileIdentity(bound.parentIdentity, parentPath) ||
    !sameFileIdentity(bound.runIdentity, runHandle) ||
    !sameFileIdentity(bound.runIdentity, runPath)
  ) {
    fail("report_unavailable", "The validation report directories changed while they were read");
  }
}

async function readValidationReport(
  bound: BoundReportDirectory,
  signal: AbortSignal,
): Promise<
  Readonly<{
    bytes: Uint8Array;
    identity: Awaited<ReturnType<FileHandle["stat"]>>;
  }>
> {
  if ((Number(bound.runIdentity.mode) & 0o777) !== 0o700) {
    fail("report_unavailable", "The validation report directory must have private permissions");
  }
  await assertBoundDirectoriesUnchanged(bound);
  const stable = await readStableRegularFile(
    bound.reportEntryPath,
    MAX_REPORT_BYTES,
    "report_unavailable",
    signal,
  );
  if (stable.permissions !== 0o600) {
    fail("report_unavailable", "The validation report must have private file permissions");
  }
  await assertBoundDirectoriesUnchanged(bound);
  return { bytes: stable.bytes, identity: stable.identity };
}

async function cleanupBoundReport(
  bound: BoundReportDirectory,
  expectedReportIdentity?: Awaited<ReturnType<FileHandle["stat"]>>,
): Promise<boolean> {
  if (!(await boundDirectoryLocationsMatch(bound))) {
    return false;
  }
  try {
    if (expectedReportIdentity !== undefined) {
      const current = await lstat(bound.reportEntryPath, { bigint: true });
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        !sameFileIdentity(expectedReportIdentity, current)
      ) {
        return false;
      }
    }
    await unlink(bound.reportEntryPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      return false;
    }
  }
  if (!(await boundDirectoryLocationsMatch(bound))) {
    return false;
  }
  try {
    await rmdir(bound.runEntryPath);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

async function closeBoundReportDirectory(bound: BoundReportDirectory): Promise<void> {
  await Promise.allSettled([bound.runHandle.close(), bound.parentHandle.close()]);
}

async function cleanupReport(run: RunRecord): Promise<boolean> {
  let bound: BoundReportDirectory;
  try {
    bound = await openBoundReportDirectory(run);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  try {
    return await cleanupBoundReport(bound);
  } finally {
    await closeBoundReportDirectory(bound);
  }
}

function remoteCleanupKnown(run: PendingRemoteRun): boolean {
  return (
    (run.transport.phase === "staged" ||
      run.transport.phase === "failed" ||
      run.transport.phase === "cleaned") &&
    run.transport.cleanup.remote_temp_removed
  );
}

async function cleanupRemoteSnapshot(run: PendingRemoteRun): Promise<boolean> {
  if (remoteCleanupKnown(run)) {
    return true;
  }
  if (!("cleanup_lease" in run.transport) || run.transport.cleanup_lease === undefined) {
    return true;
  }
  if (!run.cleanupSafety.remoteStage) {
    return false;
  }
  try {
    const response = await runApprovedSshCleanup(run.transport, new AbortController().signal);
    return parseSshCleanup(response.stdout, {
      cleanupLease: run.transport.cleanup_lease,
      plan: run.transport.plan,
    }).remote_temp_removed;
  } catch (error) {
    if (error instanceof OpenSshRuntimeError && !error.cleanupSafe) {
      run.cleanupSafety.remoteStage = false;
    }
    return false;
  }
}

async function cleanupRemoteInventorySnapshot(run: PendingRemoteRun): Promise<boolean> {
  const inventoryTemp = run.transport.plan.plan.remote_inventory_temp;
  if (
    run.transport.phase !== "failed" ||
    !run.transport.cleanup.residual_paths.includes(inventoryTemp)
  ) {
    return true;
  }
  if (!run.cleanupSafety.remoteInventory) {
    return false;
  }
  try {
    const response = await runApprovedSshPostInventoryCleanup(
      run.transport,
      new AbortController().signal,
    );
    const expected = UTF8_ENCODER.encode(`${SSH_TRANSPORT_PROTOCOL_MARKERS.inventoryCleanup}\n`);
    return bytesEqual(response.stdout, expected);
  } catch (error) {
    if (error instanceof OpenSshRuntimeError && !error.cleanupSafe) {
      run.cleanupSafety.remoteInventory = false;
    }
    return false;
  }
}

async function cleanupLocalSnapshot(
  run: PendingRemoteRun,
): Promise<Readonly<{ removed: boolean; residualPaths: readonly string[] }>> {
  if (run.localSnapshot === undefined) {
    const residualPaths = [...run.localResidualPaths];
    return { removed: residualPaths.length === 0, residualPaths };
  }
  if (!run.cleanupSafety.local) {
    return {
      removed: false,
      residualPaths: [run.localSnapshot.local_staging_root, ...run.localResidualPaths],
    };
  }
  try {
    const cleanup = await cleanupLocalSshSnapshot(run.localSnapshot);
    if (cleanup.local_staging_removed) {
      delete run.localSnapshot;
    }
    const residualPaths = [...cleanup.residual_paths, ...run.localResidualPaths];
    return {
      removed: cleanup.local_staging_removed && residualPaths.length === 0,
      residualPaths: [...new Set(residualPaths)],
    };
  } catch {
    return {
      removed: false,
      residualPaths: [run.transport.plan.plan.local_staging_root, ...run.localResidualPaths],
    };
  }
}

function cleanupStatus(input: {
  readonly localRemoved: boolean;
  readonly localResidualPaths: readonly string[];
  readonly remoteRemoved: boolean;
  readonly remoteResidualPaths?: readonly string[];
  readonly run: PendingRemoteRun;
}): SshCleanupStatus {
  const residualPaths = [...input.localResidualPaths, ...(input.remoteResidualPaths ?? [])];
  if (!input.remoteRemoved) {
    const remotePath =
      "cleanup_lease" in input.run.transport && input.run.transport.cleanup_lease !== undefined
        ? input.run.transport.cleanup_lease.remote_temp
        : input.run.transport.plan.plan.remote_temp;
    residualPaths.push(remotePath);
  }
  return {
    local_staging_removed: input.localRemoved,
    remote_temp_removed: input.remoteRemoved,
    residual_paths: [...new Set(residualPaths)],
  };
}

function rejectedStageFromRuntimeError(
  error: OpenSshRuntimeError,
  state: Extract<SshTransportState, { phase: "transferring" }>,
): SshStageRejection {
  const cleanupLease = createSshRemoteCleanupLease(state.plan, state.inventory.inventory_sha256);
  try {
    if (error.stdout !== undefined && error.stdout.byteLength > 0) {
      const parsed = parseSshStage(error.stdout, state.plan, state.inventory.inventory_sha256);
      if (!parsed.ok) {
        return parsed;
      }
    }
  } catch {
    // The plan-bound path still provides an exact cleanup lease.
  }
  return {
    cleanup_lease: cleanupLease,
    error_code: "snapshot_mismatch",
    error_message: "The remote stage process did not complete successfully",
    ok: false,
  };
}

function beginRemoteOperation(
  run: PendingRemoteRun,
  callerSignal: AbortSignal,
  phase: RemoteOperation["phase"],
): RemoteOperation {
  if (run.operation !== undefined) {
    fail("invalid_run", "The remote trace run already has an active operation");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const signals = [callerSignal, run.lifecycleAbort.signal];
  for (const signal of signals) {
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  }
  let resolveDone = (): void => undefined;
  const done = new Promise<void>((resolveOperation) => {
    resolveDone = resolveOperation;
  });
  const operation: RemoteOperation = {
    controller,
    detach: () => {
      for (const signal of signals) {
        signal.removeEventListener("abort", abort);
      }
    },
    done,
    phase,
    resolveDone,
  };
  run.operation = operation;
  return operation;
}

function finishRemoteOperation(run: PendingRemoteRun, operation: RemoteOperation): void {
  if (run.operation !== operation) {
    return;
  }
  delete run.operation;
  operation.detach();
  operation.resolveDone();
}

export const YuanshengTracePlugin: Plugin = async () => {
  const sessions = new Map<string, Map<string, RunRecord>>();
  const remoteSessions = new Map<string, Map<string, PendingRemoteRun>>();
  const activeRunIds = new Set<string>();
  let disposing = false;

  function createRunId(): string {
    let runId: string;
    do {
      runId = randomBytes(16).toString("hex");
    } while (activeRunIds.has(runId));
    activeRunIds.add(runId);
    return runId;
  }

  function registerRun(sessionId: string, runId: string, run: RunRecord): void {
    const sessionRuns = sessions.get(sessionId) ?? new Map<string, RunRecord>();
    sessionRuns.set(runId, run);
    sessions.set(sessionId, sessionRuns);
  }

  function deleteRun(sessionId: string, runId: string, run: RunRecord): void {
    const sessionRuns = sessions.get(sessionId);
    if (sessionRuns?.get(runId) !== run) {
      return;
    }
    sessionRuns.delete(runId);
    activeRunIds.delete(runId);
    if (sessionRuns.size === 0) {
      sessions.delete(sessionId);
    }
  }

  function registerRemoteRun(sessionId: string, runId: string, run: PendingRemoteRun): void {
    const sessionRuns = remoteSessions.get(sessionId) ?? new Map<string, PendingRemoteRun>();
    sessionRuns.set(runId, run);
    remoteSessions.set(sessionId, sessionRuns);
  }

  function deleteRemoteRun(sessionId: string, runId: string, run: PendingRemoteRun): void {
    const sessionRuns = remoteSessions.get(sessionId);
    if (sessionRuns?.get(runId) !== run) {
      return;
    }
    sessionRuns.delete(runId);
    activeRunIds.delete(runId);
    if (sessionRuns.size === 0) {
      remoteSessions.delete(sessionId);
    }
  }

  return {
    async dispose() {
      disposing = true;
      const runs = [...sessions.values()].flatMap((sessionRuns) => [...sessionRuns.values()]);
      const remoteRuns = [...remoteSessions.values()].flatMap((sessionRuns) => [
        ...sessionRuns.values(),
      ]);
      for (const run of remoteRuns) {
        run.lifecycleAbort.abort();
      }
      await Promise.allSettled(
        remoteRuns.flatMap((run) =>
          run.operation?.phase === "running" ? [run.operation.done] : [],
        ),
      );
      const residualPaths: string[] = [];
      const reportCleanup = await Promise.all(
        runs.map(async (run) => ({ removed: await cleanupReport(run), run })),
      );
      for (const result of reportCleanup) {
        if (!result.removed) {
          residualPaths.push(result.run.reportDirectory);
        }
      }
      const remoteCleanup = await Promise.all(
        remoteRuns.map(async (run) => ({
          inventoryRemoved: await cleanupRemoteInventorySnapshot(run),
          local: await cleanupLocalSnapshot(run),
          remoteRemoved: await cleanupRemoteSnapshot(run),
          run,
        })),
      );
      for (const result of remoteCleanup) {
        residualPaths.push(...result.local.residualPaths);
        if (!result.inventoryRemoved) {
          residualPaths.push(result.run.transport.plan.plan.remote_inventory_temp);
        }
        if (!result.remoteRemoved) {
          residualPaths.push(
            "cleanup_lease" in result.run.transport &&
              result.run.transport.cleanup_lease !== undefined
              ? result.run.transport.cleanup_lease.remote_temp
              : result.run.transport.plan.plan.remote_temp,
          );
        }
      }
      const uniqueResidualPaths = [...new Set(residualPaths)];
      if (uniqueResidualPaths.length > 0) {
        const bounded = uniqueResidualPaths.slice(0, 32);
        const suffix = uniqueResidualPaths.length > bounded.length ? ", ..." : "";
        throw new TraceRuntimeError(
          "remote_transport_failed",
          `Yuansheng Trace disposal left cleanup residuals: ${bounded.join(", ")}${suffix}`,
        );
      }
      sessions.clear();
      remoteSessions.clear();
      activeRunIds.clear();
    },
    tool: {
      ys_trace_inventory_remote_input: tool({
        description:
          "Run the exactly approved read-only OpenSSH probe and inventory for a pending Yuansheng Trace remote input.",
        args: {
          plan_sha256: tool.schema.string().regex(SHA256),
          run_id: tool.schema.string().regex(RUN_ID),
        },
        async execute({ plan_sha256, run_id }, context) {
          if (disposing) {
            fail("invalid_run", "Yuansheng Trace is disposing this plugin instance");
          }
          const run = remoteSessions.get(context.sessionID)?.get(run_id);
          if (run === undefined) {
            fail("invalid_run", "The remote trace run is unknown in this OpenCode session");
          }
          if (
            run.transport.phase !== "awaiting_inventory" ||
            run.transport.plan.plan_sha256 !== plan_sha256
          ) {
            fail("invalid_run", "The remote trace run is not waiting for this exact inventory");
          }
          if (run.inventoryInFlight) {
            fail("invalid_run", "The remote trace run is already collecting its inventory");
          }
          const operation = beginRemoteOperation(run, context.abort, "running");
          run.inventoryInFlight = true;
          let inventoryAttempted = false;
          try {
            const probe = await runApprovedSshOperation(
              run.transport,
              "probe",
              operation.controller.signal,
            );
            const expectedProbe = UTF8_ENCODER.encode(`${SSH_TRANSPORT_PROTOCOL_MARKERS.probe}\n`);
            if (!bytesEqual(probe.stdout, expectedProbe)) {
              throw new TraceRuntimeError(
                "remote_transport_failed",
                "The remote OpenSSH capability probe returned an invalid response",
              );
            }
            inventoryAttempted = true;
            const response = await runApprovedSshOperation(
              run.transport,
              "inventory",
              operation.controller.signal,
            );
            const inventory = parseSshInventory(response.stdout, run.transport.plan);
            run.transport = transitionSshTransport(run.transport, {
              inventory,
              type: "bind_inventory",
            });
            inventoryAttempted = false;
            context.metadata({
              metadata: {
                directories: inventory.inventory.directories,
                files: inventory.inventory.files,
                inventory_sha256: inventory.inventory_sha256,
                plan_sha256,
                run_id,
                total_file_bytes: inventory.inventory.total_file_bytes,
              },
              title: `Yuansheng Trace inventory: ${inventory.inventory_sha256}`,
            });
            return JSON.stringify({
              inventory: inventory.inventory,
              inventory_sha256: inventory.inventory_sha256,
              next_action: "await_explicit_transfer_confirmation",
              phase: run.transport.phase,
              plan_sha256,
              run_id,
            });
          } catch (error) {
            const inventoryCleanupSafe =
              !inventoryAttempted || !(error instanceof OpenSshRuntimeError) || error.cleanupSafe;
            if (!inventoryCleanupSafe) {
              run.cleanupSafety.remoteInventory = false;
            }
            let cleanupFailed = inventoryAttempted && !inventoryCleanupSafe;
            if (inventoryAttempted && inventoryCleanupSafe) {
              try {
                const cleanup = await runApprovedSshOperation(
                  run.transport,
                  "inventory_cleanup",
                  new AbortController().signal,
                );
                const expectedCleanup = UTF8_ENCODER.encode(
                  `${SSH_TRANSPORT_PROTOCOL_MARKERS.inventoryCleanup}\n`,
                );
                cleanupFailed = !bytesEqual(cleanup.stdout, expectedCleanup);
              } catch (cleanupError) {
                if (cleanupError instanceof OpenSshRuntimeError && !cleanupError.cleanupSafe) {
                  run.cleanupSafety.remoteInventory = false;
                }
                cleanupFailed = true;
              }
            }
            if (cleanupFailed) {
              run.transport = transitionSshTransport(run.transport, {
                cleanup: cleanupStatus({
                  localRemoved: true,
                  localResidualPaths: [],
                  remoteRemoved: true,
                  remoteResidualPaths: [run.transport.plan.plan.remote_inventory_temp],
                  run,
                }),
                error_code: "transport_failed",
                type: "fail",
              });
              throw new TraceRuntimeError(
                "remote_transport_failed",
                `Remote inventory failed and may have left ${run.transport.plan.plan.remote_inventory_temp}`,
              );
            }
            deleteRemoteRun(context.sessionID, run_id, run);
            throw boundedTransportError(
              error,
              "The approved remote inventory operation could not be completed",
            );
          } finally {
            run.inventoryInFlight = false;
            finishRemoteOperation(run, operation);
          }
        },
      }),
      ys_trace_transfer_remote_input: tool({
        description:
          "Transfer an explicitly confirmed Yuansheng Trace SSH inventory into a verified local snapshot and clean the remote staging directory.",
        args: {
          inventory_sha256: tool.schema.string().regex(SHA256),
          plan_sha256: tool.schema.string().regex(SHA256),
          run_id: tool.schema.string().regex(RUN_ID),
        },
        async execute({ inventory_sha256, plan_sha256, run_id }, context) {
          if (disposing) {
            fail("invalid_run", "Yuansheng Trace is disposing this plugin instance");
          }
          const run = remoteSessions.get(context.sessionID)?.get(run_id);
          if (run === undefined) {
            fail("invalid_run", "The remote trace run is unknown in this OpenCode session");
          }
          if (
            run.transport.phase !== "awaiting_transfer_confirmation" ||
            run.transport.plan.plan_sha256 !== plan_sha256 ||
            run.transport.inventory.inventory_sha256 !== inventory_sha256
          ) {
            fail("invalid_run", "The remote trace run is not waiting for this exact transfer");
          }
          if (run.transferInFlight || run.inventoryInFlight) {
            fail("invalid_run", "The remote trace run already has an operation in progress");
          }

          const transferConfirmationSha256 = canonicalizeJson({
            inventory_sha256,
            plan_sha256,
            run_id,
          }).sha256;
          const operation = beginRemoteOperation(run, context.abort, "awaiting_authorization");
          run.transferInFlight = true;
          try {
            try {
              await context.ask({
                always: [transferConfirmationSha256],
                metadata: {
                  inventory: run.transport.inventory.inventory,
                  inventory_sha256,
                  plan_sha256,
                  run_id,
                  transfer_confirmation_sha256: transferConfirmationSha256,
                },
                patterns: [transferConfirmationSha256],
                permission: "ys_trace_ssh_transfer",
              });
            } catch (error) {
              throw boundedTransportError(error, "The remote snapshot transfer was not approved");
            }
            checkCancelled(operation.controller.signal);
            operation.phase = "running";

            let stageCleanupSafe = true;
            let remoteInventoryMayExist = false;
            try {
              run.transport = transitionSshTransport(run.transport, {
                inventory_sha256,
                type: "confirm_transfer",
              });
              if (run.transport.phase !== "transferring") {
                fail("invalid_run", "The remote trace run did not enter its transfer phase");
              }
              const transferring = run.transport;
              let stageResponse: Awaited<ReturnType<typeof runApprovedSshStage>>;
              remoteInventoryMayExist = true;
              try {
                stageResponse = await runApprovedSshStage(
                  transferring,
                  operation.controller.signal,
                );
                remoteInventoryMayExist = false;
              } catch (error) {
                let rejection: SshStageRejection;
                if (error instanceof OpenSshRuntimeError) {
                  stageCleanupSafe = error.cleanupSafe;
                  if (!error.cleanupSafe) {
                    run.cleanupSafety.remoteStage = false;
                    run.cleanupSafety.remoteInventory = false;
                  }
                  rejection = rejectedStageFromRuntimeError(error, transferring);
                } else {
                  rejection = {
                    cleanup_lease: createSshRemoteCleanupLease(transferring.plan, inventory_sha256),
                    error_code: "snapshot_mismatch",
                    error_message: "The remote stage process did not complete successfully",
                    ok: false,
                  };
                }
                run.transport = transitionSshTransport(transferring, {
                  rejection,
                  type: "reject_stage",
                });
                throw error;
              }

              let parsedStage: ReturnType<typeof parseSshStage>;
              try {
                parsedStage = parseSshStage(
                  stageResponse.stdout,
                  transferring.plan,
                  inventory_sha256,
                );
              } catch (error) {
                run.transport = transitionSshTransport(transferring, {
                  rejection: {
                    cleanup_lease: createSshRemoteCleanupLease(transferring.plan, inventory_sha256),
                    error_code: "snapshot_mismatch",
                    error_message: "The remote stage response could not be validated",
                    ok: false,
                  },
                  type: "reject_stage",
                });
                throw error;
              }
              if (!parsedStage.ok) {
                run.transport = transitionSshTransport(transferring, {
                  rejection: parsedStage,
                  type: "reject_stage",
                });
                throw new SshTransportError(parsedStage.error_code, parsedStage.error_message);
              }
              run.transport = transitionSshTransport(transferring, {
                stage: parsedStage.stage,
                type: "bind_stage",
              });
              if (run.transport.phase !== "downloading") {
                fail("invalid_run", "The remote trace run did not enter its download phase");
              }

              const downloading = run.transport;
              try {
                run.localSnapshot = await createLocalSshSnapshot(
                  downloading,
                  operation.controller.signal,
                );
              } catch (error) {
                if (error instanceof LocalSshSnapshotError && error.residualRoot !== null) {
                  run.localResidualPaths.add(error.residualRoot);
                }
                throw error;
              }
              try {
                await runApprovedSftpDownload(
                  downloading,
                  run.localSnapshot,
                  operation.controller.signal,
                );
              } catch (error) {
                if (error instanceof OpenSshRuntimeError) {
                  stageCleanupSafe = error.cleanupSafe;
                  if (!error.cleanupSafe) {
                    run.cleanupSafety.local = false;
                    run.cleanupSafety.remoteStage = false;
                  }
                }
                throw error;
              }
              const mapping = await materializeLocalSshSnapshot(
                run.localSnapshot,
                downloading,
                operation.controller.signal,
              );

              remoteInventoryMayExist = true;
              let postInventoryResponse: Awaited<ReturnType<typeof runApprovedSshPostInventory>>;
              try {
                postInventoryResponse = await runApprovedSshPostInventory(
                  downloading,
                  operation.controller.signal,
                );
                remoteInventoryMayExist = false;
              } catch (error) {
                if (error instanceof OpenSshRuntimeError) {
                  if (!error.cleanupSafe) {
                    run.cleanupSafety.remoteInventory = false;
                  }
                }
                throw error;
              }
              const postInventory = parseSshInventory(
                postInventoryResponse.stdout,
                downloading.plan,
              );
              if (postInventory.inventory_sha256 !== inventory_sha256) {
                throw new SshTransportError(
                  "source_changed",
                  "The remote source changed before the snapshot transfer completed",
                );
              }

              let cleanupResponse: Awaited<ReturnType<typeof runApprovedSshCleanup>>;
              try {
                cleanupResponse = await runApprovedSshCleanup(
                  downloading,
                  new AbortController().signal,
                );
              } catch (error) {
                if (error instanceof OpenSshRuntimeError) {
                  stageCleanupSafe = error.cleanupSafe;
                  if (!error.cleanupSafe) {
                    run.cleanupSafety.remoteStage = false;
                  }
                }
                throw error;
              }
              const remoteCleanup = parseSshCleanup(cleanupResponse.stdout, {
                cleanupLease: downloading.cleanup_lease,
                plan: downloading.plan,
              });
              run.transport = transitionSshTransport(downloading, {
                cleanup: remoteCleanup,
                mapping,
                type: "complete_staging",
              });
              context.metadata({
                metadata: {
                  inventory_sha256,
                  local_tree_root: mapping.mapping.local_tree_root,
                  mapping_sha256: mapping.mapping_sha256,
                  plan_sha256,
                  run_id,
                  stage_sha256: mapping.mapping.stage_sha256,
                },
                title: `Yuansheng Trace SSH snapshot: ${mapping.mapping_sha256}`,
              });
              return JSON.stringify({
                inventory_sha256,
                local_tree_root: mapping.mapping.local_tree_root,
                mapping,
                next_action: "local_snapshot_ready_for_validation",
                phase: run.transport.phase,
                plan_sha256,
                run_id,
              });
            } catch (error) {
              let postInventoryRemoved = !remoteInventoryMayExist;
              if (remoteInventoryMayExist && run.cleanupSafety.remoteInventory) {
                try {
                  const cleanup = await runApprovedSshPostInventoryCleanup(
                    run.transport,
                    new AbortController().signal,
                  );
                  const expected = UTF8_ENCODER.encode(
                    `${SSH_TRANSPORT_PROTOCOL_MARKERS.inventoryCleanup}\n`,
                  );
                  postInventoryRemoved = bytesEqual(cleanup.stdout, expected);
                } catch (cleanupError) {
                  if (cleanupError instanceof OpenSshRuntimeError && !cleanupError.cleanupSafe) {
                    run.cleanupSafety.remoteInventory = false;
                  }
                  postInventoryRemoved = false;
                }
              }
              const localCleanup = await cleanupLocalSnapshot(run);
              const remoteRemoved = stageCleanupSafe ? await cleanupRemoteSnapshot(run) : false;
              const cleanup = cleanupStatus({
                localRemoved: localCleanup.removed,
                localResidualPaths: localCleanup.residualPaths,
                remoteRemoved,
                remoteResidualPaths: postInventoryRemoved
                  ? []
                  : [run.transport.plan.plan.remote_inventory_temp],
                run,
              });
              try {
                run.transport = transitionSshTransport(run.transport, {
                  cleanup,
                  error_code:
                    error instanceof SshTransportError
                      ? error.code
                      : error instanceof OpenSshRuntimeError && error.code === "operation_cancelled"
                        ? "operation_cancelled"
                        : error instanceof OpenSshRuntimeError && error.code === "operation_timeout"
                          ? "operation_timeout"
                          : "transport_failed",
                  type: "fail",
                });
              } catch {
                // The bounded failure below remains authoritative if state recording also fails.
              }
              if (
                cleanup.local_staging_removed &&
                cleanup.remote_temp_removed &&
                cleanup.residual_paths.length === 0
              ) {
                deleteRemoteRun(context.sessionID, run_id, run);
              }
              if (cleanup.residual_paths.length > 0) {
                throw new TraceRuntimeError(
                  "remote_transport_failed",
                  `The SSH snapshot transfer failed and left cleanup residuals: ${cleanup.residual_paths.join(", ")}`,
                );
              }
              throw boundedTransportError(
                error,
                "The approved SSH snapshot transfer could not be completed",
              );
            }
          } finally {
            run.transferInFlight = false;
            finishRemoteOperation(run, operation);
          }
        },
      }),
      ys_trace_provide_validation_report: tool({
        description:
          "Verify and consume the exact perf data validation report bound to a Yuansheng Trace run.",
        args: {
          report_path: tool.schema.string(),
          report_sha256: tool.schema.string().regex(SHA256),
          run_id: tool.schema.string().regex(RUN_ID),
        },
        async execute({ report_path, report_sha256, run_id }, context) {
          const sessionRuns = sessions.get(context.sessionID);
          const run = sessionRuns?.get(run_id);
          if (run === undefined) {
            fail("invalid_run", "The trace run is unknown in this OpenCode session");
          }
          if (run.reportInFlight) {
            fail("invalid_run", "The trace run is already consuming a validation report");
          }
          run.reportInFlight = true;
          let bound: BoundReportDirectory | undefined;
          let reportIdentity: Awaited<ReturnType<FileHandle["stat"]>> | undefined;

          try {
            if (run.transition.state.phase !== "awaiting_validation_report") {
              fail("invalid_run", "The trace run is not waiting for a validation report");
            }
            requireExactReportPath(report_path, run.reportPath);
            try {
              bound = await openBoundReportDirectory(run);
            } catch (error) {
              throw boundedError(
                error,
                "report_unavailable",
                "The validation report directories are unavailable",
              );
            }
            const report = await readValidationReport(bound, context.abort);
            const { bytes } = report;
            reportIdentity = report.identity;
            const rawSha256 = sha256Hex(bytes);
            if (rawSha256 !== report_sha256) {
              fail(
                "report_receipt_mismatch",
                "The validation report receipt does not match the file",
              );
            }

            let next: TraceTransition;
            try {
              const parsed = parsePerfDataValidationReportV1(bytes);
              if (parsed.sha256 !== rawSha256 || !bytesEqual(parsed.bytes, bytes)) {
                fail("report_not_canonical", "The validation report is not canonical JSON");
              }
              next = transitionTraceWorkflow(run.transition.state, {
                bytes,
                evidenceRoot: run.evidenceRoot,
                type: "provide_validation_report",
              });
            } catch (error) {
              throw boundedError(
                error,
                "report_rejected",
                "The validation report was rejected by Yuansheng Trace",
              );
            }

            if (next.state.reportSha256 !== rawSha256) {
              fail("report_rejected", "The validation report digest was not bound to the workflow");
            }
            if (!(await cleanupBoundReport(bound, reportIdentity))) {
              fail(
                "report_cleanup_failed",
                "Yuansheng Trace could not remove the validation report",
              );
            }

            run.transition = next;
            run.reportInFlight = false;
            return JSON.stringify({
              output: next.output,
              report_sha256: rawSha256,
              run_id,
            });
          } catch (error) {
            deleteRun(context.sessionID, run_id, run);
            const clean =
              bound === undefined
                ? await cleanupReport(run)
                : await cleanupBoundReport(bound, reportIdentity);
            if (!clean) {
              throw new TraceRuntimeError(
                "report_cleanup_failed",
                "Yuansheng Trace could not clean up a failed validation report run",
              );
            }
            throw boundedError(
              error,
              "report_rejected",
              "The validation report was rejected by Yuansheng Trace",
            );
          } finally {
            if (bound !== undefined) {
              await closeBoundReportDirectory(bound);
            }
          }
        },
      }),
      ys_trace_start: tool({
        description:
          "Resolve Yuansheng Trace local paths or prepare an exact OpenSSH plan, without executing the validator.",
        args: {
          artifact_root: tool.schema.string().optional(),
          perf_data_root: tool.schema.string(),
          ssh_alias: tool.schema.string().optional(),
          ssh_limits: tool.schema
            .object({
              command_timeout_milliseconds: tool.schema.number().int().positive().optional(),
              max_depth: tool.schema.number().int().positive().optional(),
              max_entries: tool.schema.number().int().positive().optional(),
              max_file_bytes: tool.schema.number().int().positive().optional(),
              max_files: tool.schema.number().int().positive().optional(),
              max_path_bytes: tool.schema.number().int().positive().optional(),
              max_total_bytes: tool.schema.number().int().positive().optional(),
            })
            .strict()
            .optional(),
          software: tool.schema.string(),
        },
        async execute({ artifact_root, perf_data_root, software, ssh_alias, ssh_limits }, context) {
          if (disposing) {
            fail("invalid_run", "Yuansheng Trace is disposing this plugin instance");
          }
          const projectRoot = requireProjectRoot(context.worktree, context.directory);
          const resolvedArtifactRoot = resolveArtifactRoot(projectRoot, artifact_root);
          if (ssh_alias !== undefined) {
            const remoteSoftware = requireRemoteSoftware(software);
            const remoteRunId = createRunId();
            let remoteRunRegistered = false;
            try {
              const executables = await discoverOpenSshExecutables();
              const plan = createSshTransportPlan({
                alias: ssh_alias,
                ...(ssh_limits === undefined ? {} : { limits: sshLimits(ssh_limits) }),
                localStagingRoot: sshStagingRoot(remoteRunId),
                remoteRoot: perf_data_root,
                runId: remoteRunId,
                sessionId: context.sessionID,
                sftpExecutable: executables.sftp.path,
                sftpExecutableSha256: executables.sftp.sha256,
                sshExecutable: executables.ssh.path,
                sshExecutableSha256: executables.ssh.sha256,
              });
              let transport = createSshTransportState(plan, {
                runId: remoteRunId,
                sessionId: context.sessionID,
              });
              context.metadata({
                metadata: {
                  artifact_root: resolvedArtifactRoot,
                  plan: plan.plan,
                  plan_sha256: plan.plan_sha256,
                  run_id: remoteRunId,
                },
                title: `Yuansheng Trace SSH plan: ${plan.plan_sha256}`,
              });
              await context.ask({
                always: [plan.plan_sha256],
                metadata: {
                  artifact_root: resolvedArtifactRoot,
                  plan: plan.plan,
                  plan_sha256: plan.plan_sha256,
                  run_id: remoteRunId,
                },
                patterns: [plan.plan_sha256],
                permission: "ys_trace_ssh_transport",
              });
              if (disposing) {
                fail("invalid_run", "Yuansheng Trace disposed before SSH plan approval completed");
              }
              transport = transitionSshTransport(transport, {
                plan_sha256: plan.plan_sha256,
                type: "approve_plan",
              });
              const remoteRun: PendingRemoteRun = {
                artifactRoot: resolvedArtifactRoot,
                cleanupSafety: {
                  local: true,
                  remoteInventory: true,
                  remoteStage: true,
                },
                inventoryInFlight: false,
                lifecycleAbort: new AbortController(),
                localResidualPaths: new Set<string>(),
                software: remoteSoftware,
                transport,
                transferInFlight: false,
              };
              registerRemoteRun(context.sessionID, remoteRunId, remoteRun);
              remoteRunRegistered = true;
              return JSON.stringify({
                artifact_root: resolvedArtifactRoot,
                location: plan.plan.location,
                next_tool: "ys_trace_inventory_remote_input",
                phase: transport.phase,
                plan: plan.plan,
                plan_sha256: plan.plan_sha256,
                run_id: remoteRunId,
                software: remoteSoftware,
              });
            } catch (error) {
              throw boundedTransportError(
                error,
                "The Yuansheng Trace SSH plan could not be prepared",
              );
            } finally {
              if (!remoteRunRegistered) {
                activeRunIds.delete(remoteRunId);
              }
            }
          }
          if (ssh_limits !== undefined) {
            fail("invalid_path", "ssh_limits requires an explicit ssh_alias");
          }
          const resolvedPerfDataRoot = resolvePerfDataRoot(projectRoot, perf_data_root);
          const validator = await inspectInstalledValidator(context.abort);
          const profile = parseSg2044HardwareProfile(
            await readFile(SG2044_PROFILE_URL, { signal: context.abort }),
          );
          const transition = startTraceWorkflow({
            artifactRoot: resolvedArtifactRoot,
            perfDataRoot: resolvedPerfDataRoot,
            profiles: [profile],
            software,
          });
          const runId = createRunId();
          let runRegistered = false;

          try {
            const report = reportPaths(runId);
            const run: RunRecord = {
              evidenceRoot: resolvedPerfDataRoot,
              reportDirectory: report.directory,
              reportInFlight: false,
              reportParent: report.parent,
              reportPath: report.path,
              transition,
            };
            context.metadata({
              metadata: {
                artifact_root: resolvedArtifactRoot,
                perf_data_root: resolvedPerfDataRoot,
                report_directory: report.directory,
                report_path: report.path,
                run_id: runId,
              },
              title: `Yuansheng Trace: ${resolvedArtifactRoot}`,
            });
            const approvalPaths = [
              resolvedArtifactRoot,
              resolvedPerfDataRoot,
              report.directory,
              report.path,
            ];
            await context.ask({
              always: approvalPaths,
              metadata: {
                artifact_root: resolvedArtifactRoot,
                perf_data_root: resolvedPerfDataRoot,
                report_directory: report.directory,
                report_path: report.path,
                run_id: runId,
              },
              patterns: approvalPaths,
              permission: "ys_trace_start",
            });
            if (disposing) {
              fail("invalid_run", "Yuansheng Trace disposed before start approval completed");
            }
            registerRun(context.sessionID, runId, run);
            runRegistered = true;

            return JSON.stringify({
              artifact_root: resolvedArtifactRoot,
              output: transition.output,
              perf_data_root: resolvedPerfDataRoot,
              run_id: runId,
              validation_report: {
                directory: report.directory,
                path: report.path,
              },
              validator: {
                directory: validator.directory,
                requirements_path: validator.requirementsPath,
                requirements_sha256: validator.requirementsSha256,
                tool_tree_sha256: validator.toolTreeSha256,
              },
            });
          } finally {
            if (!runRegistered) {
              activeRunIds.delete(runId);
            }
          }
        },
      }),
    },
  };
};
