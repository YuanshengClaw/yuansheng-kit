import { describe, expect, test } from "bun:test";

import {
  HardwareProfileError,
  parseSg2044HardwareProfile,
  SG2044_SOURCE_SHA256,
} from "../../../plugins/trace/workflows/hardware-profile";
import {
  PerfDataValidationReportError,
  parsePerfDataValidationReportV1,
} from "../../../plugins/trace/workflows/perf-data-validation-report";
import {
  isTraceFunctionExecutionContext,
  startTraceWorkflow,
  type TraceTransition,
  TraceWorkflowError,
  type TraceWorkflowOutput,
  transitionTraceWorkflow,
} from "../../../plugins/trace/workflows/trace-workflow";
import { canonicalizeJson } from "../../../tools/yuansheng-root-cause-blueprint/src/canonical-json";

const ARTIFACT_ROOT = "/tmp/yuansheng-trace-artifacts";
const CHANGED_ARTIFACT_ROOT = "/tmp/yuansheng-trace-artifacts-changed";
const EVIDENCE_ROOT = "/tmp/yuansheng-trace-evidence";
const CANDIDATE_ALPHA_V1 = "1".repeat(64);
const CANDIDATE_ALPHA_V2 = "2".repeat(64);
const CANDIDATE_ZETA = "3".repeat(64);
const ARTIFACT_ALPHA = "a".repeat(64);
const ARTIFACT_ZETA = "b".repeat(64);
const REPORT_URL = new URL(
  "../../fixtures/trace/interaction/perf-data-validation-report-v1.json",
  import.meta.url,
);
const PYTHON_VALIDATOR_GOLDEN_URL = new URL(
  "../../../plugins/trace/tools/perf-data-validator/tests/golden/openblas-dgemv-report-v1.json",
  import.meta.url,
);
const PROFILE_URL = new URL(
  "../../../plugins/trace/resources/hardware-profiles/sg2044.json",
  import.meta.url,
);

async function readBytes(url: URL): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(url).arrayBuffer());
}

async function reportPayload(): Promise<Uint8Array> {
  return readBytes(REPORT_URL);
}

function expectReportError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected perf data validation report parsing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PerfDataValidationReportError);
    expect(error).toMatchObject({ code });
  }
}

function expectWorkflowError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected trace workflow transition to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(TraceWorkflowError);
    expect(error).toMatchObject({ code });
  }
}

function requireOutput<T extends TraceWorkflowOutput["type"]>(
  transition: TraceTransition,
  type: T,
): Extract<TraceWorkflowOutput, { readonly type: T }> {
  if (transition.output.type !== type) {
    throw new Error(`Expected ${type}, received ${transition.output.type}`);
  }
  return transition.output as Extract<TraceWorkflowOutput, { readonly type: T }>;
}

async function confirmedProfile() {
  return parseSg2044HardwareProfile(await readBytes(PROFILE_URL));
}

async function reachTestcaseSelection(): Promise<TraceTransition> {
  const profile = await confirmedProfile();
  let transition = startTraceWorkflow({ artifactRoot: ARTIFACT_ROOT, profiles: [profile] });
  expect(transition.output).toEqual({ field: "software", type: "request_parameter" });

  transition = transitionTraceWorkflow(transition.state, {
    field: "software",
    type: "provide_parameter",
    value: "synthetic-suite",
  });
  expect(transition.output).toEqual({ field: "perf_data_root", type: "request_parameter" });

  transition = transitionTraceWorkflow(transition.state, {
    field: "perf_data_root",
    type: "provide_parameter",
    value: "user-supplied-perf-root",
  });
  expect(transition.output.type).toBe("request_validation_report");

  transition = transitionTraceWorkflow(transition.state, {
    bytes: await reportPayload(),
    evidenceRoot: EVIDENCE_ROOT,
    type: "provide_validation_report",
  });
  expect(transition.output).toMatchObject({
    profiles: [{ id: "sg2044", sha256: SG2044_SOURCE_SHA256 }],
    type: "request_profile_selection",
  });

  transition = transitionTraceWorkflow(transition.state, {
    profileId: "sg2044",
    type: "select_profile",
  });
  expect(transition.output).toEqual({
    testcases: ["case_alpha", "case_zeta"],
    type: "request_testcase_selection",
  });
  return transition;
}

describe("trace workflow report and profile ports", () => {
  test("accepts exact profile bytes and strict, immutable report snapshots", async () => {
    const profileBytes = await readBytes(PROFILE_URL);
    const profile = parseSg2044HardwareProfile(profileBytes);
    expect(profile).toMatchObject({
      id: "sg2044",
      profile: { soc: "SG2044", vector: { flavor: "RVV 1.0", vlen_bits: 128 } },
      sha256: SG2044_SOURCE_SHA256,
    });
    expect(Object.isFrozen(profile)).toBeTrue();
    expect(Object.isFrozen(profile.profile.vector)).toBeTrue();
    expectWorkflowError(
      () => startTraceWorkflow({ artifactRoot: "/", profiles: [profile] }),
      "invalid-absolute-path",
    );
    expectWorkflowError(
      () => startTraceWorkflow({ artifactRoot: "relative/artifacts", profiles: [profile] }),
      "invalid-absolute-path",
    );
    for (const software of ["unsafe\u0001software", "a".repeat(256), "cafe\u0301"]) {
      expectWorkflowError(
        () => startTraceWorkflow({ artifactRoot: ARTIFACT_ROOT, profiles: [profile], software }),
        "invalid-parameter",
      );
    }

    const changedProfile = new TextEncoder().encode(
      new TextDecoder().decode(profileBytes).replace("SOPHGO", "SOPHGo"),
    );
    expect(() => parseSg2044HardwareProfile(changedProfile)).toThrow(HardwareProfileError);
    try {
      parseSg2044HardwareProfile(changedProfile);
    } catch (error) {
      expect(error).toMatchObject({ code: "profile-hash-mismatch" });
    }

    const payload = await reportPayload();
    const parsed = parsePerfDataValidationReportV1(payload);
    expect(parsed.report.testcases.map((testcase) => testcase.name)).toEqual([
      "case_zeta",
      "case_alpha",
    ]);
    expect(Object.isFrozen(parsed.report)).toBeTrue();
    expect(Object.isFrozen(parsed.report.metadata)).toBeTrue();
    expect(Object.isFrozen(parsed.report.testcases)).toBeTrue();
    expect(Object.isFrozen(parsed.report.testcases[0])).toBeTrue();
    expect(parsed.bytes).toEqual(canonicalizeJson(parsed.report).bytes);
    expect(parsePerfDataValidationReportV1(payload).sha256).toBe(parsed.sha256);

    const storedPythonGolden = await readBytes(PYTHON_VALIDATOR_GOLDEN_URL);
    expect(storedPythonGolden.at(-1)).toBe(0x0a);
    const pythonGolden = storedPythonGolden.slice(0, -1);
    const parsedPythonGolden = parsePerfDataValidationReportV1(pythonGolden);
    expect(parsedPythonGolden.bytes).toEqual(pythonGolden);
    expect(parsedPythonGolden.report.testcases).toMatchObject([
      { name: "dgemv_2048x2048", status: "valid" },
    ]);

    const unsupported = canonicalizeJson({ ...parsed.report, contract_version: 2 }).bytes;
    expectReportError(
      () => parsePerfDataValidationReportV1(unsupported),
      "unsupported-report-version",
    );

    const duplicateTestcase = canonicalizeJson({
      ...parsed.report,
      testcases: [...parsed.report.testcases, parsed.report.testcases[0]],
    }).bytes;
    expectReportError(
      () => parsePerfDataValidationReportV1(duplicateTestcase),
      "report-semantic-invalid",
    );

    const nonNfcTestcase = canonicalizeJson({
      ...parsed.report,
      testcases: [{ ...parsed.report.testcases[0], name: "case_e\u0301" }],
    }).bytes;
    expectReportError(
      () => parsePerfDataValidationReportV1(nonNfcTestcase),
      "report-semantic-invalid",
    );

    const overlongRankedFunction = canonicalizeJson({
      ...parsed.report,
      testcases: parsed.report.testcases.map((testcase, testcaseIndex) => ({
        ...testcase,
        annotates: testcase.annotates.map((annotate, annotateIndex) => ({
          ...annotate,
          function:
            testcaseIndex === 0 && annotateIndex === 0 ? "f".repeat(252) : annotate.function,
        })),
      })),
    }).bytes;
    expectReportError(
      () => parsePerfDataValidationReportV1(overlongRankedFunction),
      "report-semantic-invalid",
    );
  });
});

describe("platform-neutral trace workflow", () => {
  test("binds one function through candidate review, sealing, and publication", async () => {
    let transition = await reachTestcaseSelection();
    transition = transitionTraceWorkflow(transition.state, {
      selection: { name: "case_zeta", type: "one" },
      type: "select_testcases",
    });
    const approval = requireOutput(transition, "request_plan_approval");
    expect(approval.plan.artifactRoot).toBe(ARTIFACT_ROOT);
    expect(approval.plan.evidenceRoot).toBe(EVIDENCE_ROOT);
    expect(approval.plan.functions.map((item) => item.functionId)).toEqual([
      "case_zeta/001_zeta_only",
    ]);
    expect(approval.plan.profile.id).toBe("sg2044");
    expect(approval.plan.profile.sha256).toBe(SG2044_SOURCE_SHA256);
    expect(approval.plan.profile.facts.vendor).toBe("SOPHGO");
    expect(approval.plan.profile.facts["instruction scheduling method"]).toBe("out-of-order");
    expect(approval.plan.profile.facts.cpuinfo.isa.length).toBeGreaterThan(0);
    expect(Object.isFrozen(approval.plan)).toBeTrue();
    expect(Object.isFrozen(approval.plan.functions)).toBeTrue();
    expect(Object.isFrozen(approval.plan.functions[0])).toBeTrue();
    const functionPlan = approval.plan.functions[0];
    if (functionPlan === undefined) {
      throw new Error("Expected one planned function");
    }

    expectWorkflowError(
      () =>
        transitionTraceWorkflow(transition.state, {
          artifactSha256: null,
          candidateDigest: null,
          contextSha256: "0".repeat(64),
          functionId: functionPlan.functionId,
          target: functionPlan.target,
          type: "artifact_ready",
        }),
      "invalid-event",
    );
    expectWorkflowError(
      () =>
        transitionTraceWorkflow(transition.state, {
          planSha256: "0".repeat(64),
          type: "approve_plan",
        }),
      "stale-plan-approval",
    );

    transition = transitionTraceWorkflow(transition.state, {
      planSha256: approval.planSha256,
      type: "approve_plan",
    });
    const inspection = requireOutput(transition, "inspect_artifact");
    const { context } = inspection;
    expect(isTraceFunctionExecutionContext(context)).toBeTrue();
    expect(Object.keys(context).sort()).toEqual([
      "artifactRoot",
      "contextSha256",
      "evidenceRoot",
      "function",
      "planSha256",
      "profile",
      "reportSha256",
      "software",
    ]);
    expect(context).toMatchObject({
      artifactRoot: ARTIFACT_ROOT,
      evidenceRoot: EVIDENCE_ROOT,
      function: { functionId: functionPlan.functionId, target: functionPlan.target },
      planSha256: approval.planSha256,
      profile: { facts: { soc: "SG2044" }, id: "sg2044" },
      software: "synthetic-suite",
    });
    expect(Object.isFrozen(context)).toBeTrue();
    expect(Object.isFrozen(context.function)).toBeTrue();
    expect(Object.isFrozen(context.profile.facts.cpuinfo)).toBeTrue();

    transition = transitionTraceWorkflow(transition.state, {
      artifactSha256: null,
      candidateDigest: null,
      contextSha256: context.contextSha256,
      functionId: functionPlan.functionId,
      target: functionPlan.target,
      type: "artifact_ready",
    });
    const analysis = requireOutput(transition, "analyze_function");
    expect(analysis.context).toBe(context);
    expect(analysis).toMatchObject({
      replacementAuthorization: null,
      revisionOfCandidateDigest: null,
    });

    const failed = transitionTraceWorkflow(transition.state, {
      errorCode: "analysis_failed",
      functionId: functionPlan.functionId,
      type: "function_failed",
    });
    const failure = requireOutput(failed, "record_failure");
    expect(failure.context).toBe(context);
    expect(failure.function).toBe(context.function);

    transition = transitionTraceWorkflow(transition.state, {
      candidateDigest: CANDIDATE_ZETA,
      contextSha256: context.contextSha256,
      functionId: functionPlan.functionId,
      type: "candidate_prepared",
    });
    const review = requireOutput(transition, "review_candidate");
    expect(review.context).toBe(context);
    expect(review.candidateDigest).toBe(CANDIDATE_ZETA);

    const reviewFailure = transitionTraceWorkflow(transition.state, {
      errorCode: "review_failed",
      functionId: functionPlan.functionId,
      type: "function_failed",
    });
    const failedCandidateDiscard = requireOutput(reviewFailure, "discard_candidate");
    expect(failedCandidateDiscard).toMatchObject({
      candidateDigest: CANDIDATE_ZETA,
      context,
      reason: "function_failed",
    });
    const failureAfterDiscard = transitionTraceWorkflow(reviewFailure.state, {
      candidateDigest: CANDIDATE_ZETA,
      contextSha256: context.contextSha256,
      functionId: functionPlan.functionId,
      type: "candidate_discarded",
    });
    expect(requireOutput(failureAfterDiscard, "record_failure")).toMatchObject({
      context,
      errorCode: "review_failed",
    });

    transition = transitionTraceWorkflow(transition.state, {
      artifactSha256: ARTIFACT_ZETA,
      candidateDigest: CANDIDATE_ZETA,
      contextSha256: context.contextSha256,
      functionId: functionPlan.functionId,
      target: functionPlan.target,
      type: "candidate_sealed",
    });
    const publication = requireOutput(transition, "publish_artifact");
    expect(publication.context).toBe(context);
    expect(publication).toMatchObject({
      artifactSha256: ARTIFACT_ZETA,
      candidateDigest: CANDIDATE_ZETA,
      replacementAuthorization: null,
      target: functionPlan.target,
    });

    transition = transitionTraceWorkflow(transition.state, {
      artifactSha256: ARTIFACT_ZETA,
      candidateDigest: CANDIDATE_ZETA,
      contextSha256: context.contextSha256,
      functionId: functionPlan.functionId,
      receipt: "published-zeta",
      target: functionPlan.target,
      type: "artifact_published",
    });
    expect(transition.output).toEqual({
      completedFunctionIds: [functionPlan.functionId],
      skippedFunctionIds: [],
      type: "completed",
    });
  });

  test("requires a new candidate digest and recovers late publication conflicts", async () => {
    let transition = await reachTestcaseSelection();
    transition = transitionTraceWorkflow(transition.state, {
      selection: { type: "all" },
      type: "select_testcases",
    });
    const approval = requireOutput(transition, "request_plan_approval");
    expect(approval.plan.functions.map((item) => item.functionId)).toEqual([
      "case_alpha/001_alpha_head",
      "case_alpha/002_alpha_tail",
      "case_zeta/001_zeta_only",
    ]);

    transition = transitionTraceWorkflow(transition.state, {
      planSha256: approval.planSha256,
      type: "approve_plan",
    });
    const alphaInspection = requireOutput(transition, "inspect_artifact");
    const alphaContext = alphaInspection.context;
    transition = transitionTraceWorkflow(transition.state, {
      artifactSha256: null,
      candidateDigest: null,
      contextSha256: alphaContext.contextSha256,
      functionId: alphaInspection.function.functionId,
      target: alphaInspection.function.target,
      type: "artifact_ready",
    });
    expect(requireOutput(transition, "analyze_function").context).toBe(alphaContext);

    transition = transitionTraceWorkflow(transition.state, {
      candidateDigest: CANDIDATE_ALPHA_V1,
      contextSha256: alphaContext.contextSha256,
      functionId: alphaInspection.function.functionId,
      type: "candidate_prepared",
    });
    requireOutput(transition, "review_candidate");
    transition = transitionTraceWorkflow(transition.state, {
      candidateDigest: CANDIDATE_ALPHA_V1,
      contextSha256: alphaContext.contextSha256,
      functionId: alphaInspection.function.functionId,
      type: "candidate_revision_required",
    });
    const revision = requireOutput(transition, "analyze_function");
    expect(revision.context).toBe(alphaContext);
    expect(revision.revisionOfCandidateDigest).toBe(CANDIDATE_ALPHA_V1);
    expectWorkflowError(
      () =>
        transitionTraceWorkflow(transition.state, {
          candidateDigest: CANDIDATE_ALPHA_V1,
          contextSha256: alphaContext.contextSha256,
          functionId: alphaInspection.function.functionId,
          type: "candidate_prepared",
        }),
      "stale-candidate",
    );
    expectWorkflowError(
      () =>
        transitionTraceWorkflow(transition.state, {
          artifactSha256: ARTIFACT_ALPHA,
          candidateDigest: CANDIDATE_ALPHA_V1,
          contextSha256: alphaContext.contextSha256,
          functionId: alphaInspection.function.functionId,
          target: alphaInspection.function.target,
          type: "candidate_sealed",
        }),
      "invalid-event",
    );

    transition = transitionTraceWorkflow(transition.state, {
      candidateDigest: CANDIDATE_ALPHA_V2,
      contextSha256: alphaContext.contextSha256,
      functionId: alphaInspection.function.functionId,
      type: "candidate_prepared",
    });
    transition = transitionTraceWorkflow(transition.state, {
      artifactSha256: ARTIFACT_ALPHA,
      candidateDigest: CANDIDATE_ALPHA_V2,
      contextSha256: alphaContext.contextSha256,
      functionId: alphaInspection.function.functionId,
      target: alphaInspection.function.target,
      type: "candidate_sealed",
    });
    requireOutput(transition, "publish_artifact");

    transition = transitionTraceWorkflow(transition.state, {
      artifactSha256: ARTIFACT_ALPHA,
      authorizationToken: "publication-conflict-token",
      candidateDigest: CANDIDATE_ALPHA_V2,
      contextSha256: alphaContext.contextSha256,
      existingTreeSha256: "c".repeat(64),
      functionId: alphaInspection.function.functionId,
      target: alphaInspection.function.target,
      type: "artifact_conflict",
    });
    const lateConflict = requireOutput(transition, "request_conflict_resolution");
    expect(lateConflict.conflict).toMatchObject({
      artifactSha256: ARTIFACT_ALPHA,
      candidateDigest: CANDIDATE_ALPHA_V2,
      contextSha256: alphaContext.contextSha256,
      resume: "publication",
    });
    const lateConflictState = transition.state;

    const replacement = transitionTraceWorkflow(lateConflictState, {
      authorizationToken: "publication-conflict-token",
      type: "replace_artifact",
    });
    const replacementPublication = requireOutput(replacement, "publish_artifact");
    expect(replacementPublication.context).toBe(alphaContext);
    expect(replacementPublication.replacementAuthorization).toBe("publication-conflict-token");

    const changedRootDiscard = transitionTraceWorkflow(lateConflictState, {
      artifactRoot: CHANGED_ARTIFACT_ROOT,
      type: "change_artifact_root",
    });
    expect(requireOutput(changedRootDiscard, "discard_candidate")).toMatchObject({
      candidateDigest: CANDIDATE_ALPHA_V2,
      context: alphaContext,
      reason: "artifact_root_changed",
    });
    const changedRoot = transitionTraceWorkflow(changedRootDiscard.state, {
      candidateDigest: CANDIDATE_ALPHA_V2,
      contextSha256: alphaContext.contextSha256,
      functionId: alphaInspection.function.functionId,
      type: "candidate_discarded",
    });
    const changedApproval = requireOutput(changedRoot, "request_plan_approval");
    expect(changedRoot.state.functionContext).toBeNull();
    expect(changedApproval.plan.functions[0]?.target).toBe(
      `${CHANGED_ARTIFACT_ROOT}/synthetic-suite/case_alpha/001_alpha_head`,
    );
    expectWorkflowError(
      () =>
        transitionTraceWorkflow(changedRoot.state, {
          planSha256: approval.planSha256,
          type: "approve_plan",
        }),
      "stale-plan-approval",
    );
    const changedInspection = transitionTraceWorkflow(changedRoot.state, {
      planSha256: changedApproval.planSha256,
      type: "approve_plan",
    });
    expect(requireOutput(changedInspection, "inspect_artifact").context).not.toBe(alphaContext);

    const cancelledConflict = transitionTraceWorkflow(lateConflictState, {
      type: "terminate_conflict",
    });
    expect(requireOutput(cancelledConflict, "discard_candidate").reason).toBe("workflow_cancelled");
    const cancelled = transitionTraceWorkflow(cancelledConflict.state, {
      candidateDigest: CANDIDATE_ALPHA_V2,
      contextSha256: alphaContext.contextSha256,
      functionId: alphaInspection.function.functionId,
      type: "candidate_discarded",
    });
    expect(cancelled.output.type).toBe("cancelled");

    transition = transitionTraceWorkflow(lateConflictState, {
      artifactSha256: ARTIFACT_ALPHA,
      candidateDigest: CANDIDATE_ALPHA_V2,
      contextSha256: alphaContext.contextSha256,
      functionId: alphaInspection.function.functionId,
      target: alphaInspection.function.target,
      type: "artifact_ready",
    });
    expect(requireOutput(transition, "publish_artifact").replacementAuthorization).toBeNull();
    transition = transitionTraceWorkflow(transition.state, {
      artifactSha256: ARTIFACT_ALPHA,
      candidateDigest: CANDIDATE_ALPHA_V2,
      contextSha256: alphaContext.contextSha256,
      functionId: alphaInspection.function.functionId,
      receipt: "published-alpha",
      target: alphaInspection.function.target,
      type: "artifact_published",
    });
    requireOutput(transition, "request_continue");

    const pauseState = transition.state;
    const continued = transitionTraceWorkflow(pauseState, {
      functionId: alphaInspection.function.functionId,
      type: "continue",
    });
    expect(requireOutput(continued, "inspect_artifact").function.functionId).toBe(
      "case_alpha/002_alpha_tail",
    );

    transition = transitionTraceWorkflow(pauseState, {
      functionId: alphaInspection.function.functionId,
      type: "stop",
    });
    const zetaInspection = requireOutput(transition, "inspect_artifact");
    expect(zetaInspection.function.functionId).toBe("case_zeta/001_zeta_only");
    expect(transition.state.skippedFunctionIds).toEqual(["case_alpha/002_alpha_tail"]);

    transition = transitionTraceWorkflow(transition.state, {
      artifactSha256: null,
      authorizationToken: "analysis-conflict-token",
      candidateDigest: null,
      contextSha256: zetaInspection.context.contextSha256,
      existingTreeSha256: "d".repeat(64),
      functionId: zetaInspection.function.functionId,
      target: zetaInspection.function.target,
      type: "artifact_conflict",
    });
    expect(requireOutput(transition, "request_conflict_resolution").conflict.resume).toBe(
      "analysis",
    );
    expectWorkflowError(
      () =>
        transitionTraceWorkflow(transition.state, {
          authorizationToken: "wrong-token",
          type: "replace_artifact",
        }),
      "stale-conflict-authorization",
    );
    transition = transitionTraceWorkflow(transition.state, {
      authorizationToken: "analysis-conflict-token",
      type: "replace_artifact",
    });
    const zetaAnalysis = requireOutput(transition, "analyze_function");
    expect(zetaAnalysis.context).toBe(zetaInspection.context);
    expect(zetaAnalysis.replacementAuthorization).toBe("analysis-conflict-token");

    transition = transitionTraceWorkflow(transition.state, {
      candidateDigest: CANDIDATE_ZETA,
      contextSha256: zetaInspection.context.contextSha256,
      functionId: zetaInspection.function.functionId,
      type: "candidate_prepared",
    });
    transition = transitionTraceWorkflow(transition.state, {
      artifactSha256: ARTIFACT_ZETA,
      candidateDigest: CANDIDATE_ZETA,
      contextSha256: zetaInspection.context.contextSha256,
      functionId: zetaInspection.function.functionId,
      target: zetaInspection.function.target,
      type: "candidate_sealed",
    });
    transition = transitionTraceWorkflow(transition.state, {
      artifactSha256: ARTIFACT_ZETA,
      candidateDigest: CANDIDATE_ZETA,
      contextSha256: zetaInspection.context.contextSha256,
      functionId: zetaInspection.function.functionId,
      receipt: "published-zeta",
      target: zetaInspection.function.target,
      type: "artifact_published",
    });
    expect(transition.output).toEqual({
      completedFunctionIds: ["case_alpha/001_alpha_head", "case_zeta/001_zeta_only"],
      skippedFunctionIds: ["case_alpha/002_alpha_tail"],
      type: "completed",
    });
  });
});
