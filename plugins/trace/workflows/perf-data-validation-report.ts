import Ajv2020, { type SchemaObject } from "ajv/dist/2020";

import { canonicalizeJson } from "../../../tools/yuansheng-root-cause-blueprint/src/canonical-json";
import {
  type JsonObject,
  type JsonValue,
  parseStrictJson,
} from "../../../tools/yuansheng-root-cause-blueprint/src/strict-json";
import reportSchema from "./perf-data-validation-report-v1.schema.json" with { type: "json" };

export interface PerfDataFileV1 {
  readonly bytes: string;
  readonly path: string;
  readonly sha256: string;
}

export interface PerfDataIssueV1 {
  readonly code: string;
  readonly detail: string;
  readonly path: string | null;
  readonly severity: "error" | "warning";
}

export interface PerfDataMetadataV1 {
  readonly build_isa: string | null;
  readonly commit_hash: string | null;
  readonly file: PerfDataFileV1 | null;
  readonly issues: readonly PerfDataIssueV1[];
  readonly repository_url: string | null;
  readonly status: "invalid" | "missing" | "present";
  readonly test_branch: string | null;
}

export interface PerfDataAnnotateV1 {
  readonly file: PerfDataFileV1;
  readonly function: string;
  readonly rank: string;
}

export interface PerfDataTestcaseV1 {
  readonly annotate_directory: string | null;
  readonly annotates: readonly PerfDataAnnotateV1[];
  readonly issues: readonly PerfDataIssueV1[];
  readonly name: string;
  readonly perf_stat: PerfDataFileV1 | null;
  readonly status: "invalid" | "valid";
}

export interface PerfDataValidationReportV1 {
  readonly contract_version: 1;
  readonly issues: readonly PerfDataIssueV1[];
  readonly kind: "perf_data_validation_report";
  readonly metadata: PerfDataMetadataV1;
  readonly report_status: "unusable" | "usable";
  readonly testcases: readonly PerfDataTestcaseV1[];
}

export interface ParsedPerfDataValidationReportV1 {
  /** RFC 8785/JCS bytes used for digest and equality comparisons. */
  readonly bytes: Uint8Array;
  readonly report: PerfDataValidationReportV1;
  readonly sha256: string;
}

export type PerfDataValidationReportErrorCode =
  | "report-schema-invalid"
  | "report-semantic-invalid"
  | "unsupported-report-version";

export class PerfDataValidationReportError extends Error {
  constructor(
    readonly code: PerfDataValidationReportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PerfDataValidationReportError";
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  ownProperties: true,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
  validateSchema: true,
});

const validateReport = ajv.compile<PerfDataValidationReportV1>(reportSchema as SchemaObject);
const UTF8_ENCODER = new TextEncoder();

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeJson(item);
    }
    Object.freeze(value);
    return value;
  }
  if (isJsonObject(value)) {
    for (const item of Object.values(value)) {
      deepFreezeJson(item);
    }
    Object.freeze(value);
  }
  return value;
}

function schemaFailureMessage(): string {
  const firstError = validateReport.errors?.[0];
  if (firstError === undefined) {
    return "Perf data validation report does not satisfy the v1 Schema";
  }
  return `Perf data validation report does not satisfy the v1 Schema at ${firstError.instancePath || "/"}: ${firstError.message ?? firstError.keyword}`;
}

function semanticFailure(message: string): never {
  throw new PerfDataValidationReportError("report-semantic-invalid", message);
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

function assertSafeSegment(value: string, label: string): void {
  if (
    value === "." ||
    value === ".." ||
    value.length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    hasAsciiControl(value) ||
    value.normalize("NFC") !== value ||
    UTF8_ENCODER.encode(value).byteLength > 255
  ) {
    semanticFailure(`${label} is not a safe path segment`);
  }
}

function assertSafeLogicalPath(value: string, label: string): void {
  if (
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    hasAsciiControl(value)
  ) {
    semanticFailure(`${label} is not a safe relative logical path`);
  }
  const segments = value.split("/");
  if (segments.length === 0) {
    semanticFailure(`${label} is not a normalized logical path`);
  }
  for (const segment of segments) {
    assertSafeSegment(segment, label);
  }
}

function assertFileReference(file: PerfDataFileV1, label: string, seenPaths: Set<string>): void {
  assertSafeLogicalPath(file.path, label);
  if (seenPaths.has(file.path)) {
    semanticFailure(`Validation report repeats evidence path ${file.path}`);
  }
  seenPaths.add(file.path);
}

function assertMetadataConsistency(metadata: PerfDataMetadataV1, seenPaths: Set<string>): void {
  if (metadata.status === "present" && metadata.file === null) {
    semanticFailure("Present metadata must identify its source file");
  }
  if (
    metadata.status === "missing" &&
    (metadata.file !== null ||
      metadata.repository_url !== null ||
      metadata.test_branch !== null ||
      metadata.commit_hash !== null ||
      metadata.build_isa !== null)
  ) {
    semanticFailure("Missing metadata cannot contain a file or extracted metadata values");
  }
  if (
    metadata.status === "invalid" &&
    (metadata.repository_url !== null ||
      metadata.test_branch !== null ||
      metadata.commit_hash !== null ||
      metadata.build_isa !== null)
  ) {
    semanticFailure("Invalid metadata cannot expose untrusted extracted values");
  }
  if (metadata.file !== null) {
    assertFileReference(metadata.file, "metadata file", seenPaths);
  }
}

function assertIssuePaths(issues: readonly PerfDataIssueV1[], label: string): void {
  for (const issue of issues) {
    if (issue.path !== null) {
      assertSafeLogicalPath(issue.path, label);
    }
  }
}

function assertReportSemantics(report: PerfDataValidationReportV1): void {
  if (
    report.report_status === "usable" &&
    report.issues.some((issue) => issue.severity === "error")
  ) {
    semanticFailure("A usable validation report cannot contain a global error");
  }

  const testcaseNames = new Set<string>();
  const seenPaths = new Set<string>();
  assertIssuePaths(report.issues, "report issue path");
  assertMetadataConsistency(report.metadata, seenPaths);
  assertIssuePaths(report.metadata.issues, "metadata issue path");

  for (const testcase of report.testcases) {
    assertSafeSegment(testcase.name, "testcase name");
    assertIssuePaths(testcase.issues, "testcase issue path");
    if (testcaseNames.has(testcase.name)) {
      semanticFailure(`Validation report repeats testcase ${testcase.name}`);
    }
    testcaseNames.add(testcase.name);

    if (testcase.perf_stat !== null) {
      assertFileReference(testcase.perf_stat, "perf stat file", seenPaths);
    }
    if (testcase.annotate_directory !== null) {
      assertSafeLogicalPath(testcase.annotate_directory, "annotate directory");
    }

    const ranks = new Set<string>();
    const functions = new Set<string>();
    for (const annotate of testcase.annotates) {
      assertSafeSegment(annotate.function, "annotate function");
      if (UTF8_ENCODER.encode(`${annotate.rank}_${annotate.function}`).byteLength > 255) {
        semanticFailure("ranked annotate function is not a safe artifact path segment");
      }
      assertFileReference(annotate.file, "annotate file", seenPaths);
      if (testcase.status === "valid") {
        if (ranks.has(annotate.rank)) {
          semanticFailure(`Validation report repeats rank ${annotate.rank} in ${testcase.name}`);
        }
        if (functions.has(annotate.function)) {
          semanticFailure(
            `Validation report repeats function ${annotate.function} in ${testcase.name}`,
          );
        }
        ranks.add(annotate.rank);
        functions.add(annotate.function);
      }
    }
  }
}

export function parsePerfDataValidationReportV1(
  input: Uint8Array,
): ParsedPerfDataValidationReportV1 {
  const value = parseStrictJson(input);
  if (
    !isJsonObject(value) ||
    value.contract_version !== 1 ||
    value.kind !== "perf_data_validation_report"
  ) {
    throw new PerfDataValidationReportError(
      "unsupported-report-version",
      "Perf data validation report must use contract version 1",
    );
  }

  if (!validateReport(value)) {
    throw new PerfDataValidationReportError("report-schema-invalid", schemaFailureMessage());
  }

  const canonical = canonicalizeJson(value);
  assertReportSemantics(value);
  const report = deepFreezeJson(value);

  return {
    bytes: canonical.bytes.slice(),
    report,
    sha256: canonical.sha256,
  };
}
