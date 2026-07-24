import {
  canonicalizeJson,
  sealArtifact,
  sha256Digest,
} from "../../plugins/craft/workflows/artifacts/canonical";
import type {
  ActionJournal,
  BlueprintReviewAttestation,
  BlueprintReviewSubject,
  CriterionEvidence,
  Delivery,
  DiffManifest,
  MutationAuthorization,
  PatchCandidate,
  PatchPlan,
  PatchReview,
  PhaseCommandAuthorization,
  PhaseCommandManifest,
  RepositoryBinding,
  RootCauseArtifact,
  VerificationAuthorization,
  VerificationManifest,
  VerificationSource,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../../plugins/craft/workflows/artifacts/generated";
import { artifactRef } from "../../plugins/craft/workflows/artifacts/parser";
import type { JsonValue } from "../../plugins/craft/workflows/artifacts/strict-json";

const CREATED_AT = "2026-07-24T08:00:00.000Z";
const WORKFLOW_ID = "workflow:ABCDEFGHIJKLMNOP";
const BUILDER_SESSION_ID = "session:BUILDER123456789";
const REVIEWER_SESSION_ID = "session:REVIEWER12345678";
const REVIEW_SESSION_ID = "session:BLUEPRINT1234567";
const BINDING_TREE_DIGEST = digest("bound repository tree");
const BLUEPRINT_RAW_DIGEST = digest("raw Blueprint bytes");
const BLUEPRINT_CANONICAL_DIGEST = digest("canonical Blueprint bytes");
const SEALED_DIRECTORY_DIGEST = digest("sealed function directory");

function digest(value: string): `sha256:${string}` {
  return sha256Digest(new TextEncoder().encode(value));
}

const BINARY_PATCH_DIGEST = digest("canonical binary patch");
const DIFF_ENTRIES: DiffManifest["entries"] = [
  {
    binary: false,
    new_blob_digest: digest("new normalize.ts"),
    new_mode: "100644",
    old_blob_digest: digest("old normalize.ts"),
    old_mode: "100644",
    operation: "modify",
    path: "src/normalize.ts",
    source_path: null,
  },
];
const DIFF_CONTENT_DIGEST = canonicalizeJson({
  binary_patch_digest: BINARY_PATCH_DIGEST,
  entries: DIFF_ENTRIES,
}).digest;

function makeContract<T extends YuanshengCraftContractV1>(payload: Omit<T, "artifact_digest">): T {
  return sealArtifact(payload as unknown as Record<string, JsonValue>) as unknown as T;
}

function encode(contract: YuanshengCraftContractV1): Uint8Array {
  return canonicalizeJson(contract).bytes;
}

export function makeRepositoryBinding(
  overrides: Partial<
    Omit<RepositoryBinding, "artifact_digest" | "artifact_type" | "artifact_version">
  > = {},
): RepositoryBinding {
  return makeContract<RepositoryBinding>({
    artifact_type: "repository-binding",
    artifact_version: 1,
    commit_sha: "0123456789abcdef0123456789abcdef01234567",
    created_at: CREATED_AT,
    git_root_realpath: "/workspace/project",
    preparation_mode: "manual",
    product_root_realpath: "/workspace/project",
    repository_url: "https://example.invalid/project.git",
    target_worktree_realpath: "/workspace/project",
    tree_digest: BINDING_TREE_DIGEST,
    ...overrides,
  });
}

function rootCauseFacts(binding: RepositoryBinding): RootCauseArtifact["facts"] {
  return [
    {
      evidence_refs: [artifactRef(binding)],
      id: "fact:OBSERVED12345678",
      statement: "The normalized configuration omits the required field.",
    },
  ];
}

function rootCauseCriteria(): RootCauseArtifact["criteria"] {
  return [
    {
      fact_ids: ["fact:OBSERVED12345678"],
      id: "criterion:PRESERVE12345678",
      required: true,
      statement: "The required field remains present after normalization.",
    },
  ];
}

export function makeProblemEntryGraph(): readonly YuanshengCraftContractV1[] {
  const binding = makeRepositoryBinding();
  const rootCause = makeContract<RootCauseArtifact>({
    artifact_type: "root-cause",
    artifact_version: 1,
    created_at: CREATED_AT,
    criteria: [...rootCauseCriteria()],
    entry_strategy: "problem-description",
    facts: [...rootCauseFacts(binding)],
    gaps: [
      {
        id: "gap:LOGGING123456789",
        statement: "Logging behavior has not yet been observed.",
      },
    ],
    inferences: [
      {
        basis_fact_ids: ["fact:OBSERVED12345678"],
        id: "inference:NORMALIZE1234567",
        statement: "Normalization discards the field.",
      },
    ],
    problem_summary: "Configuration normalization drops a required field.",
    provenance: {
      source: "problem-description",
      source_refs: [artifactRef(binding)],
    },
    status: "confirmed",
    workflow_id: WORKFLOW_ID,
  });
  return [binding, rootCause];
}

export function makeBlueprintEntryGraph(
  action: BlueprintReviewAttestation["action"] = "allow",
  overallStatus: BlueprintReviewSubject["overall_status"] = "confirmed",
  finalStatus: BlueprintReviewSubject["final_status"] = "confirmed_root_cause",
): readonly YuanshengCraftContractV1[] {
  const binding = makeRepositoryBinding();
  const subject = makeContract<BlueprintReviewSubject>({
    artifact_type: "blueprint-review-subject",
    artifact_version: 1,
    blueprint_canonical_digest: BLUEPRINT_CANONICAL_DIGEST,
    blueprint_raw_blob_digest: BLUEPRINT_RAW_DIGEST,
    candidate_payload_digest: digest("candidate payload"),
    created_at: CREATED_AT,
    final_status: finalStatus,
    function_identity: {
      function_name: "normalize",
      rank: "001",
      software: "example-project",
      test_case: "configuration",
    },
    overall_status: overallStatus,
    repository_binding_ref: artifactRef(binding),
    sealed_function_directory_digest: SEALED_DIRECTORY_DIGEST,
    source_path: "src/normalize.ts",
    validation: {
      claim_to_evidence_digest: digest("claim to evidence"),
      diagnosis_digest: digest("diagnosis"),
      evidence: [
        {
          digest: digest("annotate evidence"),
          path: "evidence/annotate.txt",
        },
        {
          digest: digest("hardware profile"),
          path: "evidence/hardware-profile.json",
        },
        {
          digest: digest("perf stat"),
          path: "evidence/perf-stat.txt",
        },
      ],
      machine_validation_digest: digest("machine validation"),
      semantic_validation_digest: digest("semantic validation"),
    },
  });
  const attestation = makeContract<BlueprintReviewAttestation>({
    action,
    artifact_type: "blueprint-review-attestation",
    artifact_version: 1,
    blueprint_canonical_digest: BLUEPRINT_CANONICAL_DIGEST,
    created_at: "2026-07-24T08:01:00.000Z",
    repository_binding_ref: artifactRef(binding),
    resolved_repository: {
      commit_sha: binding.commit_sha,
      repository_url: binding.repository_url,
      source_realpath: "/workspace/project/src/normalize.ts",
      target_worktree_realpath: binding.target_worktree_realpath,
    },
    review_subject_digest: subject.artifact_digest,
    review_subject_ref: artifactRef(subject),
    reviewer_session_id: REVIEW_SESSION_ID,
    sealed_function_directory_digest: SEALED_DIRECTORY_DIGEST,
  });
  const rootCause = makeContract<RootCauseArtifact>({
    artifact_type: "root-cause",
    artifact_version: 1,
    created_at: "2026-07-24T08:02:00.000Z",
    criteria: [...rootCauseCriteria()],
    entry_strategy: "root-cause-import",
    facts: [...rootCauseFacts(binding)],
    gaps: [
      {
        id: "gap:LOGGING123456789",
        statement: "Logging behavior was not present in the sealed evidence.",
      },
    ],
    inferences: [
      {
        basis_fact_ids: ["fact:OBSERVED12345678"],
        id: "inference:NORMALIZE1234567",
        statement: "The reviewed Blueprint identifies normalization as the cause.",
      },
    ],
    problem_summary: "Configuration normalization drops a required field.",
    provenance: {
      blueprint: {
        attestation_ref: artifactRef(attestation),
        blueprint_canonical_digest: BLUEPRINT_CANONICAL_DIGEST,
        blueprint_raw_blob_digest: BLUEPRINT_RAW_DIGEST,
        review_subject_ref: artifactRef(subject),
        sealed_function_directory_digest: SEALED_DIRECTORY_DIGEST,
      },
      source: "root-cause-blueprint",
    },
    status: "confirmed",
    workflow_id: WORKFLOW_ID,
  });
  return [binding, subject, attestation, rootCause];
}

export interface CompleteContractGraph {
  readonly artifacts: readonly YuanshengCraftContractV1[];
  readonly candidate: PatchCandidate;
  readonly repeatedDiffCandidate: PatchCandidate;
  readonly rootCause: RootCauseArtifact;
}

export function makeCompleteContractGraph(): CompleteContractGraph {
  const [bindingValue, subjectValue, attestationValue, rootCauseValue] = makeBlueprintEntryGraph();
  const binding = bindingValue as RepositoryBinding;
  const subject = subjectValue as BlueprintReviewSubject;
  const attestation = attestationValue as BlueprintReviewAttestation;
  const rootCause = rootCauseValue as RootCauseArtifact;

  const plan = makeContract<PatchPlan>({
    artifact_type: "patch-plan",
    artifact_version: 1,
    changes: [
      {
        criterion_ids: ["criterion:PRESERVE12345678"],
        id: "change:PRESERVE12345678",
        operation: "modify",
        path: "src/normalize.ts",
        reason: "Preserve the required configuration field.",
        root_cause_item_ids: ["inference:NORMALIZE1234567"],
        source_path: null,
      },
    ],
    created_at: "2026-07-24T08:03:00.000Z",
    criterion_ids: ["criterion:PRESERVE12345678"],
    non_goals: ["Redesign the configuration format."],
    objectives: ["Preserve the required configuration field."],
    plan_revision: 1,
    root_cause_ref: artifactRef(rootCause),
    status: "approved",
    workflow_id: WORKFLOW_ID,
  });
  const mutation = makeContract<MutationAuthorization>({
    action: "allow",
    artifact_type: "mutation-authorization",
    artifact_version: 1,
    authorized_changes: [
      {
        operation: "modify",
        path: "src/normalize.ts",
        planned_change_id: "change:PRESERVE12345678",
        source_path: null,
      },
    ],
    authorized_revision: 1,
    baseline_commit: binding.commit_sha,
    capability: "file-mutation-only",
    created_at: "2026-07-24T08:04:00.000Z",
    plan_ref: artifactRef(plan),
    principal: {
      agent_id: "ys-craft-patch-builder",
      session_id: BUILDER_SESSION_ID,
    },
    repository_binding_ref: artifactRef(binding),
    target_worktree_realpath: binding.target_worktree_realpath,
    workflow_id: WORKFLOW_ID,
  });
  const diff = makeContract<DiffManifest>({
    artifact_type: "diff-manifest",
    artifact_version: 1,
    binary_patch_digest: BINARY_PATCH_DIGEST,
    created_at: "2026-07-24T08:05:00.000Z",
    diff_content_digest: DIFF_CONTENT_DIGEST,
    entries: DIFF_ENTRIES,
    mutation_authorization_ref: artifactRef(mutation),
    plan_ref: artifactRef(plan),
    repository_binding_ref: artifactRef(binding),
    workflow_id: WORKFLOW_ID,
  });
  const candidate = makeContract<PatchCandidate>({
    artifact_type: "patch-candidate",
    artifact_version: 1,
    candidate_revision: 1,
    created_at: "2026-07-24T08:06:00.000Z",
    diff_content_digest: DIFF_CONTENT_DIGEST,
    diff_manifest_ref: artifactRef(diff),
    iteration: 1,
    plan_ref: artifactRef(plan),
    status: "ready-for-verification",
    workflow_id: WORKFLOW_ID,
  });
  const repeatedDiffCandidate = makeContract<PatchCandidate>({
    artifact_type: "patch-candidate",
    artifact_version: 1,
    candidate_revision: 2,
    created_at: "2026-07-24T08:07:00.000Z",
    diff_content_digest: DIFF_CONTENT_DIGEST,
    diff_manifest_ref: artifactRef(diff),
    iteration: 2,
    plan_ref: artifactRef(plan),
    status: "ready-for-verification",
    workflow_id: WORKFLOW_ID,
  });
  const commands: VerificationSource["commands"] = [
    {
      argv: ["bun", "test", "tests/normalize.test.ts"],
      command_id: "command:NORMALIZE1234567",
      criterion_id: "criterion:PRESERVE12345678",
      cwd: "tests",
      environment_allowlist: ["CI"],
      log_path: "commands/normalize.log",
      required: true,
      runner_id: "local",
      runner_type: "local",
      timeout_seconds: 300,
    },
  ];
  const configDigest = digest("runtime config");
  const source = makeContract<VerificationSource>({
    artifact_type: "verification-source",
    artifact_version: 1,
    commands: [...commands],
    config_digest: configDigest,
    created_at: "2026-07-24T08:08:00.000Z",
    human_criterion_ids: [],
    plan_ref: artifactRef(plan),
    repository_binding_ref: artifactRef(binding),
    source_type: "official",
    workflow_id: WORKFLOW_ID,
  });
  const verificationManifest = makeContract<VerificationManifest>({
    artifact_type: "verification-manifest",
    artifact_version: 1,
    baseline_commit: binding.commit_sha,
    candidate_ref: artifactRef(candidate),
    commands: [...commands],
    config_digest: configDigest,
    created_at: "2026-07-24T08:09:00.000Z",
    diff_content_digest: candidate.diff_content_digest,
    human_criterion_ids: [],
    log_root_realpath: "/workspace/output/verification",
    repository_binding_ref: artifactRef(binding),
    source_ref: artifactRef(source),
    target_worktree_realpath: binding.target_worktree_realpath,
    workflow_id: WORKFLOW_ID,
  });
  const verificationAuthorization = makeContract<VerificationAuthorization>({
    action: "allow",
    artifact_type: "verification-authorization",
    artifact_version: 1,
    candidate_ref: artifactRef(candidate),
    created_at: "2026-07-24T08:10:00.000Z",
    manifest_ref: artifactRef(verificationManifest),
    principal: {
      agent_id: "ys-craft-regression-verifier",
      session_id: "session:VERIFIER12345678",
    },
    workflow_id: WORKFLOW_ID,
  });
  const phaseManifest = makeContract<PhaseCommandManifest>({
    artifact_type: "phase-command-manifest",
    artifact_version: 1,
    commands: [
      {
        argv: ["bun", "test"],
        command_id: "command:PHASE12345678901",
        cwd: "tests",
        environment_allowlist: ["CI"],
        timeout_seconds: 300,
      },
    ],
    created_at: "2026-07-24T08:11:00.000Z",
    output_root_realpath: "/workspace/output",
    phase: "planning",
    repository_binding_ref: artifactRef(binding),
    subject_ref: artifactRef(plan),
    target_access: "read-only",
    workflow_id: WORKFLOW_ID,
  });
  const phaseAuthorization = makeContract<PhaseCommandAuthorization>({
    action: "allow",
    artifact_type: "phase-command-authorization",
    artifact_version: 1,
    created_at: "2026-07-24T08:12:00.000Z",
    manifest_ref: artifactRef(phaseManifest),
    principal: {
      agent_id: "ys-craft-patch-planner",
      session_id: "session:PLANNER123456789",
    },
    workflow_id: WORKFLOW_ID,
  });
  const evidence = makeContract<CriterionEvidence>({
    artifact_type: "criterion-evidence",
    artifact_version: 1,
    candidate_ref: artifactRef(candidate),
    command_results: [
      {
        command_id: "command:NORMALIZE1234567",
        exit_code: 0,
        finished_at: "2026-07-24T08:14:00.000Z",
        infra_error: null,
        log_digest: digest("verification log"),
        log_persisted: true,
        output_artifact_digests: [],
        started_at: "2026-07-24T08:13:00.000Z",
        status: "pass",
        stderr_digest: digest("verification stderr"),
        stdout_digest: digest("verification stdout"),
      },
    ],
    created_at: "2026-07-24T08:13:00.000Z",
    criterion_id: "criterion:PRESERVE12345678",
    evidence_kind: "machine",
    finished_at: "2026-07-24T08:14:00.000Z",
    human_confirmation: null,
    manifest_ref: artifactRef(verificationManifest),
    observed_diff_content_digest: candidate.diff_content_digest,
    started_at: "2026-07-24T08:13:00.000Z",
    status: "pass",
    workflow_id: WORKFLOW_ID,
  });
  const review = makeContract<PatchReview>({
    artifact_type: "patch-review",
    artifact_version: 1,
    candidate_ref: artifactRef(candidate),
    created_at: "2026-07-24T08:15:00.000Z",
    criterion_evidence_refs: [artifactRef(evidence)],
    findings: [],
    reviewer: {
      agent_id: "ys-craft-patch-reviewer",
      session_id: REVIEWER_SESSION_ID,
    },
    root_cause_eliminated: true,
    status: "pass",
    verification_sufficient: true,
    within_approved_scope: true,
    workflow_id: WORKFLOW_ID,
  });
  const delivery = makeContract<Delivery>({
    artifact_type: "delivery",
    artifact_version: 1,
    candidate_ref: artifactRef(candidate),
    created_at: "2026-07-24T08:16:00.000Z",
    criterion_evidence_refs: [artifactRef(evidence)],
    delivery_patch_digest: DIFF_CONTENT_DIGEST,
    patch_review_ref: artifactRef(review),
    plan_ref: artifactRef(plan),
    residual_risks: [],
    root_cause_ref: artifactRef(rootCause),
    status: "complete",
    summary: "The required configuration field is preserved.",
    workflow_id: WORKFLOW_ID,
  });
  const state = makeContract<WorkflowState>({
    artifact_refs: [
      artifactRef(binding),
      artifactRef(subject),
      artifactRef(attestation),
      artifactRef(rootCause),
      artifactRef(plan),
      artifactRef(candidate),
      artifactRef(review),
      artifactRef(delivery),
    ],
    artifact_type: "workflow-state",
    artifact_version: 1,
    blocked_context: null,
    completed_at: "2026-07-24T08:16:00.000Z",
    coordinator: {
      agent_id: "ys-craft",
      session_id: "session:PRIMARY1234567890",
    },
    created_at: CREATED_AT,
    entry_context: {
      attestation_ref: artifactRef(attestation),
      repository_binding_ref: artifactRef(binding),
      review_subject_ref: artifactRef(subject),
      root_cause_ref: artifactRef(rootCause),
      strategy: "root-cause-import",
    },
    entry_strategy: "root-cause-import",
    phase: "completed",
    phase_principal: null,
    principal_audit: [
      {
        agent_id: "ys-craft",
        session_id: "session:PRIMARY1234567890",
      },
      {
        agent_id: "ys-craft-patch-builder",
        session_id: BUILDER_SESSION_ID,
      },
      {
        agent_id: "ys-craft-patch-reviewer",
        session_id: REVIEWER_SESSION_ID,
      },
    ],
    revision: 12,
    stale_artifact_refs: [],
    status: "completed",
    updated_at: "2026-07-24T08:16:00.000Z",
    workflow_id: WORKFLOW_ID,
  });
  const journal = makeContract<ActionJournal>({
    artifact_type: "action-journal",
    artifact_version: 1,
    created_at: CREATED_AT,
    entries: [
      {
        action: "ys_craft_start_problem",
        at: CREATED_AT,
        principal: {
          agent_id: "ys-craft",
          session_id: "session:PRIMARY1234567890",
        },
        result: "succeeded",
        sequence: 1,
        subject_refs: [artifactRef(rootCause)],
      },
      {
        action: "ys_craft_complete",
        at: "2026-07-24T08:16:00.000Z",
        principal: {
          agent_id: "ys-craft-delivery-coordinator",
          session_id: "session:DELIVERY12345678",
        },
        result: "succeeded",
        sequence: 2,
        subject_refs: [artifactRef(delivery)],
      },
    ],
    revision: 2,
    workflow_id: WORKFLOW_ID,
  });

  return {
    artifacts: [
      binding,
      subject,
      attestation,
      rootCause,
      plan,
      mutation,
      diff,
      candidate,
      repeatedDiffCandidate,
      source,
      verificationManifest,
      verificationAuthorization,
      phaseManifest,
      phaseAuthorization,
      evidence,
      review,
      delivery,
      state,
      journal,
    ],
    candidate,
    repeatedDiffCandidate,
    rootCause,
  };
}

export function encodeContracts(
  contracts: readonly YuanshengCraftContractV1[],
): readonly Uint8Array[] {
  return contracts.map(encode);
}
