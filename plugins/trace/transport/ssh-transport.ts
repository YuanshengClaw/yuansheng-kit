import { posix, resolve } from "node:path";

import {
  canonicalizeJson,
  sha256Hex,
} from "../../../tools/yuansheng-root-cause-blueprint/src/canonical-json";

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const RUN_ID = /^[0-9a-f]{32}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SSH_ALIAS = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252}[A-Za-z0-9])?$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SIGNED_DECIMAL = /^(?:0|-?[1-9][0-9]*)$/u;
const HEXADECIMAL = /^(?:0|[1-9a-f][0-9a-f]*)$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const INVENTORY_MAGIC = "YS_TRACE_SSH_INVENTORY_V1";
const PROBE_RESULT = "YS_TRACE_SSH_PROBE_V1\n";
const STAGE_MAGIC = "YS_TRACE_SSH_STAGE_V1";
const CLEANUP_MAGIC = "YS_TRACE_SSH_CLEANUP_V1";
const INVENTORY_CLEANUP_RESULT = "YS_TRACE_SSH_INVENTORY_CLEANUP_V1\n";
const OBJECT_ID = /^f[0-9]{8}$/u;
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const SIGNED_64_MIN = -(1n << 63n);
const SIGNED_64_MAX = (1n << 63n) - 1n;
const UNSIGNED_64_MAX = (1n << 64n) - 1n;

export const SSH_TRANSPORT_CONTRACT_VERSION = 1 as const;

export interface SshTransportLimits {
  readonly commandTimeoutMilliseconds: number;
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxPathBytes: number;
  readonly maxTotalBytes: number;
}

export const SSH_TRANSPORT_DEFAULT_LIMITS = Object.freeze({
  commandTimeoutMilliseconds: 120_000,
  maxDepth: 32,
  maxEntries: 8192,
  maxFileBytes: 64 * 1024 * 1024,
  maxFiles: 4096,
  maxPathBytes: 4096,
  maxTotalBytes: 512 * 1024 * 1024,
} satisfies SshTransportLimits);

export const SSH_TRANSPORT_HARD_LIMITS = Object.freeze({
  commandTimeoutMilliseconds: 600_000,
  maxDepth: 64,
  maxEntries: 16_384,
  maxFileBytes: 512 * 1024 * 1024,
  maxFiles: 8192,
  maxPathBytes: 16_384,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
} satisfies SshTransportLimits);

export type SshTransportErrorCode =
  | "cleanup_failed"
  | "input_invalid"
  | "inventory_rejected"
  | "operation_cancelled"
  | "operation_timeout"
  | "plan_mismatch"
  | "snapshot_mismatch"
  | "source_changed"
  | "state_invalid"
  | "transport_failed";

export class SshTransportError extends Error {
  constructor(
    readonly code: SshTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SshTransportError";
  }
}

export interface CreateSshTransportPlanInput {
  readonly alias: string;
  readonly limits?: Partial<SshTransportLimits>;
  readonly localStagingRoot: string;
  readonly remoteRoot: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly sftpExecutable: string;
  readonly sftpExecutableSha256: string;
  readonly sshExecutable: string;
  readonly sshExecutableSha256: string;
}

interface SshCommandPlan {
  readonly argv: readonly string[];
  readonly maximum_stdout_bytes: number;
  readonly operation: "cleanup" | "inventory" | "inventory_cleanup" | "probe" | "stage";
  readonly stdin_sha256: string;
}

export interface SshTransportPlanV1 {
  readonly algorithms: Readonly<{
    readonly content_digest: "sha256";
    readonly inventory_framing: "nul-delimited-v1";
    readonly inventory_order: "unsigned-byte-lexicographic";
    readonly mapping: "safe-object-id-v1";
    readonly path_encoding: "base64-raw-posix-bytes";
    readonly snapshot_consistency: "source-status-and-sha256-before-after-copy";
  }>;
  readonly allowed_entry_types: readonly ["directory", "regular_file"];
  readonly cleanup: Readonly<{
    readonly local: "remove-only-the-bound-private-staging-root";
    readonly remote: "remove-only-the-returned-run-bound-mktemp-directory";
  }>;
  readonly commands: Readonly<{
    readonly cleanup: SshCommandPlan;
    readonly inventory: SshCommandPlan;
    readonly inventory_cleanup: SshCommandPlan;
    readonly probe: SshCommandPlan;
    readonly stage: SshCommandPlan;
  }>;
  readonly contract_version: typeof SSH_TRANSPORT_CONTRACT_VERSION;
  readonly executables: Readonly<{
    readonly sftp: string;
    readonly ssh: string;
  }>;
  readonly executable_sha256: Readonly<{
    readonly sftp: string;
    readonly ssh: string;
  }>;
  readonly kind: "ys_trace_ssh_transport_plan";
  readonly limits: Readonly<{
    readonly command_timeout_milliseconds: number;
    readonly max_depth: number;
    readonly max_entries: number;
    readonly max_file_bytes: number;
    readonly max_files: number;
    readonly max_path_bytes: number;
    readonly max_total_bytes: number;
  }>;
  readonly local_staging_root: string;
  readonly location: Readonly<{
    readonly alias: string;
    readonly kind: "ssh";
    readonly remote_root_base64: string;
    readonly remote_root_utf8: string;
  }>;
  readonly remote_required_commands: readonly string[];
  readonly remote_inventory_temp: string;
  readonly remote_temp_template: string;
  readonly run_id: string;
  readonly session_binding_sha256: string;
  readonly sftp: Readonly<{
    readonly argv_prefix: readonly string[];
    readonly batch_protocol: "safe-object-id-get-v1";
  }>;
}

export interface SshTransportPlanEnvelope {
  readonly plan: SshTransportPlanV1;
  readonly plan_sha256: string;
}

export interface SshInventoryEntryV1 {
  readonly path_base64: string;
  readonly path_utf8: string | null;
  readonly sha256: string | null;
  readonly status: Readonly<{
    readonly ctime_seconds: string;
    readonly device: string;
    readonly inode: string;
    readonly mode_hex: string;
    readonly mtime_seconds: string;
    readonly size: string;
  }>;
  readonly type: "directory" | "regular_file";
}

export interface SshInventoryV1 {
  readonly contract_version: typeof SSH_TRANSPORT_CONTRACT_VERSION;
  readonly directories: number;
  readonly entries: readonly SshInventoryEntryV1[];
  readonly files: number;
  readonly kind: "ys_trace_ssh_inventory";
  readonly total_file_bytes: string;
}

export interface SshInventoryEnvelope {
  readonly inventory: SshInventoryV1;
  readonly inventory_sha256: string;
  readonly plan_sha256: string;
}

export interface SshStagedObjectV1 {
  readonly object_id: string;
  readonly sha256: string;
  readonly size: string;
}

export interface SshStageV1 {
  readonly confirmed_inventory_sha256: string;
  readonly contract_version: typeof SSH_TRANSPORT_CONTRACT_VERSION;
  readonly inventory_sha256: string;
  readonly kind: "ys_trace_ssh_stage";
  readonly objects: readonly SshStagedObjectV1[];
  readonly owner_marker_sha256: string;
  readonly plan_sha256: string;
  readonly remote_temp: string;
  readonly remote_temp_base64: string;
  readonly run_id: string;
  readonly total_file_bytes: string;
}

export interface SshStageEnvelope {
  readonly inventory: SshInventoryEnvelope;
  readonly stage: SshStageV1;
  readonly stage_sha256: string;
}

export interface SshRemoteCleanupLeaseV1 {
  readonly confirmed_inventory_sha256: string;
  readonly owner_marker_sha256: string;
  readonly plan_sha256: string;
  readonly remote_temp: string;
  readonly remote_temp_base64: string;
  readonly run_id: string;
}

export type SshStageParseResult =
  | Readonly<{
      cleanup_lease: SshRemoteCleanupLeaseV1;
      ok: true;
      stage: SshStageEnvelope;
    }>
  | Readonly<{
      cleanup_lease: SshRemoteCleanupLeaseV1;
      error_code: "snapshot_mismatch" | "source_changed";
      error_message: string;
      ok: false;
    }>;

export type SshStageRejection = Extract<SshStageParseResult, Readonly<{ ok: false }>>;

export interface SshSnapshotMappingEntryV1 extends SshInventoryEntryV1 {
  readonly object_id: string | null;
}

export interface SshSnapshotMappingV1 {
  readonly contract_version: typeof SSH_TRANSPORT_CONTRACT_VERSION;
  readonly entries: readonly SshSnapshotMappingEntryV1[];
  readonly inventory_sha256: string;
  readonly kind: "ys_trace_ssh_snapshot_mapping";
  readonly local_objects_root: string;
  readonly local_tree_root: string;
  readonly plan_sha256: string;
  readonly remote_temp: string;
  readonly stage_sha256: string;
}

export interface SshSnapshotMappingEnvelope {
  readonly mapping: SshSnapshotMappingV1;
  readonly mapping_sha256: string;
}

export interface SshCleanupStatus {
  readonly local_staging_removed: boolean;
  readonly remote_temp_removed: boolean;
  readonly residual_paths: readonly string[];
}

interface SshTransportStateBase {
  readonly plan: SshTransportPlanEnvelope;
}

export type SshTransportState =
  | (SshTransportStateBase & Readonly<{ phase: "awaiting_plan_approval" }>)
  | (SshTransportStateBase & Readonly<{ phase: "awaiting_inventory" }>)
  | (SshTransportStateBase &
      Readonly<{
        inventory: SshInventoryEnvelope;
        phase: "awaiting_transfer_confirmation";
      }>)
  | (SshTransportStateBase &
      Readonly<{
        inventory: SshInventoryEnvelope;
        phase: "transferring";
      }>)
  | (SshTransportStateBase &
      Readonly<{
        cleanup_lease: SshRemoteCleanupLeaseV1;
        error_code: SshStageRejection["error_code"];
        error_message: string;
        inventory: SshInventoryEnvelope;
        phase: "cleanup_pending";
      }>)
  | (SshTransportStateBase &
      Readonly<{
        cleanup_lease: SshRemoteCleanupLeaseV1;
        inventory: SshInventoryEnvelope;
        phase: "downloading";
        stage: SshStageEnvelope;
      }>)
  | (SshTransportStateBase &
      Readonly<{
        cleanup_lease: SshRemoteCleanupLeaseV1;
        inventory: SshInventoryEnvelope;
        mapping: SshSnapshotMappingEnvelope;
        phase: "staged";
        stage: SshStageEnvelope;
      }>)
  | (SshTransportStateBase &
      Readonly<{
        cleanup: SshCleanupStatus;
        cleanup_lease?: SshRemoteCleanupLeaseV1;
        error_code: SshTransportErrorCode;
        phase: "failed";
      }>)
  | (SshTransportStateBase &
      Readonly<{
        cleanup: SshCleanupStatus;
        phase: "cleaned";
      }>);

export type SshTransportEvent =
  | Readonly<{ plan_sha256: string; type: "approve_plan" }>
  | Readonly<{ inventory: SshInventoryEnvelope; type: "bind_inventory" }>
  | Readonly<{ inventory_sha256: string; type: "confirm_transfer" }>
  | Readonly<{ stage: SshStageEnvelope; type: "bind_stage" }>
  | Readonly<{ rejection: SshStageRejection; type: "reject_stage" }>
  | Readonly<{ mapping: SshSnapshotMappingEnvelope; type: "complete_staging" }>
  | Readonly<{
      cleanup: SshCleanupStatus;
      error_code: SshTransportErrorCode;
      type: "fail";
    }>
  | Readonly<{ cleanup: SshCleanupStatus; type: "clean" }>;

const APPROVED_TRANSPORT_STATES = new WeakSet<object>();

function fail(code: SshTransportErrorCode, message: string): never {
  throw new SshTransportError(code, message);
}

function freezeSnapshot<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  for (const item of Object.values(value)) {
    freezeSnapshot(item);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function requireSafeInteger(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail("input_invalid", `${label} must be a positive safe integer within the hard limit`);
  }
  return value;
}

export function resolveSshTransportLimits(
  requested: Partial<SshTransportLimits> = {},
): SshTransportLimits {
  const values = {
    ...SSH_TRANSPORT_DEFAULT_LIMITS,
    ...requested,
  };
  const resolved = {
    commandTimeoutMilliseconds: requireSafeInteger(
      values.commandTimeoutMilliseconds,
      SSH_TRANSPORT_HARD_LIMITS.commandTimeoutMilliseconds,
      "commandTimeoutMilliseconds",
    ),
    maxDepth: requireSafeInteger(values.maxDepth, SSH_TRANSPORT_HARD_LIMITS.maxDepth, "maxDepth"),
    maxEntries: requireSafeInteger(
      values.maxEntries,
      SSH_TRANSPORT_HARD_LIMITS.maxEntries,
      "maxEntries",
    ),
    maxFileBytes: requireSafeInteger(
      values.maxFileBytes,
      SSH_TRANSPORT_HARD_LIMITS.maxFileBytes,
      "maxFileBytes",
    ),
    maxFiles: requireSafeInteger(values.maxFiles, SSH_TRANSPORT_HARD_LIMITS.maxFiles, "maxFiles"),
    maxPathBytes: requireSafeInteger(
      values.maxPathBytes,
      SSH_TRANSPORT_HARD_LIMITS.maxPathBytes,
      "maxPathBytes",
    ),
    maxTotalBytes: requireSafeInteger(
      values.maxTotalBytes,
      SSH_TRANSPORT_HARD_LIMITS.maxTotalBytes,
      "maxTotalBytes",
    ),
  };
  if (resolved.maxFiles > resolved.maxEntries) {
    fail("input_invalid", "maxFiles must not exceed maxEntries");
  }
  return Object.freeze(resolved);
}

function requireAbsoluteLocalPath(value: string, label: string): string {
  if (value.length === 0 || value.includes("\0") || !value.startsWith("/")) {
    fail("input_invalid", `${label} must be an absolute path`);
  }
  const normalized = resolve(value);
  if (normalized === "/" || normalized !== value) {
    fail("input_invalid", `${label} must be a normalized non-root absolute path`);
  }
  return normalized;
}

function requireRemoteRoot(value: string): string {
  if (value.length === 0 || value.includes("\0") || !value.startsWith("/") || value === "/") {
    fail("input_invalid", "remoteRoot must be an absolute non-root POSIX path");
  }
  if (value.endsWith("/") || value.includes("//")) {
    fail("input_invalid", "remoteRoot must use a normalized POSIX path representation");
  }
  const segments = value.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail("input_invalid", "remoteRoot must not contain empty, dot, or dot-dot segments");
  }
  if (UTF8_ENCODER.encode(value).byteLength > SSH_TRANSPORT_HARD_LIMITS.maxPathBytes) {
    fail("input_invalid", "remoteRoot exceeds the hard path byte limit");
  }
  return value;
}

function requireAlias(value: string): string {
  if (!SSH_ALIAS.test(value)) {
    fail("input_invalid", "alias must be a conservative SSH configuration alias");
  }
  return value;
}

function requireSha256(value: string, label: string): string {
  if (!SHA256.test(value)) {
    fail("input_invalid", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function encoded(value: string): string {
  return Buffer.from(UTF8_ENCODER.encode(value)).toString("base64");
}

function maximumInventoryBytes(limits: SshTransportLimits): number {
  const encodedPathBytes = Math.ceil(limits.maxPathBytes / 3) * 4;
  const perEntry = encodedPathBytes + 384;
  return Math.min(Number.MAX_SAFE_INTEGER, limits.maxEntries * perEntry + 1024);
}

function maximumStageBytes(limits: SshTransportLimits): number {
  return maximumInventoryBytes(limits) + limits.maxFiles * 112 + 512;
}

const SHELL_DOLLAR = "$";
const REMOTE_REQUIRED_COMMANDS = Object.freeze([
  "base64",
  "bash",
  "cat",
  "chmod",
  "cp",
  "find",
  "head",
  "id",
  "mkdir",
  "mktemp",
  "realpath",
  "rm",
  "rmdir",
  "sha256sum",
  "sort",
  "stat",
  "uname",
] as const);
const REMOTE_SCRIPT_LINES = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "export LC_ALL=C",
  "fail() { printf 'YS_TRACE_REMOTE_ERROR:%s\\n' \"$1\" >&2; exit 70; }",
  'require_command() { command -v -- "$1" >/dev/null 2>&1 || fail missing_command; }',
  `decode_value() { local marked reencoded; marked="$(printf '%s' "$1" | base64 --decode && printf x)" || fail invalid_base64; DECODED_VALUE=${SHELL_DOLLAR}{marked%x}; reencoded=$(printf '%s' "$DECODED_VALUE" | base64 --wrap=0) || fail invalid_base64; [[ $reencoded == "$1" ]] || fail noncanonical_base64; }`,
  "status_of() { stat --printf='%d:%i:%f:%s:%Y:%Z' -- \"$1\"; }",
  "hash_of() { local digest ignored; sha256sum <\"$1\" | { IFS=' ' read -r digest ignored; printf '%s' \"$digest\"; }; }",
  "hash_stdin() { local digest ignored; sha256sum | { IFS=' ' read -r digest ignored; printf '%s' \"$digest\"; }; }",
  "TRANSIENT_TEMP=",
  "REMOTE_TEMP=",
  "REMOTE_RUN_ID=",
  "REMOTE_UID=",
  "KEEP_REMOTE_TEMP=0",
  `cleanup_transient() { local target=${SHELL_DOLLAR}{TRANSIENT_TEMP-}; TRANSIENT_TEMP=; if [[ -n $target ]]; then rm -rf -- "$target" || return 70; [[ ! -e $target && ! -L $target ]] || return 70; fi; }`,
  `valid_remote_temp_shape() { local candidate=$1 run_id=$2 prefix suffix; prefix="/tmp/yuansheng-ys-trace-$run_id."; [[ $candidate == "$prefix"* ]] || return 1; suffix=${SHELL_DOLLAR}{candidate#"$prefix"}; [[ $suffix =~ ^[A-Za-z0-9]{8}$ ]]; }`,
  'remove_uncommitted_temp() { local candidate=$1 run_id=$2 uid=$3; valid_remote_temp_shape "$candidate" "$run_id" || return 1; [[ -d $candidate && ! -L $candidate ]] || return 1; [[ $(stat --printf=\'%u\' -- "$candidate") == "$uid" ]] || return 1; rm -rf --one-file-system -- "$candidate" || return 1; [[ ! -e $candidate && ! -L $candidate ]]; }',
  'on_exit() { local status=$?; trap - EXIT; cleanup_transient || { (( status == 0 )) && status=70; }; if (( status != 0 && KEEP_REMOTE_TEMP == 0 )) && [[ -n $REMOTE_TEMP ]]; then remove_uncommitted_temp "$REMOTE_TEMP" "$REMOTE_RUN_ID" "$REMOTE_UID" || :; fi; exit "$status"; }',
  "trap on_exit EXIT",
  "trap 'exit 129' HUP",
  "trap 'exit 130' INT",
  "trap 'exit 143' TERM",
  'require_canonical_root() { local root=$1 expected_base64 actual_base64; expected_base64=$(printf \'%s\\0\' "$root" | base64 --wrap=0) || fail root_canonicalization_failed; actual_base64=$(realpath -e -z -- "$root" | base64 --wrap=0) || fail root_canonicalization_failed; [[ $actual_base64 == "$expected_base64" ]] || fail root_not_canonical; [[ -d $root && ! -L $root ]] || fail root_invalid; }',
  "collect_inventory_paths() {",
  "  local root=$1 run_id=$2 session_binding=$3 max_depth=$4 max_entries=$5 max_path_bytes=$6",
  "  local target list sorted marker path relative without_slashes depth discovered=0 find_status head_status",
  "  local -a pipeline_status=()",
  "  [[ $run_id =~ ^[0-9a-f]{32}$ ]] || fail run_id_invalid",
  "  [[ $session_binding =~ ^[0-9a-f]{64}$ ]] || fail session_binding_invalid",
  "  target=/tmp/yuansheng-ys-trace-inventory-$run_id",
  '  [[ $target != "$root/"* ]] || fail staging_overlaps_source',
  '  mkdir -m 0700 -- "$target" || fail inventory_temp_exists',
  "  TRANSIENT_TEMP=$target",
  "  [[ -d $TRANSIENT_TEMP && ! -L $TRANSIENT_TEMP ]] || fail inventory_temp_invalid",
  "  marker=$TRANSIENT_TEMP/.ys-trace-owner",
  '  printf \'%s\\0%s\\0%s\\0\' \'YS_TRACE_SSH_INVENTORY_OWNER_V1\' "$run_id" "$session_binding" >"$marker" || fail marker_write_failed',
  '  chmod 0400 -- "$marker" || fail marker_mode_failed',
  "  list=$TRANSIENT_TEMP/paths",
  "  sorted=$TRANSIENT_TEMP/sorted",
  "  set +e",
  '  find -P "$root" -mindepth 1 -maxdepth "$((max_depth + 1))" -print0 | head -z -n "$((max_entries + 1))" >"$list"',
  `  pipeline_status=("${SHELL_DOLLAR}{PIPESTATUS[@]}")`,
  "  set -e",
  `  find_status=${SHELL_DOLLAR}{pipeline_status[0]-1}`,
  `  head_status=${SHELL_DOLLAR}{pipeline_status[1]-1}`,
  "  (( head_status == 0 )) || fail enumeration_failed",
  "  while IFS= read -r -d '' path; do",
  '    [[ $path == "$root/"* ]] || fail path_outside_root',
  `    relative=${SHELL_DOLLAR}{path#"$root/"}`,
  "    [[ -n $relative ]] || fail empty_relative_path",
  `    (( ${SHELL_DOLLAR}{#relative} <= max_path_bytes )) || fail path_too_long`,
  `    without_slashes=${SHELL_DOLLAR}{relative////}`,
  `    depth=$(( ${SHELL_DOLLAR}{#relative} - ${SHELL_DOLLAR}{#without_slashes} + 1 ))`,
  "    (( depth <= max_depth )) || fail depth_limit",
  "    discovered=$((discovered + 1))",
  "    (( discovered <= max_entries )) || fail entry_limit",
  '  done <"$list"',
  "  (( find_status == 0 )) || fail enumeration_failed",
  '  sort -z -- "$list" >"$sorted" || fail sort_failed',
  "  SORTED_PATH_LIST=$sorted",
  "}",
  "cleanup_inventory_temp() {",
  "  local run_id=$1 session_binding=$2 target marker uid actual_marker_sha expected_marker_sha",
  "  [[ $run_id =~ ^[0-9a-f]{32}$ ]] || fail run_id_invalid",
  "  [[ $session_binding =~ ^[0-9a-f]{64}$ ]] || fail session_binding_invalid",
  "  target=/tmp/yuansheng-ys-trace-inventory-$run_id",
  "  if [[ ! -e $target && ! -L $target ]]; then printf 'YS_TRACE_SSH_INVENTORY_CLEANUP_V1\\n'; return; fi",
  "  [[ -d $target && ! -L $target ]] || fail inventory_temp_invalid",
  "  marker=$target/.ys-trace-owner",
  "  if [[ ! -e $marker && ! -L $marker ]]; then rmdir -- \"$target\" || fail marker_missing; printf 'YS_TRACE_SSH_INVENTORY_CLEANUP_V1\\n'; return; fi",
  "  [[ -f $marker && ! -L $marker ]] || fail marker_invalid",
  "  uid=$(id -u) || fail uid_failed",
  '  [[ $(stat --printf=\'%u\' -- "$target") == "$uid" && $(stat --printf=\'%u\' -- "$marker") == "$uid" ]] || fail inventory_temp_owner_invalid',
  '  actual_marker_sha=$(hash_of "$marker") || fail marker_hash_failed',
  "  expected_marker_sha=$(printf '%s\\0%s\\0%s\\0' 'YS_TRACE_SSH_INVENTORY_OWNER_V1' \"$run_id\" \"$session_binding\" | hash_stdin) || fail marker_hash_failed",
  '  [[ $actual_marker_sha == "$expected_marker_sha" ]] || fail marker_mismatch',
  '  rm -rf --one-file-system -- "$target" || fail cleanup_failed',
  "  [[ ! -e $target && ! -L $target ]] || fail cleanup_residual",
  "  printf 'YS_TRACE_SSH_INVENTORY_CLEANUP_V1\\n'",
  "}",
  "stage_snapshot() {",
  "  local root=$1 run_id=$2 confirmed_inventory_sha=$3 max_depth=$4 max_entries=$5 max_files=$6 max_path_bytes=$7 max_file_bytes=$8 max_total_bytes=$9",
  "  local prefix suffix objects marker response object_records remote_temp_base64 owner_marker_sha",
  "  local entries=0 files=0 directories=0 total=0 file_index=0 path relative path_base64 kind hash status_before status_mid status_after hash_after",
  "  local device inode mode size mtime ctime object_id object object_size object_hash",
  "  [[ $run_id =~ ^[0-9a-f]{32}$ ]] || fail run_id_invalid",
  "  [[ $confirmed_inventory_sha =~ ^[0-9a-f]{64}$ ]] || fail inventory_sha_invalid",
  "  REMOTE_RUN_ID=$run_id",
  "  REMOTE_UID=$(id -u) || fail uid_failed",
  '  REMOTE_TEMP=$(mktemp -d -- "/tmp/yuansheng-ys-trace-$run_id.XXXXXXXX") || fail mktemp_failed',
  '  valid_remote_temp_shape "$REMOTE_TEMP" "$run_id" || fail temp_invalid',
  "  [[ -d $REMOTE_TEMP && ! -L $REMOTE_TEMP ]] || fail temp_invalid",
  '  [[ $(stat --printf=\'%u\' -- "$REMOTE_TEMP") == "$REMOTE_UID" ]] || fail temp_owner_invalid',
  '  [[ $REMOTE_TEMP != "$root/"* && $root != "$REMOTE_TEMP/"* ]] || fail staging_overlaps_source',
  "  objects=$REMOTE_TEMP/objects",
  '  mkdir -m 0700 -- "$objects" || fail staging_create_failed',
  "  remote_temp_base64=$(printf '%s' \"$REMOTE_TEMP\" | base64 --wrap=0) || fail base64_failed",
  "  marker=$REMOTE_TEMP/.ys-trace-owner",
  '  printf \'%s\\0%s\\0%s\\0\' \'YS_TRACE_SSH_OWNER_V1\' "$run_id" "$remote_temp_base64" >"$marker" || fail marker_write_failed',
  '  chmod 0400 -- "$marker" || fail marker_mode_failed',
  '  owner_marker_sha=$(hash_of "$marker") || fail marker_hash_failed',
  "  [[ $owner_marker_sha =~ ^[0-9a-f]{64}$ ]] || fail marker_hash_failed",
  "  response=$REMOTE_TEMP/.stage-response",
  "  object_records=$REMOTE_TEMP/.object-records",
  '  : >"$response" || fail response_create_failed',
  '  : >"$object_records" || fail response_create_failed',
  '  printf \'%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0\' \'YS_TRACE_SSH_STAGE_V1\' "$run_id" "$confirmed_inventory_sha" "$remote_temp_base64" "$owner_marker_sha" \'YS_TRACE_SSH_INVENTORY_V1\' >>"$response" || fail response_write_failed',
  "  while IFS= read -r -d '' path; do",
  '    [[ $path == "$root/"* ]] || fail path_outside_root',
  `    relative=${SHELL_DOLLAR}{path#"$root/"}`,
  "    [[ -n $relative ]] || fail empty_relative_path",
  "    entries=$((entries + 1))",
  "    (( entries <= max_entries )) || fail entry_limit",
  "    if [[ -L $path ]]; then",
  "      fail symbolic_link",
  "    elif [[ -d $path ]]; then",
  "      kind=D",
  "      hash=-",
  "      directories=$((directories + 1))",
  '      status_before=$(status_of "$path") || fail status_failed',
  '      status_after=$(status_of "$path") || fail status_failed',
  '      [[ $status_before == "$status_after" ]] || fail source_changed',
  "    elif [[ -f $path ]]; then",
  "      kind=F",
  "      files=$((files + 1))",
  "      file_index=$files",
  "      (( files <= max_files )) || fail file_limit",
  '      status_before=$(status_of "$path") || fail status_failed',
  '      hash=$(hash_of "$path") || fail hash_failed',
  '      status_mid=$(status_of "$path") || fail status_failed',
  '      [[ $status_before == "$status_mid" && $hash =~ ^[0-9a-f]{64}$ ]] || fail source_changed',
  "    else",
  "      fail special_file",
  "    fi",
  '    IFS=: read -r device inode mode size mtime ctime <<<"$status_before"',
  "    if [[ $kind == F ]]; then",
  "      (( size <= max_file_bytes )) || fail file_size_limit",
  "      total=$((total + size))",
  "      (( total <= max_total_bytes )) || fail total_size_limit",
  "      printf -v object_id 'f%08d' \"$file_index\"",
  "      object=$objects/$object_id",
  "      [[ ! -e $object && ! -L $object ]] || fail object_exists",
  '      cp --reflink=never -- "$path" "$object" || fail copy_failed',
  "      [[ -f $object && ! -L $object ]] || fail object_invalid",
  '      chmod 0400 -- "$object" || fail object_mode_failed',
  "      [[ -f $path && ! -L $path ]] || fail source_changed",
  '      status_after=$(status_of "$path") || fail status_failed',
  '      hash_after=$(hash_of "$path") || fail hash_failed',
  '      status_mid=$(status_of "$path") || fail status_failed',
  '      [[ $status_before == "$status_after" && $status_before == "$status_mid" && $hash == "$hash_after" ]] || fail source_changed',
  "      object_size=$(stat --printf='%s' -- \"$object\") || fail object_status_failed",
  '      object_hash=$(hash_of "$object") || fail object_hash_failed',
  '      [[ $object_size == "$size" && $object_hash == "$hash" ]] || fail copy_mismatch',
  '      printf \'%s\\0%s\\0%s\\0%s\\0\' \'O\' "$object_id" "$size" "$hash" >>"$object_records" || fail response_write_failed',
  "    fi",
  "    path_base64=$(printf '%s' \"$relative\" | base64 --wrap=0) || fail base64_failed",
  '    printf \'%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0\' "$kind" "$path_base64" "$device" "$inode" "$mode" "$size" "$mtime" "$ctime" "$hash" >>"$response" || fail response_write_failed',
  '  done <"$SORTED_PATH_LIST"',
  '  printf \'END\\0%s\\0%s\\0%s\\0OBJECTS\\0\' "$directories" "$files" "$total" >>"$response" || fail response_write_failed',
  '  cat -- "$object_records" >>"$response" || fail response_write_failed',
  '  printf \'END_OBJECTS\\0%s\\0%s\\0\' "$files" "$total" >>"$response" || fail response_write_failed',
  "  cleanup_transient || fail cleanup_failed",
  '  cat -- "$response" || fail response_emit_failed',
  '  rm -- "$response" "$object_records" || fail metadata_cleanup_failed',
  "  KEEP_REMOTE_TEMP=1",
  "}",
  "cleanup_stage_temp() {",
  "  local run_id=$1 remote_temp_base64=$2 marker_sha=$3 remote_temp marker objects uid actual_marker_sha expected_marker_sha",
  "  [[ $run_id =~ ^[0-9a-f]{32}$ ]] || fail run_id_invalid",
  "  [[ $marker_sha =~ ^[0-9a-f]{64}$ ]] || fail marker_hash_invalid",
  '  decode_value "$remote_temp_base64" || fail temp_decode_failed',
  "  remote_temp=$DECODED_VALUE",
  '  valid_remote_temp_shape "$remote_temp" "$run_id" || fail temp_invalid',
  "  if [[ ! -e $remote_temp && ! -L $remote_temp ]]; then printf '%s\\0%s\\0%s\\0%s\\0%s\\0' 'YS_TRACE_SSH_CLEANUP_V1' \"$run_id\" \"$remote_temp_base64\" \"$marker_sha\" 'REMOVED'; return; fi",
  "  [[ -d $remote_temp && ! -L $remote_temp ]] || fail temp_invalid",
  "  marker=$remote_temp/.ys-trace-owner",
  "  objects=$remote_temp/objects",
  "  [[ -f $marker && ! -L $marker ]] || fail marker_invalid",
  "  [[ -d $objects && ! -L $objects ]] || fail objects_invalid",
  "  uid=$(id -u) || fail uid_failed",
  '  [[ $(stat --printf=\'%u\' -- "$remote_temp") == "$uid" && $(stat --printf=\'%u\' -- "$marker") == "$uid" && $(stat --printf=\'%u\' -- "$objects") == "$uid" ]] || fail temp_owner_invalid',
  '  actual_marker_sha=$(hash_of "$marker") || fail marker_hash_failed',
  "  expected_marker_sha=$(printf '%s\\0%s\\0%s\\0' 'YS_TRACE_SSH_OWNER_V1' \"$run_id\" \"$remote_temp_base64\" | hash_stdin) || fail marker_hash_failed",
  '  [[ $actual_marker_sha == "$marker_sha" && $actual_marker_sha == "$expected_marker_sha" ]] || fail marker_mismatch',
  '  rm -rf --one-file-system -- "$remote_temp" || fail cleanup_failed',
  "  [[ ! -e $remote_temp && ! -L $remote_temp ]] || fail cleanup_residual",
  "  printf '%s\\0%s\\0%s\\0%s\\0%s\\0' 'YS_TRACE_SSH_CLEANUP_V1' \"$run_id\" \"$remote_temp_base64\" \"$marker_sha\" 'REMOVED'",
  "}",
  "emit_inventory() {",
  "  local root=$1 run_id=$2 session_binding=$3 max_depth=$4 max_entries=$5 max_files=$6 max_path_bytes=$7 max_file_bytes=$8 max_total_bytes=$9",
  "  local entries=0 files=0 directories=0 total=0 path relative path_base64 kind hash status_before status_after",
  "  local device inode mode size mtime ctime",
  '  collect_inventory_paths "$root" "$run_id" "$session_binding" "$max_depth" "$max_entries" "$max_path_bytes"',
  "  printf '%s\\0' 'YS_TRACE_SSH_INVENTORY_V1'",
  "  while IFS= read -r -d '' path; do",
  '    [[ $path == "$root/"* ]] || fail path_outside_root',
  `    relative=${SHELL_DOLLAR}{path#"$root/"}`,
  "    [[ -n $relative ]] || fail empty_relative_path",
  `    (( ${SHELL_DOLLAR}{#relative} <= max_path_bytes )) || fail path_too_long`,
  `    without_slashes=${SHELL_DOLLAR}{relative////}`,
  `    depth=$(( ${SHELL_DOLLAR}{#relative} - ${SHELL_DOLLAR}{#without_slashes} + 1 ))`,
  "    (( depth <= max_depth )) || fail depth_limit",
  "    entries=$((entries + 1))",
  "    (( entries <= max_entries )) || fail entry_limit",
  "    if [[ -L $path ]]; then",
  "      fail symbolic_link",
  "    elif [[ -d $path ]]; then",
  "      kind=D",
  "      hash=-",
  "      directories=$((directories + 1))",
  "    elif [[ -f $path ]]; then",
  "      kind=F",
  "      files=$((files + 1))",
  "      (( files <= max_files )) || fail file_limit",
  "    else",
  "      fail special_file",
  "    fi",
  '    status_before=$(status_of "$path") || fail status_failed',
  '    IFS=: read -r device inode mode size mtime ctime <<<"$status_before"',
  "    if [[ $kind == F ]]; then",
  "      (( size <= max_file_bytes )) || fail file_size_limit",
  "      total=$((total + size))",
  "      (( total <= max_total_bytes )) || fail total_size_limit",
  '      hash=$(hash_of "$path") || fail hash_failed',
  "      [[ $hash =~ ^[0-9a-f]{64}$ ]] || fail hash_invalid",
  "    fi",
  '    status_after=$(status_of "$path") || fail status_failed',
  '    [[ $status_before == "$status_after" ]] || fail source_changed',
  "    path_base64=$(printf '%s' \"$relative\" | base64 --wrap=0) || fail base64_failed",
  '    printf \'%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0%s\\0\' "$kind" "$path_base64" "$device" "$inode" "$mode" "$size" "$mtime" "$ctime" "$hash"',
  '  done <"$SORTED_PATH_LIST"',
  '  printf \'END\\0%s\\0%s\\0%s\\0\' "$directories" "$files" "$total"',
  "}",
  `operation=${SHELL_DOLLAR}{1-}`,
  "case $operation in",
  "  probe)",
  "    [[ $# == 1 ]] || fail invalid_arguments",
  "    [[ $(uname -s) == Linux ]] || fail unsupported_system",
  "    (( BASH_VERSINFO[0] >= 4 )) || fail unsupported_bash",
  `    for item in ${REMOTE_REQUIRED_COMMANDS.join(" ")}; do require_command "$item"; done`,
  "    find --version >/dev/null 2>&1 || fail unsupported_find",
  "    stat --version >/dev/null 2>&1 || fail unsupported_stat",
  "    sha256sum --version >/dev/null 2>&1 || fail unsupported_sha256sum",
  "    base64 --version >/dev/null 2>&1 || fail unsupported_base64",
  "    cp --version >/dev/null 2>&1 || fail unsupported_cp",
  "    head --version >/dev/null 2>&1 || fail unsupported_head",
  "    sort --version >/dev/null 2>&1 || fail unsupported_sort",
  "    realpath --version >/dev/null 2>&1 || fail unsupported_realpath",
  "    rm --version >/dev/null 2>&1 || fail unsupported_rm",
  "    printf 'YS_TRACE_SSH_PROBE_V1\\n'",
  "    ;;",
  "  inventory)",
  "    [[ $# == 10 ]] || fail invalid_arguments",
  '    decode_value "$2" || fail root_decode_failed',
  "    root=$DECODED_VALUE",
  "    [[ $root == /* && $root != / ]] || fail root_invalid",
  '    require_canonical_root "$root"',
  `    emit_inventory "$root" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${SHELL_DOLLAR}{10}"`,
  "    cleanup_transient || fail cleanup_failed",
  "    ;;",
  "  inventory-cleanup)",
  "    [[ $# == 3 ]] || fail invalid_arguments",
  '    cleanup_inventory_temp "$2" "$3"',
  "    ;;",
  "  stage)",
  "    [[ $# == 11 ]] || fail invalid_arguments",
  '    decode_value "$2" || fail root_decode_failed',
  "    root=$DECODED_VALUE",
  "    [[ $root == /* && $root != / ]] || fail root_invalid",
  '    require_canonical_root "$root"',
  '    collect_inventory_paths "$root" "$3" "$5" "$6" "$7" "$9"',
  `    stage_snapshot "$root" "$3" "$4" "$6" "$7" "$8" "$9" "${SHELL_DOLLAR}{10}" "${SHELL_DOLLAR}{11}"`,
  "    ;;",
  "  cleanup)",
  "    [[ $# == 4 ]] || fail invalid_arguments",
  '    cleanup_stage_temp "$2" "$3" "$4"',
  "    ;;",
  "  *) fail unknown_operation ;;",
  "esac",
];

export const SSH_REMOTE_SCRIPT = `${REMOTE_SCRIPT_LINES.join("\n")}\n`;
export const SSH_REMOTE_SCRIPT_SHA256 = sha256Hex(UTF8_ENCODER.encode(SSH_REMOTE_SCRIPT));

function commandPlan(
  executable: string,
  argv: readonly string[],
  operation: SshCommandPlan["operation"],
  maximumStdoutBytes: number,
): SshCommandPlan {
  return freezeSnapshot({
    argv: [executable, ...argv],
    maximum_stdout_bytes: maximumStdoutBytes,
    operation,
    stdin_sha256: SSH_REMOTE_SCRIPT_SHA256,
  });
}

function buildSshTransportPlan(input: {
  readonly alias: string;
  readonly limits: SshTransportLimits;
  readonly localStagingRoot: string;
  readonly remoteRoot: string;
  readonly runId: string;
  readonly sessionBindingSha256: string;
  readonly sftpExecutable: string;
  readonly sftpExecutableSha256: string;
  readonly sshExecutable: string;
  readonly sshExecutableSha256: string;
}): SshTransportPlanEnvelope {
  const { alias, limits, localStagingRoot, remoteRoot } = input;
  const ssh = input.sshExecutable;
  const sftp = input.sftpExecutable;
  const rootBase64 = encoded(remoteRoot);
  const sessionBindingSha256 = input.sessionBindingSha256;
  const maximumStdoutBytes = maximumInventoryBytes(limits);
  const sshPrefix = ["-o", "BatchMode=yes", "--", alias, "bash", "-s", "--"] as const;
  const limitArguments = [
    String(limits.maxDepth),
    String(limits.maxEntries),
    String(limits.maxFiles),
    String(limits.maxPathBytes),
    String(limits.maxFileBytes),
    String(limits.maxTotalBytes),
  ] as const;
  const plan: SshTransportPlanV1 = freezeSnapshot({
    algorithms: {
      content_digest: "sha256",
      inventory_framing: "nul-delimited-v1",
      inventory_order: "unsigned-byte-lexicographic",
      mapping: "safe-object-id-v1",
      path_encoding: "base64-raw-posix-bytes",
      snapshot_consistency: "source-status-and-sha256-before-after-copy",
    },
    allowed_entry_types: ["directory", "regular_file"],
    cleanup: {
      local: "remove-only-the-bound-private-staging-root",
      remote: "remove-only-the-returned-run-bound-mktemp-directory",
    },
    commands: {
      cleanup: commandPlan(
        ssh,
        [
          ...sshPrefix,
          "cleanup",
          input.runId,
          "YS_TRACE_REMOTE_TEMP_BASE64",
          "YS_TRACE_OWNER_MARKER_SHA256",
        ],
        "cleanup",
        1024,
      ),
      inventory: commandPlan(
        ssh,
        [
          ...sshPrefix,
          "inventory",
          rootBase64,
          input.runId,
          sessionBindingSha256,
          ...limitArguments,
        ],
        "inventory",
        maximumStdoutBytes,
      ),
      inventory_cleanup: commandPlan(
        ssh,
        [...sshPrefix, "inventory-cleanup", input.runId, sessionBindingSha256],
        "inventory_cleanup",
        1024,
      ),
      probe: commandPlan(ssh, [...sshPrefix, "probe"], "probe", 1024),
      stage: commandPlan(
        ssh,
        [
          ...sshPrefix,
          "stage",
          rootBase64,
          input.runId,
          "YS_TRACE_CONFIRMED_INVENTORY_SHA256",
          sessionBindingSha256,
          ...limitArguments,
        ],
        "stage",
        maximumStageBytes(limits),
      ),
    },
    contract_version: SSH_TRANSPORT_CONTRACT_VERSION,
    executable_sha256: {
      sftp: input.sftpExecutableSha256,
      ssh: input.sshExecutableSha256,
    },
    executables: { sftp, ssh },
    kind: "ys_trace_ssh_transport_plan",
    limits: {
      command_timeout_milliseconds: limits.commandTimeoutMilliseconds,
      max_depth: limits.maxDepth,
      max_entries: limits.maxEntries,
      max_file_bytes: limits.maxFileBytes,
      max_files: limits.maxFiles,
      max_path_bytes: limits.maxPathBytes,
      max_total_bytes: limits.maxTotalBytes,
    },
    local_staging_root: localStagingRoot,
    location: {
      alias,
      kind: "ssh",
      remote_root_base64: rootBase64,
      remote_root_utf8: remoteRoot,
    },
    remote_required_commands: REMOTE_REQUIRED_COMMANDS,
    remote_inventory_temp: `/tmp/yuansheng-ys-trace-inventory-${input.runId}`,
    remote_temp_template: `/tmp/yuansheng-ys-trace-${input.runId}.XXXXXXXX`,
    run_id: input.runId,
    session_binding_sha256: sessionBindingSha256,
    sftp: {
      argv_prefix: [sftp, "-o", "BatchMode=yes", "-b", "-", "--", alias],
      batch_protocol: "safe-object-id-get-v1",
    },
  });
  return freezeSnapshot({
    plan,
    plan_sha256: canonicalizeJson(plan).sha256,
  });
}

export function createSshTransportPlan(
  input: CreateSshTransportPlanInput,
): SshTransportPlanEnvelope {
  if (!RUN_ID.test(input.runId)) {
    fail("input_invalid", "runId must contain exactly 32 lowercase hexadecimal characters");
  }
  if (input.sessionId.length === 0 || input.sessionId.includes("\0")) {
    fail("input_invalid", "sessionId must be non-empty");
  }
  return buildSshTransportPlan({
    alias: requireAlias(input.alias),
    limits: resolveSshTransportLimits(input.limits),
    localStagingRoot: requireAbsoluteLocalPath(input.localStagingRoot, "localStagingRoot"),
    remoteRoot: requireRemoteRoot(input.remoteRoot),
    runId: input.runId,
    sessionBindingSha256: sha256Hex(UTF8_ENCODER.encode(input.sessionId)),
    sftpExecutable: requireAbsoluteLocalPath(input.sftpExecutable, "sftpExecutable"),
    sftpExecutableSha256: requireSha256(input.sftpExecutableSha256, "sftpExecutableSha256"),
    sshExecutable: requireAbsoluteLocalPath(input.sshExecutable, "sshExecutable"),
    sshExecutableSha256: requireSha256(input.sshExecutableSha256, "sshExecutableSha256"),
  });
}

function decodeAscii(bytes: Uint8Array, label: string, maximumBytes = 128): string {
  if (bytes.byteLength > maximumBytes) {
    fail("inventory_rejected", `${label} exceeds its field size limit`);
  }
  let value: string;
  try {
    value = UTF8_DECODER.decode(bytes);
  } catch {
    fail("inventory_rejected", `${label} must contain ASCII text`);
  }
  if ([...value].some((character) => character.charCodeAt(0) > 0x7f)) {
    fail("inventory_rejected", `${label} must contain ASCII text`);
  }
  return value;
}

function splitNul(bytes: Uint8Array): readonly Uint8Array[] {
  if (bytes.byteLength === 0 || bytes.at(-1) !== 0) {
    fail("inventory_rejected", "The inventory framing is truncated");
  }
  const fields: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if (bytes[index] === 0) {
      fields.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  return fields;
}

function splitNulPrefix(
  bytes: Uint8Array,
  fieldCount: number,
  maximumPrefixBytes: number,
): Readonly<{ fields: readonly Uint8Array[]; nextOffset: number }> {
  const fields: Uint8Array[] = [];
  let start = 0;
  const limit = Math.min(bytes.byteLength, maximumPrefixBytes);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] !== 0) {
      continue;
    }
    fields.push(bytes.subarray(start, index));
    start = index + 1;
    if (fields.length === fieldCount) {
      return { fields, nextOffset: start };
    }
  }
  fail("inventory_rejected", "The stage response has no complete bounded header");
}

function decodeBase64(value: string, label: string): Uint8Array {
  if (value.length === 0 || !BASE64.test(value)) {
    fail("inventory_rejected", `${label} is not canonical base64`);
  }
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (Buffer.from(bytes).toString("base64") !== value) {
    fail("inventory_rejected", `${label} is not canonical base64`);
  }
  return bytes;
}

function requireDecimal(value: string, label: string): bigint {
  if (!DECIMAL.test(value)) {
    fail("inventory_rejected", `${label} must be a canonical non-negative decimal integer`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_SAFE_INTEGER) {
    fail("inventory_rejected", `${label} exceeds the supported integer range`);
  }
  return parsed;
}

function requireUnsigned64(value: string, label: string): bigint {
  if (!DECIMAL.test(value)) {
    fail("inventory_rejected", `${label} must be a canonical unsigned integer`);
  }
  const parsed = BigInt(value);
  if (parsed > UNSIGNED_64_MAX) {
    fail("inventory_rejected", `${label} exceeds the unsigned 64-bit range`);
  }
  return parsed;
}

function requireSignedDecimal(value: string, label: string): void {
  if (!SIGNED_DECIMAL.test(value)) {
    fail("inventory_rejected", `${label} must be a canonical decimal integer`);
  }
  const parsed = BigInt(value);
  if (parsed < SIGNED_64_MIN || parsed > SIGNED_64_MAX) {
    fail("inventory_rejected", `${label} exceeds the signed 64-bit range`);
  }
}

function requireMode(value: string, expectedType: SshInventoryEntryV1["type"]): void {
  if (!HEXADECIMAL.test(value)) {
    fail("inventory_rejected", "mode must be canonical lowercase hexadecimal");
  }
  const fileType = BigInt(`0x${value}`) & 0xf000n;
  const expected = expectedType === "directory" ? 0x4000n : 0x8000n;
  if (fileType !== expected) {
    fail("inventory_rejected", "mode does not match the declared entry type");
  }
}

function pathDepth(bytes: Uint8Array): number {
  let depth = 1;
  for (const byte of bytes) {
    if (byte === 0x2f) {
      depth += 1;
    }
  }
  return depth;
}

function requireSafeRelativePath(bytes: Uint8Array, limits: SshTransportLimits): void {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.maxPathBytes || bytes[0] === 0x2f) {
    fail("inventory_rejected", "An inventory path is empty, absolute, or too long");
  }
  let segmentStart = 0;
  for (let index = 0; index <= bytes.byteLength; index += 1) {
    const byte = bytes[index];
    if (byte === 0) {
      fail("inventory_rejected", "An inventory path contains NUL");
    }
    if (index !== bytes.byteLength && byte !== 0x2f) {
      continue;
    }
    const segment = bytes.subarray(segmentStart, index);
    if (
      segment.byteLength === 0 ||
      (segment.byteLength === 1 && segment[0] === 0x2e) ||
      (segment.byteLength === 2 && segment[0] === 0x2e && segment[1] === 0x2e)
    ) {
      fail("inventory_rejected", "An inventory path contains an unsafe segment");
    }
    segmentStart = index + 1;
  }
  if (pathDepth(bytes) > limits.maxDepth) {
    fail("inventory_rejected", "An inventory path exceeds the approved depth");
  }
}

function utf8Path(bytes: Uint8Array): string | null {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

function parentBase64(bytes: Uint8Array): string | null {
  for (let index = bytes.byteLength - 1; index >= 0; index -= 1) {
    if (bytes[index] === 0x2f) {
      return Buffer.from(bytes.subarray(0, index)).toString("base64");
    }
  }
  return null;
}

function limitsFromPlan(plan: SshTransportPlanV1): SshTransportLimits {
  return {
    commandTimeoutMilliseconds: plan.limits.command_timeout_milliseconds,
    maxDepth: plan.limits.max_depth,
    maxEntries: plan.limits.max_entries,
    maxFileBytes: plan.limits.max_file_bytes,
    maxFiles: plan.limits.max_files,
    maxPathBytes: plan.limits.max_path_bytes,
    maxTotalBytes: plan.limits.max_total_bytes,
  };
}

export function parseSshInventory(
  bytes: Uint8Array,
  plan: SshTransportPlanEnvelope,
): SshInventoryEnvelope {
  if (bytes.byteLength > plan.plan.commands.inventory.maximum_stdout_bytes) {
    fail("inventory_rejected", "The inventory exceeds the approved output bound");
  }
  const fields = splitNul(bytes);
  let index = 0;
  if (decodeAscii(fields[index++] ?? new Uint8Array(), "inventory header") !== INVENTORY_MAGIC) {
    fail("inventory_rejected", "The inventory header is invalid");
  }
  const limits = limitsFromPlan(plan.plan);
  const entries: SshInventoryEntryV1[] = [];
  const pathBytes = new Map<string, Uint8Array>();
  const entryTypes = new Map<string, SshInventoryEntryV1["type"]>();
  let declaredDirectories: number | undefined;
  let declaredFiles: number | undefined;
  let declaredTotal: bigint | undefined;
  let files = 0;
  let directories = 0;
  let total = 0n;

  while (index < fields.length) {
    const marker = decodeAscii(fields[index++] ?? new Uint8Array(), "inventory marker");
    if (marker === "END") {
      declaredDirectories = Number(
        requireDecimal(
          decodeAscii(fields[index++] ?? new Uint8Array(), "directory count"),
          "directory count",
        ),
      );
      declaredFiles = Number(
        requireDecimal(
          decodeAscii(fields[index++] ?? new Uint8Array(), "file count"),
          "file count",
        ),
      );
      declaredTotal = requireDecimal(
        decodeAscii(fields[index++] ?? new Uint8Array(), "total file bytes"),
        "total file bytes",
      );
      if (index !== fields.length) {
        fail("inventory_rejected", "The inventory contains data after its trailer");
      }
      break;
    }
    if (marker !== "D" && marker !== "F") {
      fail("inventory_rejected", "The inventory contains an unsupported entry type");
    }
    if (entries.length >= limits.maxEntries) {
      fail("inventory_rejected", "The inventory exceeds the approved entry limit");
    }
    const pathBase64 = decodeAscii(
      fields[index++] ?? new Uint8Array(),
      "path_base64",
      Math.ceil(limits.maxPathBytes / 3) * 4,
    );
    const rawPath = decodeBase64(pathBase64, "path_base64");
    requireSafeRelativePath(rawPath, limits);
    if (pathBytes.has(pathBase64)) {
      fail("inventory_rejected", "The inventory repeats a logical path");
    }
    const previous = entries.at(-1);
    if (previous !== undefined) {
      const previousBytes = pathBytes.get(previous.path_base64);
      if (previousBytes === undefined || Buffer.compare(previousBytes, rawPath) >= 0) {
        fail("inventory_rejected", "The inventory paths are not in strict byte order");
      }
    }
    const device = decodeAscii(fields[index++] ?? new Uint8Array(), "device");
    const inode = decodeAscii(fields[index++] ?? new Uint8Array(), "inode");
    const mode = decodeAscii(fields[index++] ?? new Uint8Array(), "mode");
    const size = decodeAscii(fields[index++] ?? new Uint8Array(), "size");
    const mtime = decodeAscii(fields[index++] ?? new Uint8Array(), "mtime");
    const ctime = decodeAscii(fields[index++] ?? new Uint8Array(), "ctime");
    const digest = decodeAscii(fields[index++] ?? new Uint8Array(), "sha256");
    requireUnsigned64(device, "device");
    requireUnsigned64(inode, "inode");
    const parsedSize = requireDecimal(size, "size");
    requireSignedDecimal(mtime, "mtime");
    requireSignedDecimal(ctime, "ctime");
    const type = marker === "D" ? "directory" : "regular_file";
    requireMode(mode, type);
    let entrySha256: string | null;
    if (type === "directory") {
      directories += 1;
      if (digest !== "-") {
        fail("inventory_rejected", "A directory inventory entry must not contain a digest");
      }
      entrySha256 = null;
    } else {
      files += 1;
      if (files > limits.maxFiles || parsedSize > BigInt(limits.maxFileBytes)) {
        fail("inventory_rejected", "A file inventory entry exceeds the approved limit");
      }
      total += parsedSize;
      if (total > BigInt(limits.maxTotalBytes) || !SHA256.test(digest)) {
        fail("inventory_rejected", "The file inventory digest or total byte count is invalid");
      }
      entrySha256 = digest;
    }
    const parent = parentBase64(rawPath);
    if (parent !== null) {
      if (entryTypes.get(parent) !== "directory") {
        fail("inventory_rejected", "An inventory entry does not have a preceding directory parent");
      }
    }
    const entry: SshInventoryEntryV1 = freezeSnapshot({
      path_base64: pathBase64,
      path_utf8: utf8Path(rawPath),
      sha256: entrySha256,
      status: {
        ctime_seconds: ctime,
        device,
        inode,
        mode_hex: mode,
        mtime_seconds: mtime,
        size,
      },
      type,
    });
    pathBytes.set(pathBase64, rawPath);
    entryTypes.set(pathBase64, type);
    entries.push(entry);
  }

  if (
    declaredDirectories === undefined ||
    declaredFiles === undefined ||
    declaredTotal === undefined ||
    declaredDirectories !== directories ||
    declaredFiles !== files ||
    declaredTotal !== total
  ) {
    fail("inventory_rejected", "The inventory trailer does not match its entries");
  }
  const inventory: SshInventoryV1 = freezeSnapshot({
    contract_version: SSH_TRANSPORT_CONTRACT_VERSION,
    directories,
    entries,
    files,
    kind: "ys_trace_ssh_inventory",
    total_file_bytes: String(total),
  });
  return freezeSnapshot({
    inventory,
    inventory_sha256: canonicalizeJson(inventory).sha256,
    plan_sha256: plan.plan_sha256,
  });
}

function joinNulFields(fields: readonly Uint8Array[]): Uint8Array {
  const length = fields.reduce((total, field) => total + field.byteLength + 1, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const field of fields) {
    bytes.set(field, offset);
    offset += field.byteLength;
    bytes[offset] = 0;
    offset += 1;
  }
  return bytes;
}

export function parseSshStage(
  bytes: Uint8Array,
  plan: SshTransportPlanEnvelope,
  confirmedInventorySha256: string,
): SshStageParseResult {
  requirePlanEnvelope(plan);
  if (!SHA256.test(confirmedInventorySha256)) {
    fail("snapshot_mismatch", "The stage response is not bound to an approved inventory");
  }
  const header = splitNulPrefix(bytes, 5, 1024);
  const headerFields = header.fields;
  let index = 0;
  if (decodeAscii(headerFields[index++] ?? new Uint8Array(), "stage header") !== STAGE_MAGIC) {
    fail("snapshot_mismatch", "The stage response header is invalid");
  }
  const runId = decodeAscii(headerFields[index++] ?? new Uint8Array(), "stage run_id");
  const confirmed = decodeAscii(
    headerFields[index++] ?? new Uint8Array(),
    "confirmed inventory digest",
  );
  const remoteTempBase64 = decodeAscii(
    headerFields[index++] ?? new Uint8Array(),
    "remote_temp_base64",
    512,
  );
  const ownerMarkerSha256 = decodeAscii(
    headerFields[index++] ?? new Uint8Array(),
    "owner marker digest",
  );
  if (
    runId !== plan.plan.run_id ||
    confirmed !== confirmedInventorySha256 ||
    !SHA256.test(ownerMarkerSha256)
  ) {
    fail("snapshot_mismatch", "The stage response identity does not match the approved transfer");
  }
  const remoteTemp = decodeAscii(
    decodeBase64(remoteTempBase64, "remote_temp_base64"),
    "remote_temp",
    256,
  );
  const cleanupLease = validateSshRemoteCleanupLease(
    {
      confirmed_inventory_sha256: confirmed,
      owner_marker_sha256: ownerMarkerSha256,
      plan_sha256: plan.plan_sha256,
      remote_temp: remoteTemp,
      remote_temp_base64: remoteTempBase64,
      run_id: runId,
    },
    plan,
    confirmedInventorySha256,
  );

  try {
    if (bytes.byteLength > plan.plan.commands.stage.maximum_stdout_bytes) {
      fail("snapshot_mismatch", "The stage response exceeds its approved output bound");
    }
    const fields = splitNul(bytes.subarray(header.nextOffset));
    index = 0;
    const inventoryStart = index;
    if (decodeAscii(fields[index++] ?? new Uint8Array(), "inventory header") !== INVENTORY_MAGIC) {
      fail("snapshot_mismatch", "The stage response does not contain an inventory");
    }
    while (index < fields.length) {
      const marker = decodeAscii(fields[index++] ?? new Uint8Array(), "stage inventory marker");
      if (marker === "END") {
        index += 3;
        if (index > fields.length) {
          fail("snapshot_mismatch", "The stage inventory trailer is truncated");
        }
        break;
      }
      if (marker !== "D" && marker !== "F") {
        fail("snapshot_mismatch", "The stage inventory contains an unsupported entry type");
      }
      index += 8;
      if (index > fields.length) {
        fail("snapshot_mismatch", "A stage inventory entry is truncated");
      }
    }
    const inventory = parseSshInventory(joinNulFields(fields.slice(inventoryStart, index)), plan);
    if (inventory.inventory_sha256 !== confirmedInventorySha256) {
      fail("source_changed", "The remote source changed after inventory confirmation");
    }
    if (decodeAscii(fields[index++] ?? new Uint8Array(), "object header") !== "OBJECTS") {
      fail("snapshot_mismatch", "The stage response does not contain an object list");
    }
    const objects: SshStagedObjectV1[] = [];
    let objectTrailerSeen = false;
    while (index < fields.length) {
      const marker = decodeAscii(fields[index++] ?? new Uint8Array(), "object marker");
      if (marker === "END_OBJECTS") {
        const declaredFiles = Number(
          requireDecimal(
            decodeAscii(fields[index++] ?? new Uint8Array(), "object file count"),
            "object file count",
          ),
        );
        const declaredTotal = requireDecimal(
          decodeAscii(fields[index++] ?? new Uint8Array(), "object total bytes"),
          "object total bytes",
        );
        if (
          index !== fields.length ||
          declaredFiles !== objects.length ||
          declaredTotal !== BigInt(inventory.inventory.total_file_bytes)
        ) {
          fail("snapshot_mismatch", "The staged object trailer does not match the inventory");
        }
        objectTrailerSeen = true;
        break;
      }
      if (marker !== "O") {
        fail("snapshot_mismatch", "The stage response contains an unsupported object record");
      }
      const objectId = decodeAscii(fields[index++] ?? new Uint8Array(), "object_id");
      const size = decodeAscii(fields[index++] ?? new Uint8Array(), "object size");
      const digest = decodeAscii(fields[index++] ?? new Uint8Array(), "object digest");
      requireDecimal(size, "object size");
      const expectedId = safeObjectId(objects.length + 1);
      if (objectId !== expectedId || !OBJECT_ID.test(objectId) || !SHA256.test(digest)) {
        fail("snapshot_mismatch", "A staged object identifier or digest is invalid");
      }
      objects.push(freezeSnapshot({ object_id: objectId, sha256: digest, size }));
    }
    if (!objectTrailerSeen) {
      fail("snapshot_mismatch", "The staged object list has no complete trailer");
    }
    const inventoryFiles = inventory.inventory.entries.filter(
      (entry) => entry.type === "regular_file",
    );
    if (
      objects.length !== inventoryFiles.length ||
      objects.some(
        (object, objectIndex) =>
          object.size !== inventoryFiles[objectIndex]?.status.size ||
          object.sha256 !== inventoryFiles[objectIndex]?.sha256,
      )
    ) {
      fail("snapshot_mismatch", "The staged objects do not exactly match the inventory files");
    }
    const stage: SshStageV1 = freezeSnapshot({
      confirmed_inventory_sha256: confirmedInventorySha256,
      contract_version: SSH_TRANSPORT_CONTRACT_VERSION,
      inventory_sha256: inventory.inventory_sha256,
      kind: "ys_trace_ssh_stage",
      objects,
      owner_marker_sha256: ownerMarkerSha256,
      plan_sha256: plan.plan_sha256,
      remote_temp: remoteTemp,
      remote_temp_base64: remoteTempBase64,
      run_id: runId,
      total_file_bytes: inventory.inventory.total_file_bytes,
    });
    const stageEnvelope = freezeSnapshot({
      inventory,
      stage,
      stage_sha256: canonicalizeJson(stage).sha256,
    });
    return freezeSnapshot({ cleanup_lease: cleanupLease, ok: true as const, stage: stageEnvelope });
  } catch (error) {
    const sourceChanged = error instanceof SshTransportError && error.code === "source_changed";
    const errorMessage =
      error instanceof Error ? error.message : "The staged snapshot could not be validated";
    return freezeSnapshot({
      cleanup_lease: cleanupLease,
      error_code: sourceChanged ? ("source_changed" as const) : ("snapshot_mismatch" as const),
      error_message: errorMessage,
      ok: false as const,
    });
  }
}

export function parseSshCleanup(
  bytes: Uint8Array,
  expected: Readonly<{
    cleanupLease: SshRemoteCleanupLeaseV1;
    plan: SshTransportPlanEnvelope;
  }>,
): SshCleanupStatus {
  const cleanupLease = validateSshRemoteCleanupLease(expected.cleanupLease, expected.plan);
  if (bytes.byteLength > expected.plan.plan.commands.cleanup.maximum_stdout_bytes) {
    fail("cleanup_failed", "The remote cleanup response exceeds its approved output bound");
  }
  const fields = splitNul(bytes);
  if (fields.length !== 5) {
    fail("cleanup_failed", "The remote cleanup response has invalid framing");
  }
  const values = fields.map((field, index) =>
    decodeAscii(field, `cleanup field ${index}`, index === 2 ? 512 : 128),
  );
  if (
    values[0] !== CLEANUP_MAGIC ||
    values[1] !== cleanupLease.run_id ||
    values[2] !== cleanupLease.remote_temp_base64 ||
    values[3] !== cleanupLease.owner_marker_sha256 ||
    values[4] !== "REMOVED"
  ) {
    fail("cleanup_failed", "The remote cleanup response does not match the staged snapshot");
  }
  return freezeSnapshot({
    local_staging_removed: false,
    remote_temp_removed: true,
    residual_paths: [],
  });
}

function safeObjectId(index: number): string {
  return `f${String(index).padStart(8, "0")}`;
}

function requireRemoteTemp(value: string, runId: string): string {
  const prefix = `/tmp/yuansheng-ys-trace-${runId}.`;
  const suffix = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  if (!/^[A-Za-z0-9]{8}$/u.test(suffix)) {
    fail("snapshot_mismatch", "The remote transport directory is not bound to this run");
  }
  return value;
}

export function validateSshRemoteCleanupLease(
  lease: SshRemoteCleanupLeaseV1,
  plan: SshTransportPlanEnvelope,
  confirmedInventorySha256?: string,
): SshRemoteCleanupLeaseV1 {
  requirePlanEnvelope(plan);
  if (
    lease.plan_sha256 !== plan.plan_sha256 ||
    lease.run_id !== plan.plan.run_id ||
    !SHA256.test(lease.confirmed_inventory_sha256) ||
    (confirmedInventorySha256 !== undefined &&
      lease.confirmed_inventory_sha256 !== confirmedInventorySha256) ||
    !SHA256.test(lease.owner_marker_sha256) ||
    lease.remote_temp_base64.length > 512
  ) {
    fail("snapshot_mismatch", "The remote cleanup lease is not bound to the approved transfer");
  }
  const remoteTemp = decodeAscii(
    decodeBase64(lease.remote_temp_base64, "remote_temp_base64"),
    "remote_temp",
    256,
  );
  if (
    remoteTemp !== lease.remote_temp ||
    requireRemoteTemp(remoteTemp, plan.plan.run_id) !== remoteTemp
  ) {
    fail("snapshot_mismatch", "The remote cleanup lease directory encoding is invalid");
  }
  const expectedMarkerSha256 = sha256Hex(
    joinNulFields(
      ["YS_TRACE_SSH_OWNER_V1", lease.run_id, lease.remote_temp_base64].map((value) =>
        UTF8_ENCODER.encode(value),
      ),
    ),
  );
  if (lease.owner_marker_sha256 !== expectedMarkerSha256) {
    fail("snapshot_mismatch", "The remote cleanup lease owner marker is invalid");
  }
  return freezeSnapshot({
    confirmed_inventory_sha256: lease.confirmed_inventory_sha256,
    owner_marker_sha256: lease.owner_marker_sha256,
    plan_sha256: lease.plan_sha256,
    remote_temp: remoteTemp,
    remote_temp_base64: lease.remote_temp_base64,
    run_id: lease.run_id,
  });
}

function cleanupLeaseFromStage(
  stage: SshStageEnvelope,
  plan: SshTransportPlanEnvelope,
  confirmedInventorySha256: string,
): SshRemoteCleanupLeaseV1 {
  return validateSshRemoteCleanupLease(
    {
      confirmed_inventory_sha256: stage.stage.confirmed_inventory_sha256,
      owner_marker_sha256: stage.stage.owner_marker_sha256,
      plan_sha256: stage.stage.plan_sha256,
      remote_temp: stage.stage.remote_temp,
      remote_temp_base64: stage.stage.remote_temp_base64,
      run_id: stage.stage.run_id,
    },
    plan,
    confirmedInventorySha256,
  );
}

export function createSshSnapshotMapping(input: {
  readonly plan: SshTransportPlanEnvelope;
  readonly stage: SshStageEnvelope;
}): SshSnapshotMappingEnvelope {
  if (
    input.stage.stage.plan_sha256 !== input.plan.plan_sha256 ||
    input.stage.inventory.plan_sha256 !== input.plan.plan_sha256 ||
    input.stage.stage.inventory_sha256 !== input.stage.inventory.inventory_sha256
  ) {
    fail("plan_mismatch", "The staged inventory does not belong to the transport plan");
  }
  const remoteTemp = requireRemoteTemp(input.stage.stage.remote_temp, input.plan.plan.run_id);
  let fileIndex = 0;
  const entries = input.stage.inventory.inventory.entries.map(
    (entry): SshSnapshotMappingEntryV1 => {
      if (entry.type === "regular_file") {
        fileIndex += 1;
      }
      const objectId = entry.type === "regular_file" ? safeObjectId(fileIndex) : null;
      return freezeSnapshot({ ...entry, object_id: objectId });
    },
  );
  const mapping: SshSnapshotMappingV1 = freezeSnapshot({
    contract_version: SSH_TRANSPORT_CONTRACT_VERSION,
    entries,
    inventory_sha256: input.stage.inventory.inventory_sha256,
    kind: "ys_trace_ssh_snapshot_mapping",
    local_objects_root: posix.join(input.plan.plan.local_staging_root, "objects"),
    local_tree_root: posix.join(input.plan.plan.local_staging_root, "tree"),
    plan_sha256: input.plan.plan_sha256,
    remote_temp: remoteTemp,
    stage_sha256: input.stage.stage_sha256,
  });
  return freezeSnapshot({
    mapping,
    mapping_sha256: canonicalizeJson(mapping).sha256,
  });
}

function requirePlanEnvelope(plan: SshTransportPlanEnvelope): SshTransportPlanEnvelope {
  if (
    !SHA256.test(plan.plan_sha256) ||
    canonicalizeJson(plan.plan).sha256 !== plan.plan_sha256 ||
    plan.plan.contract_version !== SSH_TRANSPORT_CONTRACT_VERSION ||
    plan.plan.kind !== "ys_trace_ssh_transport_plan" ||
    !RUN_ID.test(plan.plan.run_id) ||
    !SHA256.test(plan.plan.session_binding_sha256) ||
    !SHA256.test(plan.plan.executable_sha256?.sftp ?? "") ||
    !SHA256.test(plan.plan.executable_sha256?.ssh ?? "")
  ) {
    fail("plan_mismatch", "The transport plan envelope is not canonical or supported");
  }
  requireAlias(plan.plan.location.alias);
  const remoteRoot = requireRemoteRoot(plan.plan.location.remote_root_utf8);
  if (encoded(remoteRoot) !== plan.plan.location.remote_root_base64) {
    fail("plan_mismatch", "The encoded remote root does not match the transport plan");
  }
  requireAbsoluteLocalPath(plan.plan.local_staging_root, "localStagingRoot");
  const ssh = requireAbsoluteLocalPath(plan.plan.executables.ssh, "sshExecutable");
  const sftp = requireAbsoluteLocalPath(plan.plan.executables.sftp, "sftpExecutable");
  for (const [name, command] of Object.entries(plan.plan.commands)) {
    if (
      command.operation !== name ||
      command.stdin_sha256 !== SSH_REMOTE_SCRIPT_SHA256 ||
      command.argv[0] !== ssh ||
      command.argv.some((argument) => argument.includes("\0")) ||
      !Number.isSafeInteger(command.maximum_stdout_bytes) ||
      command.maximum_stdout_bytes <= 0
    ) {
      fail("plan_mismatch", "The transport command plan is not bound to the fixed SSH script");
    }
  }
  if (plan.plan.sftp.argv_prefix[0] !== sftp) {
    fail("plan_mismatch", "The SFTP command prefix is not bound to its executable");
  }
  const expected = buildSshTransportPlan({
    alias: plan.plan.location.alias,
    limits: resolveSshTransportLimits(limitsFromPlan(plan.plan)),
    localStagingRoot: plan.plan.local_staging_root,
    remoteRoot,
    runId: plan.plan.run_id,
    sessionBindingSha256: plan.plan.session_binding_sha256,
    sftpExecutable: sftp,
    sftpExecutableSha256: plan.plan.executable_sha256.sftp,
    sshExecutable: ssh,
    sshExecutableSha256: plan.plan.executable_sha256.ssh,
  });
  if (canonicalizeJson(expected.plan).text !== canonicalizeJson(plan.plan).text) {
    fail("plan_mismatch", "The transport plan differs from the fixed plan construction");
  }
  return plan;
}

function requireInventoryEnvelope(
  inventory: SshInventoryEnvelope,
  plan: SshTransportPlanEnvelope,
): SshInventoryEnvelope {
  if (
    inventory.plan_sha256 !== plan.plan_sha256 ||
    !SHA256.test(inventory.inventory_sha256) ||
    canonicalizeJson(inventory.inventory).sha256 !== inventory.inventory_sha256 ||
    inventory.inventory.contract_version !== SSH_TRANSPORT_CONTRACT_VERSION ||
    inventory.inventory.kind !== "ys_trace_ssh_inventory" ||
    inventory.inventory.entries.length !==
      inventory.inventory.directories + inventory.inventory.files
  ) {
    fail("snapshot_mismatch", "The inventory envelope is not canonical or plan-bound");
  }
  const limits = limitsFromPlan(plan.plan);
  const paths = new Map<string, Uint8Array>();
  const types = new Map<string, SshInventoryEntryV1["type"]>();
  let previousPath: Uint8Array | undefined;
  let directories = 0;
  let files = 0;
  let total = 0n;
  for (const entry of inventory.inventory.entries) {
    const rawPath = decodeBase64(entry.path_base64, "path_base64");
    requireSafeRelativePath(rawPath, limits);
    if (
      paths.has(entry.path_base64) ||
      Buffer.compare(previousPath ?? new Uint8Array(), rawPath) >= 0
    ) {
      fail("snapshot_mismatch", "The inventory envelope contains duplicate or unordered paths");
    }
    const expectedUtf8 = utf8Path(rawPath);
    if (entry.path_utf8 !== expectedUtf8) {
      fail("snapshot_mismatch", "The inventory UTF-8 path view does not match its raw bytes");
    }
    const parent = parentBase64(rawPath);
    if (parent !== null && types.get(parent) !== "directory") {
      fail("snapshot_mismatch", "The inventory envelope has a missing directory parent");
    }
    requireUnsigned64(entry.status.device, "device");
    requireUnsigned64(entry.status.inode, "inode");
    const size = requireDecimal(entry.status.size, "size");
    requireSignedDecimal(entry.status.mtime_seconds, "mtime");
    requireSignedDecimal(entry.status.ctime_seconds, "ctime");
    requireMode(entry.status.mode_hex, entry.type);
    if (entry.type === "directory") {
      directories += 1;
      if (entry.sha256 !== null) {
        fail("snapshot_mismatch", "A directory inventory entry contains a digest");
      }
    } else {
      files += 1;
      total += size;
      if (
        files > limits.maxFiles ||
        size > BigInt(limits.maxFileBytes) ||
        total > BigInt(limits.maxTotalBytes) ||
        entry.sha256 === null ||
        !SHA256.test(entry.sha256)
      ) {
        fail("snapshot_mismatch", "A file inventory entry exceeds the approved limits");
      }
    }
    paths.set(entry.path_base64, rawPath);
    types.set(entry.path_base64, entry.type);
    previousPath = rawPath;
  }
  if (
    inventory.inventory.entries.length > limits.maxEntries ||
    inventory.inventory.directories !== directories ||
    inventory.inventory.files !== files ||
    inventory.inventory.total_file_bytes !== String(total)
  ) {
    fail("snapshot_mismatch", "The inventory envelope totals do not match its entries");
  }
  return inventory;
}

function requireStageEnvelope(
  stage: SshStageEnvelope,
  plan: SshTransportPlanEnvelope,
  confirmedInventory: SshInventoryEnvelope,
): SshStageEnvelope {
  const inventory = requireInventoryEnvelope(stage.inventory, plan);
  if (
    !SHA256.test(stage.stage_sha256) ||
    canonicalizeJson(stage.stage).sha256 !== stage.stage_sha256 ||
    stage.stage.contract_version !== SSH_TRANSPORT_CONTRACT_VERSION ||
    stage.stage.kind !== "ys_trace_ssh_stage" ||
    stage.stage.plan_sha256 !== plan.plan_sha256 ||
    stage.stage.run_id !== plan.plan.run_id ||
    stage.stage.confirmed_inventory_sha256 !== confirmedInventory.inventory_sha256 ||
    stage.stage.inventory_sha256 !== confirmedInventory.inventory_sha256 ||
    inventory.inventory_sha256 !== confirmedInventory.inventory_sha256 ||
    stage.stage.total_file_bytes !== inventory.inventory.total_file_bytes
  ) {
    fail("snapshot_mismatch", "The stage envelope is not canonical or inventory-bound");
  }
  cleanupLeaseFromStage(stage, plan, confirmedInventory.inventory_sha256);
  const files = inventory.inventory.entries.filter((entry) => entry.type === "regular_file");
  if (
    stage.stage.objects.length !== files.length ||
    stage.stage.objects.some((object, index) => {
      const file = files[index];
      return (
        file === undefined ||
        object.object_id !== safeObjectId(index + 1) ||
        object.size !== file.status.size ||
        object.sha256 !== file.sha256
      );
    })
  ) {
    fail("snapshot_mismatch", "The stage object mapping differs from its inventory");
  }
  return stage;
}

function requireStageRejection(
  rejection: SshStageRejection,
  plan: SshTransportPlanEnvelope,
  confirmedInventory: SshInventoryEnvelope,
): SshStageRejection {
  if (
    rejection.ok !== false ||
    (rejection.error_code !== "snapshot_mismatch" && rejection.error_code !== "source_changed") ||
    typeof rejection.error_message !== "string" ||
    rejection.error_message.length === 0 ||
    rejection.error_message.length > 1024 ||
    rejection.error_message.includes("\0")
  ) {
    fail("snapshot_mismatch", "The rejected stage result is invalid");
  }
  const cleanupLease = validateSshRemoteCleanupLease(
    rejection.cleanup_lease,
    plan,
    confirmedInventory.inventory_sha256,
  );
  return freezeSnapshot({
    cleanup_lease: cleanupLease,
    error_code: rejection.error_code,
    error_message: rejection.error_message,
    ok: false as const,
  });
}

function requireMappingEnvelope(
  mapping: SshSnapshotMappingEnvelope,
  plan: SshTransportPlanEnvelope,
  stage: SshStageEnvelope,
): SshSnapshotMappingEnvelope {
  if (
    !SHA256.test(mapping.mapping_sha256) ||
    canonicalizeJson(mapping.mapping).sha256 !== mapping.mapping_sha256 ||
    mapping.mapping.contract_version !== SSH_TRANSPORT_CONTRACT_VERSION ||
    mapping.mapping.kind !== "ys_trace_ssh_snapshot_mapping" ||
    mapping.mapping.plan_sha256 !== plan.plan_sha256 ||
    mapping.mapping.inventory_sha256 !== stage.inventory.inventory_sha256 ||
    mapping.mapping.stage_sha256 !== stage.stage_sha256
  ) {
    fail("snapshot_mismatch", "The snapshot mapping envelope is not canonical or plan-bound");
  }
  const expected = createSshSnapshotMapping({
    plan,
    stage,
  });
  if (expected.mapping_sha256 !== mapping.mapping_sha256) {
    fail("snapshot_mismatch", "The snapshot mapping differs from the bound inventory mapping");
  }
  return expected;
}

export function createSshTransportState(
  plan: SshTransportPlanEnvelope,
  binding: Readonly<{ runId: string; sessionId: string }>,
): SshTransportState {
  requirePlanEnvelope(plan);
  if (
    binding.runId !== plan.plan.run_id ||
    sha256Hex(UTF8_ENCODER.encode(binding.sessionId)) !== plan.plan.session_binding_sha256
  ) {
    fail("plan_mismatch", "The transport state binding does not match the plan session and run");
  }
  return freezeSnapshot({ phase: "awaiting_plan_approval", plan });
}

export function assertApprovedSshTransportState(state: SshTransportState): SshTransportState {
  requirePlanEnvelope(state.plan);
  if (state.phase === "awaiting_plan_approval" || !APPROVED_TRANSPORT_STATES.has(state)) {
    fail("state_invalid", "The transport state has not received its exact plan approval");
  }
  return state;
}

function preserveApproval<T extends SshTransportState>(source: SshTransportState, target: T): T {
  if (APPROVED_TRANSPORT_STATES.has(source)) {
    APPROVED_TRANSPORT_STATES.add(target);
  }
  return target;
}

function requireCleanup(value: SshCleanupStatus): SshCleanupStatus {
  if (value.residual_paths.some((path) => path.length === 0 || path.includes("\0"))) {
    fail("state_invalid", "Cleanup residual paths must be non-empty strings without NUL");
  }
  return freezeSnapshot({
    local_staging_removed: value.local_staging_removed,
    remote_temp_removed: value.remote_temp_removed,
    residual_paths: [...value.residual_paths],
  });
}

export function transitionSshTransport(
  state: SshTransportState,
  event: SshTransportEvent,
): SshTransportState {
  if (event.type === "fail") {
    if (state.phase === "cleaned") {
      fail("state_invalid", "A cleaned transport cannot fail again");
    }
    const cleanupLease =
      "cleanup_lease" in state && state.cleanup_lease !== undefined
        ? { cleanup_lease: state.cleanup_lease }
        : ({} as const);
    return preserveApproval(
      state,
      freezeSnapshot({
        cleanup: requireCleanup(event.cleanup),
        ...cleanupLease,
        error_code: event.error_code,
        phase: "failed" as const,
        plan: state.plan,
      }),
    );
  }
  if (event.type === "clean") {
    if (state.phase === "cleaned") {
      fail("state_invalid", "The transport is already cleaned");
    }
    const cleanup = requireCleanup(event.cleanup);
    if (
      !cleanup.local_staging_removed ||
      !cleanup.remote_temp_removed ||
      cleanup.residual_paths.length !== 0
    ) {
      fail("cleanup_failed", "The transport cleanup left a residual path");
    }
    return preserveApproval(
      state,
      freezeSnapshot({ cleanup, phase: "cleaned" as const, plan: state.plan }),
    );
  }
  if (state.phase === "awaiting_plan_approval" && event.type === "approve_plan") {
    if (event.plan_sha256 !== state.plan.plan_sha256) {
      fail("plan_mismatch", "The approval does not match the transport plan");
    }
    const approved = freezeSnapshot({
      phase: "awaiting_inventory" as const,
      plan: state.plan,
    });
    APPROVED_TRANSPORT_STATES.add(approved);
    return approved;
  }
  if (state.phase === "awaiting_inventory" && event.type === "bind_inventory") {
    const inventory = requireInventoryEnvelope(event.inventory, state.plan);
    return preserveApproval(
      state,
      freezeSnapshot({
        inventory,
        phase: "awaiting_transfer_confirmation" as const,
        plan: state.plan,
      }),
    );
  }
  if (state.phase === "awaiting_transfer_confirmation" && event.type === "confirm_transfer") {
    if (event.inventory_sha256 !== state.inventory.inventory_sha256) {
      fail("snapshot_mismatch", "The transfer confirmation does not match the inventory");
    }
    return preserveApproval(
      state,
      freezeSnapshot({
        inventory: state.inventory,
        phase: "transferring" as const,
        plan: state.plan,
      }),
    );
  }
  if (state.phase === "transferring" && event.type === "reject_stage") {
    const rejection = requireStageRejection(event.rejection, state.plan, state.inventory);
    return preserveApproval(
      state,
      freezeSnapshot({
        cleanup_lease: rejection.cleanup_lease,
        error_code: rejection.error_code,
        error_message: rejection.error_message,
        inventory: state.inventory,
        phase: "cleanup_pending" as const,
        plan: state.plan,
      }),
    );
  }
  if (state.phase === "transferring" && event.type === "bind_stage") {
    const stage = requireStageEnvelope(event.stage, state.plan, state.inventory);
    const cleanupLease = cleanupLeaseFromStage(stage, state.plan, state.inventory.inventory_sha256);
    return preserveApproval(
      state,
      freezeSnapshot({
        cleanup_lease: cleanupLease,
        inventory: state.inventory,
        phase: "downloading" as const,
        plan: state.plan,
        stage,
      }),
    );
  }
  if (state.phase === "downloading" && event.type === "complete_staging") {
    const mapping = requireMappingEnvelope(event.mapping, state.plan, state.stage);
    return preserveApproval(
      state,
      freezeSnapshot({
        cleanup_lease: state.cleanup_lease,
        inventory: state.inventory,
        mapping,
        phase: "staged" as const,
        plan: state.plan,
        stage: state.stage,
      }),
    );
  }
  fail("state_invalid", `Event ${event.type} is invalid while transport is ${state.phase}`);
}

export const SSH_TRANSPORT_PROTOCOL_MARKERS = Object.freeze({
  cleanup: CLEANUP_MAGIC,
  inventory: INVENTORY_MAGIC,
  inventoryCleanup: INVENTORY_CLEANUP_RESULT.trim(),
  probe: PROBE_RESULT.trim(),
  stage: STAGE_MAGIC,
});
