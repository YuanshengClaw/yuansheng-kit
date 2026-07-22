import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";

import {
  canonicalizeJson,
  sha256Hex,
} from "../../../tools/yuansheng-root-cause-blueprint/src/canonical-json";
import type { YuanshengRootCauseBlueprintV1Lite } from "../../../tools/yuansheng-root-cause-blueprint/src/generated/types/yuansheng-root-cause-blueprint-v1-lite";
import { validateYuanshengRootCauseBlueprintV1Lite } from "../../../tools/yuansheng-root-cause-blueprint/src/generated/validators";
import { checkYuanshengRootCauseBlueprintV1Lite } from "../../../tools/yuansheng-root-cause-blueprint/src/semantic-rules";
import {
  type JsonObject,
  type JsonValue,
  parseStrictJson,
} from "../../../tools/yuansheng-root-cause-blueprint/src/strict-json";
import { type ConfirmedHardwareProfile, parseSg2044HardwareProfile } from "./hardware-profile";
import type { PerfDataFileV1 } from "./perf-data-validation-report";
import {
  isTraceFunctionExecutionContext,
  type TraceFunctionExecutionContext,
} from "./trace-workflow";

const UTF8_ENCODER = new TextEncoder();
const SHA256 = /^[0-9a-f]{64}$/u;
const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const RANK = /^[0-9]{3}$/u;
const SAFE_FILE_MODE = 0o600;
const SAFE_DIRECTORY_MODE = 0o700;

const EVIDENCE_DESTINATIONS = {
  annotate: "evidence/annotate.txt",
  hardware_profile: "evidence/hardware-profile.json",
  metadata: "evidence/metadata.json",
  perf_stat: "evidence/perf-stat.txt",
} as const;

const PAYLOAD_FILES = [
  "blueprint.json",
  "claim-to-evidence.json",
  "diagnosis.md",
  EVIDENCE_DESTINATIONS.annotate,
  EVIDENCE_DESTINATIONS.hardware_profile,
  EVIDENCE_DESTINATIONS.perf_stat,
] as const;

const SEALED_FILES = [
  ...PAYLOAD_FILES,
  "machine-validation.json",
  "semantic-validation.json",
  "checksums.json",
] as const;

export type EvidenceKind = keyof typeof EVIDENCE_DESTINATIONS;

export type ReportedEvidenceKind = Exclude<EvidenceKind, "hardware_profile">;

export type ClaimKind = "function_name" | "numeric_value" | "other_factual" | "path";

export type SemanticDimension =
  | "claim_traceability"
  | "explainability"
  | "internal_consistency"
  | "safety_guardrails"
  | "technical_accuracy";

export interface ArtifactIdentity {
  readonly functionName: string;
  readonly rank: string;
  readonly software: string;
  readonly testCase: string;
}

export interface ReportedEvidenceFile extends PerfDataFileV1 {
  readonly kind: ReportedEvidenceKind;
}

export interface HardwareProfileEvidence {
  readonly bytes: string;
  readonly content: Uint8Array;
  readonly profile: ConfirmedHardwareProfile;
  readonly sha256: string;
}

export type EvidenceLocator =
  | null
  | {
      readonly endByteExclusive: string;
      readonly kind: "byte_range";
      readonly startByte: string;
    }
  | {
      readonly endLine: number;
      readonly kind: "line_range";
      readonly startLine: number;
    }
  | {
      readonly kind: "json_pointer";
      readonly pointer: string;
    };

export interface ClaimEvidenceBinding {
  readonly kind: EvidenceKind;
  readonly locator: EvidenceLocator;
}

export interface ClaimBinding {
  readonly claimKind: ClaimKind;
  readonly claimPath: string;
  readonly evidence: readonly ClaimEvidenceBinding[];
}

export interface PrepareBlueprintCandidateInput {
  readonly blueprintBytes: Uint8Array;
  readonly claims: readonly ClaimBinding[];
  readonly context: TraceFunctionExecutionContext;
  readonly diagnosisReport: Uint8Array;
  readonly hardwareProfile: HardwareProfileEvidence;
}

export interface ResolvedTraceFunctionExecutionContext {
  readonly artifactRoot: string;
  readonly contextSha256: string;
  readonly evidence: readonly ReportedEvidenceFile[];
  readonly evidenceRoot: string;
  readonly identity: ArtifactIdentity;
  readonly profileId: string;
  readonly profileSha256: string;
  readonly targetPath: string;
}

export interface SemanticDimensionResult {
  readonly detail: string;
  readonly dimension: SemanticDimension;
  readonly status: "fail" | "pass";
}

export interface FiveDimensionSemanticReview {
  readonly candidateDigest: string;
  readonly dimensions: readonly SemanticDimensionResult[];
  readonly summary: string;
}

export interface PreparedBlueprintCandidate {
  readonly candidateDigest: string;
  readonly kind: "prepared_blueprint_candidate";
  readonly targetPath: string;
}

export interface SealedBlueprintCandidate {
  readonly artifactSha256: string;
  readonly candidateDigest: string;
  readonly kind: "sealed_blueprint_candidate";
  readonly targetPath: string;
}

export type DiscardableBlueprintCandidate = PreparedBlueprintCandidate | SealedBlueprintCandidate;

export interface DiscardedBlueprintCandidate {
  readonly candidateDigest: string;
  readonly kind: "blueprint_candidate_discarded";
  readonly targetPath: string;
}

export interface CandidateReviewEvidence {
  readonly bytes: Uint8Array;
  readonly kind: EvidenceKind;
  readonly path: string;
  readonly sha256: string;
  readonly sourceIdentity: string;
}

export interface CandidateReviewInput {
  readonly blueprintBytes: Uint8Array;
  readonly candidateDigest: string;
  readonly diagnosisReport: Uint8Array;
  readonly evidence: readonly CandidateReviewEvidence[];
  readonly sidecarBytes: Uint8Array;
}

export interface VerifiedSealedCandidate {
  readonly artifactRoot: string;
  readonly artifactSha256: string;
  readonly candidateDigest: string;
  readonly stagingPath: string;
  readonly targetPath: string;
}

interface CopiedEvidence {
  readonly bytes: Uint8Array;
  readonly destination: string;
  readonly kind: EvidenceKind;
  readonly sha256: string;
  readonly sourceIdentity: string;
}

interface PreparedState {
  readonly allowedPayloadFiles: readonly string[];
  readonly artifactRoot: string;
  readonly blueprint: YuanshengRootCauseBlueprintV1Lite;
  readonly candidateDigest: string;
  readonly expectedPayloadManifestBytes: Uint8Array;
  readonly reviewInput: CandidateReviewInput;
  readonly stagingPath: string;
  readonly targetPath: string;
  status: "prepared" | "rejected" | "sealed";
}

interface SealedState {
  readonly artifactRoot: string;
  readonly artifactSha256: string;
  readonly candidateDigest: string;
  published: boolean;
  readonly stagingPath: string;
  readonly targetPath: string;
}

interface FileDigest {
  readonly bytes: string;
  readonly path: string;
  readonly sha256: string;
}

const preparedStates = new WeakMap<PreparedBlueprintCandidate, PreparedState>();
const sealedStates = new WeakMap<SealedBlueprintCandidate, SealedState>();

export class BlueprintPipelineError extends Error {
  readonly code: string;
  readonly residualPath: string | undefined;

  constructor(code: string, message: string, residualPath?: string) {
    super(message);
    this.name = "BlueprintPipelineError";
    this.code = code;
    this.residualPath = residualPath;
  }
}

function fail(code: string, message: string): never {
  throw new BlueprintPipelineError(code, message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) {
    fail("invalid_sha256", `${label} must be a lowercase SHA-256 hexadecimal string`);
  }
}

function assertUnsignedDecimal(value: string, label: string): bigint {
  if (!UNSIGNED_DECIMAL.test(value)) {
    fail("invalid_decimal", `${label} must be a canonical unsigned decimal string`);
  }
  return BigInt(value);
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
  assertPathSegment(`${identity.rank}_${identity.functionName}`, "ranked function directory");
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

async function ensureRealDirectory(path: string, label: string, create: boolean): Promise<void> {
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
      if (!create) {
        fail("directory_not_found", `${label} does not exist`);
      }
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
  const resolved = await realpath(path).catch(() =>
    fail("directory_not_found", `${label} does not exist`),
  );
  if (resolved !== path) {
    fail("symlink_path_forbidden", `${label} must not contain a symbolic-link alias`);
  }
  const status = await stat(path);
  if (!status.isDirectory()) {
    fail("directory_required", `${label} must be a directory`);
  }
}

function assertLogicalPath(path: string): readonly string[] {
  if (path.length === 0 || isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
    fail("invalid_evidence_path", "Evidence paths must be relative POSIX logical paths");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail("invalid_evidence_path", "Evidence paths must not contain empty, dot, or parent segments");
  }
  for (const segment of segments) {
    if (
      hasControlCharacter(segment) ||
      segment.normalize("NFC") !== segment ||
      UTF8_ENCODER.encode(segment).length > 255
    ) {
      fail(
        "invalid_evidence_path",
        "Evidence path segments must be NFC, control-free, and at most 255 UTF-8 bytes",
      );
    }
  }
  return segments;
}

async function readStableRegularFile(root: string, logicalPath: string): Promise<Uint8Array> {
  const segments = assertLogicalPath(logicalPath);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index] ?? "");
    const status = await stat(current, { bigint: true }).catch(() =>
      fail("evidence_not_found", `Reported evidence does not exist: ${logicalPath}`),
    );
    if (index < segments.length - 1) {
      if (!status.isDirectory()) {
        fail("evidence_parent_not_directory", `Evidence parent is not a directory: ${logicalPath}`);
      }
      const resolved = await realpath(current);
      if (resolved !== current) {
        fail("symlink_path_forbidden", `Evidence path traverses a symbolic link: ${logicalPath}`);
      }
      continue;
    }
    const resolved = await realpath(current);
    if (resolved !== current || !status.isFile()) {
      fail("evidence_not_regular", `Evidence must be a non-symlink regular file: ${logicalPath}`);
    }
    const before = status;
    const bytes = new Uint8Array(await readFile(current));
    const after = await stat(current, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      fail("evidence_changed", `Evidence changed while it was being copied: ${logicalPath}`);
    }
    return bytes;
  }
  return fail("invalid_evidence_path", "Evidence path has no file component");
}

async function ensureContainedDirectory(parent: string, name: string): Promise<string> {
  assertPathSegment(name, "artifact directory");
  const path = join(parent, name);
  if (dirname(path) !== parent) {
    fail("path_escape", "Artifact directory escaped its trusted parent");
  }
  const status = await lstat(path).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (status === undefined) {
    await mkdir(path, { mode: SAFE_DIRECTORY_MODE }).catch((error: unknown) => {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    });
  }
  const finalStatus = await lstat(path);
  if (finalStatus.isSymbolicLink() || !finalStatus.isDirectory()) {
    fail("artifact_parent_not_directory", `Artifact parent is not a real directory: ${path}`);
  }
  const resolved = await realpath(path);
  if (resolved !== path) {
    fail("symlink_path_forbidden", `Artifact parent must not be a symbolic link: ${path}`);
  }
  return path;
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

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateBlueprintBytes(bytes: Uint8Array): YuanshengRootCauseBlueprintV1Lite {
  const value = parseStrictJson(bytes);
  if (!validateYuanshengRootCauseBlueprintV1Lite(value)) {
    fail("blueprint_schema_invalid", "Blueprint does not satisfy the v1-lite Schema");
  }
  const blueprint = value as unknown as YuanshengRootCauseBlueprintV1Lite;
  const semanticIssues = checkYuanshengRootCauseBlueprintV1Lite(blueprint);
  if (semanticIssues.length > 0) {
    fail("blueprint_machine_semantics_invalid", JSON.stringify(semanticIssues));
  }
  return blueprint;
}

function assertBlueprintContextBinding(
  blueprint: YuanshengRootCauseBlueprintV1Lite,
  identity: ArtifactIdentity,
): void {
  if (blueprint.section1_basic_info.software !== identity.software) {
    fail(
      "blueprint_software_mismatch",
      "Blueprint software does not match the approved function context",
    );
  }
  if (
    blueprint.section3_key_evidence["3_2_hotspot_evidence"].some(
      (hotspot) => hotspot.hotspot_function !== identity.functionName,
    )
  ) {
    fail(
      "blueprint_function_mismatch",
      "Blueprint hotspot evidence contains a function outside the approved function context",
    );
  }
}

function decodeJsonPointerSegment(segment: string): string {
  if (/~(?:[^01]|$)/u.test(segment)) {
    fail("invalid_json_pointer", "JSON Pointer contains an invalid tilde escape");
  }
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveJsonPointer(value: JsonValue, pointer: string): JsonValue {
  if (!pointer.startsWith("/") || pointer.length < 2) {
    fail("invalid_json_pointer", "Claim paths and JSON locators must be non-root JSON Pointers");
  }
  let current: JsonValue = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodeJsonPointerSegment(rawSegment);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) {
        fail("json_pointer_missing", `JSON Pointer does not select an array element: ${pointer}`);
      }
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        fail("json_pointer_missing", `JSON Pointer is outside the array: ${pointer}`);
      }
      const selected = current[index];
      if (selected === undefined) {
        fail("json_pointer_missing", `JSON Pointer does not resolve: ${pointer}`);
      }
      current = selected;
      continue;
    }
    if (!isJsonObject(current) || !(segment in current)) {
      fail("json_pointer_missing", `JSON Pointer does not resolve: ${pointer}`);
    }
    current = current[segment] as JsonValue;
  }
  return current;
}

function validateLocator(locator: EvidenceLocator, evidence: CopiedEvidence): void {
  if (locator === null) {
    return;
  }
  switch (locator.kind) {
    case "byte_range": {
      const start = assertUnsignedDecimal(locator.startByte, "startByte");
      const end = assertUnsignedDecimal(locator.endByteExclusive, "endByteExclusive");
      if (start >= end || end > BigInt(evidence.bytes.length)) {
        fail("evidence_locator_out_of_bounds", "Evidence byte range is empty or outside the file");
      }
      return;
    }
    case "line_range": {
      if (
        !Number.isSafeInteger(locator.startLine) ||
        !Number.isSafeInteger(locator.endLine) ||
        locator.startLine < 1 ||
        locator.endLine < locator.startLine
      ) {
        fail("evidence_locator_out_of_bounds", "Evidence line range is invalid");
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(evidence.bytes);
      const lineCount = text.length === 0 ? 0 : text.split("\n").length;
      if (locator.endLine > lineCount) {
        fail("evidence_locator_out_of_bounds", "Evidence line range is outside the file");
      }
      return;
    }
    case "json_pointer": {
      const value = parseStrictJson(evidence.bytes);
      resolveJsonPointer(value, locator.pointer);
      return;
    }
  }
}

function makeSidecar(
  blueprint: YuanshengRootCauseBlueprintV1Lite,
  blueprintSha256: string,
  claims: readonly ClaimBinding[],
  evidenceByKind: ReadonlyMap<EvidenceKind, CopiedEvidence>,
): Uint8Array {
  const seenClaims = new Set<string>();
  const sidecarClaims = claims
    .map((claim) => {
      if (seenClaims.has(claim.claimPath)) {
        fail("duplicate_claim", `Duplicate sidecar claim: ${claim.claimPath}`);
      }
      seenClaims.add(claim.claimPath);
      const claimValue = resolveJsonPointer(blueprint as unknown as JsonValue, claim.claimPath);
      if (claimValue === null) {
        fail(
          "null_claim_forbidden",
          `A null gap is not an evidence-backed factual claim: ${claim.claimPath}`,
        );
      }
      if (claim.evidence.length === 0) {
        fail("claim_evidence_required", `Claim has no evidence: ${claim.claimPath}`);
      }
      const seenEvidence = new Set<string>();
      const references = claim.evidence
        .map((binding) => {
          const evidence = evidenceByKind.get(binding.kind);
          if (evidence === undefined) {
            fail(
              "claim_evidence_missing",
              `Claim references absent evidence kind: ${binding.kind}`,
            );
          }
          validateLocator(binding.locator, evidence);
          const referenceKey = canonicalizeJson({
            locator: binding.locator,
            path: evidence.destination,
          }).text;
          if (seenEvidence.has(referenceKey)) {
            fail(
              "duplicate_claim_evidence",
              `Claim repeats an evidence reference: ${claim.claimPath}`,
            );
          }
          seenEvidence.add(referenceKey);
          return {
            locator: binding.locator,
            path: evidence.destination,
            sha256: evidence.sha256,
            source_identity: evidence.sourceIdentity,
          };
        })
        .sort((left, right) =>
          compareText(canonicalizeJson(left).text, canonicalizeJson(right).text),
        );
      return {
        claim_kind: claim.claimKind,
        claim_path: claim.claimPath,
        claim_value_sha256: canonicalizeJson(claimValue).sha256,
        evidence: references,
      };
    })
    .sort((left, right) => compareText(left.claim_path, right.claim_path));

  if (sidecarClaims.length === 0) {
    fail("claim_required", "The claim-to-evidence sidecar must contain at least one claim");
  }
  return canonicalizeJson({
    blueprint_sha256: blueprintSha256,
    claims: sidecarClaims,
    format_version: 1,
    kind: "claim_to_evidence",
  }).bytes;
}

async function digestFiles(root: string, paths: readonly string[]): Promise<readonly FileDigest[]> {
  const uniquePaths = [...new Set(paths)].sort(compareText);
  if (uniquePaths.length !== paths.length) {
    fail("duplicate_artifact_path", "Artifact file list contains duplicate paths");
  }
  const digests: FileDigest[] = [];
  for (const path of uniquePaths) {
    const bytes = new Uint8Array(await readFile(join(root, ...path.split("/"))));
    digests.push({
      bytes: String(bytes.length),
      path,
      sha256: sha256Hex(bytes),
    });
  }
  return digests;
}

function manifestBytes(
  kind: "artifact_checksums" | "candidate_payload",
  files: readonly FileDigest[],
): Uint8Array {
  return canonicalizeJson({ files, format_version: 1, kind }).bytes;
}

async function collectRegularFiles(root: string, current = root): Promise<readonly string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      fail("symlink_path_forbidden", `Candidate contains a symbolic link: ${path}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectRegularFiles(root, path)));
      continue;
    }
    if (!entry.isFile()) {
      fail("special_file_forbidden", `Candidate contains a special file: ${path}`);
    }
    files.push(relative(root, path).split(sep).join("/"));
  }
  return files;
}

function expectedPayloadPaths(hasMetadata: boolean): readonly string[] {
  return hasMetadata ? [...PAYLOAD_FILES, EVIDENCE_DESTINATIONS.metadata] : PAYLOAD_FILES;
}

function expectedSealedPaths(hasMetadata: boolean): readonly string[] {
  return hasMetadata ? [...SEALED_FILES, EVIDENCE_DESTINATIONS.metadata] : SEALED_FILES;
}

function assertExactPaths(actual: readonly string[], expected: readonly string[]): void {
  const normalizedActual = [...actual].sort(compareText);
  const normalizedExpected = [...expected].sort(compareText);
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    fail(
      "artifact_file_set_changed",
      `Artifact file set differs from the sealed set: ${JSON.stringify(normalizedActual)}`,
    );
  }
}

function makePreparedHandle(state: PreparedState): PreparedBlueprintCandidate {
  const handle = Object.freeze({
    candidateDigest: state.candidateDigest,
    kind: "prepared_blueprint_candidate" as const,
    targetPath: state.targetPath,
  });
  preparedStates.set(handle, state);
  return handle;
}

function makeSealedHandle(state: SealedState): SealedBlueprintCandidate {
  const handle = Object.freeze({
    artifactSha256: state.artifactSha256,
    candidateDigest: state.candidateDigest,
    kind: "sealed_blueprint_candidate" as const,
    targetPath: state.targetPath,
  });
  sealedStates.set(handle, state);
  return handle;
}

export function resolveTraceFunctionExecutionContext(
  context: TraceFunctionExecutionContext,
): ResolvedTraceFunctionExecutionContext {
  if (!isTraceFunctionExecutionContext(context)) {
    fail(
      "invalid_execution_context",
      "Blueprint preparation requires an execution context issued by the trace workflow",
    );
  }
  const contextSha256 = canonicalizeJson({
    artifactRoot: context.artifactRoot,
    evidenceRoot: context.evidenceRoot,
    function: context.function,
    planSha256: context.planSha256,
    profile: context.profile,
    reportSha256: context.reportSha256,
    software: context.software,
  }).sha256;
  if (context.contextSha256 !== contextSha256) {
    fail(
      "execution_context_digest_mismatch",
      "Trace execution context differs from its approved JCS digest",
    );
  }
  const identity = Object.freeze({
    functionName: context.function.function,
    rank: context.function.rank,
    software: context.software,
    testCase: context.function.testcase,
  });
  assertIdentity(identity);
  const targetPath = join(
    context.artifactRoot,
    identity.software,
    identity.testCase,
    `${identity.rank}_${identity.functionName}`,
  );
  if (context.function.target !== targetPath) {
    fail(
      "execution_context_target_mismatch",
      "Trace execution context target differs from its approved artifact identity",
    );
  }
  const evidence: ReportedEvidenceFile[] = [
    { ...context.function.annotate, kind: "annotate" },
    { ...context.function.perfStat, kind: "perf_stat" },
  ];
  if (context.function.metadata !== null) {
    evidence.push({ ...context.function.metadata, kind: "metadata" });
  }
  return Object.freeze({
    artifactRoot: context.artifactRoot,
    contextSha256,
    evidence: Object.freeze(evidence),
    evidenceRoot: context.evidenceRoot,
    identity,
    profileId: context.profile.id,
    profileSha256: context.profile.sha256,
    targetPath,
  });
}

export async function prepareBlueprintCandidate(
  input: PrepareBlueprintCandidateInput,
): Promise<PreparedBlueprintCandidate> {
  const context = resolveTraceFunctionExecutionContext(input.context);
  const identity = { ...context.identity };
  const blueprintInputBytes = Uint8Array.from(input.blueprintBytes);
  const diagnosisReportBytes = Uint8Array.from(input.diagnosisReport);
  const claims = structuredClone(input.claims);
  const evidenceDeclarations = context.evidence.map((declaration) => ({ ...declaration }));
  const hardwareProfileContent = Uint8Array.from(input.hardwareProfile.content);
  const hardwareProfileBytes = input.hardwareProfile.bytes;
  const hardwareProfileSha256 = input.hardwareProfile.sha256;
  const hardwareProfile = input.hardwareProfile.profile;

  assertIdentity(identity);
  await ensureRealDirectory(context.artifactRoot, "artifactRoot", true);
  await ensureRealDirectory(context.evidenceRoot, "evidenceRoot", false);

  const blueprintValue = validateBlueprintBytes(blueprintInputBytes);
  assertBlueprintContextBinding(blueprintValue, identity);
  const canonicalBlueprint = canonicalizeJson(blueprintValue);

  const seenEvidence = new Set<EvidenceKind>();
  const copiedEvidence: CopiedEvidence[] = [];
  for (const declaration of evidenceDeclarations) {
    if (seenEvidence.has(declaration.kind)) {
      fail("duplicate_evidence_kind", `Evidence kind appears more than once: ${declaration.kind}`);
    }
    seenEvidence.add(declaration.kind);
    assertSha256(declaration.sha256, `${declaration.kind} evidence hash`);
    const expectedBytes = assertUnsignedDecimal(
      declaration.bytes,
      `${declaration.kind} evidence byte count`,
    );
    const bytes = await readStableRegularFile(context.evidenceRoot, declaration.path);
    if (BigInt(bytes.length) !== expectedBytes || sha256Hex(bytes) !== declaration.sha256) {
      fail(
        "evidence_report_mismatch",
        `Evidence bytes do not match the validated report: ${declaration.path}`,
      );
    }
    copiedEvidence.push({
      bytes,
      destination: EVIDENCE_DESTINATIONS[declaration.kind],
      kind: declaration.kind,
      sha256: declaration.sha256,
      sourceIdentity: declaration.path,
    });
  }
  if (!seenEvidence.has("annotate") || !seenEvidence.has("perf_stat")) {
    fail(
      "required_evidence_missing",
      "A candidate requires one annotate and one perf-stat evidence file",
    );
  }
  assertSha256(hardwareProfileSha256, "hardware profile hash");
  if (hardwareProfileSha256 !== hardwareProfile.sha256) {
    fail(
      "hardware_profile_hash_mismatch",
      "Hardware profile evidence does not match the confirmed profile",
    );
  }
  if (
    context.profileId !== hardwareProfile.id ||
    context.profileSha256 !== hardwareProfile.sha256
  ) {
    fail(
      "execution_context_profile_mismatch",
      "Hardware profile evidence differs from the profile approved by the trace workflow",
    );
  }
  const expectedHardwareBytes = assertUnsignedDecimal(
    hardwareProfileBytes,
    "hardware profile byte count",
  );
  if (
    BigInt(hardwareProfileContent.length) !== expectedHardwareBytes ||
    sha256Hex(hardwareProfileContent) !== hardwareProfileSha256
  ) {
    fail(
      "hardware_profile_hash_mismatch",
      "Hardware profile bytes differ from the confirmed profile",
    );
  }
  const reparsedHardwareProfile = parseSg2044HardwareProfile(hardwareProfileContent);
  if (
    reparsedHardwareProfile.id !== hardwareProfile.id ||
    reparsedHardwareProfile.sha256 !== hardwareProfile.sha256 ||
    canonicalizeJson(reparsedHardwareProfile.profile).sha256 !==
      canonicalizeJson(input.context.profile.facts).sha256
  ) {
    fail(
      "hardware_profile_identity_mismatch",
      "Hardware profile bytes do not match the confirmed profile identity",
    );
  }
  copiedEvidence.push({
    bytes: hardwareProfileContent,
    destination: EVIDENCE_DESTINATIONS.hardware_profile,
    kind: "hardware_profile",
    sha256: hardwareProfileSha256,
    sourceIdentity: `profile:${hardwareProfile.id}`,
  });
  seenEvidence.add("hardware_profile");

  const softwareDirectory = await ensureContainedDirectory(context.artifactRoot, identity.software);
  const testCaseDirectory = await ensureContainedDirectory(softwareDirectory, identity.testCase);
  const targetPath = join(testCaseDirectory, `${identity.rank}_${identity.functionName}`);
  if (dirname(targetPath) !== testCaseDirectory) {
    fail("path_escape", "Artifact target escaped its trusted test-case directory");
  }
  if (targetPath !== context.targetPath) {
    fail("execution_context_target_mismatch", "Artifact target differs from the approved context");
  }

  const stagingPath = await mkdtemp(join(testCaseDirectory, ".ys-trace-candidate-"));
  try {
    const evidenceDirectory = join(stagingPath, "evidence");
    await mkdir(evidenceDirectory, { mode: SAFE_DIRECTORY_MODE });
    await writeExclusive(join(stagingPath, "blueprint.json"), canonicalBlueprint.bytes);
    await writeExclusive(join(stagingPath, "diagnosis.md"), diagnosisReportBytes);
    for (const evidence of copiedEvidence) {
      await writeExclusive(
        join(stagingPath, ...evidence.destination.split("/")),
        Uint8Array.from(evidence.bytes),
      );
    }
    const evidenceByKind = new Map(copiedEvidence.map((evidence) => [evidence.kind, evidence]));
    const sidecarBytes = makeSidecar(
      blueprintValue,
      canonicalBlueprint.sha256,
      claims,
      evidenceByKind,
    );
    await writeExclusive(join(stagingPath, "claim-to-evidence.json"), sidecarBytes);

    const allowedPayloadFiles = expectedPayloadPaths(seenEvidence.has("metadata"));
    assertExactPaths(await collectRegularFiles(stagingPath), allowedPayloadFiles);
    const payloadFiles = await digestFiles(stagingPath, allowedPayloadFiles);
    const expectedPayloadManifestBytes = manifestBytes("candidate_payload", payloadFiles);
    const candidateDigest = sha256Hex(expectedPayloadManifestBytes);
    await syncDirectory(evidenceDirectory);
    await syncDirectory(stagingPath);

    return makePreparedHandle({
      allowedPayloadFiles,
      artifactRoot: context.artifactRoot,
      blueprint: blueprintValue,
      candidateDigest,
      expectedPayloadManifestBytes,
      reviewInput: {
        blueprintBytes: Uint8Array.from(canonicalBlueprint.bytes),
        candidateDigest,
        diagnosisReport: Uint8Array.from(diagnosisReportBytes),
        evidence: copiedEvidence
          .map((evidence) => ({
            bytes: Uint8Array.from(evidence.bytes),
            kind: evidence.kind,
            path: evidence.destination,
            sha256: evidence.sha256,
            sourceIdentity: evidence.sourceIdentity,
          }))
          .sort((left, right) => compareText(left.path, right.path)),
        sidecarBytes: Uint8Array.from(sidecarBytes),
      },
      stagingPath,
      status: "prepared",
      targetPath,
    });
  } catch (error) {
    await rm(stagingPath, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

export function readCandidateReviewInput(
  candidate: PreparedBlueprintCandidate,
): CandidateReviewInput {
  const state = preparedStates.get(candidate);
  if (state === undefined || state.status !== "prepared") {
    fail("invalid_candidate_handle", "Prepared candidate is unknown or no longer reviewable");
  }
  return {
    blueprintBytes: Uint8Array.from(state.reviewInput.blueprintBytes),
    candidateDigest: state.reviewInput.candidateDigest,
    diagnosisReport: Uint8Array.from(state.reviewInput.diagnosisReport),
    evidence: state.reviewInput.evidence.map((evidence) => ({
      bytes: Uint8Array.from(evidence.bytes),
      kind: evidence.kind,
      path: evidence.path,
      sha256: evidence.sha256,
      sourceIdentity: evidence.sourceIdentity,
    })),
    sidecarBytes: Uint8Array.from(state.reviewInput.sidecarBytes),
  };
}

function validateFiveDimensionReview(
  review: FiveDimensionSemanticReview,
  candidateDigest: string,
): Uint8Array {
  if (review.candidateDigest !== candidateDigest) {
    fail("semantic_review_candidate_mismatch", "Semantic review is bound to a different candidate");
  }
  const expectedDimensions: readonly SemanticDimension[] = [
    "claim_traceability",
    "explainability",
    "internal_consistency",
    "safety_guardrails",
    "technical_accuracy",
  ];
  const actualDimensions = review.dimensions.map((result) => result.dimension).sort(compareText);
  if (JSON.stringify(actualDimensions) !== JSON.stringify(expectedDimensions)) {
    fail(
      "semantic_review_dimensions_invalid",
      "Semantic review must contain each dimension exactly once",
    );
  }
  const failed = review.dimensions.filter((result) => result.status !== "pass");
  if (failed.length > 0) {
    fail(
      "semantic_revision_required",
      `Semantic review requires a new candidate: ${failed.map((result) => result.dimension).join(", ")}`,
    );
  }
  return canonicalizeJson({
    candidate_digest: review.candidateDigest,
    dimensions: [...review.dimensions]
      .sort((left, right) => compareText(left.dimension, right.dimension))
      .map((result) => ({
        detail: result.detail,
        dimension: result.dimension,
        status: result.status,
      })),
    format_version: 1,
    kind: "five_dimension_semantic_validation",
    summary: review.summary,
  }).bytes;
}

export async function sealBlueprintCandidate(
  candidate: PreparedBlueprintCandidate,
  semanticReview: FiveDimensionSemanticReview,
): Promise<SealedBlueprintCandidate> {
  const state = preparedStates.get(candidate);
  if (state === undefined || state.status !== "prepared") {
    fail("invalid_candidate_handle", "Prepared candidate is unknown or has already been sealed");
  }
  const actualPaths = await collectRegularFiles(state.stagingPath);
  assertExactPaths(actualPaths, state.allowedPayloadFiles);
  const actualPayload = manifestBytes(
    "candidate_payload",
    await digestFiles(state.stagingPath, state.allowedPayloadFiles),
  );
  if (!equalBytes(actualPayload, state.expectedPayloadManifestBytes)) {
    fail("candidate_changed", "Candidate changed after machine validation");
  }
  validateBlueprintBytes(new Uint8Array(await readFile(join(state.stagingPath, "blueprint.json"))));
  let semanticValidationBytes: Uint8Array;
  try {
    semanticValidationBytes = validateFiveDimensionReview(semanticReview, state.candidateDigest);
  } catch (error) {
    if (error instanceof BlueprintPipelineError && error.code === "semantic_revision_required") {
      state.status = "rejected";
      preparedStates.delete(candidate);
      try {
        await rm(state.stagingPath, { force: true, recursive: true });
      } catch (cleanupError) {
        throw new BlueprintPipelineError(
          "candidate_rejection_cleanup_failed",
          `Rejected candidate could not be removed: ${String(cleanupError)}`,
          state.stagingPath,
        );
      }
    }
    throw error;
  }
  const machineValidationBytes = canonicalizeJson({
    candidate_digest: state.candidateDigest,
    checks: [
      "blueprint_strict_json",
      "blueprint_v1_lite_schema",
      "blueprint_cross_field_rules",
      "claim_to_evidence_binding",
      "evidence_size_and_sha256",
    ],
    format_version: 1,
    kind: "machine_validation",
    status: "pass",
  }).bytes;
  await writeExclusive(join(state.stagingPath, "machine-validation.json"), machineValidationBytes);
  await writeExclusive(
    join(state.stagingPath, "semantic-validation.json"),
    semanticValidationBytes,
  );

  const hasMetadata = state.allowedPayloadFiles.includes(EVIDENCE_DESTINATIONS.metadata);
  const pathsBeforeChecksums = expectedSealedPaths(hasMetadata).filter(
    (path) => path !== "checksums.json",
  );
  const checksumsBytes = manifestBytes(
    "artifact_checksums",
    await digestFiles(state.stagingPath, pathsBeforeChecksums),
  );
  await writeExclusive(join(state.stagingPath, "checksums.json"), checksumsBytes);
  assertExactPaths(await collectRegularFiles(state.stagingPath), expectedSealedPaths(hasMetadata));
  const artifactSha256 = sha256Hex(checksumsBytes);
  await syncDirectory(join(state.stagingPath, "evidence"));
  await syncDirectory(state.stagingPath);
  state.status = "sealed";
  const sealed = makeSealedHandle({
    artifactRoot: state.artifactRoot,
    artifactSha256,
    candidateDigest: state.candidateDigest,
    published: false,
    stagingPath: state.stagingPath,
    targetPath: state.targetPath,
  });
  preparedStates.delete(candidate);
  return sealed;
}

export async function discardBlueprintCandidate(
  candidate: DiscardableBlueprintCandidate,
): Promise<DiscardedBlueprintCandidate> {
  if (candidate.kind === "prepared_blueprint_candidate") {
    const state = preparedStates.get(candidate);
    if (state === undefined || state.status !== "prepared") {
      fail("invalid_candidate_handle", "Candidate is unknown or can no longer be discarded");
    }
    try {
      await rm(state.stagingPath, { force: true, recursive: true });
    } catch (error) {
      throw new BlueprintPipelineError(
        "candidate_discard_cleanup_failed",
        `Candidate could not be discarded: ${String(error)}`,
        state.stagingPath,
      );
    }
    state.status = "rejected";
    preparedStates.delete(candidate);
    return Object.freeze({
      candidateDigest: state.candidateDigest,
      kind: "blueprint_candidate_discarded" as const,
      targetPath: state.targetPath,
    });
  }
  const state = sealedStates.get(candidate);
  if (state === undefined || state.published) {
    fail("invalid_candidate_handle", "Candidate is unknown or can no longer be discarded");
  }
  try {
    await rm(state.stagingPath, { force: true, recursive: true });
  } catch (error) {
    throw new BlueprintPipelineError(
      "candidate_discard_cleanup_failed",
      `Candidate could not be discarded: ${String(error)}`,
      state.stagingPath,
    );
  }
  sealedStates.delete(candidate);
  return Object.freeze({
    candidateDigest: state.candidateDigest,
    kind: "blueprint_candidate_discarded" as const,
    targetPath: state.targetPath,
  });
}

async function verifySealedDirectory(state: SealedState, directoryPath: string): Promise<void> {
  const actualPaths = await collectRegularFiles(directoryPath);
  const hasMetadata = actualPaths.includes(EVIDENCE_DESTINATIONS.metadata);
  const expectedPaths = expectedSealedPaths(hasMetadata);
  assertExactPaths(actualPaths, expectedPaths);
  const pathsBeforeChecksums = expectedPaths.filter((path) => path !== "checksums.json");
  const recomputedChecksums = manifestBytes(
    "artifact_checksums",
    await digestFiles(directoryPath, pathsBeforeChecksums),
  );
  const storedChecksums = new Uint8Array(await readFile(join(directoryPath, "checksums.json")));
  if (
    !equalBytes(recomputedChecksums, storedChecksums) ||
    sha256Hex(storedChecksums) !== state.artifactSha256
  ) {
    fail(
      "sealed_candidate_changed",
      "Sealed candidate checksum manifest no longer matches its files",
    );
  }
  const blueprintBytes = new Uint8Array(await readFile(join(directoryPath, "blueprint.json")));
  const blueprint = validateBlueprintBytes(blueprintBytes);
  if (!equalBytes(canonicalizeJson(blueprint).bytes, blueprintBytes)) {
    fail("blueprint_not_canonical", "Published Blueprint bytes must be RFC 8785 canonical JSON");
  }
  const payloadPaths = expectedPayloadPaths(hasMetadata);
  const payloadManifest = manifestBytes(
    "candidate_payload",
    await digestFiles(directoryPath, payloadPaths),
  );
  if (sha256Hex(payloadManifest) !== state.candidateDigest) {
    fail("candidate_digest_changed", "Final candidate payload differs from the reviewed payload");
  }

  for (const validationFile of ["machine-validation.json", "semantic-validation.json"] as const) {
    const validation = parseStrictJson(
      new Uint8Array(await readFile(join(directoryPath, validationFile))),
    );
    if (!isJsonObject(validation) || validation.candidate_digest !== state.candidateDigest) {
      fail(
        "validation_binding_changed",
        `${validationFile} is not bound to the final candidate digest`,
      );
    }
  }
}

function requireUnpublishedSealedState(candidate: SealedBlueprintCandidate): SealedState {
  const state = sealedStates.get(candidate);
  if (state === undefined || state.published) {
    fail("invalid_candidate_handle", "Sealed candidate is unknown or has already been published");
  }
  return state;
}

function verifiedSealedCandidate(state: SealedState): VerifiedSealedCandidate {
  return {
    artifactRoot: state.artifactRoot,
    artifactSha256: state.artifactSha256,
    candidateDigest: state.candidateDigest,
    stagingPath: state.stagingPath,
    targetPath: state.targetPath,
  };
}

export async function verifySealedBlueprintCandidate(
  candidate: SealedBlueprintCandidate,
): Promise<VerifiedSealedCandidate> {
  const state = requireUnpublishedSealedState(candidate);
  await verifySealedDirectory(state, state.stagingPath);
  return verifiedSealedCandidate(state);
}

export async function verifySealedBlueprintCandidateTarget(
  candidate: SealedBlueprintCandidate,
): Promise<VerifiedSealedCandidate> {
  const state = requireUnpublishedSealedState(candidate);
  await verifySealedDirectory(state, state.targetPath);
  return verifiedSealedCandidate(state);
}

export function markBlueprintCandidatePublished(candidate: SealedBlueprintCandidate): void {
  const state = sealedStates.get(candidate);
  if (state === undefined || state.published) {
    fail("invalid_candidate_handle", "Sealed candidate is unknown or has already been published");
  }
  state.published = true;
}
