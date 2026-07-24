import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";
import type {
  BinaryGitCommandResult,
  BinaryGitRunner,
} from "../../workflows/building/candidate-capture";
import type { GitCommandResult, GitRunner } from "../../workflows/repository-preflight/preflight";
import {
  type ParsedCraftRuntimeConfig,
  parseCraftRuntimeConfigBytes,
} from "../../workflows/runtime-config/config";
import type {
  LocalProcessResult,
  LocalProcessRunner,
  VerificationLogSink,
} from "../../workflows/verification/local-verification";

const CONFIG_RELATIVE_PATH = ".opencode/yuansheng/craft.json";
const STATE_RELATIVE_PATH = ".opencode/yuansheng/workflow";
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const READ_ONLY_NOFOLLOW = constants.O_NOFOLLOW | constants.O_RDONLY;

export interface OpenCodeCraftController {
  readonly configDocument: ParsedCraftRuntimeConfig;
  readonly configPath: string;
  readonly controllerRoot: string;
  readonly stateRootPath: string;
}

function requireInjectedControllerRoot(worktree: string, directory: string): string {
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

function sameIdentity(
  before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  after: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.mtimeMs === after.mtimeMs &&
    before.size === after.size
  );
}

async function readBoundConfig(configPath: string): Promise<Uint8Array> {
  const parentPath = dirname(configPath);
  const parentRealpath = await realpath(parentPath).catch(() => {
    throw new TypeError(`Yuansheng Craft config parent does not exist: ${parentPath}`);
  });
  if (parentRealpath !== parentPath) {
    throw new TypeError("Yuansheng Craft config path must not traverse a symlink");
  }
  const parentStats = await lstat(parentPath);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new TypeError("Yuansheng Craft config parent must be a non-symlink directory");
  }
  const handle = await open(configPath, READ_ONLY_NOFOLLOW).catch((error: unknown) => {
    throw new TypeError(
      `Yuansheng Craft config is required at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_CONFIG_BYTES) {
      throw new TypeError("Yuansheng Craft config must be a non-empty regular file up to 1 MiB");
    }
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat();
    if (!sameIdentity(before, after) || bytes.byteLength !== after.size) {
      throw new TypeError("Yuansheng Craft config changed while it was being read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function loadOpenCodeCraftController(input: {
  readonly directory: string;
  readonly worktree: string;
}): Promise<OpenCodeCraftController> {
  const injectedRoot = requireInjectedControllerRoot(input.worktree, input.directory);
  const controllerRoot = await realpath(injectedRoot).catch(() => {
    throw new TypeError("OpenCode controller root does not exist");
  });
  if (controllerRoot !== injectedRoot) {
    throw new TypeError("OpenCode controller root must be supplied as its canonical realpath");
  }
  const rootStats = await lstat(controllerRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new TypeError("OpenCode controller root must be a non-symlink directory");
  }
  const configPath = join(controllerRoot, CONFIG_RELATIVE_PATH);
  return Object.freeze({
    configDocument: parseCraftRuntimeConfigBytes(await readBoundConfig(configPath)),
    configPath,
    controllerRoot,
    stateRootPath: join(controllerRoot, STATE_RELATIVE_PATH),
  });
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  abort: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) {
        break;
      }
      length += item.value.byteLength;
      if (length > limit) {
        abort();
        throw new Error("Git command output exceeded the 4 MiB limit");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readLimitedBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  abort: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) {
        break;
      }
      length += item.value.byteLength;
      if (length > limit) {
        abort();
        throw new Error("Git command output exceeded the 4 MiB limit");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createOpenCodeGitRunner(controllerRoot: string): GitRunner {
  return Object.freeze({
    async run(argv: readonly string[], timeoutMs: number): Promise<GitCommandResult> {
      if (
        argv.length === 0 ||
        argv[0] !== "git" ||
        argv.some((argument) => argument.length === 0 || argument.includes("\0"))
      ) {
        throw new TypeError("Yuansheng Craft Git runner accepts only explicit git argv");
      }
      const child = Bun.spawn([...argv], {
        cwd: controllerRoot,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      try {
        const abort = () => child.kill();
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          readLimited(child.stdout, MAX_GIT_OUTPUT_BYTES, abort),
          readLimited(child.stderr, MAX_GIT_OUTPUT_BYTES, abort),
        ]);
        return Object.freeze({
          exitCode: timedOut ? 124 : exitCode,
          stderr: timedOut
            ? `${stderr}\nGit command timed out after ${timeoutMs} ms`.trim()
            : stderr,
          stdout,
        });
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) {
          child.kill();
        }
      }
    },
  });
}

export function createOpenCodeBinaryGitRunner(): BinaryGitRunner {
  return Object.freeze({
    async run(
      argv: readonly string[],
      cwd: string,
      timeoutMs: number,
    ): Promise<BinaryGitCommandResult> {
      if (
        !isAbsolute(cwd) ||
        argv.length === 0 ||
        argv[0] !== "git" ||
        argv.some((argument) => argument.length === 0 || argument.includes("\0"))
      ) {
        throw new TypeError("Yuansheng Craft binary Git runner requires explicit cwd and argv");
      }
      const child = Bun.spawn([...argv], {
        cwd,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      try {
        const abort = () => child.kill();
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          readLimitedBytes(child.stdout, MAX_GIT_OUTPUT_BYTES, abort),
          readLimitedBytes(child.stderr, MAX_GIT_OUTPUT_BYTES, abort),
        ]);
        if (!timedOut) {
          return Object.freeze({ exitCode, stderr, stdout });
        }
        const timeoutMessage = new TextEncoder().encode(
          `Git command timed out after ${timeoutMs} ms`,
        );
        const timeoutStderr = new Uint8Array(stderr.byteLength + timeoutMessage.byteLength);
        timeoutStderr.set(stderr);
        timeoutStderr.set(timeoutMessage, stderr.byteLength);
        return Object.freeze({
          exitCode: 124,
          stderr: timeoutStderr,
          stdout,
        });
      } finally {
        clearTimeout(timer);
        if (child.exitCode === null) {
          child.kill();
        }
      }
    },
  });
}

export function createOpenCodeLocalProcessRunner(): LocalProcessRunner {
  return Object.freeze({
    async run(input: Parameters<LocalProcessRunner["run"]>[0]): Promise<LocalProcessResult> {
      try {
        const child = Bun.spawn([...input.argv], {
          cwd: input.cwdRealpath,
          env: { ...input.environment },
          stderr: "pipe",
          stdin: "ignore",
          stdout: "pipe",
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, input.timeoutMs);
        try {
          const abort = () => child.kill();
          let collected: readonly [number, Uint8Array, Uint8Array] | undefined;
          try {
            collected = await Promise.all([
              child.exited,
              readLimitedBytes(child.stdout, MAX_GIT_OUTPUT_BYTES, abort),
              readLimitedBytes(child.stderr, MAX_GIT_OUTPUT_BYTES, abort),
            ]);
          } catch {
            return {
              error: timedOut ? "timeout" : "spawn_failure",
              kind: "infra_error",
              stderr: new Uint8Array(),
              stdout: new Uint8Array(),
            };
          }
          const [exitCode, stdout, stderr] = collected;
          if (timedOut) {
            return {
              error: "timeout",
              kind: "infra_error",
              stderr,
              stdout,
            };
          }
          if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
            return {
              error: "spawn_failure",
              kind: "infra_error",
              stderr,
              stdout,
            };
          }
          return {
            exitCode,
            kind: "exited",
            outputArtifactDigests: [],
            stderr,
            stdout,
          };
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null) {
            child.kill();
          }
        }
      } catch {
        return {
          error: "spawn_failure",
          kind: "infra_error",
          stderr: new Uint8Array(),
          stdout: new Uint8Array(),
        };
      }
    },
  });
}

export function createOpenCodeVerificationLogSink(): VerificationLogSink {
  return Object.freeze({
    async write(input: Parameters<VerificationLogSink["write"]>[0]): Promise<void> {
      const parentPath = dirname(input.logRealpath);
      const parentRealpath = await realpath(parentPath);
      const parentStats = await lstat(parentPath);
      if (
        parentRealpath !== parentPath ||
        parentStats.isSymbolicLink() ||
        !parentStats.isDirectory()
      ) {
        throw new TypeError("Verification log parent must be a canonical non-symlink directory");
      }
      const handle = await open(
        input.logRealpath,
        constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(input.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  });
}
