import { isAbsolute, join, normalize, parse as parsePath, relative, resolve } from "node:path";

import { canonicalizeJson } from "../../../tools/yuansheng-root-cause-blueprint/src/canonical-json";
import type { ConfirmedHardwareProfile, Sg2044HardwareProfile } from "./hardware-profile";
import {
  type ParsedPerfDataValidationReportV1,
  type PerfDataFileV1,
  type PerfDataTestcaseV1,
  type PerfDataValidationReportV1,
  parsePerfDataValidationReportV1,
} from "./perf-data-validation-report";

export type TraceParameter = "perf_data_root" | "software";

export interface TraceHardwareProfileIdentity {
  readonly facts: Readonly<Sg2044HardwareProfile>;
  readonly id: string;
  readonly sha256: string;
}

export interface TraceFunctionPlan {
  readonly annotate: PerfDataFileV1;
  readonly function: string;
  readonly functionId: string;
  readonly metadata: PerfDataFileV1 | null;
  readonly perfStat: PerfDataFileV1;
  readonly rank: string;
  readonly target: string;
  readonly testcase: string;
}

export interface TraceExecutionPlan {
  readonly artifactRoot: string;
  readonly evidenceRoot: string;
  readonly functions: readonly TraceFunctionPlan[];
  readonly operations: readonly string[];
  readonly perfDataRoot: string;
  readonly profile: TraceHardwareProfileIdentity;
  readonly reportSha256: string;
  readonly software: string;
}

export interface TraceFunctionExecutionContext {
  readonly artifactRoot: string;
  readonly contextSha256: string;
  readonly evidenceRoot: string;
  readonly function: TraceFunctionPlan;
  readonly planSha256: string;
  readonly profile: TraceHardwareProfileIdentity;
  readonly reportSha256: string;
  readonly software: string;
}

export interface TraceArtifactConflict {
  readonly artifactSha256: string | null;
  readonly authorizationToken: string;
  readonly candidateDigest: string | null;
  readonly contextSha256: string;
  readonly existingTreeSha256: string;
  readonly functionId: string;
  readonly resume: "analysis" | "publication";
  readonly target: string;
}

export type TraceCandidateDisposition =
  | Readonly<{ type: "cancel" }>
  | Readonly<{ type: "record_failure" }>
  | Readonly<{ artifactRoot: string; type: "replan" }>;

export type TraceCandidateDiscardReason =
  | "artifact_root_changed"
  | "function_failed"
  | "workflow_cancelled";

export type TraceWorkflowPhase =
  | "awaiting_artifact_inspection"
  | "awaiting_candidate"
  | "awaiting_candidate_review"
  | "awaiting_conflict_resolution"
  | "awaiting_continue"
  | "awaiting_parameter"
  | "awaiting_plan_approval"
  | "awaiting_profile_selection"
  | "awaiting_publication"
  | "awaiting_testcase_selection"
  | "awaiting_validation_report"
  | "cancelled"
  | "completed"
  | "discarding_candidate"
  | "failed"
  | "recording_failure";

export interface TraceWorkflowState {
  readonly artifactRoot: string;
  readonly availableProfiles: readonly TraceHardwareProfileIdentity[];
  readonly completedFunctionIds: readonly string[];
  readonly currentArtifactSha256: string | null;
  readonly currentCandidateDigest: string | null;
  readonly cursor: number;
  readonly evidenceRoot: string | null;
  readonly failureCode: string | null;
  readonly failureRecordPath: string | null;
  readonly functionContext: TraceFunctionExecutionContext | null;
  readonly pendingConflict: TraceArtifactConflict | null;
  readonly pendingCandidateDisposition: TraceCandidateDisposition | null;
  readonly pendingParameter: TraceParameter | null;
  readonly perfDataRoot: string | null;
  readonly phase: TraceWorkflowPhase;
  readonly plan: TraceExecutionPlan | null;
  readonly planSha256: string | null;
  readonly report: PerfDataValidationReportV1 | null;
  readonly reportSha256: string | null;
  readonly replacementAuthorization: string | null;
  readonly revisionOfCandidateDigest: string | null;
  readonly selectedFunctions: readonly TraceFunctionPlan[];
  readonly selectedProfile: TraceHardwareProfileIdentity | null;
  readonly skippedFunctionIds: readonly string[];
  readonly software: string | null;
}

export type TraceTestcaseSelection =
  | Readonly<{ name: string; type: "one" }>
  | Readonly<{ type: "all" }>;

export type TraceWorkflowEvent =
  | Readonly<{
      field: TraceParameter;
      type: "provide_parameter";
      value: string;
    }>
  | Readonly<{
      bytes: Uint8Array;
      evidenceRoot: string;
      type: "provide_validation_report";
    }>
  | Readonly<{
      profileId: string;
      type: "select_profile";
    }>
  | Readonly<{
      selection: TraceTestcaseSelection;
      type: "select_testcases";
    }>
  | Readonly<{
      planSha256: string;
      type: "approve_plan";
    }>
  | Readonly<{ type: "cancel_plan" }>
  | Readonly<{
      artifactSha256: string | null;
      candidateDigest: string | null;
      contextSha256: string;
      functionId: string;
      target: string;
      type: "artifact_ready";
    }>
  | Readonly<{
      artifactSha256: string | null;
      authorizationToken: string;
      candidateDigest: string | null;
      contextSha256: string;
      existingTreeSha256: string;
      functionId: string;
      target: string;
      type: "artifact_conflict";
    }>
  | Readonly<{
      authorizationToken: string;
      type: "replace_artifact";
    }>
  | Readonly<{
      artifactRoot: string;
      type: "change_artifact_root";
    }>
  | Readonly<{ type: "terminate_conflict" }>
  | Readonly<{
      candidateDigest: string;
      contextSha256: string;
      functionId: string;
      type: "candidate_prepared";
    }>
  | Readonly<{
      candidateDigest: string;
      contextSha256: string;
      functionId: string;
      type: "candidate_revision_required";
    }>
  | Readonly<{
      candidateDigest: string;
      contextSha256: string;
      functionId: string;
      type: "candidate_discarded";
    }>
  | Readonly<{
      artifactSha256: string;
      candidateDigest: string;
      contextSha256: string;
      functionId: string;
      target: string;
      type: "candidate_sealed";
    }>
  | Readonly<{
      artifactSha256: string;
      candidateDigest: string;
      contextSha256: string;
      functionId: string;
      receipt: string;
      target: string;
      type: "artifact_published";
    }>
  | Readonly<{
      errorCode: string;
      functionId: string;
      type: "function_failed";
    }>
  | Readonly<{
      recordPath: string;
      type: "failure_recorded";
    }>
  | Readonly<{
      functionId: string;
      type: "continue";
    }>
  | Readonly<{
      functionId: string;
      type: "stop";
    }>;

export type TraceWorkflowOutput =
  | Readonly<{
      field: TraceParameter;
      type: "request_parameter";
    }>
  | Readonly<{
      perfDataRoot: string;
      software: string;
      type: "request_validation_report";
    }>
  | Readonly<{
      profiles: readonly TraceHardwareProfileIdentity[];
      type: "request_profile_selection";
    }>
  | Readonly<{
      testcases: readonly string[];
      type: "request_testcase_selection";
    }>
  | Readonly<{
      plan: TraceExecutionPlan;
      planSha256: string;
      type: "request_plan_approval";
    }>
  | Readonly<{
      context: TraceFunctionExecutionContext;
      function: TraceFunctionPlan;
      type: "inspect_artifact";
    }>
  | Readonly<{
      conflict: TraceArtifactConflict;
      type: "request_conflict_resolution";
    }>
  | Readonly<{
      context: TraceFunctionExecutionContext;
      replacementAuthorization: string | null;
      revisionOfCandidateDigest: string | null;
      type: "analyze_function";
    }>
  | Readonly<{
      candidateDigest: string;
      context: TraceFunctionExecutionContext;
      type: "review_candidate";
    }>
  | Readonly<{
      candidateDigest: string;
      context: TraceFunctionExecutionContext;
      reason: TraceCandidateDiscardReason;
      type: "discard_candidate";
    }>
  | Readonly<{
      artifactSha256: string;
      candidateDigest: string;
      context: TraceFunctionExecutionContext;
      replacementAuthorization: string | null;
      target: string;
      type: "publish_artifact";
    }>
  | Readonly<{
      current: TraceFunctionPlan;
      next: TraceFunctionPlan;
      type: "request_continue";
    }>
  | Readonly<{
      context: TraceFunctionExecutionContext;
      errorCode: string;
      function: TraceFunctionPlan;
      type: "record_failure";
    }>
  | Readonly<{
      completedFunctionIds: readonly string[];
      skippedFunctionIds: readonly string[];
      type: "completed";
    }>
  | Readonly<{
      completedFunctionIds: readonly string[];
      skippedFunctionIds: readonly string[];
      type: "cancelled";
    }>
  | Readonly<{
      errorCode: string;
      recordPath: string;
      type: "failed";
    }>;

export interface TraceTransition {
  readonly output: TraceWorkflowOutput;
  readonly state: TraceWorkflowState;
}

export interface StartTraceWorkflowInput {
  readonly artifactRoot: string;
  readonly perfDataRoot?: string;
  readonly profiles: readonly ConfirmedHardwareProfile[];
  readonly software?: string;
}

export type TraceWorkflowErrorCode =
  | "duplicate-profile"
  | "invalid-absolute-path"
  | "invalid-conflict"
  | "invalid-context"
  | "invalid-event"
  | "invalid-parameter"
  | "invalid-profile"
  | "invalid-report"
  | "invalid-selection"
  | "no-hardware-profile"
  | "stale-conflict-authorization"
  | "stale-candidate"
  | "stale-function-event"
  | "stale-plan-approval"
  | "stale-publication"
  | "unusable-report";

export class TraceWorkflowError extends Error {
  constructor(
    readonly code: TraceWorkflowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TraceWorkflowError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/u;
const UTF8_ENCODER = new TextEncoder();
const TRACE_FUNCTION_CONTEXTS = new WeakSet<object>();
const PLAN_OPERATIONS = [
  "verify_report_evidence",
  "inspect_artifact_target",
  "analyze_function",
  "machine_validate_candidate",
  "semantic_review_candidate",
  "publish_function_artifact",
  "discard_candidate_on_abort",
  "record_failure_if_needed",
] as const;

function freezeSnapshot<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) {
    freezeSnapshot(item);
  }
  Object.freeze(value);
  return value;
}

export function isTraceFunctionExecutionContext(
  value: unknown,
): value is TraceFunctionExecutionContext {
  return typeof value === "object" && value !== null && TRACE_FUNCTION_CONTEXTS.has(value);
}

export function assertTraceFunctionExecutionContext(
  value: unknown,
): asserts value is TraceFunctionExecutionContext {
  if (!isTraceFunctionExecutionContext(value)) {
    throw new TraceWorkflowError(
      "invalid-context",
      "Function execution context was not issued by the trace workflow",
    );
  }
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const commonLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < commonLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function requireNonempty(value: string, label: string): string {
  if (value.trim().length === 0 || value.includes("\0")) {
    throw new TraceWorkflowError("invalid-parameter", `${label} must be a non-empty string`);
  }
  return value;
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

function requireSoftwareSegment(value: string): string {
  const software = requireNonempty(value, "software");
  if (
    software === "." ||
    software === ".." ||
    /[/\\]/u.test(software) ||
    hasControlCharacter(software) ||
    software.normalize("NFC") !== software ||
    UTF8_ENCODER.encode(software).byteLength > 255
  ) {
    throw new TraceWorkflowError(
      "invalid-parameter",
      "software must be a single safe artifact path segment",
    );
  }
  return software;
}

function requireAbsolutePath(value: string, label: string): string {
  if (
    !isAbsolute(value) ||
    value.includes("\0") ||
    normalize(value) !== value ||
    resolve(value) !== value ||
    parsePath(value).root === value
  ) {
    throw new TraceWorkflowError(
      "invalid-absolute-path",
      `${label} must be a caller-resolved absolute path`,
    );
  }
  return value;
}

function profileIdentity(profile: ConfirmedHardwareProfile): TraceHardwareProfileIdentity {
  return freezeSnapshot({
    facts: {
      ...profile.profile,
      cpuinfo: { ...profile.profile.cpuinfo },
      vector: { ...profile.profile.vector },
    },
    id: profile.id,
    sha256: profile.sha256,
  });
}

function requireProfiles(
  profiles: readonly ConfirmedHardwareProfile[],
): readonly TraceHardwareProfileIdentity[] {
  if (profiles.length === 0) {
    throw new TraceWorkflowError(
      "no-hardware-profile",
      "At least one confirmed hardware profile is required",
    );
  }
  const identities = profiles
    .map(profileIdentity)
    .sort((left, right) => compareUtf8(left.id, right.id));
  const seen = new Set<string>();
  for (const profile of identities) {
    if (seen.has(profile.id)) {
      throw new TraceWorkflowError(
        "duplicate-profile",
        `Hardware profile ${profile.id} is declared more than once`,
      );
    }
    seen.add(profile.id);
  }
  return Object.freeze(identities);
}

function requestAfterParameters(state: TraceWorkflowState): TraceTransition {
  if (state.software === null) {
    const next = { ...state, pendingParameter: "software", phase: "awaiting_parameter" } as const;
    return { output: { field: "software", type: "request_parameter" }, state: next };
  }
  if (state.perfDataRoot === null) {
    const next = {
      ...state,
      pendingParameter: "perf_data_root",
      phase: "awaiting_parameter",
    } as const;
    return { output: { field: "perf_data_root", type: "request_parameter" }, state: next };
  }
  const next = {
    ...state,
    pendingParameter: null,
    phase: "awaiting_validation_report",
  } as const;
  return {
    output: {
      perfDataRoot: state.perfDataRoot,
      software: state.software,
      type: "request_validation_report",
    },
    state: next,
  };
}

function validTestcases(report: PerfDataValidationReportV1): readonly PerfDataTestcaseV1[] {
  return report.testcases
    .filter((testcase) => testcase.status === "valid")
    .sort((left, right) => compareUtf8(left.name, right.name));
}

function targetPath(
  artifactRoot: string,
  software: string,
  testcase: string,
  rank: string,
  functionName: string,
): string {
  return join(artifactRoot, software, testcase, `${rank}_${functionName}`);
}

function planFunctions(
  report: PerfDataValidationReportV1,
  selectedNames: ReadonlySet<string>,
  artifactRoot: string,
  software: string,
): readonly TraceFunctionPlan[] {
  const functions: TraceFunctionPlan[] = [];
  for (const testcase of validTestcases(report)) {
    if (!selectedNames.has(testcase.name)) {
      continue;
    }
    if (testcase.perf_stat === null) {
      throw new TraceWorkflowError(
        "invalid-report",
        `Valid testcase ${testcase.name} has no perf stat reference`,
      );
    }
    const annotates = [...testcase.annotates].sort(
      (left, right) =>
        Number.parseInt(left.rank, 10) - Number.parseInt(right.rank, 10) ||
        compareUtf8(left.function, right.function),
    );
    for (const annotate of annotates) {
      const functionId = `${testcase.name}/${annotate.rank}_${annotate.function}`;
      functions.push({
        annotate: annotate.file,
        function: annotate.function,
        functionId,
        metadata: report.metadata.file,
        perfStat: testcase.perf_stat,
        rank: annotate.rank,
        target: targetPath(artifactRoot, software, testcase.name, annotate.rank, annotate.function),
        testcase: testcase.name,
      });
    }
  }
  return freezeSnapshot(functions);
}

function currentFunction(state: TraceWorkflowState): TraceFunctionPlan {
  const current = state.selectedFunctions[state.cursor];
  if (current === undefined) {
    throw new TraceWorkflowError("invalid-event", "Workflow has no current function");
  }
  return current;
}

function requireFunctionBinding(state: TraceWorkflowState, functionId: string): TraceFunctionPlan {
  const current = currentFunction(state);
  if (current.functionId !== functionId) {
    throw new TraceWorkflowError(
      "stale-function-event",
      `Expected an event for ${current.functionId}, received ${functionId}`,
    );
  }
  return current;
}

function requireContextBinding(
  state: TraceWorkflowState,
  functionId: string,
  contextSha256: string,
): TraceFunctionExecutionContext {
  requireFunctionBinding(state, functionId);
  const context = state.functionContext;
  if (
    context === null ||
    !isTraceFunctionExecutionContext(context) ||
    context.contextSha256 !== contextSha256
  ) {
    throw new TraceWorkflowError(
      "invalid-context",
      "Lifecycle event does not match the current function execution context",
    );
  }
  return context;
}

function requireCandidateBinding(
  state: TraceWorkflowState,
  functionId: string,
  contextSha256: string,
  candidateDigest: string,
): TraceFunctionExecutionContext {
  const context = requireContextBinding(state, functionId, contextSha256);
  if (!SHA256.test(candidateDigest) || state.currentCandidateDigest !== candidateDigest) {
    throw new TraceWorkflowError(
      "stale-candidate",
      "Lifecycle event does not match the current candidate digest",
    );
  }
  return context;
}

type TraceArtifactReadyEvent = Extract<TraceWorkflowEvent, { readonly type: "artifact_ready" }>;
type TraceArtifactConflictEvent = Extract<
  TraceWorkflowEvent,
  { readonly type: "artifact_conflict" }
>;
type TracePublicationBinding = Readonly<{
  artifactSha256: string;
  candidateDigest: string;
  contextSha256: string;
  functionId: string;
  target: string;
}>;

function requireInspectionBinding(
  state: TraceWorkflowState,
  event: TraceArtifactReadyEvent | TraceArtifactConflictEvent,
): TraceFunctionPlan {
  const current = requireFunctionBinding(state, event.functionId);
  if (
    event.target !== current.target ||
    event.artifactSha256 !== null ||
    event.candidateDigest !== null
  ) {
    throw new TraceWorkflowError(
      event.type === "artifact_conflict" ? "invalid-conflict" : "stale-publication",
      "Artifact inspection event must identify the current target before analysis begins",
    );
  }
  requireContextBinding(state, event.functionId, event.contextSha256);
  return current;
}

function requirePublicationBinding(
  state: TraceWorkflowState,
  event: TracePublicationBinding,
): TraceFunctionExecutionContext {
  const context = requireCandidateBinding(
    state,
    event.functionId,
    event.contextSha256,
    event.candidateDigest,
  );
  if (
    !SHA256.test(event.artifactSha256) ||
    state.currentArtifactSha256 !== event.artifactSha256 ||
    event.target !== context.function.target
  ) {
    throw new TraceWorkflowError(
      "stale-publication",
      "Publication event does not match the sealed artifact and exact target",
    );
  }
  return context;
}

function createArtifactConflict(
  state: TraceWorkflowState,
  event: TraceArtifactConflictEvent,
  resume: "analysis" | "publication",
): TraceArtifactConflict {
  if (resume === "analysis") {
    requireInspectionBinding(state, event);
  } else {
    if (event.artifactSha256 === null || event.candidateDigest === null) {
      throw new TraceWorkflowError(
        "invalid-conflict",
        "Publication conflict must bind the sealed candidate and artifact",
      );
    }
    requirePublicationBinding(state, {
      artifactSha256: event.artifactSha256,
      candidateDigest: event.candidateDigest,
      contextSha256: event.contextSha256,
      functionId: event.functionId,
      target: event.target,
    });
  }
  if (
    !SHA256.test(event.existingTreeSha256) ||
    event.authorizationToken.trim().length === 0 ||
    event.authorizationToken.includes("\0")
  ) {
    throw new TraceWorkflowError(
      "invalid-conflict",
      `Artifact conflict cannot resume ${resume} without bound content and authorization`,
    );
  }
  return freezeSnapshot({
    artifactSha256: event.artifactSha256,
    authorizationToken: event.authorizationToken,
    candidateDigest: event.candidateDigest,
    contextSha256: event.contextSha256,
    existingTreeSha256: event.existingTreeSha256,
    functionId: event.functionId,
    resume,
    target: event.target,
  });
}

function createFunctionContext(state: TraceWorkflowState): TraceFunctionExecutionContext {
  if (
    state.evidenceRoot === null ||
    state.planSha256 === null ||
    state.reportSha256 === null ||
    state.selectedProfile === null ||
    state.software === null
  ) {
    throw new TraceWorkflowError("invalid-context", "Workflow execution context is incomplete");
  }
  const core = freezeSnapshot({
    artifactRoot: state.artifactRoot,
    evidenceRoot: state.evidenceRoot,
    function: currentFunction(state),
    planSha256: state.planSha256,
    profile: state.selectedProfile,
    reportSha256: state.reportSha256,
    software: state.software,
  });
  const context = freezeSnapshot({
    ...core,
    contextSha256: canonicalizeJson(core).sha256,
  });
  TRACE_FUNCTION_CONTEXTS.add(context);
  return context;
}

function buildApprovalPlan(state: TraceWorkflowState): TraceTransition {
  if (
    state.software === null ||
    state.perfDataRoot === null ||
    state.evidenceRoot === null ||
    state.selectedProfile === null ||
    state.reportSha256 === null
  ) {
    throw new TraceWorkflowError("invalid-event", "Workflow is incomplete before plan approval");
  }
  const plan: TraceExecutionPlan = freezeSnapshot({
    artifactRoot: state.artifactRoot,
    evidenceRoot: state.evidenceRoot,
    functions: freezeSnapshot(state.selectedFunctions.slice(state.cursor)),
    operations: PLAN_OPERATIONS,
    perfDataRoot: state.perfDataRoot,
    profile: state.selectedProfile,
    reportSha256: state.reportSha256,
    software: state.software,
  });
  const planSha256 = canonicalizeJson(plan).sha256;
  const next = {
    ...state,
    currentArtifactSha256: null,
    currentCandidateDigest: null,
    functionContext: null,
    pendingCandidateDisposition: null,
    pendingConflict: null,
    phase: "awaiting_plan_approval",
    plan,
    planSha256,
    replacementAuthorization: null,
    revisionOfCandidateDigest: null,
  } as const;
  return {
    output: { plan, planSha256, type: "request_plan_approval" },
    state: next,
  };
}

function inspectCurrent(state: TraceWorkflowState): TraceTransition {
  const context = createFunctionContext(state);
  const next = {
    ...state,
    currentArtifactSha256: null,
    currentCandidateDigest: null,
    functionContext: context,
    pendingCandidateDisposition: null,
    pendingConflict: null,
    phase: "awaiting_artifact_inspection",
    replacementAuthorization: null,
    revisionOfCandidateDigest: null,
  } as const;
  return {
    output: { context, function: currentFunction(next), type: "inspect_artifact" },
    state: next,
  };
}

function analyzeCurrent(
  state: TraceWorkflowState,
  replacementAuthorization: string | null,
  revisionOfCandidateDigest: string | null = null,
): TraceTransition {
  const context = state.functionContext ?? createFunctionContext(state);
  assertTraceFunctionExecutionContext(context);
  const next = {
    ...state,
    currentArtifactSha256: null,
    currentCandidateDigest: null,
    functionContext: context,
    pendingCandidateDisposition: null,
    pendingConflict: null,
    phase: "awaiting_candidate",
    replacementAuthorization,
    revisionOfCandidateDigest,
  } as const;
  return {
    output: {
      context,
      replacementAuthorization,
      revisionOfCandidateDigest,
      type: "analyze_function",
    },
    state: next,
  };
}

function publishCurrent(
  state: TraceWorkflowState,
  replacementAuthorization: string | null,
): TraceTransition {
  const context = state.functionContext;
  if (
    context === null ||
    !isTraceFunctionExecutionContext(context) ||
    state.currentCandidateDigest === null ||
    state.currentArtifactSha256 === null
  ) {
    throw new TraceWorkflowError("invalid-context", "Publication context is incomplete");
  }
  const next = {
    ...state,
    pendingCandidateDisposition: null,
    pendingConflict: null,
    phase: "awaiting_publication",
    replacementAuthorization,
  } as const;
  return {
    output: {
      artifactSha256: state.currentArtifactSha256,
      candidateDigest: state.currentCandidateDigest,
      context,
      replacementAuthorization,
      target: context.function.target,
      type: "publish_artifact",
    },
    state: next,
  };
}

function completeCurrent(state: TraceWorkflowState): TraceTransition {
  const current = currentFunction(state);
  const completedFunctionIds = [...state.completedFunctionIds, current.functionId];
  const completedState = {
    ...state,
    completedFunctionIds,
    currentArtifactSha256: null,
    currentCandidateDigest: null,
    functionContext: null,
    pendingCandidateDisposition: null,
    pendingConflict: null,
    replacementAuthorization: null,
  } as const;
  const nextFunction = state.selectedFunctions[state.cursor + 1];
  if (nextFunction === undefined) {
    return terminalOutput(completedState, "completed");
  }
  const next = {
    ...completedState,
    phase: "awaiting_continue",
  } as const;
  return {
    output: { current, next: nextFunction, type: "request_continue" },
    state: next,
  };
}

function requestCandidateDiscard(
  state: TraceWorkflowState,
  disposition: TraceCandidateDisposition,
  reason: TraceCandidateDiscardReason,
): TraceTransition {
  const context = state.functionContext;
  const candidateDigest = state.currentCandidateDigest;
  assertTraceFunctionExecutionContext(context);
  if (candidateDigest === null || !SHA256.test(candidateDigest)) {
    throw new TraceWorkflowError("stale-candidate", "Workflow has no candidate to discard");
  }
  const next = {
    ...state,
    pendingCandidateDisposition: freezeSnapshot(disposition),
    phase: "discarding_candidate",
  } as const;
  return {
    output: { candidateDigest, context, reason, type: "discard_candidate" },
    state: next,
  };
}

function replanArtifactRoot(state: TraceWorkflowState, artifactRoot: string): TraceTransition {
  if (state.software === null) {
    throw new TraceWorkflowError("invalid-event", "Workflow software is not bound");
  }
  const selectedFunctions = freezeSnapshot(
    state.selectedFunctions.map((item) => ({
      ...item,
      target: targetPath(
        artifactRoot,
        state.software ?? "",
        item.testcase,
        item.rank,
        item.function,
      ),
    })),
  );
  return buildApprovalPlan({ ...state, artifactRoot, selectedFunctions });
}

function recordFunctionFailure(
  state: TraceWorkflowState,
  functionId: string,
  errorCodeValue: string,
): TraceTransition {
  const current = requireFunctionBinding(state, functionId);
  const context = state.functionContext;
  assertTraceFunctionExecutionContext(context);
  const errorCode = requireNonempty(errorCodeValue, "errorCode");
  const failedState = { ...state, failureCode: errorCode } as const;
  if (state.currentCandidateDigest !== null) {
    return requestCandidateDiscard(failedState, { type: "record_failure" }, "function_failed");
  }
  const next = { ...failedState, phase: "recording_failure" } as const;
  return {
    output: { context, errorCode, function: current, type: "record_failure" },
    state: next,
  };
}

function terminalOutput(
  state: TraceWorkflowState,
  type: "cancelled" | "completed",
): TraceTransition {
  const next = { ...state, phase: type } as const;
  return {
    output: {
      completedFunctionIds: next.completedFunctionIds,
      skippedFunctionIds: next.skippedFunctionIds,
      type,
    },
    state: next,
  };
}

function invalidEvent(state: TraceWorkflowState, event: TraceWorkflowEvent): never {
  throw new TraceWorkflowError(
    "invalid-event",
    `Event ${event.type} is not accepted while workflow is ${state.phase}`,
  );
}

export function startTraceWorkflow(input: StartTraceWorkflowInput): TraceTransition {
  const artifactRoot = requireAbsolutePath(input.artifactRoot, "artifactRoot");
  const state: TraceWorkflowState = {
    artifactRoot,
    availableProfiles: requireProfiles(input.profiles),
    completedFunctionIds: [],
    currentArtifactSha256: null,
    currentCandidateDigest: null,
    cursor: 0,
    evidenceRoot: null,
    failureCode: null,
    failureRecordPath: null,
    functionContext: null,
    pendingCandidateDisposition: null,
    pendingConflict: null,
    pendingParameter: null,
    perfDataRoot:
      input.perfDataRoot === undefined
        ? null
        : requireNonempty(input.perfDataRoot, "perf_data_root"),
    phase: "awaiting_parameter",
    plan: null,
    planSha256: null,
    report: null,
    reportSha256: null,
    replacementAuthorization: null,
    revisionOfCandidateDigest: null,
    selectedFunctions: [],
    selectedProfile: null,
    skippedFunctionIds: [],
    software: input.software === undefined ? null : requireSoftwareSegment(input.software),
  };
  return requestAfterParameters(state);
}

export function transitionTraceWorkflow(
  state: TraceWorkflowState,
  event: TraceWorkflowEvent,
): TraceTransition {
  switch (state.phase) {
    case "awaiting_parameter": {
      if (event.type !== "provide_parameter" || event.field !== state.pendingParameter) {
        return invalidEvent(state, event);
      }
      const value =
        event.field === "software"
          ? requireSoftwareSegment(event.value)
          : requireNonempty(event.value, "perf_data_root");
      return requestAfterParameters({
        ...state,
        [event.field === "software" ? "software" : "perfDataRoot"]: value,
      });
    }
    case "awaiting_validation_report": {
      if (event.type !== "provide_validation_report") {
        return invalidEvent(state, event);
      }
      const parsed: ParsedPerfDataValidationReportV1 = parsePerfDataValidationReportV1(event.bytes);
      if (parsed.report.report_status !== "usable") {
        throw new TraceWorkflowError("unusable-report", "Validation report is not usable");
      }
      const evidenceRoot = requireAbsolutePath(event.evidenceRoot, "evidenceRoot");
      const next = {
        ...state,
        evidenceRoot,
        phase: "awaiting_profile_selection",
        report: parsed.report,
        reportSha256: parsed.sha256,
      } as const;
      return {
        output: { profiles: next.availableProfiles, type: "request_profile_selection" },
        state: next,
      };
    }
    case "awaiting_profile_selection": {
      if (event.type !== "select_profile") {
        return invalidEvent(state, event);
      }
      const selectedProfile = state.availableProfiles.find(
        (profile) => profile.id === event.profileId,
      );
      if (selectedProfile === undefined) {
        throw new TraceWorkflowError(
          "invalid-profile",
          `Hardware profile ${event.profileId} is not available`,
        );
      }
      if (state.report === null) {
        throw new TraceWorkflowError("invalid-event", "Validation report is not bound");
      }
      const testcases = validTestcases(state.report).map((testcase) => testcase.name);
      const next = {
        ...state,
        phase: "awaiting_testcase_selection",
        selectedProfile,
      } as const;
      return {
        output: { testcases, type: "request_testcase_selection" },
        state: next,
      };
    }
    case "awaiting_testcase_selection": {
      if (event.type !== "select_testcases") {
        return invalidEvent(state, event);
      }
      if (state.report === null || state.software === null) {
        throw new TraceWorkflowError("invalid-event", "Workflow selection context is incomplete");
      }
      const availableNames = validTestcases(state.report).map((testcase) => testcase.name);
      const selectedNames =
        event.selection.type === "all" ? new Set(availableNames) : new Set([event.selection.name]);
      if ([...selectedNames].some((name) => !availableNames.includes(name))) {
        throw new TraceWorkflowError(
          "invalid-selection",
          "Testcase selection contains a testcase not declared valid by the report",
        );
      }
      const selectedFunctions = planFunctions(
        state.report,
        selectedNames,
        state.artifactRoot,
        state.software,
      );
      if (selectedFunctions.length === 0) {
        throw new TraceWorkflowError(
          "invalid-selection",
          "Testcase selection contains no analyzable functions",
        );
      }
      return buildApprovalPlan({ ...state, cursor: 0, selectedFunctions });
    }
    case "awaiting_plan_approval": {
      if (event.type === "cancel_plan") {
        return terminalOutput(state, "cancelled");
      }
      if (event.type !== "approve_plan") {
        return invalidEvent(state, event);
      }
      if (state.plan === null || state.planSha256 === null) {
        throw new TraceWorkflowError("invalid-event", "Workflow approval plan is missing");
      }
      const currentPlanSha256 = canonicalizeJson(state.plan).sha256;
      if (currentPlanSha256 !== state.planSha256 || event.planSha256 !== currentPlanSha256) {
        throw new TraceWorkflowError(
          "stale-plan-approval",
          "Plan approval does not match the current execution plan",
        );
      }
      return inspectCurrent(state);
    }
    case "awaiting_artifact_inspection": {
      if (event.type === "function_failed") {
        return recordFunctionFailure(state, event.functionId, event.errorCode);
      }
      if (event.type === "artifact_ready") {
        requireInspectionBinding(state, event);
        return analyzeCurrent(state, null);
      }
      if (event.type !== "artifact_conflict") {
        return invalidEvent(state, event);
      }
      const pendingConflict = createArtifactConflict(state, event, "analysis");
      const next = {
        ...state,
        pendingConflict,
        phase: "awaiting_conflict_resolution",
      } as const;
      return {
        output: { conflict: pendingConflict, type: "request_conflict_resolution" },
        state: next,
      };
    }
    case "awaiting_candidate": {
      if (event.type === "function_failed") {
        return recordFunctionFailure(state, event.functionId, event.errorCode);
      }
      if (event.type !== "candidate_prepared") {
        return invalidEvent(state, event);
      }
      const context = requireContextBinding(state, event.functionId, event.contextSha256);
      if (!SHA256.test(event.candidateDigest)) {
        throw new TraceWorkflowError(
          "stale-candidate",
          "Prepared candidate must provide a SHA-256 digest",
        );
      }
      if (event.candidateDigest === state.revisionOfCandidateDigest) {
        throw new TraceWorkflowError(
          "stale-candidate",
          "A semantic revision must produce a candidate with a new digest",
        );
      }
      const next = {
        ...state,
        currentCandidateDigest: event.candidateDigest,
        phase: "awaiting_candidate_review",
        revisionOfCandidateDigest: null,
      } as const;
      return {
        output: {
          candidateDigest: event.candidateDigest,
          context,
          type: "review_candidate",
        },
        state: next,
      };
    }
    case "awaiting_candidate_review": {
      if (event.type === "function_failed") {
        return recordFunctionFailure(state, event.functionId, event.errorCode);
      }
      if (event.type === "candidate_revision_required") {
        requireCandidateBinding(
          state,
          event.functionId,
          event.contextSha256,
          event.candidateDigest,
        );
        return analyzeCurrent(state, state.replacementAuthorization, event.candidateDigest);
      }
      if (event.type !== "candidate_sealed") {
        return invalidEvent(state, event);
      }
      const context = requireCandidateBinding(
        state,
        event.functionId,
        event.contextSha256,
        event.candidateDigest,
      );
      if (!SHA256.test(event.artifactSha256) || event.target !== context.function.target) {
        throw new TraceWorkflowError(
          "stale-publication",
          "Sealed artifact does not match the candidate's exact target",
        );
      }
      return publishCurrent(
        { ...state, currentArtifactSha256: event.artifactSha256 },
        state.replacementAuthorization,
      );
    }
    case "awaiting_publication": {
      if (event.type === "function_failed") {
        return recordFunctionFailure(state, event.functionId, event.errorCode);
      }
      if (event.type === "artifact_published") {
        requirePublicationBinding(state, event);
        requireNonempty(event.receipt, "publication receipt");
        return completeCurrent(state);
      }
      if (event.type !== "artifact_conflict") {
        return invalidEvent(state, event);
      }
      const pendingConflict = createArtifactConflict(state, event, "publication");
      const next = {
        ...state,
        pendingConflict,
        phase: "awaiting_conflict_resolution",
      } as const;
      return {
        output: { conflict: pendingConflict, type: "request_conflict_resolution" },
        state: next,
      };
    }
    case "awaiting_conflict_resolution": {
      if (event.type === "function_failed") {
        return recordFunctionFailure(state, event.functionId, event.errorCode);
      }
      if (event.type === "terminate_conflict") {
        if (state.currentCandidateDigest !== null) {
          return requestCandidateDiscard(state, { type: "cancel" }, "workflow_cancelled");
        }
        return terminalOutput(state, "cancelled");
      }
      if (event.type === "change_artifact_root") {
        const artifactRoot = requireAbsolutePath(event.artifactRoot, "artifactRoot");
        if (state.currentCandidateDigest !== null) {
          return requestCandidateDiscard(
            state,
            { artifactRoot, type: "replan" },
            "artifact_root_changed",
          );
        }
        return replanArtifactRoot(state, artifactRoot);
      }
      const conflict = state.pendingConflict;
      if (conflict === null) {
        throw new TraceWorkflowError("invalid-conflict", "Workflow conflict context is missing");
      }
      if (event.type === "artifact_ready") {
        if (conflict.resume === "analysis") {
          requireInspectionBinding(state, event);
          return analyzeCurrent(state, null);
        }
        if (event.artifactSha256 === null || event.candidateDigest === null) {
          throw new TraceWorkflowError(
            "stale-publication",
            "Publication reinspection must bind the sealed candidate and artifact",
          );
        }
        requirePublicationBinding(state, {
          artifactSha256: event.artifactSha256,
          candidateDigest: event.candidateDigest,
          contextSha256: event.contextSha256,
          functionId: event.functionId,
          target: event.target,
        });
        return publishCurrent(state, null);
      }
      if (event.type !== "replace_artifact") {
        return invalidEvent(state, event);
      }
      if (event.authorizationToken !== conflict.authorizationToken) {
        throw new TraceWorkflowError(
          "stale-conflict-authorization",
          "Replacement authorization does not match the current artifact conflict",
        );
      }
      return conflict.resume === "analysis"
        ? analyzeCurrent(state, event.authorizationToken)
        : publishCurrent(state, event.authorizationToken);
    }
    case "discarding_candidate": {
      if (event.type !== "candidate_discarded") {
        return invalidEvent(state, event);
      }
      requireCandidateBinding(state, event.functionId, event.contextSha256, event.candidateDigest);
      const disposition = state.pendingCandidateDisposition;
      if (disposition === null) {
        throw new TraceWorkflowError(
          "invalid-event",
          "Candidate discard has no pending workflow disposition",
        );
      }
      const next = {
        ...state,
        currentArtifactSha256: null,
        currentCandidateDigest: null,
        pendingCandidateDisposition: null,
        pendingConflict: null,
        replacementAuthorization: null,
        revisionOfCandidateDigest: null,
      } as const;
      switch (disposition.type) {
        case "cancel":
          return terminalOutput(next, "cancelled");
        case "record_failure": {
          if (next.failureCode === null) {
            throw new TraceWorkflowError(
              "invalid-event",
              "Candidate discard lost the pending function failure",
            );
          }
          return recordFunctionFailure(next, event.functionId, next.failureCode);
        }
        case "replan":
          return replanArtifactRoot(next, disposition.artifactRoot);
        default:
          throw new TraceWorkflowError(
            "invalid-event",
            "Candidate discard has an unknown workflow disposition",
          );
      }
    }
    case "awaiting_continue": {
      if (event.type !== "continue" && event.type !== "stop") {
        return invalidEvent(state, event);
      }
      const current = requireFunctionBinding(state, event.functionId);
      let cursor = state.cursor + 1;
      const skippedFunctionIds = [...state.skippedFunctionIds];
      if (event.type === "stop") {
        while (state.selectedFunctions[cursor]?.testcase === current.testcase) {
          const skipped = state.selectedFunctions[cursor];
          if (skipped !== undefined) {
            skippedFunctionIds.push(skipped.functionId);
          }
          cursor += 1;
        }
      }
      if (state.selectedFunctions[cursor] === undefined) {
        return terminalOutput({ ...state, cursor, skippedFunctionIds }, "completed");
      }
      return inspectCurrent({ ...state, cursor, skippedFunctionIds });
    }
    case "recording_failure": {
      if (event.type !== "failure_recorded") {
        return invalidEvent(state, event);
      }
      const recordPath = requireAbsolutePath(event.recordPath, "failure record path");
      const failedRoot = join(state.artifactRoot, ".failed");
      const relativeRecordPath = relative(failedRoot, recordPath);
      if (
        relativeRecordPath.length === 0 ||
        /^\.\.(?:[/\\]|$)/u.test(relativeRecordPath) ||
        isAbsolute(relativeRecordPath)
      ) {
        throw new TraceWorkflowError(
          "invalid-absolute-path",
          "Failure record path must be contained below artifactRoot/.failed",
        );
      }
      if (state.failureCode === null) {
        throw new TraceWorkflowError("invalid-event", "Workflow failure code is missing");
      }
      const next = { ...state, failureRecordPath: recordPath, phase: "failed" } as const;
      return {
        output: { errorCode: state.failureCode, recordPath, type: "failed" },
        state: next,
      };
    }
    case "cancelled":
    case "completed":
    case "failed":
      return invalidEvent(state, event);
  }
}
