import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeJson, sha256Digest } from "../../plugins/craft/workflows/artifacts/canonical";
import type { JsonValue } from "../../plugins/craft/workflows/artifacts/strict-json";
import type { YuanshengRootCauseBlueprintV1Lite } from "../../tools/yuansheng-root-cause-blueprint/src/generated/types/yuansheng-root-cause-blueprint-v1-lite";

export const BLUEPRINT_REPOSITORY_URL = "https://github.com/OpenMathLib/OpenBLAS.git";
export const BLUEPRINT_COMMIT_SHA = "992a5362380efd1d4f5f2f490a08b56d9a5b407f";
export const BLUEPRINT_SOURCE_PATH = "src/kernel/dgemv_n.c";

const MACHINE_CHECKS = [
  "blueprint_strict_json",
  "blueprint_v1_lite_schema",
  "blueprint_cross_field_rules",
  "claim_to_evidence_binding",
  "evidence_size_and_sha256",
] as const;
const SEMANTIC_DIMENSIONS = [
  "claim_traceability",
  "explainability",
  "internal_consistency",
  "safety_guardrails",
  "technical_accuracy",
] as const;

interface FileDigest {
  readonly bytes: string;
  readonly path: string;
  readonly sha256: string;
}

export interface SealedBlueprintFixtureOptions {
  readonly commitSha?: string | null;
  readonly duplicateFunctionHotspot?: boolean;
  readonly functionName?: string;
  readonly invalidEvidenceLocator?: boolean;
  readonly machineStatus?: "fail" | "pass";
  readonly multipleFunctionHotspot?: boolean;
  readonly overallStatus?: "confirmed" | "probable";
  readonly repositoryUrl?: string | null;
  readonly semanticStatus?: "fail" | "pass";
  readonly sourcePath?: string | null;
}

export interface SealedBlueprintFixture {
  readonly blueprint: YuanshengRootCauseBlueprintV1Lite;
  readonly blueprintBytes: Uint8Array;
  readonly directoryPath: string;
}

function digestHex(bytes: Uint8Array): string {
  return sha256Digest(bytes).slice("sha256:".length);
}

function manifest(
  kind: "artifact_checksums" | "candidate_payload",
  files: readonly FileDigest[],
): Uint8Array {
  return canonicalizeJson({
    files: [...files].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
    format_version: 1,
    kind,
  }).bytes;
}

function asJson(value: unknown): JsonValue {
  return value as JsonValue;
}

async function baseBlueprint(): Promise<YuanshengRootCauseBlueprintV1Lite> {
  const fixturePath = join(
    import.meta.dir,
    "../fixtures/trace/openblas-dgemv/blueprint-v1-lite.json",
  );
  return JSON.parse(await readFile(fixturePath, "utf8")) as YuanshengRootCauseBlueprintV1Lite;
}

function claim(
  blueprint: YuanshengRootCauseBlueprintV1Lite,
  claimKind: "function_name" | "numeric_value" | "other_factual" | "path",
  claimPath: string,
  evidence: {
    readonly locator: JsonValue;
    readonly path: string;
    readonly sha256: string;
    readonly source_identity: string;
  },
): JsonValue {
  const segments = claimPath.slice(1).split("/");
  let selected: unknown = blueprint;
  for (const segment of segments) {
    selected = (selected as Record<string, unknown>)[segment];
  }
  return {
    claim_kind: claimKind,
    claim_path: claimPath,
    claim_value_sha256: digestHex(canonicalizeJson(asJson(selected)).bytes),
    evidence: [evidence],
  };
}

function claimPath(value: JsonValue): string {
  const record = value as Record<string, JsonValue>;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof record.claim_path !== "string"
  ) {
    throw new TypeError("Fixture claim is missing its path");
  }
  return record.claim_path;
}

export async function createSealedBlueprintFixture(
  temporaryRoot: string,
  options: SealedBlueprintFixtureOptions = {},
): Promise<SealedBlueprintFixture> {
  const functionName = options.functionName ?? "dgemv_n";
  const repositoryUrl =
    options.repositoryUrl === undefined ? BLUEPRINT_REPOSITORY_URL : options.repositoryUrl;
  const commitSha = options.commitSha === undefined ? BLUEPRINT_COMMIT_SHA : options.commitSha;
  const sourcePath = options.sourcePath === undefined ? BLUEPRINT_SOURCE_PATH : options.sourcePath;
  const overallStatus = options.overallStatus ?? "confirmed";
  const blueprint = await baseBlueprint();

  blueprint.section1_basic_info.software = "openblas";
  blueprint.section1_basic_info.repository_url = repositoryUrl;
  blueprint.section1_basic_info.commit_hash = commitSha;
  blueprint.section1_basic_info.overall_status = overallStatus;
  blueprint.section1_basic_info.overall_confidence = overallStatus === "confirmed" ? 0.94 : 0.72;
  blueprint.section2_summary.most_likely_root_cause =
    "The scalar cleanup loop dominates because this build does not select the available RVV kernel.";
  blueprint.section2_summary.recommend_to_ys_craft = "conditional";
  const firstHotspot = blueprint.section3_key_evidence["3_2_hotspot_evidence"][0];
  if (firstHotspot === undefined) {
    throw new TypeError("Blueprint fixture requires one hotspot");
  }
  firstHotspot.hotspot_function = functionName;
  firstHotspot.file_module = sourcePath;
  firstHotspot.note =
    "The sealed annotate evidence identifies the scalar cleanup loop as the dominant hotspot.";
  if (options.duplicateFunctionHotspot || options.multipleFunctionHotspot) {
    blueprint.section3_key_evidence["3_2_hotspot_evidence"].push({
      ...firstHotspot,
      hotspot_function: options.multipleFunctionHotspot ? "dgemv_other" : functionName,
      note: "A second sealed sample attributes the same execution path.",
    });
  }
  const codeKnowledge = blueprint.section3_key_evidence["3_3_code_knowledge_evidence"];
  codeKnowledge.related_code_location = sourcePath;
  codeKnowledge.related_knowledge =
    sourcePath === null ? null : "The reviewed source contains the scalar cleanup loop.";
  codeKnowledge.evidence_explanation =
    sourcePath === null
      ? "The sealed evidence identifies the function but not a source file."
      : "The sealed annotate evidence and reviewed source mapping agree.";
  blueprint.section4_root_cause.most_likely_root_cause =
    blueprint.section2_summary.most_likely_root_cause;
  blueprint.section4_root_cause.root_cause_type = "code_path";
  blueprint.section4_root_cause.reasoning =
    "The function-level profile, source mapping, and metric evidence consistently identify the scalar cleanup path.";
  blueprint.section5_risks_and_gaps.current_gaps = [
    "pattern_catalog_unavailable",
    "duration_data_unavailable",
    "aarch64_baseline_unavailable",
    ...(repositoryUrl === null || commitSha === null ? ["repository_metadata_unavailable"] : []),
    ...(sourcePath === null ? ["source_location_unavailable", "code_knowledge_unavailable"] : []),
  ];
  blueprint.section5_risks_and_gaps.risk_level = "medium";
  blueprint.section6_ys_craft_actions.proceed_to_optimization = "conditional";
  blueprint.section6_ys_craft_actions.priority_location = functionName;
  blueprint.section6_ys_craft_actions.recommended_first_action =
    "Review the scalar cleanup loop and prepare a narrowly scoped dispatch correction.";
  blueprint.section6_ys_craft_actions.change_risk = "medium";
  blueprint.section7_final_verdict.final_status =
    overallStatus === "confirmed" ? "confirmed_root_cause" : "probable_root_cause";
  blueprint.section7_final_verdict.block_reason =
    "An explicit human allow decision is required before Yuansheng Craft may import the diagnosis.";

  const directoryPath = join(temporaryRoot, "openblas", "dgemv_2048x2048", `001_${functionName}`);
  const evidenceDirectory = join(directoryPath, "evidence");
  await mkdir(evidenceDirectory, { recursive: true });

  const blueprintBytes = canonicalizeJson(asJson(blueprint)).bytes;
  const annotateBytes = new TextEncoder().encode(
    "Samples: 100\n  72.00% dgemv_n scalar cleanup loop\n",
  );
  const perfBytes = new TextEncoder().encode("178437499 duration_time\n0.333535 IPC\n");
  const hardwareBytes = canonicalizeJson({
    kind: "hardware_profile",
    profile: {
      architecture: "rv64",
      id: "sg2044-test",
    },
  }).bytes;
  const evidence = {
    annotate: {
      locator: {
        endLine: 2,
        kind: "line_range",
        startLine: 2,
      },
      path: "evidence/annotate.txt",
      sha256: digestHex(annotateBytes),
      source_identity: "trace-report:annotate",
    },
    hardware: {
      locator: {
        kind: "json_pointer",
        pointer: "/profile/id",
      },
      path: "evidence/hardware-profile.json",
      sha256: digestHex(hardwareBytes),
      source_identity: "profile:sg2044-test",
    },
    perf: {
      locator: {
        endByteExclusive: options.invalidEvidenceLocator ? "999999" : "18",
        kind: "byte_range",
        startByte: "0",
      },
      path: "evidence/perf-stat.txt",
      sha256: digestHex(perfBytes),
      source_identity: "trace-report:perf-stat",
    },
  } as const;
  const claims: JsonValue[] = [
    claim(blueprint, "other_factual", "/section2_summary/anomaly_conclusion", evidence.hardware),
    claim(
      blueprint,
      "numeric_value",
      "/section3_key_evidence/3_1_metric_evidence/0/rv",
      evidence.perf,
    ),
    ...blueprint.section3_key_evidence["3_2_hotspot_evidence"].map((_, index) =>
      claim(
        blueprint,
        "function_name",
        `/section3_key_evidence/3_2_hotspot_evidence/${index}/hotspot_function`,
        evidence.annotate,
      ),
    ),
    ...(sourcePath === null
      ? []
      : [
          claim(
            blueprint,
            "path",
            "/section3_key_evidence/3_3_code_knowledge_evidence/related_code_location",
            evidence.annotate,
          ),
        ]),
  ].sort((left, right) => {
    const leftPath = claimPath(left);
    const rightPath = claimPath(right);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  const sidecarBytes = canonicalizeJson({
    blueprint_sha256: digestHex(blueprintBytes),
    claims,
    format_version: 1,
    kind: "claim_to_evidence",
  }).bytes;
  const payload = new Map<string, Uint8Array>([
    ["blueprint.json", blueprintBytes],
    ["claim-to-evidence.json", sidecarBytes],
    [
      "diagnosis.md",
      new TextEncoder().encode(
        "# Sealed diagnosis\n\nThe scalar cleanup loop is the confirmed cause.\n",
      ),
    ],
    ["evidence/annotate.txt", annotateBytes],
    ["evidence/hardware-profile.json", hardwareBytes],
    ["evidence/perf-stat.txt", perfBytes],
  ]);
  const payloadDigests = [...payload].map(([path, bytes]) => ({
    bytes: String(bytes.length),
    path,
    sha256: digestHex(bytes),
  }));
  const candidateDigest = digestHex(manifest("candidate_payload", payloadDigests));
  const machineBytes = canonicalizeJson({
    candidate_digest: candidateDigest,
    checks: MACHINE_CHECKS,
    format_version: 1,
    kind: "machine_validation",
    status: options.machineStatus ?? "pass",
  }).bytes;
  const semanticBytes = canonicalizeJson({
    candidate_digest: candidateDigest,
    dimensions: SEMANTIC_DIMENSIONS.map((dimension) => ({
      detail: `${dimension} passed review`,
      dimension,
      status:
        options.semanticStatus === "fail" && dimension === "technical_accuracy" ? "fail" : "pass",
    })),
    format_version: 1,
    kind: "five_dimension_semantic_validation",
    summary: "All required review dimensions were evaluated.",
  }).bytes;
  const sealedFiles = new Map(payload);
  sealedFiles.set("machine-validation.json", machineBytes);
  sealedFiles.set("semantic-validation.json", semanticBytes);
  for (const [path, bytes] of sealedFiles) {
    await writeFile(join(directoryPath, ...path.split("/")), bytes);
  }
  const sealedDigests = [...sealedFiles].map(([path, bytes]) => ({
    bytes: String(bytes.length),
    path,
    sha256: digestHex(bytes),
  }));
  await writeFile(
    join(directoryPath, "checksums.json"),
    manifest("artifact_checksums", sealedDigests),
  );
  return {
    blueprint,
    blueprintBytes,
    directoryPath,
  };
}
