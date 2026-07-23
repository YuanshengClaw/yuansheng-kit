import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import type { YuanshengRootCauseBlueprintV1Lite } from "../../../../tools/yuansheng-root-cause-blueprint/src/generated/types/yuansheng-root-cause-blueprint-v1-lite";
import { validateYuanshengRootCauseBlueprintV1Lite } from "../../../../tools/yuansheng-root-cause-blueprint/src/generated/validators";
import { checkYuanshengRootCauseBlueprintV1Lite } from "../../../../tools/yuansheng-root-cause-blueprint/src/semantic-rules";
import { canonicalizeJson, sha256Digest } from "../artifacts/canonical";
import { type JsonValue, parseStrictJson } from "../artifacts/strict-json";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const RANKED_FUNCTION = /^([0-9]{3})_(.+)$/u;
const CLAIM_KINDS = Object.freeze(["function_name", "numeric_value", "other_factual", "path"]);
const EXPECTED_MACHINE_CHECKS = Object.freeze([
  "blueprint_strict_json",
  "blueprint_v1_lite_schema",
  "blueprint_cross_field_rules",
  "claim_to_evidence_binding",
  "evidence_size_and_sha256",
]);
const EXPECTED_SEMANTIC_DIMENSIONS = Object.freeze([
  "claim_traceability",
  "explainability",
  "internal_consistency",
  "safety_guardrails",
  "technical_accuracy",
]);
const BASE_PAYLOAD_FILES = Object.freeze([
  "blueprint.json",
  "claim-to-evidence.json",
  "diagnosis.md",
  "evidence/annotate.txt",
  "evidence/hardware-profile.json",
  "evidence/perf-stat.txt",
]);
const VALIDATION_FILES = Object.freeze(["machine-validation.json", "semantic-validation.json"]);

export interface TraceFunctionIdentity {
  readonly functionName: string;
  readonly rank: string;
  readonly software: string;
  readonly testCase: string;
}

export interface VerifiedEvidenceDigest {
  readonly digest: `sha256:${string}`;
  readonly path: string;
}

export interface VerifiedSealedBlueprint {
  readonly blueprintCanonicalDigest: `sha256:${string}`;
  readonly blueprintRawBlobDigest: `sha256:${string}`;
  readonly candidatePayloadDigest: `sha256:${string}`;
  readonly directoryRealpath: string;
  readonly finalStatus: YuanshengRootCauseBlueprintV1Lite["section7_final_verdict"]["final_status"];
  readonly functionIdentity: TraceFunctionIdentity;
  readonly overallStatus: YuanshengRootCauseBlueprintV1Lite["section1_basic_info"]["overall_status"];
  readonly sealedFunctionDirectoryDigest: `sha256:${string}`;
  readonly sourcePath: string | null;
  readonly validation: {
    readonly claimToEvidenceDigest: `sha256:${string}`;
    readonly diagnosisDigest: `sha256:${string}`;
    readonly evidence: readonly VerifiedEvidenceDigest[];
    readonly machineValidationDigest: `sha256:${string}`;
    readonly semanticValidationDigest: `sha256:${string}`;
  };
}

export interface VerifiedSealedBlueprintSnapshot {
  readonly blueprint: YuanshengRootCauseBlueprintV1Lite;
  readonly blueprintRawBytes: Uint8Array;
}

interface VerifiedState extends VerifiedSealedBlueprintSnapshot {}

interface FileDigest {
  readonly bytes: string;
  readonly path: string;
  readonly sha256: string;
}

interface EvidenceReference {
  readonly locator: JsonValue;
  readonly path: string;
  readonly sha256: string;
  readonly sourceIdentity: string;
}

interface ClaimRecord {
  readonly claimKind: string;
  readonly claimPath: string;
  readonly claimValueSha256: string;
  readonly evidence: readonly EvidenceReference[];
}

const VERIFIED_STATES = new WeakMap<VerifiedSealedBlueprint, VerifiedState>();

export class SealedBlueprintError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SealedBlueprintError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new SealedBlueprintError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    fail("invalid_sealed_json", `${label} contains an unexpected or missing field`);
  }
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail("invalid_sealed_json", `${label} must be an object`);
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("invalid_sealed_json", `${label} must be a non-empty string`);
  }
  return value;
}

function requiredSha256(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!SHA256_HEX.test(digest)) {
    fail("invalid_sealed_json", `${label} must be lowercase SHA-256 hexadecimal`);
  }
  return digest;
}

function prefixedDigest(hex: string): `sha256:${string}` {
  return `sha256:${hex}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCanonicalRelativePath(path: string, label: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.endsWith("/") ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail("invalid_sealed_path", `${label} must be a canonical relative POSIX path`);
  }
}

function assertSafePathSegment(value: string, label: string): void {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    hasControlCharacter ||
    value.normalize("NFC") !== value ||
    UTF8_ENCODER.encode(value).length > 255
  ) {
    fail("function_identity_invalid", `${label} is not a safe normalized path segment`);
  }
}

async function assertExactRealDirectory(directoryPath: string): Promise<string> {
  if (
    !isAbsolute(directoryPath) ||
    normalize(directoryPath) !== directoryPath ||
    resolve(directoryPath) !== directoryPath ||
    parse(directoryPath).root === directoryPath
  ) {
    fail(
      "invalid_sealed_directory",
      "Sealed function directory must be a normalized absolute path",
    );
  }
  const root = parse(directoryPath).root;
  let current = root;
  for (const segment of relative(root, directoryPath).split(sep)) {
    if (segment.length === 0) {
      continue;
    }
    current = join(current, segment);
    const status = await lstat(current).catch(() =>
      fail("sealed_directory_not_found", `Sealed directory does not exist: ${directoryPath}`),
    );
    if (status.isSymbolicLink() || !status.isDirectory()) {
      fail("sealed_directory_symlink", "Sealed directory path must contain only real directories");
    }
  }
  const resolved = await realpath(directoryPath);
  if (resolved !== directoryPath) {
    fail("sealed_directory_symlink", "Sealed directory must be addressed by its exact realpath");
  }
  return resolved;
}

async function collectFiles(root: string, current = root): Promise<readonly string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      fail("sealed_symlink", `Sealed artifact contains a symlink: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, path)));
    } else if (entry.isFile()) {
      files.push(relative(root, path).split(sep).join("/"));
    } else {
      fail("sealed_special_file", `Sealed artifact contains a special file: ${entry.name}`);
    }
  }
  return files;
}

async function readStableFile(root: string, logicalPath: string): Promise<Uint8Array> {
  assertCanonicalRelativePath(logicalPath, "Sealed file path");
  const path = join(root, ...logicalPath.split("/"));
  const before = await stat(path, { bigint: true });
  if (!before.isFile() || (await realpath(path)) !== path) {
    fail("sealed_file_invalid", `Sealed file must be a real regular file: ${logicalPath}`);
  }
  const bytes = new Uint8Array(await readFile(path));
  const after = await stat(path, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    fail("sealed_file_changed", `Sealed file changed while being read: ${logicalPath}`);
  }
  return bytes;
}

function parseCanonicalJson(bytes: Uint8Array, label: string): JsonValue {
  const value = parseStrictJson(bytes);
  if (!equalBytes(canonicalizeJson(value).bytes, bytes)) {
    fail("sealed_json_not_canonical", `${label} must use RFC 8785 canonical bytes`);
  }
  return value;
}

function fileManifestBytes(kind: "artifact_checksums" | "candidate_payload", files: FileDigest[]) {
  return canonicalizeJson({
    files: [...files].sort((left, right) => compareText(left.path, right.path)),
    format_version: 1,
    kind,
  }).bytes;
}

async function digestFiles(root: string, paths: readonly string[]): Promise<readonly FileDigest[]> {
  const sorted = [...paths].sort(compareText);
  if (new Set(sorted).size !== sorted.length) {
    fail("duplicate_sealed_file", "Sealed file set contains a duplicate path");
  }
  const digests: FileDigest[] = [];
  for (const path of sorted) {
    const bytes = await readStableFile(root, path);
    digests.push({
      bytes: String(bytes.length),
      path,
      sha256: sha256Digest(bytes).slice("sha256:".length),
    });
  }
  return digests;
}

function parseChecksumManifest(value: JsonValue): readonly FileDigest[] {
  const manifest = requiredRecord(value, "checksums.json");
  exactKeys(manifest, ["files", "format_version", "kind"], "checksums.json");
  if (
    manifest.kind !== "artifact_checksums" ||
    manifest.format_version !== 1 ||
    !Array.isArray(manifest.files)
  ) {
    fail("invalid_checksum_manifest", "checksums.json has an invalid identity");
  }
  const files = manifest.files.map((item, index) => {
    const file = requiredRecord(item, `checksums.files[${index}]`);
    exactKeys(file, ["bytes", "path", "sha256"], `checksums.files[${index}]`);
    const path = requiredString(file.path, `checksums.files[${index}].path`);
    assertCanonicalRelativePath(path, `checksums.files[${index}].path`);
    const bytes = requiredString(file.bytes, `checksums.files[${index}].bytes`);
    if (!/^(?:0|[1-9][0-9]*)$/u.test(bytes)) {
      fail("invalid_checksum_manifest", "Checksum byte counts must be canonical unsigned decimals");
    }
    return {
      bytes,
      path,
      sha256: requiredSha256(file.sha256, `checksums.files[${index}].sha256`),
    };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    fail("duplicate_sealed_file", "Checksum manifest contains duplicate file identities");
  }
  return files;
}

function resolveJsonPointer(value: JsonValue, pointer: string): JsonValue {
  if (!pointer.startsWith("/") || pointer.length < 2) {
    fail("invalid_claim_pointer", `Claim path is not a non-root JSON Pointer: ${pointer}`);
  }
  let current = value;
  for (const rawSegment of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/u.test(rawSegment)) {
      fail("invalid_claim_pointer", `Claim path has an invalid escape: ${pointer}`);
    }
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(segment)) {
        fail("invalid_claim_pointer", `Claim path does not select an array item: ${pointer}`);
      }
      const selected = current[Number(segment)];
      if (selected === undefined) {
        fail("invalid_claim_pointer", `Claim path is outside the Blueprint: ${pointer}`);
      }
      current = selected;
    } else if (isRecord(current) && segment in current) {
      current = current[segment] as JsonValue;
    } else {
      fail("invalid_claim_pointer", `Claim path does not resolve: ${pointer}`);
    }
  }
  return current;
}

function parseEvidenceReference(value: unknown, label: string): EvidenceReference {
  const reference = requiredRecord(value, label);
  exactKeys(reference, ["locator", "path", "sha256", "source_identity"], label);
  const path = requiredString(reference.path, `${label}.path`);
  assertCanonicalRelativePath(path, `${label}.path`);
  return {
    locator: reference.locator as JsonValue,
    path,
    sha256: requiredSha256(reference.sha256, `${label}.sha256`),
    sourceIdentity: requiredString(reference.source_identity, `${label}.source_identity`),
  };
}

function canonicalUnsignedDecimal(value: unknown, label: string): bigint {
  const decimal = requiredString(value, label);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(decimal)) {
    fail("evidence_locator_invalid", `${label} must be a canonical unsigned decimal`);
  }
  return BigInt(decimal);
}

function validateEvidenceLocator(
  locator: JsonValue,
  evidenceBytes: Uint8Array,
  label: string,
): void {
  if (locator === null) {
    return;
  }
  const value = requiredRecord(locator, label);
  const kind = requiredString(value.kind, `${label}.kind`);
  if (kind === "byte_range") {
    exactKeys(value, ["endByteExclusive", "kind", "startByte"], label);
    const start = canonicalUnsignedDecimal(value.startByte, `${label}.startByte`);
    const end = canonicalUnsignedDecimal(value.endByteExclusive, `${label}.endByteExclusive`);
    if (start >= end || end > BigInt(evidenceBytes.length)) {
      fail("evidence_locator_out_of_bounds", `${label} is outside the evidence bytes`);
    }
    return;
  }
  if (kind === "line_range") {
    exactKeys(value, ["endLine", "kind", "startLine"], label);
    const { endLine, startLine } = value;
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      (startLine as number) < 1 ||
      (endLine as number) < (startLine as number)
    ) {
      fail("evidence_locator_out_of_bounds", `${label} has an invalid line range`);
    }
    let text: string;
    try {
      text = UTF8_DECODER.decode(evidenceBytes);
    } catch {
      fail("evidence_locator_invalid", `${label} requires UTF-8 evidence`);
    }
    const lineCount = text.length === 0 ? 0 : text.split("\n").length;
    if ((endLine as number) > lineCount) {
      fail("evidence_locator_out_of_bounds", `${label} is outside the evidence lines`);
    }
    return;
  }
  if (kind === "json_pointer") {
    exactKeys(value, ["kind", "pointer"], label);
    const pointer = requiredString(value.pointer, `${label}.pointer`);
    let evidenceValue: JsonValue;
    try {
      evidenceValue = parseStrictJson(evidenceBytes);
    } catch {
      fail("evidence_locator_invalid", `${label} requires strict JSON evidence`);
    }
    resolveJsonPointer(evidenceValue, pointer);
    return;
  }
  fail("evidence_locator_invalid", `${label} has an unknown locator kind`);
}

function parseClaims(
  value: JsonValue,
  blueprint: YuanshengRootCauseBlueprintV1Lite,
  blueprintCanonicalHex: string,
  fileDigests: ReadonlyMap<string, FileDigest>,
  fileContents: ReadonlyMap<string, Uint8Array>,
): readonly ClaimRecord[] {
  const sidecar = requiredRecord(value, "claim-to-evidence.json");
  exactKeys(
    sidecar,
    ["blueprint_sha256", "claims", "format_version", "kind"],
    "claim-to-evidence.json",
  );
  if (
    sidecar.kind !== "claim_to_evidence" ||
    sidecar.format_version !== 1 ||
    sidecar.blueprint_sha256 !== blueprintCanonicalHex ||
    !Array.isArray(sidecar.claims) ||
    sidecar.claims.length === 0
  ) {
    fail("claim_sidecar_invalid", "Claim sidecar identity or Blueprint binding is invalid");
  }
  const claims = sidecar.claims.map((item, index) => {
    const claim = requiredRecord(item, `claims[${index}]`);
    exactKeys(
      claim,
      ["claim_kind", "claim_path", "claim_value_sha256", "evidence"],
      `claims[${index}]`,
    );
    const claimPath = requiredString(claim.claim_path, `claims[${index}].claim_path`);
    const selected = resolveJsonPointer(blueprint as unknown as JsonValue, claimPath);
    if (selected === null) {
      fail("claim_binding_invalid", `Null Blueprint values cannot be factual claims: ${claimPath}`);
    }
    const expectedValueDigest = canonicalizeJson(selected).digest.slice("sha256:".length);
    if (claim.claim_value_sha256 !== expectedValueDigest || !Array.isArray(claim.evidence)) {
      fail("claim_binding_invalid", `Claim value or evidence list is invalid: ${claimPath}`);
    }
    const evidence = claim.evidence.map((reference, referenceIndex) => {
      const parsed = parseEvidenceReference(
        reference,
        `claims[${index}].evidence[${referenceIndex}]`,
      );
      const file = fileDigests.get(parsed.path);
      if (file === undefined || file.sha256 !== parsed.sha256) {
        fail("claim_binding_invalid", `Claim evidence digest is not sealed: ${parsed.path}`);
      }
      if (!parsed.path.startsWith("evidence/")) {
        fail("claim_binding_invalid", `Claim evidence is outside the evidence set: ${parsed.path}`);
      }
      const evidenceBytes = fileContents.get(parsed.path);
      if (evidenceBytes === undefined) {
        fail("claim_binding_invalid", `Claim evidence bytes are unavailable: ${parsed.path}`);
      }
      validateEvidenceLocator(
        parsed.locator,
        evidenceBytes,
        `claims[${index}].evidence[${referenceIndex}].locator`,
      );
      return parsed;
    });
    if (evidence.length === 0) {
      fail("claim_binding_invalid", `Claim has no evidence: ${claimPath}`);
    }
    const evidenceIdentities = evidence.map(
      (reference) =>
        canonicalizeJson({
          locator: reference.locator,
          path: reference.path,
        }).text,
    );
    if (
      new Set(evidenceIdentities).size !== evidenceIdentities.length ||
      JSON.stringify([...evidenceIdentities].sort(compareText)) !==
        JSON.stringify(evidenceIdentities)
    ) {
      fail("claim_binding_invalid", `Claim evidence must be unique and sorted: ${claimPath}`);
    }
    const claimKind = requiredString(claim.claim_kind, `claims[${index}].claim_kind`);
    if (!CLAIM_KINDS.includes(claimKind)) {
      fail("claim_binding_invalid", `Claim has an unknown kind: ${claimPath}`);
    }
    return {
      claimKind,
      claimPath,
      claimValueSha256: requiredSha256(
        claim.claim_value_sha256,
        `claims[${index}].claim_value_sha256`,
      ),
      evidence,
    };
  });
  const claimPaths = claims.map((claim) => claim.claimPath);
  if (
    new Set(claimPaths).size !== claimPaths.length ||
    JSON.stringify([...claimPaths].sort(compareText)) !== JSON.stringify(claimPaths)
  ) {
    fail("claim_binding_invalid", "Claims must have unique, sorted identities");
  }
  return claims;
}

function assertFunctionIdentity(
  blueprint: YuanshengRootCauseBlueprintV1Lite,
  claims: readonly ClaimRecord[],
  directoryPath: string,
): TraceFunctionIdentity {
  const match = RANKED_FUNCTION.exec(basename(directoryPath));
  if (match === null) {
    fail("function_identity_invalid", "Sealed directory must use rank_function identity");
  }
  const rank = match[1] ?? "";
  const functionName = match[2] ?? "";
  const software = basename(dirname(dirname(directoryPath)));
  const testCase = basename(dirname(directoryPath));
  assertSafePathSegment(functionName, "functionName");
  assertSafePathSegment(software, "software");
  assertSafePathSegment(testCase, "testCase");
  assertSafePathSegment(`${rank}_${functionName}`, "ranked function directory");
  const hotspots = blueprint.section3_key_evidence["3_2_hotspot_evidence"];
  if (blueprint.section1_basic_info.software !== software) {
    fail("function_identity_invalid", "Blueprint software differs from the sealed directory");
  }
  if (hotspots.some((hotspot) => hotspot.hotspot_function !== functionName)) {
    fail("multiple_function_identity", "Blueprint hotspot evidence must describe one function");
  }
  const expectedClaimPaths = hotspots.map(
    (_, index) => `/section3_key_evidence/3_2_hotspot_evidence/${index}/hotspot_function`,
  );
  const functionClaims = claims.filter((claim) => claim.claimKind === "function_name");
  const expectedClaimPathSet = new Set(expectedClaimPaths);
  if (
    functionClaims.length !== expectedClaimPaths.length ||
    functionClaims.some((claim) => {
      expectedClaimPathSet.delete(claim.claimPath);
      return claim.evidence.every((evidence) => evidence.path !== "evidence/annotate.txt");
    }) ||
    expectedClaimPathSet.size !== 0
  ) {
    fail(
      "function_claim_invalid",
      "Each hotspot function must have one annotate-backed function claim",
    );
  }
  return Object.freeze({
    functionName,
    rank,
    software,
    testCase,
  });
}

function parseMachineValidation(value: JsonValue, candidateDigest: string): void {
  const validation = requiredRecord(value, "machine-validation.json");
  exactKeys(
    validation,
    ["candidate_digest", "checks", "format_version", "kind", "status"],
    "machine-validation.json",
  );
  if (
    validation.candidate_digest !== candidateDigest ||
    validation.format_version !== 1 ||
    validation.kind !== "machine_validation" ||
    validation.status !== "pass" ||
    !Array.isArray(validation.checks) ||
    JSON.stringify(validation.checks) !== JSON.stringify(EXPECTED_MACHINE_CHECKS)
  ) {
    fail("machine_validation_invalid", "Machine validation is not a complete passing binding");
  }
}

function parseSemanticValidation(value: JsonValue, candidateDigest: string): void {
  const validation = requiredRecord(value, "semantic-validation.json");
  exactKeys(
    validation,
    ["candidate_digest", "dimensions", "format_version", "kind", "summary"],
    "semantic-validation.json",
  );
  if (
    validation.candidate_digest !== candidateDigest ||
    validation.format_version !== 1 ||
    validation.kind !== "five_dimension_semantic_validation" ||
    typeof validation.summary !== "string" ||
    validation.summary.length === 0 ||
    !Array.isArray(validation.dimensions)
  ) {
    fail("semantic_validation_invalid", "Semantic validation identity is invalid");
  }
  const dimensions = validation.dimensions.map((item, index) => {
    const dimension = requiredRecord(item, `semantic dimensions[${index}]`);
    exactKeys(dimension, ["detail", "dimension", "status"], `semantic dimensions[${index}]`);
    if (
      dimension.status !== "pass" ||
      typeof dimension.detail !== "string" ||
      dimension.detail.length === 0
    ) {
      fail("semantic_validation_invalid", "Every semantic dimension must pass with detail");
    }
    return requiredString(dimension.dimension, `semantic dimensions[${index}].dimension`);
  });
  if (JSON.stringify(dimensions) !== JSON.stringify(EXPECTED_SEMANTIC_DIMENSIONS)) {
    fail("semantic_validation_invalid", "Semantic validation dimensions are incomplete");
  }
}

function sourcePathFromBlueprint(blueprint: YuanshengRootCauseBlueprintV1Lite): string | null {
  const gaps = new Set(blueprint.section5_risks_and_gaps.current_gaps);
  const modules = new Set(
    blueprint.section3_key_evidence["3_2_hotspot_evidence"]
      .map((hotspot) => hotspot.file_module)
      .filter((path): path is string => path !== null),
  );
  if (modules.size > 1) {
    fail("source_mapping_conflict", "Hotspot evidence contains conflicting source mappings");
  }
  const codeLocation =
    blueprint.section3_key_evidence["3_3_code_knowledge_evidence"].related_code_location;
  if (gaps.has("source_location_unavailable")) {
    if (codeLocation !== null) {
      fail("source_mapping_conflict", "Unavailable source mapping cannot name a code location");
    }
    return null;
  }
  const modulePath = [...modules][0];
  const sourcePath = codeLocation ?? modulePath;
  if (
    sourcePath === undefined ||
    sourcePath === null ||
    (codeLocation !== null && modulePath !== undefined && codeLocation !== modulePath)
  ) {
    fail("source_mapping_conflict", "Blueprint source mapping is missing or inconsistent");
  }
  assertCanonicalRelativePath(sourcePath, "Blueprint source mapping");
  return sourcePath;
}

function parseBlueprint(bytes: Uint8Array): {
  readonly blueprint: YuanshengRootCauseBlueprintV1Lite;
  readonly canonicalDigest: `sha256:${string}`;
} {
  const value = parseCanonicalJson(bytes, "blueprint.json");
  if (!validateYuanshengRootCauseBlueprintV1Lite(value)) {
    fail("blueprint_schema_invalid", "Blueprint does not satisfy the canonical v1-lite schema");
  }
  const blueprint = value as unknown as YuanshengRootCauseBlueprintV1Lite;
  const issues = checkYuanshengRootCauseBlueprintV1Lite(blueprint);
  if (issues.length > 0) {
    fail("blueprint_semantics_invalid", JSON.stringify(issues));
  }
  return {
    blueprint,
    canonicalDigest: canonicalizeJson(blueprint).digest,
  };
}

function expectedFiles(hasMetadata: boolean): readonly string[] {
  return [
    ...BASE_PAYLOAD_FILES,
    ...(hasMetadata ? ["evidence/metadata.json"] : []),
    ...VALIDATION_FILES,
    "checksums.json",
  ].sort(compareText);
}

export async function verifySealedBlueprintDirectory(
  directoryPath: string,
): Promise<VerifiedSealedBlueprint> {
  const directoryRealpath = await assertExactRealDirectory(directoryPath);
  const actualFiles = await collectFiles(directoryRealpath);
  const hasMetadata = actualFiles.includes("evidence/metadata.json");
  if (
    JSON.stringify([...actualFiles].sort(compareText)) !==
    JSON.stringify(expectedFiles(hasMetadata))
  ) {
    fail("sealed_file_set_invalid", "Sealed directory does not contain the exact Trace file set");
  }

  const checksumBytes = await readStableFile(directoryRealpath, "checksums.json");
  const checksumValue = parseCanonicalJson(checksumBytes, "checksums.json");
  const storedChecksums = parseChecksumManifest(checksumValue);
  const filesBeforeChecksums = expectedFiles(hasMetadata).filter(
    (path) => path !== "checksums.json",
  );
  const recomputedChecksums = await digestFiles(directoryRealpath, filesBeforeChecksums);
  if (
    canonicalizeJson(storedChecksums).text !== canonicalizeJson(recomputedChecksums).text ||
    !equalBytes(checksumBytes, fileManifestBytes("artifact_checksums", [...recomputedChecksums]))
  ) {
    fail("sealed_checksum_mismatch", "Checksum manifest does not match the sealed files");
  }
  const fileDigestMap = new Map(recomputedChecksums.map((file) => [file.path, file]));
  const fileContents = new Map<string, Uint8Array>();
  for (const path of filesBeforeChecksums) {
    const bytes = await readStableFile(directoryRealpath, path);
    const expected = fileDigestMap.get(path);
    if (
      expected === undefined ||
      expected.bytes !== String(bytes.length) ||
      expected.sha256 !== sha256Digest(bytes).slice("sha256:".length)
    ) {
      fail("sealed_file_changed", `Sealed file changed during verification: ${path}`);
    }
    fileContents.set(path, bytes);
  }

  const payloadFiles = filesBeforeChecksums.filter((path) => !VALIDATION_FILES.includes(path));
  const candidateManifest = fileManifestBytes(
    "candidate_payload",
    payloadFiles.map((path) => {
      const digest = fileDigestMap.get(path);
      if (digest === undefined) {
        return fail("sealed_file_invalid", `Payload file is not sealed: ${path}`);
      }
      return digest;
    }),
  );
  const candidateDigestHex = sha256Digest(candidateManifest).slice("sha256:".length);

  const blueprintBytes = fileContents.get("blueprint.json");
  const sidecarBytes = fileContents.get("claim-to-evidence.json");
  const diagnosisBytes = fileContents.get("diagnosis.md");
  const machineBytes = fileContents.get("machine-validation.json");
  const semanticBytes = fileContents.get("semantic-validation.json");
  if (
    blueprintBytes === undefined ||
    sidecarBytes === undefined ||
    diagnosisBytes === undefined ||
    machineBytes === undefined ||
    semanticBytes === undefined
  ) {
    fail("sealed_file_invalid", "A required sealed file snapshot is unavailable");
  }
  const { blueprint, canonicalDigest } = parseBlueprint(blueprintBytes);
  const claims = parseClaims(
    parseCanonicalJson(sidecarBytes, "claim-to-evidence.json"),
    blueprint,
    canonicalDigest.slice("sha256:".length),
    fileDigestMap,
    fileContents,
  );
  const functionIdentity = assertFunctionIdentity(blueprint, claims, directoryRealpath);

  parseMachineValidation(
    parseCanonicalJson(machineBytes, "machine-validation.json"),
    candidateDigestHex,
  );
  parseSemanticValidation(
    parseCanonicalJson(semanticBytes, "semantic-validation.json"),
    candidateDigestHex,
  );

  const evidence = recomputedChecksums
    .filter((file) => file.path.startsWith("evidence/"))
    .map((file) =>
      Object.freeze({
        digest: prefixedDigest(file.sha256),
        path: file.path,
      }),
    );
  const result = Object.freeze({
    blueprintCanonicalDigest: canonicalDigest,
    blueprintRawBlobDigest: sha256Digest(blueprintBytes),
    candidatePayloadDigest: sha256Digest(candidateManifest),
    directoryRealpath,
    finalStatus: blueprint.section7_final_verdict.final_status,
    functionIdentity,
    overallStatus: blueprint.section1_basic_info.overall_status,
    sealedFunctionDirectoryDigest: sha256Digest(checksumBytes),
    sourcePath: sourcePathFromBlueprint(blueprint),
    validation: Object.freeze({
      claimToEvidenceDigest: sha256Digest(sidecarBytes),
      diagnosisDigest: sha256Digest(diagnosisBytes),
      evidence: Object.freeze(evidence),
      machineValidationDigest: sha256Digest(machineBytes),
      semanticValidationDigest: sha256Digest(semanticBytes),
    }),
  });
  VERIFIED_STATES.set(result, {
    blueprint: structuredClone(blueprint),
    blueprintRawBytes: Uint8Array.from(blueprintBytes),
  });
  return result;
}

export function snapshotVerifiedSealedBlueprint(
  verified: VerifiedSealedBlueprint,
): VerifiedSealedBlueprintSnapshot {
  const state = VERIFIED_STATES.get(verified);
  if (state === undefined) {
    fail("unverified_sealed_blueprint", "Blueprint input was not produced by the sealed verifier");
  }
  return {
    blueprint: structuredClone(state.blueprint),
    blueprintRawBytes: Uint8Array.from(state.blueprintRawBytes),
  };
}
