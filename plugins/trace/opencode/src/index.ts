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
import { parseSg2044HardwareProfile } from "../../workflows/hardware-profile";
import { parsePerfDataValidationReportV1 } from "../../workflows/perf-data-validation-report";
import {
  startTraceWorkflow,
  type TraceTransition,
  transitionTraceWorkflow,
} from "../../workflows/trace-workflow";

const DEFAULT_ARTIFACT_ROOT = ".opencode/yuansheng/blueprint";
const REPORT_FILENAME = "perf-data-validation-report-v1.json";
const REPORT_PATH_SEGMENTS = ["yuansheng-kit", "ys-trace", "reports"] as const;
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

export const YuanshengTracePlugin: Plugin = async () => {
  const sessions = new Map<string, Map<string, RunRecord>>();
  const activeRunIds = new Set<string>();

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

  return {
    async dispose() {
      const runs = [...sessions.values()].flatMap((sessionRuns) => [...sessionRuns.values()]);
      sessions.clear();
      activeRunIds.clear();
      await Promise.all(runs.map((run) => cleanupReport(run)));
    },
    tool: {
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
          "Resolve Yuansheng Trace paths, discover the installed validator, and start an in-memory trace run without executing the validator.",
        args: {
          artifact_root: tool.schema.string().optional(),
          perf_data_root: tool.schema.string(),
          software: tool.schema.string(),
        },
        async execute({ artifact_root, perf_data_root, software }, context) {
          const projectRoot = requireProjectRoot(context.worktree, context.directory);
          const resolvedArtifactRoot = resolveArtifactRoot(projectRoot, artifact_root);
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
