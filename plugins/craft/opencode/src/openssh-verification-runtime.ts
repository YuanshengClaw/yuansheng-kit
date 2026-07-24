import { lstat, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { DiffEntry } from "../../workflows/artifacts/generated";
import type { LocalProcessResult } from "../../workflows/verification/local-verification";
import type {
  SshCandidateObservation,
  SshPreflightResult,
  SshVerificationExecutor,
} from "../../workflows/verification/ssh-verification";

const MAX_OPENSSH_OUTPUT_BYTES = 16 * 1024 * 1024;
const SAFE_HOST_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_COMMIT = /^[0-9a-f]{40,64}$/u;
const SAFE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();

export const OPENSSH_REMOTE_CAPTURE_SCRIPT = String.raw`set -euo pipefail
export LC_ALL=C
remote_cwd=$1
baseline=$2
cd -- "$remote_cwd"
actual_cwd=$(pwd -P)
head_commit=$(git rev-parse --verify HEAD)
git_root=$(git rev-parse --show-toplevel)
identity="$(hostname):$(id -u):$(cd -- "$git_root" && pwd -P)"

b64_text() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

file_mode() {
  local permissions
  permissions=$(stat -c '%a' -- "$1")
  if (( (8#$permissions & 8#111) == 0 )); then
    printf '100644'
  else
    printf '100755'
  fi
}

baseline_mode() {
  local metadata
  metadata=$(git ls-tree "$baseline" -- "$1")
  case "$metadata" in
    100644\ blob\ *) printf '100644' ;;
    100755\ blob\ *) printf '100755' ;;
    *) return 1 ;;
  esac
}

baseline_digest() {
  git show "$baseline:$1" | sha256sum | awk '{print "sha256:" $1}'
}

current_digest() {
  sha256sum -- "$1" | awk '{print "sha256:" $1}'
}

is_binary_change() {
  local path=$1
  local output
  if output=$(git diff --numstat --no-renames HEAD -- "$path") &&
    [[ "$output" == -*$'\t'-*$'\t'* ]]; then
    return 0
  fi
  if output=$(git diff --no-index --numstat -- /dev/null "$path" 2>/dev/null) ||
    [[ $? -eq 1 ]]; then
    [[ "$output" == -*$'\t'-*$'\t'* ]]
    return
  fi
  return 1
}

declare -a statuses=()
declare -a paths=()
while IFS= read -r -d '' status && IFS= read -r -d '' path; do
  case "$status" in
    A|D|M|T) ;;
    *) exit 86 ;;
  esac
  statuses+=("$status")
  paths+=("$path")
done < <(git diff --name-status -z --no-renames --no-ext-diff --no-textconv HEAD -- .)
while IFS= read -r -d '' path; do
  statuses+=("A")
  paths+=("$path")
done < <(git ls-files --others --exclude-standard -z -- .)

printf 'YS_CRAFT_REMOTE_CAPTURE_V1\n'
printf 'C\t%s\n' "$(b64_text "$actual_cwd")"
printf 'H\t%s\n' "$head_commit"
printf 'I\t%s\n' "$(b64_text "$identity")"

for index in "__DOLLAR__{!paths[@]}"; do
  status=__DOLLAR__{statuses[$index]}
  path=__DOLLAR__{paths[$index]}
  [[ -n "$path" && "$path" != /* && "$path" != *$'\n'* && "$path" != *$'\r'* &&
    "$path" != *$'\t'* && "$path" != *\\* ]] || exit 87
  old_digest=-
  new_digest=-
  old_mode=-
  new_mode=-
  operation=modify
  case "$status" in
    A)
      operation=create
      [[ -f "$path" && ! -L "$path" ]] || exit 88
      new_digest=$(current_digest "$path")
      new_mode=$(file_mode "$path")
      ;;
    D)
      operation=delete
      old_digest=$(baseline_digest "$path")
      old_mode=$(baseline_mode "$path")
      ;;
    M|T)
      operation=modify
      [[ -f "$path" && ! -L "$path" ]] || exit 88
      old_digest=$(baseline_digest "$path")
      new_digest=$(current_digest "$path")
      old_mode=$(baseline_mode "$path")
      new_mode=$(file_mode "$path")
      ;;
  esac
  binary=0
  if is_binary_change "$path"; then
    binary=1
  fi
  printf 'E\t%s\t%s\t-\t%s\t%s\t%s\t%s\t%s\n' \
    "$operation" "$(b64_text "$path")" "$old_digest" "$new_digest" \
    "$old_mode" "$new_mode" "$binary"
done

printf 'P\t'
{
  git diff --binary --full-index --no-ext-diff --no-textconv --find-renames HEAD -- .
  while IFS= read -r -d '' path; do
    git diff --no-index --binary --full-index --no-ext-diff --no-textconv \
      -- /dev/null "$path" || [[ $? -eq 1 ]]
  done < <(git ls-files --others --exclude-standard -z -- .)
} | base64 | tr -d '\n'
printf '\nEND\n'`.replaceAll("__DOLLAR__", "$");

interface OpenSshResult {
  readonly exitCode: number;
  readonly stderr: Uint8Array;
  readonly stdout: Uint8Array;
  readonly timedOut: boolean;
}

function fail(message: string): never {
  throw new TypeError(`Invalid Yuansheng Craft OpenSSH operation: ${message}`);
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

function requireSafeArgument(value: string, label: string): string {
  if (value.length === 0 || value.includes("\0") || hasControl(value)) {
    return fail(`${label} contains an empty or control-bearing argument`);
  }
  return value;
}

export function quoteOpenSshPosixArgument(value: string): string {
  requireSafeArgument(value, "remote argv");
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function requireHostAlias(hostAlias: string): string {
  if (!SAFE_HOST_ALIAS.test(hostAlias)) {
    return fail("host alias is not a safe SSH config alias");
  }
  return hostAlias;
}

export function buildOpenSshVerificationArgv(input: {
  readonly argv: readonly [string, ...string[]];
  readonly hostAlias: string;
  readonly remoteCwd: string;
  readonly sshExecutable: string;
}): readonly string[] {
  const hostAlias = requireHostAlias(input.hostAlias);
  const remoteCwd = requireSafeArgument(input.remoteCwd, "remote cwd");
  const command = input.argv.map((argument) => quoteOpenSshPosixArgument(argument)).join(" ");
  return Object.freeze([
    input.sshExecutable,
    "--",
    hostAlias,
    `cd -- ${quoteOpenSshPosixArgument(remoteCwd)} && exec ${command}`,
  ]);
}

function openSshEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    LC_ALL: "C",
  };
  for (const name of ["HOME", "PATH", "SSH_AUTH_SOCK"] as const) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return Object.freeze(environment);
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
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
      if (length > MAX_OPENSSH_OUTPUT_BYTES) {
        abort();
        throw new Error("OpenSSH output exceeded its fixed bound");
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

async function spawnOpenSsh(input: {
  readonly argv: readonly string[];
  readonly stdin: Uint8Array | "ignore";
  readonly timeoutMs: number;
}): Promise<OpenSshResult> {
  const child = Bun.spawn([...input.argv], {
    env: { ...openSshEnvironment() },
    stderr: "pipe",
    stdin: input.stdin,
    stdout: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, input.timeoutMs);
  try {
    const abort = () => child.kill();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout, abort),
      readBounded(child.stderr, abort),
    ]);
    return Object.freeze({ exitCode, stderr, stdout, timedOut });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill();
    }
  }
}

function decodeBase64(value: string, label: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return fail(`${label} is not canonical base64`);
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function decodeTextBase64(value: string, label: string): string {
  try {
    return UTF8_DECODER.decode(decodeBase64(value, label));
  } catch {
    return fail(`${label} is not valid UTF-8`);
  }
}

function nullableDigest(value: string): `sha256:${string}` | null {
  if (value === "-") {
    return null;
  }
  if (!SAFE_DIGEST.test(value)) {
    return fail("remote capture returned an invalid blob digest");
  }
  return value as `sha256:${string}`;
}

function nullableMode(value: string): "100644" | "100755" | null {
  if (value === "-") {
    return null;
  }
  if (value !== "100644" && value !== "100755") {
    return fail("remote capture returned an invalid file mode");
  }
  return value;
}

function parseEntry(fields: readonly string[]): DiffEntry {
  if (fields.length !== 9 || fields[0] !== "E") {
    return fail("remote capture returned a malformed entry");
  }
  const operation = fields[1];
  if (
    operation !== "create" &&
    operation !== "delete" &&
    operation !== "modify" &&
    operation !== "rename"
  ) {
    return fail("remote capture returned an unsupported operation");
  }
  const sourcePath =
    fields[3] === "-" ? null : decodeTextBase64(fields[3] ?? "", "entry source path");
  return Object.freeze({
    binary: fields[8] === "1",
    new_blob_digest: nullableDigest(fields[5] ?? ""),
    new_mode: nullableMode(fields[7] ?? ""),
    old_blob_digest: nullableDigest(fields[4] ?? ""),
    old_mode: nullableMode(fields[6] ?? ""),
    operation,
    path: decodeTextBase64(fields[2] ?? "", "entry path"),
    source_path: sourcePath,
  });
}

function parseCapture(stdout: Uint8Array): SshCandidateObservation {
  let text: string;
  try {
    text = UTF8_DECODER.decode(stdout);
  } catch {
    return fail("remote capture output is not UTF-8");
  }
  const lines = text.split("\n");
  if (lines[0] !== "YS_CRAFT_REMOTE_CAPTURE_V1" || lines.at(-2) !== "END" || lines.at(-1) !== "") {
    return fail("remote capture protocol envelope is invalid");
  }
  const cwd = lines[1]?.split("\t");
  const head = lines[2]?.split("\t");
  const identity = lines[3]?.split("\t");
  const patch = lines.at(-3)?.split("\t");
  if (
    cwd?.length !== 2 ||
    cwd[0] !== "C" ||
    head?.length !== 2 ||
    head[0] !== "H" ||
    identity?.length !== 2 ||
    identity[0] !== "I" ||
    patch?.length !== 2 ||
    patch[0] !== "P" ||
    !SAFE_COMMIT.test(head[1] ?? "")
  ) {
    return fail("remote capture protocol headers are invalid");
  }
  const entries = lines.slice(4, -3).map((line) => parseEntry(line.split("\t")));
  return Object.freeze({
    binaryPatchBytes: decodeBase64(patch[1] ?? "", "binary patch"),
    entries: Object.freeze(entries),
    headCommit: head[1] ?? "",
    remoteCwdRealpath: decodeTextBase64(cwd[1] ?? "", "remote cwd"),
    remoteIdentity: decodeTextBase64(identity[1] ?? "", "remote identity"),
  });
}

export async function resolveSystemSshExecutable(): Promise<string> {
  const discovered = Bun.which("ssh");
  if (discovered === null || !isAbsolute(discovered)) {
    return fail("system ssh executable is unavailable");
  }
  const resolved = await realpath(discovered);
  const stats = await lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o111) === 0) {
    return fail("system ssh executable is not a regular executable");
  }
  return resolved;
}

export function createOpenCodeSshVerificationRunner(
  sshExecutable: string,
): SshVerificationExecutor {
  if (!isAbsolute(sshExecutable)) {
    return fail("ssh executable must be an absolute inspected system path");
  }
  return Object.freeze({
    async captureCandidate(
      input: Parameters<SshVerificationExecutor["captureCandidate"]>[0],
    ): Promise<SshPreflightResult> {
      const hostAlias = requireHostAlias(input.hostAlias);
      requireSafeArgument(input.remoteCwd, "remote cwd");
      if (!SAFE_COMMIT.test(input.baselineCommit)) {
        return fail("baseline commit is invalid");
      }
      let result: OpenSshResult;
      try {
        result = await spawnOpenSsh({
          argv: [
            sshExecutable,
            "--",
            hostAlias,
            `exec bash --noprofile --norc -s -- ${quoteOpenSshPosixArgument(
              input.remoteCwd,
            )} ${quoteOpenSshPosixArgument(input.baselineCommit)}`,
          ],
          stdin: UTF8_ENCODER.encode(OPENSSH_REMOTE_CAPTURE_SCRIPT),
          timeoutMs: input.timeoutMs,
        });
      } catch {
        return {
          error: "spawn_failure",
          kind: "infra_error",
          stderr: new Uint8Array(),
          stdout: new Uint8Array(),
        };
      }
      if (result.timedOut || result.exitCode !== 0) {
        return {
          error: result.timedOut ? "timeout" : "spawn_failure",
          kind: "infra_error",
          stderr: result.stderr,
          stdout: result.stdout,
        };
      }
      try {
        return {
          kind: "observed",
          observation: parseCapture(result.stdout),
        };
      } catch {
        return {
          error: "spawn_failure",
          kind: "infra_error",
          stderr: result.stderr,
          stdout: result.stdout,
        };
      }
    },
    async run(input: Parameters<SshVerificationExecutor["run"]>[0]): Promise<LocalProcessResult> {
      let result: OpenSshResult;
      try {
        result = await spawnOpenSsh({
          argv: buildOpenSshVerificationArgv({
            argv: input.argv,
            hostAlias: input.hostAlias,
            remoteCwd: input.remoteCwd,
            sshExecutable,
          }),
          stdin: "ignore",
          timeoutMs: input.timeoutMs,
        });
      } catch {
        return {
          error: "spawn_failure",
          kind: "infra_error",
          stderr: new Uint8Array(),
          stdout: new Uint8Array(),
        };
      }
      if (result.timedOut || result.exitCode === 255) {
        return {
          error: result.timedOut ? "timeout" : "spawn_failure",
          kind: "infra_error",
          stderr: result.stderr,
          stdout: result.stdout,
        };
      }
      return {
        exitCode: result.exitCode,
        kind: "exited",
        outputArtifactDigests: [],
        stderr: result.stderr,
        stdout: result.stdout,
      };
    },
  });
}
