import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, parse as parsePath, resolve } from "node:path";

import {
  assertApprovedSshTransportState,
  SSH_REMOTE_SCRIPT,
  SSH_REMOTE_SCRIPT_SHA256,
  type SshTransportState,
} from "../../transport/ssh-transport";

const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
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

type TerminationReason = "operation_cancelled" | "operation_timeout" | "output_invalid";

function fail(code: OpenSshRuntimeErrorCode, message: string): never {
  throw new OpenSshRuntimeError(code, message);
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
    const pathBefore = await lstat(path, { bigint: true });
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = await handle.stat({ bigint: true });
    const executeBits = BigInt(constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH);
    const effectiveUid = BigInt(process.geteuid?.() ?? -1);
    if (
      pathBefore.isSymbolicLink() ||
      !pathBefore.isFile() ||
      !openedBefore.isFile() ||
      !sameExecutableIdentity(pathBefore, openedBefore) ||
      (effectiveUid !== 0n && openedBefore.uid === effectiveUid) ||
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
    if (effectiveUid !== 0n) {
      let writable = true;
      try {
        await access(executableDescriptor, constants.W_OK);
      } catch {
        writable = false;
      }
      if (writable) {
        fail("executable_unavailable", `The system ${name} executable is user-writable`);
      }
    }
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
): Promise<BoundedReadResult> {
  const chunks: Uint8Array[] = [];
  let exceeded = false;
  let length = 0;
  const reader = stream.getReader();
  const stopReading = () => {
    void reader.cancel().catch(() => undefined);
  };
  if (stopSignal.aborted) {
    stopReading();
  } else {
    stopSignal.addEventListener("abort", stopReading, { once: true });
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
      if (exceeded) {
        continue;
      }
      const remaining = maximumBytes - length;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          length += remaining;
        }
        exceeded = true;
        onExceeded();
        break;
      }
      chunks.push(chunk);
      length += chunk.byteLength;
    }
  } finally {
    stopSignal.removeEventListener("abort", stopReading);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}

function spawnOpenSsh(command: OpenSshCommand, executionPath: string) {
  try {
    return Bun.spawn({
      cmd: [executionPath, ...command.argv],
      env: process.env,
      killSignal: "SIGKILL",
      stderr: "pipe",
      stdin: new TextEncoder().encode(command.script),
      stdout: "pipe",
    });
  } catch {
    fail("operation_failed", "The OpenSSH process could not be started");
  }
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
    try {
      child.kill("SIGKILL");
    } catch {
      // The direct child may already have exited. The terminal reason still wins.
    }
    resolveTermination?.(reason);
  };
  const abortOperation = () => terminate("operation_cancelled");
  signal.addEventListener("abort", abortOperation, { once: true });
  const timeout = setTimeout(() => {
    terminate("operation_timeout");
  }, command.timeoutMilliseconds);
  const killForOutputLimit = () => terminate("output_invalid");
  const completion = Promise.all([
    child.exited,
    readBoundedStream(
      child.stderr,
      MAX_DIAGNOSTIC_BYTES,
      killForOutputLimit,
      stopController.signal,
    ),
    readBoundedStream(
      child.stdout,
      command.maximumStdoutBytes,
      killForOutputLimit,
      stopController.signal,
    ),
  ]);
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
  if (outcome.type === "terminated") {
    void completion.catch(() => undefined);
    if (outcome.reason === "operation_cancelled") {
      fail("operation_cancelled", "The OpenSSH operation was cancelled");
    }
    if (outcome.reason === "operation_timeout") {
      fail("operation_timeout", "The OpenSSH operation exceeded the approved timeout");
    }
    fail("output_invalid", "The OpenSSH operation exceeded an approved output limit");
  }
  if (outcome.type === "failed") {
    fail("operation_failed", "The OpenSSH operation could not be completed");
  }
  const [exitCode, stderr, stdout] = outcome.result;
  if (stderr.exceeded || stdout.exceeded) {
    fail("output_invalid", "The OpenSSH operation exceeded an approved output limit");
  }
  if (exitCode !== 0) {
    const diagnostic = boundedDiagnostic(stderr.bytes);
    const suffix = diagnostic.length === 0 ? "" : `: ${diagnostic}`;
    fail("operation_failed", `The OpenSSH operation failed with exit code ${exitCode}${suffix}`);
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
