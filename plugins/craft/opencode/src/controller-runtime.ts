import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse as parsePath, resolve } from "node:path";

import type { GitCommandResult, GitRunner } from "../../workflows/repository-preflight/preflight";
import {
  type ParsedCraftRuntimeConfig,
  parseCraftRuntimeConfigBytes,
} from "../../workflows/runtime-config/config";

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
