import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";

import {
  assertApprovedSshTransportState,
  SSH_REMOTE_SCRIPT,
  SSH_REMOTE_SCRIPT_SHA256,
  type SshRemoteCleanupLeaseV1,
  type SshTransportState,
  validateSshRemoteCleanupLease,
} from "../../transport/ssh-transport";
import { type LocalSshSnapshotHandle, validatedLocalSshObjectsCwd } from "./local-ssh-snapshot";

const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024;
const PROCESS_REAP_TIMEOUT_MILLISECONDS = 2_000;
const READ_CHUNK_BYTES = 64 * 1024;
const SAFE_OBJECT_ID = /^f[0-9]{8}$/u;
const CONFIRMED_INVENTORY_PLACEHOLDER = "YS_TRACE_CONFIRMED_INVENTORY_SHA256";
const OWNER_MARKER_PLACEHOLDER = "YS_TRACE_OWNER_MARKER_SHA256";
const REMOTE_TEMP_PLACEHOLDER = "YS_TRACE_REMOTE_TEMP_BASE64";
const SSH_EXECUTABLE_PLACEHOLDER = "YS_TRACE_SSH_EXECUTABLE";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: false });

export type OpenSshRuntimeErrorCode =
  | "executable_unavailable"
  | "operation_cancelled"
  | "operation_failed"
  | "operation_timeout"
  | "output_invalid";

export class OpenSshRuntimeError extends Error {
  constructor(
    readonly code: OpenSshRuntimeErrorCode,
    message: string,
    readonly stdout?: Uint8Array,
    readonly cleanupSafe = true,
  ) {
    super(message);
    this.name = "OpenSshRuntimeError";
  }
}

export interface OpenSshExecutables {
  readonly sftp: OpenSshExecutable;
  readonly ssh: OpenSshExecutable;
}

export interface OpenSshExecutable {
  readonly path: string;
  readonly sha256: string;
}

export interface OpenSshCommand {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly executable: string;
  readonly maximumStdoutBytes: number;
  readonly script: string;
  readonly timeoutMilliseconds: number;
}

export interface OpenSshCommandResult {
  readonly stdout: Uint8Array;
}

type ApprovedSshOperation = "inventory" | "inventory_cleanup" | "probe";

interface BoundedReadResult {
  readonly bytes: Uint8Array;
  readonly exceeded: boolean;
}

interface BoundedReadState {
  readonly chunks: Uint8Array[];
  exceeded: boolean;
  length: number;
}

type TerminationReason = "operation_cancelled" | "operation_timeout" | "output_invalid";

function fail(code: OpenSshRuntimeErrorCode, message: string): never {
  throw new OpenSshRuntimeError(code, message);
}

function replaceExactArgument(
  argv: readonly string[],
  placeholder: string,
  value: string,
): readonly string[] {
  let replacements = 0;
  const replaced = argv.map((argument) => {
    if (argument !== placeholder) {
      return argument;
    }
    replacements += 1;
    return value;
  });
  if (replacements !== 1 || replaced.some((argument) => argument === placeholder)) {
    fail("operation_failed", "The approved OpenSSH command placeholder is invalid");
  }
  return replaced;
}

function boundedDiagnostic(bytes: Uint8Array): string {
  const bounded = bytes.subarray(0, MAX_DIAGNOSTIC_BYTES);
  return [...UTF8_DECODER.decode(bounded)]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (codePoint <= 0x1f &&
        character !== "\t" &&
        character !== "\n" &&
        character !== "\r") ||
        codePoint === 0x7f
        ? "?"
        : character;
    })
    .join("")
    .trim();
}

function snapshotBoundedRead(state: BoundedReadState): BoundedReadResult {
  const bytes = new Uint8Array(state.length);
  let offset = 0;
  for (const chunk of state.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded: state.exceeded };
}

function openSshEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value === undefined ||
      name.startsWith("LD_") ||
      name.startsWith("DYLD_") ||
      name === "BASH_ENV" ||
      name === "ENV" ||
      name === "SSH_ASKPASS" ||
      name === "SSH_ASKPASS_REQUIRE"
    ) {
      continue;
    }
    environment[name] = value;
  }
  environment.LC_ALL = "C";
  return environment;
}

function sameExecutableIdentity(
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function descriptorPath(handle: FileHandle): string {
  return join(parsePath(process.execPath).root, "proc", "self", "fd", String(handle.fd));
}

function controllerDescriptorPath(handle: FileHandle): string {
  return join(
    parsePath(process.execPath).root,
    "proc",
    String(process.pid),
    "fd",
    String(handle.fd),
  );
}

async function assertTrustedExecutablePath(path: string, name: "sftp" | "ssh"): Promise<void> {
  const effectiveUid = BigInt(process.geteuid?.() ?? -1);
  let current = dirname(path);
  while (true) {
    const status = await lstat(current, { bigint: true });
    const stickyProtected = (status.mode & 0o1000n) !== 0n && status.uid !== effectiveUid;
    const writableByCurrentOwner = status.uid === effectiveUid && (status.mode & 0o200n) !== 0n;
    const writableByGroupOrOther = (status.mode & 0o022n) !== 0n;
    if (
      status.isSymbolicLink() ||
      !status.isDirectory() ||
      ((writableByCurrentOwner || writableByGroupOrOther) && !stickyProtected)
    ) {
      fail(
        "executable_unavailable",
        `The system ${name} executable has an untrusted parent directory`,
      );
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

async function hashExecutable(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = new Uint8Array(Math.min(READ_CHUNK_BYTES, Math.max(1, size)));
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.byteLength, size - offset);
    const result = await handle.read(buffer, 0, length, offset);
    if (result.bytesRead === 0) {
      fail("executable_unavailable", "An OpenSSH executable changed while it was inspected");
    }
    hash.update(buffer.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  const extra = new Uint8Array(1);
  if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) {
    fail("executable_unavailable", "An OpenSSH executable changed while it was inspected");
  }
  return hash.digest("hex");
}

async function openStableExecutable(
  path: string,
  name: "sftp" | "ssh",
  expectedSha256?: string,
): Promise<Readonly<{ handle: FileHandle; sha256: string }>> {
  let handle: FileHandle | undefined;
  try {
    if (!isAbsolute(path) || resolve(await realpath(path)) !== path) {
      fail("executable_unavailable", `The system ${name} executable path is not canonical`);
    }
    await assertTrustedExecutablePath(path, name);
    const pathBefore = await lstat(path, { bigint: true });
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = await handle.stat({ bigint: true });
    const executeBits = BigInt(constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH);
    const nixStoreRoot = join(parsePath(path).root, "nix", "store");
    if (
      pathBefore.isSymbolicLink() ||
      !pathBefore.isFile() ||
      !openedBefore.isFile() ||
      !sameExecutableIdentity(pathBefore, openedBefore) ||
      (openedBefore.uid !== 0n &&
        !(openedBefore.uid === 65_534n && path.startsWith(`${nixStoreRoot}/`))) ||
      (openedBefore.mode & 0o022n) !== 0n ||
      (openedBefore.mode & executeBits) === 0n ||
      openedBefore.size <= 0n ||
      openedBefore.size > BigInt(MAX_EXECUTABLE_BYTES)
    ) {
      fail(
        "executable_unavailable",
        `The system ${name} executable is not a stable system executable`,
      );
    }
    const executableDescriptor = descriptorPath(handle);
    await access(executableDescriptor, constants.X_OK);
    const sha256 = await hashExecutable(handle, Number(openedBefore.size));
    const [openedAfter, pathAfter, canonicalAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      resolve(canonicalAfter) !== path ||
      !sameExecutableIdentity(openedBefore, openedAfter) ||
      !sameExecutableIdentity(openedBefore, pathAfter) ||
      (expectedSha256 !== undefined && sha256 !== expectedSha256)
    ) {
      fail("executable_unavailable", `The system ${name} executable changed after approval`);
    }
    return { handle, sha256 };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof OpenSshRuntimeError) {
      throw error;
    }
    return fail("executable_unavailable", `The system ${name} executable cannot be inspected`);
  }
}

async function discoverExecutable(name: "sftp" | "ssh"): Promise<OpenSshExecutable> {
  const located = Bun.which(name);
  if (located === null || !isAbsolute(located)) {
    fail("executable_unavailable", `The system ${name} executable is unavailable`);
  }
  let inspected: Awaited<ReturnType<typeof openStableExecutable>> | undefined;
  try {
    const canonical = resolve(await realpath(located));
    if (parsePath(canonical).root === canonical) {
      fail("executable_unavailable", `The system ${name} executable path is invalid`);
    }
    inspected = await openStableExecutable(canonical, name);
    return { path: canonical, sha256: inspected.sha256 };
  } catch (error) {
    if (error instanceof OpenSshRuntimeError) {
      throw error;
    }
    return fail("executable_unavailable", `The system ${name} executable cannot be inspected`);
  } finally {
    await inspected?.handle.close().catch(() => undefined);
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onExceeded: () => void,
  stopSignal: AbortSignal,
  state: BoundedReadState,
): Promise<BoundedReadResult> {
  const reader = stream.getReader();
  const stopReading = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (stopSignal.aborted) {
    stopReading();
  } else {
    stopSignal.addEventListener("abort", stopReading, { once: true });
    if (stopSignal.aborted) {
      stopReading();
    }
  }
  try {
    while (!stopSignal.aborted) {
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (error) {
        if (stopSignal.aborted) {
          break;
        }
        throw error;
      }
      if (result.done) {
        break;
      }
      const chunk = result.value;
      if (state.exceeded) {
        continue;
      }
      const remaining = maximumBytes - state.length;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          state.chunks.push(chunk.subarray(0, remaining));
          state.length += remaining;
        }
        state.exceeded = true;
        onExceeded();
        break;
      }
      state.chunks.push(chunk);
      state.length += chunk.byteLength;
    }
  } finally {
    stopSignal.removeEventListener("abort", stopReading);
    reader.releaseLock();
  }
  return snapshotBoundedRead(state);
}

function spawnOpenSsh(command: OpenSshCommand, executionPath: string) {
  try {
    return Bun.spawn({
      cmd: [executionPath, ...command.argv],
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      detached: true,
      env: openSshEnvironment(),
      killSignal: "SIGKILL",
      stderr: "pipe",
      stdin: new TextEncoder().encode(command.script),
      stdout: "pipe",
    });
  } catch {
    fail("operation_failed", "The OpenSSH process could not be started");
  }
}

function killOpenSshProcessGroup(child: ReturnType<typeof spawnOpenSsh>): void {
  try {
    if (child.pid > 0) {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    // The group may already have exited. Fall back to the direct child below.
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The direct child may already have exited.
  }
}

async function waitForProcessSettlement(settlement: Promise<unknown>): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settlement.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), PROCESS_REAP_TIMEOUT_MILLISECONDS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function processGroupExists(processGroupId: number): boolean {
  if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
    return true;
  }
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (
      typeof error !== "object" || error === null || !("code" in error) || error.code !== "ESRCH"
    );
  }
}

async function waitForProcessGroupSettlement(
  child: ReturnType<typeof spawnOpenSsh>,
  childExit: Promise<number>,
): Promise<boolean> {
  if (!(await waitForProcessSettlement(childExit))) {
    return false;
  }
  const deadline = Date.now() + PROCESS_REAP_TIMEOUT_MILLISECONDS;
  while (processGroupExists(child.pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 10);
    });
  }
  return true;
}

export async function discoverOpenSshExecutables(): Promise<OpenSshExecutables> {
  const [sftp, ssh] = await Promise.all([discoverExecutable("sftp"), discoverExecutable("ssh")]);
  return { sftp, ssh };
}

async function runOpenSshCommandWithHandle(
  command: OpenSshCommand,
  executionPath: string,
  signal: AbortSignal,
): Promise<OpenSshCommandResult> {
  if (
    !isAbsolute(command.executable) ||
    command.argv.some((argument) => argument.includes("\0")) ||
    (command.cwd !== undefined &&
      (!isAbsolute(command.cwd) ||
        command.cwd.includes("\0") ||
        resolve(command.cwd) !== command.cwd)) ||
    !Number.isSafeInteger(command.maximumStdoutBytes) ||
    command.maximumStdoutBytes <= 0 ||
    !Number.isSafeInteger(command.timeoutMilliseconds) ||
    command.timeoutMilliseconds <= 0
  ) {
    fail("operation_failed", "The OpenSSH command definition is invalid");
  }
  if (signal.aborted) {
    fail("operation_cancelled", "The OpenSSH operation was cancelled before it started");
  }
  const child = spawnOpenSsh(command, executionPath);
  const stopController = new AbortController();
  let resolveTermination: ((reason: TerminationReason) => void) | undefined;
  const terminated = new Promise<TerminationReason>((resolveTerminationPromise) => {
    resolveTermination = resolveTerminationPromise;
  });
  let terminationReason: TerminationReason | undefined;
  const terminate = (reason: TerminationReason): void => {
    if (terminationReason !== undefined) {
      return;
    }
    terminationReason = reason;
    stopController.abort();
    killOpenSshProcessGroup(child);
    resolveTermination?.(reason);
  };
  const abortOperation = () => terminate("operation_cancelled");
  signal.addEventListener("abort", abortOperation, { once: true });
  if (signal.aborted) {
    abortOperation();
  }
  const timeout = setTimeout(() => {
    terminate("operation_timeout");
  }, command.timeoutMilliseconds);
  const killForOutputLimit = () => terminate("output_invalid");
  const stderrState: BoundedReadState = { chunks: [], exceeded: false, length: 0 };
  const stdoutState: BoundedReadState = { chunks: [], exceeded: false, length: 0 };
  const childExit = child.exited;
  const stderrRead = readBoundedStream(
    child.stderr,
    MAX_DIAGNOSTIC_BYTES,
    killForOutputLimit,
    stopController.signal,
    stderrState,
  );
  const stdoutRead = readBoundedStream(
    child.stdout,
    command.maximumStdoutBytes,
    killForOutputLimit,
    stopController.signal,
    stdoutState,
  );
  const completion = Promise.all([childExit, stderrRead, stdoutRead]);
  const streamSettlement = Promise.allSettled([stderrRead, stdoutRead]);
  type Completion =
    | Readonly<{
        result: readonly [number, BoundedReadResult, BoundedReadResult];
        type: "completed";
      }>
    | Readonly<{ error: unknown; type: "failed" }>
    | Readonly<{ reason: TerminationReason; type: "terminated" }>;
  let outcome: Completion;
  try {
    outcome = await Promise.race<Completion>([
      completion.then(
        (result) => ({ result, type: "completed" as const }),
        (error: unknown) => ({ error, type: "failed" as const }),
      ),
      terminated.then((reason) => ({ reason, type: "terminated" as const })),
    ]);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortOperation);
  }
  if (terminationReason !== undefined && outcome.type !== "terminated") {
    outcome = { reason: terminationReason, type: "terminated" };
  }
  if (outcome.type === "terminated") {
    const processSettled = await waitForProcessGroupSettlement(child, childExit);
    await waitForProcessSettlement(streamSettlement);
    const partialStdout = snapshotBoundedRead(stdoutState).bytes;
    if (!processSettled) {
      throw new OpenSshRuntimeError(
        outcome.reason,
        "The terminated OpenSSH process group could not be reaped safely",
        partialStdout,
        false,
      );
    }
    if (outcome.reason === "operation_cancelled") {
      throw new OpenSshRuntimeError(
        "operation_cancelled",
        "The OpenSSH operation was cancelled",
        partialStdout,
      );
    }
    if (outcome.reason === "operation_timeout") {
      throw new OpenSshRuntimeError(
        "operation_timeout",
        "The OpenSSH operation exceeded the approved timeout",
        partialStdout,
      );
    }
    throw new OpenSshRuntimeError(
      "output_invalid",
      "The OpenSSH operation exceeded an approved output limit",
      partialStdout,
    );
  }
  if (outcome.type === "failed") {
    stopController.abort();
    killOpenSshProcessGroup(child);
    const processSettled = await waitForProcessGroupSettlement(child, childExit);
    await waitForProcessSettlement(streamSettlement);
    throw new OpenSshRuntimeError(
      "operation_failed",
      "The OpenSSH operation could not be completed",
      snapshotBoundedRead(stdoutState).bytes,
      processSettled,
    );
  }
  const [exitCode, stderr, stdout] = outcome.result;
  const processSettled = await waitForProcessGroupSettlement(child, childExit);
  if (!processSettled) {
    killOpenSshProcessGroup(child);
    throw new OpenSshRuntimeError(
      "operation_failed",
      "The OpenSSH process group did not terminate after the command completed",
      stdout.bytes,
      false,
    );
  }
  if (stderr.exceeded || stdout.exceeded) {
    throw new OpenSshRuntimeError(
      "output_invalid",
      "The OpenSSH operation exceeded an approved output limit",
      stdout.bytes,
    );
  }
  if (exitCode !== 0) {
    const diagnostic = boundedDiagnostic(stderr.bytes);
    const suffix = diagnostic.length === 0 ? "" : `: ${diagnostic}`;
    throw new OpenSshRuntimeError(
      "operation_failed",
      `The OpenSSH operation failed with exit code ${exitCode}${suffix}`,
      stdout.bytes,
    );
  }
  return { stdout: stdout.bytes };
}

async function runOpenSshCommand(
  command: OpenSshCommand,
  expected: Readonly<{ name: "sftp" | "ssh"; sha256: string }>,
  signal: AbortSignal,
): Promise<OpenSshCommandResult> {
  if (!/^[0-9a-f]{64}$/u.test(expected.sha256)) {
    fail("operation_failed", "The approved OpenSSH executable digest is invalid");
  }
  const inspected = await openStableExecutable(command.executable, expected.name, expected.sha256);
  try {
    return await runOpenSshCommandWithHandle(command, descriptorPath(inspected.handle), signal);
  } finally {
    await inspected.handle.close().catch(() => undefined);
  }
}

export async function runApprovedSshOperation(
  state: SshTransportState,
  operation: ApprovedSshOperation,
  signal: AbortSignal,
): Promise<OpenSshCommandResult> {
  assertApprovedSshTransportState(state);
  if (state.phase !== "awaiting_inventory") {
    fail("operation_failed", "The SSH operation is not valid in the current transport phase");
  }
  return runApprovedFixedSshOperation(state, operation, signal);
}

async function runApprovedFixedSshOperation(
  state: SshTransportState,
  operation: ApprovedSshOperation,
  signal: AbortSignal,
): Promise<OpenSshCommandResult> {
  const command = state.plan.plan.commands[operation];
  const [executable, ...argv] = command.argv;
  if (
    executable !== state.plan.plan.executables.ssh ||
    command.operation !== operation ||
    command.stdin_sha256 !== SSH_REMOTE_SCRIPT_SHA256 ||
    argv.some((argument) => argument.startsWith("YS_TRACE_") && argument.endsWith("SHA256"))
  ) {
    fail("operation_failed", "The approved SSH command does not match the fixed transport plan");
  }
  return runOpenSshCommand(
    {
      argv,
      executable,
      maximumStdoutBytes: command.maximum_stdout_bytes,
      script: SSH_REMOTE_SCRIPT,
      timeoutMilliseconds: state.plan.plan.limits.command_timeout_milliseconds,
    },
    { name: "ssh", sha256: state.plan.plan.executable_sha256.ssh },
    signal,
  );
}

export async function runApprovedSshPostInventory(
  state: SshTransportState,
  signal: AbortSignal,
): Promise<OpenSshCommandResult> {
  assertApprovedSshTransportState(state);
  if (state.phase !== "downloading") {
    fail("operation_failed", "The post-transfer inventory is not valid in the current phase");
  }
  return runApprovedFixedSshOperation(state, "inventory", signal);
}

export async function runApprovedSshPostInventoryCleanup(
  state: SshTransportState,
  signal: AbortSignal,
): Promise<OpenSshCommandResult> {
  assertApprovedSshTransportState(state);
  const failedWithInventoryResidual =
    state.phase === "failed" &&
    state.cleanup.residual_paths.includes(state.plan.plan.remote_inventory_temp);
  const activeTransferPhase =
    state.phase === "transferring" ||
    state.phase === "cleanup_pending" ||
    state.phase === "downloading";
  if (!activeTransferPhase && !failedWithInventoryResidual) {
    fail(
      "operation_failed",
      "The post-transfer inventory cleanup is not valid in the current phase",
    );
  }
  return runApprovedFixedSshOperation(state, "inventory_cleanup", signal);
}

export async function runApprovedSshStage(
  state: SshTransportState,
  signal: AbortSignal,
): Promise<OpenSshCommandResult> {
  assertApprovedSshTransportState(state);
  if (state.phase !== "transferring") {
    fail("operation_failed", "The SSH stage operation is not valid in the current phase");
  }
  const command = state.plan.plan.commands.stage;
  const [executable, ...plannedArgv] = command.argv;
  const argv = replaceExactArgument(
    plannedArgv,
    CONFIRMED_INVENTORY_PLACEHOLDER,
    state.inventory.inventory_sha256,
  );
  if (
    executable !== state.plan.plan.executables.ssh ||
    command.operation !== "stage" ||
    command.stdin_sha256 !== SSH_REMOTE_SCRIPT_SHA256 ||
    argv.some((argument) => argument.startsWith("YS_TRACE_"))
  ) {
    fail("operation_failed", "The approved SSH stage command is invalid");
  }
  return runOpenSshCommand(
    {
      argv,
      executable,
      maximumStdoutBytes: command.maximum_stdout_bytes,
      script: SSH_REMOTE_SCRIPT,
      timeoutMilliseconds: state.plan.plan.limits.command_timeout_milliseconds,
    },
    { name: "ssh", sha256: state.plan.plan.executable_sha256.ssh },
    signal,
  );
}

export async function runApprovedSftpDownload(
  state: SshTransportState,
  localSnapshot: LocalSshSnapshotHandle,
  signal: AbortSignal,
): Promise<OpenSshCommandResult> {
  assertApprovedSshTransportState(state);
  if (state.phase !== "downloading") {
    fail("operation_failed", "The SFTP operation is not valid in the current transport phase");
  }
  const localObjectsCwd = await validatedLocalSshObjectsCwd(localSnapshot, state, signal);
  const remoteObjectsRoot = `${state.cleanup_lease.remote_temp}/objects`;
  if (!/^\/tmp\/yuansheng-ys-trace-[0-9a-f]{32}\/objects$/u.test(remoteObjectsRoot)) {
    fail("operation_failed", "The SFTP source is not a run-bound remote objects root");
  }
  const objectIds = state.stage.stage.objects.map((object) => object.object_id);
  if (
    objectIds.length !== state.inventory.inventory.files ||
    objectIds.some(
      (objectId, index) =>
        !SAFE_OBJECT_ID.test(objectId) || objectId !== `f${String(index + 1).padStart(8, "0")}`,
    )
  ) {
    fail("operation_failed", "The staged SFTP object list is invalid");
  }
  if (objectIds.length === 0) {
    return { stdout: new Uint8Array() };
  }
  const batch = `${objectIds
    .map((objectId) => `@get -f ${remoteObjectsRoot}/${objectId} ${objectId}`)
    .join("\n")}\nbye\n`;
  const [executable, ...plannedArgv] = state.plan.plan.sftp.argv_prefix;
  if (
    executable !== state.plan.plan.executables.sftp ||
    state.plan.plan.sftp.batch_protocol !== "safe-object-id-get-v1" ||
    plannedArgv.some((argument) => argument.includes("\0"))
  ) {
    fail("operation_failed", "The approved SFTP command is invalid");
  }
  const approvedSsh = await openStableExecutable(
    state.plan.plan.executables.ssh,
    "ssh",
    state.plan.plan.executable_sha256.ssh,
  );
  let approvedSftp: Awaited<ReturnType<typeof openStableExecutable>> | undefined;
  try {
    const argv = replaceExactArgument(
      plannedArgv,
      SSH_EXECUTABLE_PLACEHOLDER,
      controllerDescriptorPath(approvedSsh.handle),
    );
    if (argv.some((argument) => argument.startsWith("YS_TRACE_"))) {
      fail("operation_failed", "The approved SFTP command placeholder is invalid");
    }
    approvedSftp = await openStableExecutable(
      executable,
      "sftp",
      state.plan.plan.executable_sha256.sftp,
    );
    return await runOpenSshCommandWithHandle(
      {
        argv,
        cwd: localObjectsCwd,
        executable,
        maximumStdoutBytes: state.plan.plan.sftp.maximum_stdout_bytes,
        script: batch,
        timeoutMilliseconds: state.plan.plan.limits.command_timeout_milliseconds,
      },
      descriptorPath(approvedSftp.handle),
      signal,
    );
  } finally {
    await Promise.allSettled([approvedSftp?.handle.close(), approvedSsh.handle.close()]);
  }
}

function cleanupLeaseForState(state: SshTransportState): SshRemoteCleanupLeaseV1 {
  if (!("cleanup_lease" in state) || state.cleanup_lease === undefined) {
    fail("operation_failed", "The transport state has no remote cleanup lease");
  }
  return validateSshRemoteCleanupLease(state.cleanup_lease, state.plan);
}

export async function runApprovedSshCleanup(
  state: SshTransportState,
  signal: AbortSignal,
): Promise<OpenSshCommandResult> {
  assertApprovedSshTransportState(state);
  const cleanupLease = cleanupLeaseForState(state);
  const command = state.plan.plan.commands.cleanup;
  const [executable, ...plannedArgv] = command.argv;
  const withRemoteTemp = replaceExactArgument(
    plannedArgv,
    REMOTE_TEMP_PLACEHOLDER,
    cleanupLease.remote_temp_base64,
  );
  const argv = replaceExactArgument(
    withRemoteTemp,
    OWNER_MARKER_PLACEHOLDER,
    cleanupLease.owner_marker_sha256,
  );
  if (
    executable !== state.plan.plan.executables.ssh ||
    command.operation !== "cleanup" ||
    command.stdin_sha256 !== SSH_REMOTE_SCRIPT_SHA256 ||
    argv.some((argument) => argument.startsWith("YS_TRACE_"))
  ) {
    fail("operation_failed", "The approved SSH cleanup command is invalid");
  }
  return runOpenSshCommand(
    {
      argv,
      executable,
      maximumStdoutBytes: command.maximum_stdout_bytes,
      script: SSH_REMOTE_SCRIPT,
      timeoutMilliseconds: state.plan.plan.limits.command_timeout_milliseconds,
    },
    { name: "ssh", sha256: state.plan.plan.executable_sha256.ssh },
    signal,
  );
}
