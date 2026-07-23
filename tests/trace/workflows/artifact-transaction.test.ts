import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fileSystem from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactConflict,
  authorizeArtifactReplacement,
  inspectArtifactAddress,
  inspectArtifactTarget,
  publishBlueprintCandidate,
  recordArtifactFailure,
} from "../../../plugins/trace/workflows/artifact-transaction";
import {
  BlueprintPipelineError,
  type ClaimBinding,
  discardBlueprintCandidate,
  type FiveDimensionSemanticReview,
  type PreparedBlueprintCandidate,
  prepareBlueprintCandidate,
  readCandidateReviewInput,
  type SealedBlueprintCandidate,
  sealBlueprintCandidate,
} from "../../../plugins/trace/workflows/blueprint-pipeline";
import { parseSg2044HardwareProfile } from "../../../plugins/trace/workflows/hardware-profile";
import type { PerfDataFileV1 } from "../../../plugins/trace/workflows/perf-data-validation-report";
import {
  startTraceWorkflow,
  type TraceFunctionExecutionContext,
  transitionTraceWorkflow,
} from "../../../plugins/trace/workflows/trace-workflow";
import { canonicalizeJson } from "../../../tools/yuansheng-root-cause-blueprint/src/canonical-json";
import type { YuanshengRootCauseBlueprintV1Lite } from "../../../tools/yuansheng-root-cause-blueprint/src/generated/types/yuansheng-root-cause-blueprint-v1-lite";

const WORKSPACE_ROOT = join(import.meta.dir, "../../..");
const FIXTURE_ROOT = join(WORKSPACE_ROOT, "tests/fixtures/trace/openblas-dgemv/perf-data");
const PROFILE_PATH = join(WORKSPACE_ROOT, "plugins/trace/resources/hardware-profiles/sg2044.json");
const BLUEPRINT_PATH = join(
  WORKSPACE_ROOT,
  "tests/fixtures/trace/openblas-dgemv/blueprint-v1-lite.json",
);
const TEST_CASE = "dgemv_2048x2048";

const PERF_STAT = {
  bytes: "2015",
  path: `${TEST_CASE}/14-openblas-benchmark-riscv-dgemv_2048x2048.txt`,
  sha256: "03f50a1c0a3766ee1b62901d688faa959acff30e60ddbb60a1063d8243e882a0",
};

const ANNOTATE = {
  bytes: "3367",
  path: `${TEST_CASE}/annotate/001-dgemv_n-annotate.txt`,
  sha256: "1e42a9afcc5bac0348f0075e587efa0dc9297bc0b568e1cb83dd61d0d33ff6f3",
};

const METADATA = {
  bytes: "506",
  path: "14-openblas_rv64_metadata.json",
  sha256: "bae284f21a62998e1b93fa41e7e8cc233ac8701117f1b3d2cbcdbfac93c4c75d",
};

const CLAIMS: readonly ClaimBinding[] = [
  {
    claimKind: "other_factual",
    claimPath: "/section1_basic_info/target_hardware",
    evidence: [{ kind: "hardware_profile", locator: null }],
  },
  {
    claimKind: "other_factual",
    claimPath: "/section1_basic_info/repository_url",
    evidence: [{ kind: "metadata", locator: { kind: "json_pointer", pointer: "/repository_url" } }],
  },
  {
    claimKind: "numeric_value",
    claimPath: "/section3_key_evidence/3_1_metric_evidence/0/rv",
    evidence: [{ kind: "perf_stat", locator: null }],
  },
  {
    claimKind: "numeric_value",
    claimPath: "/section3_key_evidence/3_1_metric_evidence/1/rv",
    evidence: [{ kind: "perf_stat", locator: null }],
  },
  {
    claimKind: "numeric_value",
    claimPath: "/section3_key_evidence/3_1_metric_evidence/2/rv",
    evidence: [{ kind: "perf_stat", locator: null }],
  },
  {
    claimKind: "function_name",
    claimPath: "/section3_key_evidence/3_2_hotspot_evidence/0/hotspot_function",
    evidence: [{ kind: "annotate", locator: null }],
  },
];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ys-trace-artifact-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function revisedBlueprintBytes(
  identityOverride: Readonly<{ functionName?: string; software?: string }> = {},
): Promise<Uint8Array> {
  const original = JSON.parse(
    await readFile(BLUEPRINT_PATH, "utf8"),
  ) as YuanshengRootCauseBlueprintV1Lite;
  return canonicalizeJson({
    ...original,
    section1_basic_info: {
      ...original.section1_basic_info,
      software: identityOverride.software ?? original.section1_basic_info.software,
      target_hardware: "SOPHGO SG2044 with T-Head XuanTie C920v2 and RVV 1.0",
    },
    section3_key_evidence: {
      ...original.section3_key_evidence,
      "3_2_hotspot_evidence": original.section3_key_evidence["3_2_hotspot_evidence"].map(
        (hotspot) => ({
          ...hotspot,
          hotspot_function: identityOverride.functionName ?? hotspot.hotspot_function,
        }),
      ),
    },
    section5_risks_and_gaps: {
      ...original.section5_risks_and_gaps,
      current_gaps: original.section5_risks_and_gaps.current_gaps.filter(
        (gap) => gap !== "hardware_profile_unavailable",
      ),
      human_review_focus:
        "Collect a same-version AArch64 baseline and more samples, then map dgemv_n to reviewed source before selecting an optimization.",
    },
    section6_agent4_actions: {
      ...original.section6_agent4_actions,
      priority_location:
        identityOverride.functionName ?? original.section6_agent4_actions.priority_location,
    },
    section7_final_verdict: {
      ...original.section7_final_verdict,
      block_reason:
        "The evidence lacks an AArch64 baseline, source mapping, Pattern catalog, and enough annotate samples for an optimization handoff.",
    },
  }).bytes;
}

function validationReport(perfStat: PerfDataFileV1): Uint8Array {
  return canonicalizeJson({
    contract_version: 1,
    issues: [],
    kind: "perf_data_validation_report",
    metadata: {
      build_isa: null,
      commit_hash: "992a5362380efd1d4f5f2f490a08b56d9a5b407f",
      file: METADATA,
      issues: [],
      repository_url: "https://github.com/OpenMathLib/OpenBLAS.git",
      status: "present",
      test_branch: "develop",
    },
    report_status: "usable",
    testcases: [
      {
        annotate_directory: `${TEST_CASE}/annotate`,
        annotates: [{ file: ANNOTATE, function: "dgemv_n", rank: "001" }],
        issues: [],
        name: TEST_CASE,
        perf_stat: perfStat,
        status: "valid",
      },
    ],
  }).bytes;
}

async function executionContext(
  artifactRoot: string,
  perfStat: PerfDataFileV1 = PERF_STAT,
): Promise<TraceFunctionExecutionContext> {
  const profileBytes = new Uint8Array(await readFile(PROFILE_PATH));
  const profile = parseSg2044HardwareProfile(profileBytes);
  let transition = startTraceWorkflow({
    artifactRoot,
    perfDataRoot: FIXTURE_ROOT,
    profiles: [profile],
    software: "openblas",
  });
  transition = transitionTraceWorkflow(transition.state, {
    bytes: validationReport(perfStat),
    evidenceRoot: FIXTURE_ROOT,
    type: "provide_validation_report",
  });
  transition = transitionTraceWorkflow(transition.state, {
    profileId: profile.id,
    type: "select_profile",
  });
  transition = transitionTraceWorkflow(transition.state, {
    selection: { name: TEST_CASE, type: "one" },
    type: "select_testcases",
  });
  if (transition.output.type !== "request_plan_approval") {
    throw new Error("Expected a plan approval request");
  }
  transition = transitionTraceWorkflow(transition.state, {
    planSha256: transition.output.planSha256,
    type: "approve_plan",
  });
  if (transition.output.type !== "inspect_artifact") {
    throw new Error("Expected an artifact inspection request");
  }
  return transition.output.context;
}

function passingReview(candidateDigest: string): FiveDimensionSemanticReview {
  return {
    candidateDigest,
    dimensions: [
      {
        detail: "Claims are bound to copied evidence.",
        dimension: "claim_traceability",
        status: "pass",
      },
      {
        detail: "Reasoning states the retained limitations.",
        dimension: "explainability",
        status: "pass",
      },
      {
        detail: "Blueprint decisions agree across sections.",
        dimension: "internal_consistency",
        status: "pass",
      },
      {
        detail: "Automatic forwarding remains disabled.",
        dimension: "safety_guardrails",
        status: "pass",
      },
      {
        detail: "Hardware and ISA statements match the confirmed profile.",
        dimension: "technical_accuracy",
        status: "pass",
      },
    ],
    summary: "All five semantic dimensions pass for the immutable candidate.",
  };
}

async function prepare(
  context: TraceFunctionExecutionContext,
  blueprintBytes?: Uint8Array,
): Promise<PreparedBlueprintCandidate> {
  const profileBytes = new Uint8Array(await readFile(PROFILE_PATH));
  const profile = parseSg2044HardwareProfile(profileBytes);
  return prepareBlueprintCandidate({
    blueprintBytes: blueprintBytes ?? (await revisedBlueprintBytes()),
    claims: CLAIMS,
    context,
    diagnosisReport: new TextEncoder().encode(
      "# Yuansheng Trace diagnosis\n\nThe retained evidence identifies dgemv_n as the sampled hotspot.\n",
    ),
    hardwareProfile: {
      bytes: String(profileBytes.length),
      content: profileBytes,
      profile,
      sha256: profile.sha256,
    },
  });
}

async function sealed(context: TraceFunctionExecutionContext): Promise<SealedBlueprintCandidate> {
  const candidate = await prepare(context);
  return sealBlueprintCandidate(candidate, passingReview(candidate.candidateDigest));
}

function replacementDecision(conflict: ArtifactConflict, candidate: SealedBlueprintCandidate) {
  return {
    candidateArtifactSha256: candidate.artifactSha256,
    decision: "replace" as const,
    existingTreeSha256: conflict.existingTreeSha256,
    targetPath: conflict.targetPath,
  };
}

describe("deterministic Blueprint artifact publication", () => {
  test("publishes identical complete artifacts from immutable, verified inputs", async () => {
    const firstBase = await temporaryDirectory();
    const secondBase = await temporaryDirectory();
    const rejectedBase = await temporaryDirectory();
    const firstRoot = join(firstBase, "nested/artifacts");
    const secondRoot = join(secondBase, "nested/artifacts");
    const firstContext = await executionContext(firstRoot);
    const secondContext = await executionContext(secondRoot);
    const rejectedContext = await executionContext(join(rejectedBase, "artifacts"));
    const firstPrepared = await prepare(firstContext);
    const review = readCandidateReviewInput(firstPrepared);
    review.blueprintBytes[0] = 0;
    expect(readCandidateReviewInput(firstPrepared).blueprintBytes[0]).toBe(123);
    const first = await sealBlueprintCandidate(
      firstPrepared,
      passingReview(firstPrepared.candidateDigest),
    );
    const rejected = await prepare(rejectedContext);
    const failedReview: FiveDimensionSemanticReview = {
      ...passingReview(rejected.candidateDigest),
      dimensions: passingReview(rejected.candidateDigest).dimensions.map((dimension) =>
        dimension.dimension === "technical_accuracy"
          ? { ...dimension, status: "fail" as const }
          : dimension,
      ),
    };
    await expect(sealBlueprintCandidate(rejected, failedReview)).rejects.toMatchObject({
      code: "semantic_revision_required",
    });
    await expect(
      sealBlueprintCandidate(rejected, passingReview(rejected.candidateDigest)),
    ).rejects.toMatchObject({ code: "invalid_candidate_handle" });
    const second = await sealed(secondContext);

    expect(first.candidateDigest).toBe(second.candidateDigest);
    expect(first.artifactSha256).toBe(second.artifactSha256);
    expect(await inspectArtifactTarget(first)).toEqual({
      kind: "artifact_target_available",
      targetPath: first.targetPath,
    });
    await expect(publishBlueprintCandidate(first)).resolves.toMatchObject({
      artifactSha256: first.artifactSha256,
      kind: "artifact_published",
      replacedExisting: false,
    });
    expect(await readFile(join(first.targetPath, "evidence/hardware-profile.json"))).toEqual(
      await readFile(PROFILE_PATH),
    );
    const sidecar = JSON.parse(
      await readFile(join(first.targetPath, "claim-to-evidence.json"), "utf8"),
    ) as {
      readonly claims: readonly {
        readonly claim_path: string;
        readonly claim_value_sha256: string;
        readonly evidence: readonly { readonly path: string; readonly sha256: string }[];
      }[];
    };
    const hardwareClaim = sidecar.claims.find(
      (claim) => claim.claim_path === "/section1_basic_info/target_hardware",
    );
    expect(hardwareClaim).toMatchObject({
      claim_value_sha256: canonicalizeJson("SOPHGO SG2044 with T-Head XuanTie C920v2 and RVV 1.0")
        .sha256,
      evidence: [
        {
          path: "evidence/hardware-profile.json",
          sha256: "e55c865f09c0e0ede3248afa6a1a3dc9b8b3187fd3052eb0691633951419029f",
        },
      ],
    });
    const checksums = JSON.parse(
      await readFile(join(first.targetPath, "checksums.json"), "utf8"),
    ) as {
      readonly files: readonly {
        readonly bytes: string;
        readonly path: string;
        readonly sha256: string;
      }[];
      readonly kind: string;
    };
    expect(checksums.kind).toBe("artifact_checksums");
    expect(checksums.files).toContainEqual({
      bytes: "563",
      path: "evidence/hardware-profile.json",
      sha256: "e55c865f09c0e0ede3248afa6a1a3dc9b8b3187fd3052eb0691633951419029f",
    });

    const mismatchedEvidenceContext = await executionContext(join(secondBase, "invalid-evidence"), {
      ...PERF_STAT,
      sha256: "0".repeat(64),
    });
    await expect(prepare(mismatchedEvidenceContext)).rejects.toMatchObject({
      code: "evidence_report_mismatch",
    });
    await expect(
      prepare(firstContext, await revisedBlueprintBytes({ software: "another-project" })),
    ).rejects.toMatchObject({ code: "blueprint_software_mismatch" });
    await expect(
      prepare(firstContext, await revisedBlueprintBytes({ functionName: "another_function" })),
    ).rejects.toMatchObject({ code: "blueprint_function_mismatch" });
    await expect(publishBlueprintCandidate(second)).resolves.toMatchObject({
      artifactSha256: first.artifactSha256,
      kind: "artifact_published",
      replacedExisting: false,
    });
  });
});

describe("explicit replacement authorization", () => {
  test("rejects wrong and stale one-shot authorization before accepting a fresh scope", async () => {
    const base = await temporaryDirectory();
    const root = join(base, "artifacts");
    const context = await executionContext(root);
    const initial = await sealed(context);
    await publishBlueprintCandidate(initial);

    const preAnalysisConflict = await inspectArtifactAddress({ context });
    if (preAnalysisConflict.kind !== "artifact_conflict") {
      throw new Error("Expected a pre-analysis artifact conflict");
    }
    const replacement = await sealed(context);
    const initialConflict = await inspectArtifactTarget(replacement);
    expect(initialConflict.kind).toBe("artifact_conflict");
    if (initialConflict.kind !== "artifact_conflict") {
      throw new Error("Expected an artifact conflict");
    }
    await expect(publishBlueprintCandidate(replacement)).resolves.toMatchObject({
      kind: "artifact_conflict",
      reason: "target_exists",
    });

    const wrongTarget = await sealed(await executionContext(join(base, "other-artifacts")));
    const wrongAuthorization = authorizeArtifactReplacement(
      preAnalysisConflict,
      replacement,
      replacementDecision(preAnalysisConflict, replacement),
    );
    await expect(publishBlueprintCandidate(wrongTarget, wrongAuthorization)).rejects.toMatchObject({
      code: "replacement_authorization_scope_mismatch",
    });

    const staleConflict = await inspectArtifactTarget(replacement);
    if (staleConflict.kind !== "artifact_conflict") {
      throw new Error("Expected an artifact conflict");
    }
    const staleAuthorization = authorizeArtifactReplacement(
      staleConflict,
      replacement,
      replacementDecision(staleConflict, replacement),
    );
    await writeFile(join(replacement.targetPath, "diagnosis.md"), "changed after approval\n");
    await expect(publishBlueprintCandidate(replacement, staleAuthorization)).resolves.toMatchObject(
      {
        kind: "artifact_conflict",
        reason: "authorization_stale",
      },
    );
    expect(await readFile(join(replacement.targetPath, "diagnosis.md"), "utf8")).toBe(
      "changed after approval\n",
    );

    const postRenameConflict = await inspectArtifactTarget(replacement);
    if (postRenameConflict.kind !== "artifact_conflict") {
      throw new Error("Expected an artifact conflict");
    }
    const postRenameAuthorization = authorizeArtifactReplacement(
      postRenameConflict,
      replacement,
      replacementDecision(postRenameConflict, replacement),
    );
    const renameAfterIsolation = fileSystem.rename;
    let isolatedTargetChanged = false;
    const isolationSpy = spyOn(fileSystem, "rename").mockImplementation(async (source, target) => {
      await renameAfterIsolation(source, target);
      if (!isolatedTargetChanged) {
        isolatedTargetChanged = true;
        await writeFile(join(String(target), "diagnosis.md"), "changed after isolation\n");
      }
    });
    try {
      await expect(
        publishBlueprintCandidate(replacement, postRenameAuthorization),
      ).resolves.toMatchObject({
        kind: "artifact_conflict",
        reason: "authorization_stale",
      });
    } finally {
      isolationSpy.mockRestore();
    }
    expect(await readFile(join(replacement.targetPath, "diagnosis.md"), "utf8")).toBe(
      "changed after isolation\n",
    );

    const freshConflict = await inspectArtifactTarget(replacement);
    if (freshConflict.kind !== "artifact_conflict") {
      throw new Error("Expected an artifact conflict");
    }
    const freshAuthorization = authorizeArtifactReplacement(
      freshConflict,
      replacement,
      replacementDecision(freshConflict, replacement),
    );
    await expect(publishBlueprintCandidate(replacement, freshAuthorization)).resolves.toMatchObject(
      {
        artifactSha256: replacement.artifactSha256,
        kind: "artifact_published",
        replacedExisting: true,
      },
    );
    expect(await readFile(join(replacement.targetPath, "diagnosis.md"), "utf8")).toContain(
      "The retained evidence identifies dgemv_n",
    );

    await writeFile(join(replacement.targetPath, "diagnosis.md"), "rollback sentinel\n");
    const rollbackCandidate = await sealed(context);
    const rollbackConflict = await inspectArtifactTarget(rollbackCandidate);
    if (rollbackConflict.kind !== "artifact_conflict") {
      throw new Error("Expected an artifact conflict");
    }
    const rollbackAuthorization = authorizeArtifactReplacement(
      rollbackConflict,
      rollbackCandidate,
      replacementDecision(rollbackConflict, rollbackCandidate),
    );
    const sampleHandle = await fileSystem.open(root, "r");
    const syncPrototype = Object.getPrototypeOf(sampleHandle) as {
      sync(): Promise<void>;
    };
    await sampleHandle.close();
    const originalSync = syncPrototype.sync;
    let syncCalls = 0;
    const syncSpy = spyOn(syncPrototype, "sync").mockImplementation(async function (this: {
      sync(): Promise<void>;
    }) {
      syncCalls += 1;
      if (syncCalls === 2) {
        throw Object.assign(new Error("injected isolation sync failure"), { code: "EIO" });
      }
      return originalSync.call(this);
    });
    try {
      await expect(
        publishBlueprintCandidate(rollbackCandidate, rollbackAuthorization),
      ).rejects.toMatchObject({ code: "artifact_replacement_failed_old_restored" });
    } finally {
      syncSpy.mockRestore();
    }
    expect(await readFile(join(replacement.targetPath, "diagnosis.md"), "utf8")).toBe(
      "rollback sentinel\n",
    );
    await expect(discardBlueprintCandidate(rollbackCandidate)).resolves.toMatchObject({
      candidateDigest: rollbackCandidate.candidateDigest,
      kind: "blueprint_candidate_discarded",
    });
    await expect(inspectArtifactTarget(rollbackCandidate)).rejects.toMatchObject({
      code: "invalid_candidate_handle",
    });

    const committedCandidate = await sealed(context);
    const committedConflict = await inspectArtifactTarget(committedCandidate);
    if (committedConflict.kind !== "artifact_conflict") {
      throw new Error("Expected an artifact conflict");
    }
    const committedAuthorization = authorizeArtifactReplacement(
      committedConflict,
      committedCandidate,
      replacementDecision(committedConflict, committedCandidate),
    );
    let commitSyncCalls = 0;
    const commitSyncSpy = spyOn(syncPrototype, "sync").mockImplementation(async function (this: {
      sync(): Promise<void>;
    }) {
      commitSyncCalls += 1;
      if (commitSyncCalls === 3) {
        throw Object.assign(new Error("injected commit sync failure"), { code: "EIO" });
      }
      return originalSync.call(this);
    });
    const renameAtCommit = fileSystem.rename;
    let commitRenameCalls = 0;
    const commitRenameSpy = spyOn(fileSystem, "rename").mockImplementation(
      async (source, target) => {
        commitRenameCalls += 1;
        if (commitRenameCalls === 3) {
          throw Object.assign(new Error("injected candidate rollback failure"), { code: "EIO" });
        }
        await renameAtCommit(source, target);
      },
    );
    try {
      const committed = await publishBlueprintCandidate(committedCandidate, committedAuthorization);
      expect(committed).toMatchObject({
        artifactSha256: committedCandidate.artifactSha256,
        kind: "artifact_published",
        replacedExisting: true,
        warnings: [{ code: "artifact_parent_sync_failed" }, { code: "backup_cleanup_failed" }],
      });
      if (committed.kind !== "artifact_published") {
        throw new Error("Expected an explicit published outcome");
      }
      expect(committed.backupRecoveryPath).toBeDefined();
    } finally {
      commitRenameSpy.mockRestore();
      commitSyncSpy.mockRestore();
    }
    expect(await readFile(join(replacement.targetPath, "diagnosis.md"), "utf8")).toContain(
      "The retained evidence identifies dgemv_n",
    );
  });
});

describe("path confinement and failed-result isolation", () => {
  test("rejects unissued contexts and symlink roots and records only allowlisted failures", async () => {
    const base = await temporaryDirectory();
    const failureContext = await executionContext(join(base, "failure-root"));
    const unissuedContext = {
      ...failureContext,
      artifactRoot: join(base, "unissued-root"),
    } as TraceFunctionExecutionContext;
    await expect(prepare(unissuedContext)).rejects.toMatchObject({
      code: "invalid_execution_context",
    });
    await expect(inspectArtifactAddress({ context: unissuedContext })).rejects.toBeInstanceOf(
      BlueprintPipelineError,
    );

    const realRoot = join(base, "real-root");
    const linkedRoot = join(base, "linked-root");
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot);
    const linkedContext = await executionContext(linkedRoot);
    await expect(prepare(linkedContext)).rejects.toMatchObject({ code: "symlink_path_forbidden" });

    const candidate = await prepare(failureContext);
    const review = readCandidateReviewInput(candidate);
    const recorded = await recordArtifactFailure({
      code: "semantic_review_failed",
      context: failureContext,
      diagnosticLog: new TextEncoder().encode("The semantic review requested a new candidate.\n"),
      evidence: review.evidence,
      message: "The candidate was not published.",
      phase: "semantic_validation",
    });
    const files = await readdir(recorded.directory, { recursive: true });
    expect(files.sort()).toEqual([
      "checksums.json",
      "diagnostic.log",
      "evidence",
      "evidence/annotate.txt",
      "evidence/hardware-profile.json",
      "evidence/metadata.json",
      "evidence/perf-stat.txt",
      "failure.json",
    ]);
    expect(files.some((path) => /blueprint|sidecar/iu.test(path))).toBe(false);
    expect(
      JSON.parse(await readFile(join(recorded.directory, "failure.json"), "utf8")),
    ).toMatchObject({
      failure_id: recorded.failureId,
      kind: "artifact_failure",
    });
    await expect(discardBlueprintCandidate(candidate)).resolves.toMatchObject({
      candidateDigest: candidate.candidateDigest,
      kind: "blueprint_candidate_discarded",
    });
    expect(() => readCandidateReviewInput(candidate)).toThrow(BlueprintPipelineError);
  });
});
