import { relative, resolve, sep } from "node:path";
import { canonicalizeJson, sealArtifact, sha256Digest } from "../artifacts/canonical";
import type {
  BlueprintReviewAttestation,
  BlueprintReviewSubject,
  RepositoryBinding,
  RootCauseArtifact,
  YuanshengCraftContractV1,
} from "../artifacts/generated";
import {
  artifactRef,
  assertBlueprintPlanningEligible,
  parseCraftContractBytes,
  validateCraftContractGraph,
} from "../artifacts/parser";
import type { JsonValue } from "../artifacts/strict-json";
import { snapshotVerifiedSealedBlueprint, type VerifiedSealedBlueprint } from "./sealed-verifier";

export interface BlueprintReviewContext {
  readonly action: "allow" | "deny";
  readonly reviewedAt: string;
  readonly reviewerSessionId: string;
}

export interface BlueprintImportTransaction {
  readonly attestation: BlueprintReviewAttestation;
  readonly contracts: readonly [
    BlueprintReviewSubject,
    BlueprintReviewAttestation,
    RootCauseArtifact,
  ];
  readonly repositoryBindingRef: ReturnType<typeof artifactRef>;
  readonly rootCauseArtifact: RootCauseArtifact;
  readonly reviewSubject: BlueprintReviewSubject;
}

export type BlueprintReviewOutcome =
  | {
      readonly attestation: BlueprintReviewAttestation;
      readonly decision: "deny";
    }
  | {
      readonly attestation: BlueprintReviewAttestation;
      readonly decision: "allow";
      readonly transaction: BlueprintImportTransaction;
    };

function sealContract<T extends YuanshengCraftContractV1>(payload: Omit<T, "artifact_digest">): T {
  const contract = sealArtifact(payload as unknown as Record<string, JsonValue>) as unknown as T;
  return parseCraftContractBytes(canonicalizeJson(contract).bytes) as T;
}

function assertRepositoryBinding(binding: RepositoryBinding): void {
  const parsed = parseCraftContractBytes(canonicalizeJson(binding).bytes);
  if (parsed.artifact_type !== "repository-binding") {
    throw new TypeError("Blueprint import requires a verified repository binding");
  }
}

function opaqueId(prefix: string, value: unknown): string {
  return `${prefix}:${sha256Digest(canonicalizeJson(value).bytes).slice("sha256:".length)}`;
}

function nonEmpty<T>(values: readonly T[], label: string): [T, ...T[]] {
  const first = values[0];
  if (first === undefined) {
    throw new TypeError(`${label} must not be empty`);
  }
  return [first, ...values.slice(1)];
}

function atLeastThree<T>(values: readonly T[], label: string): [T, T, T, ...T[]] {
  const first = values[0];
  const second = values[1];
  const third = values[2];
  if (first === undefined || second === undefined || third === undefined) {
    throw new TypeError(`${label} must contain at least three values`);
  }
  return [first, second, third, ...values.slice(3)];
}

function assertBlueprintRepositoryAgreement(
  verified: VerifiedSealedBlueprint,
  binding: RepositoryBinding,
): void {
  const { blueprint } = snapshotVerifiedSealedBlueprint(verified);
  const repositoryUrl = blueprint.section1_basic_info.repository_url;
  const commitSha = blueprint.section1_basic_info.commit_hash;
  if (repositoryUrl !== null && repositoryUrl !== binding.repository_url) {
    throw new TypeError("Blueprint repository URL conflicts with the repository binding");
  }
  if (commitSha !== null && commitSha !== binding.commit_sha) {
    throw new TypeError("Blueprint commit conflicts with the repository binding");
  }
  resolvedSourceRealpath(verified, binding);
}

function resolvedSourceRealpath(
  verified: VerifiedSealedBlueprint,
  binding: RepositoryBinding,
): string | null {
  if (verified.sourcePath === null) {
    return null;
  }
  const resolved = resolve(binding.product_root_realpath, ...verified.sourcePath.split("/"));
  const productRelative = relative(binding.product_root_realpath, resolved).split(sep).join("/");
  if (productRelative !== verified.sourcePath) {
    throw new TypeError("Blueprint source mapping does not identify a product-relative file");
  }
  return resolved;
}

export function buildBlueprintReviewSubject(
  verified: VerifiedSealedBlueprint,
  binding: RepositoryBinding,
): BlueprintReviewSubject {
  assertRepositoryBinding(binding);
  assertBlueprintRepositoryAgreement(verified, binding);
  snapshotVerifiedSealedBlueprint(verified);
  return sealContract<BlueprintReviewSubject>({
    artifact_type: "blueprint-review-subject",
    artifact_version: 1,
    blueprint_canonical_digest: verified.blueprintCanonicalDigest,
    blueprint_raw_blob_digest: verified.blueprintRawBlobDigest,
    candidate_payload_digest: verified.candidatePayloadDigest,
    created_at: binding.created_at,
    final_status: verified.finalStatus,
    function_identity: {
      function_name: verified.functionIdentity.functionName,
      rank: verified.functionIdentity.rank,
      software: verified.functionIdentity.software,
      test_case: verified.functionIdentity.testCase,
    },
    overall_status: verified.overallStatus,
    repository_binding_ref: artifactRef(binding),
    sealed_function_directory_digest: verified.sealedFunctionDirectoryDigest,
    source_path: verified.sourcePath,
    validation: {
      claim_to_evidence_digest: verified.validation.claimToEvidenceDigest,
      diagnosis_digest: verified.validation.diagnosisDigest,
      evidence: atLeastThree(
        verified.validation.evidence.map((evidence) => ({
          digest: evidence.digest,
          path: evidence.path,
        })),
        "Sealed evidence",
      ),
      machine_validation_digest: verified.validation.machineValidationDigest,
      semantic_validation_digest: verified.validation.semanticValidationDigest,
    },
  });
}

export function buildBlueprintReviewAttestation(
  verified: VerifiedSealedBlueprint,
  subject: BlueprintReviewSubject,
  binding: RepositoryBinding,
  context: BlueprintReviewContext,
): BlueprintReviewAttestation {
  assertRepositoryBinding(binding);
  assertBlueprintRepositoryAgreement(verified, binding);
  const expectedSubject = buildBlueprintReviewSubject(verified, binding);
  if (expectedSubject.artifact_digest !== subject.artifact_digest) {
    throw new TypeError("Review subject does not match the verified sealed Blueprint");
  }
  return sealContract<BlueprintReviewAttestation>({
    action: context.action,
    artifact_type: "blueprint-review-attestation",
    artifact_version: 1,
    blueprint_canonical_digest: verified.blueprintCanonicalDigest,
    created_at: context.reviewedAt,
    repository_binding_ref: artifactRef(binding),
    resolved_repository: {
      commit_sha: binding.commit_sha,
      repository_url: binding.repository_url,
      source_realpath: resolvedSourceRealpath(verified, binding),
      target_worktree_realpath: binding.target_worktree_realpath,
    },
    review_subject_digest: subject.artifact_digest,
    review_subject_ref: artifactRef(subject),
    reviewer_session_id: context.reviewerSessionId,
    sealed_function_directory_digest: verified.sealedFunctionDirectoryDigest,
  });
}

function convertRootCause(
  verified: VerifiedSealedBlueprint,
  subject: BlueprintReviewSubject,
  attestation: BlueprintReviewAttestation,
  workflowId: string,
): RootCauseArtifact {
  const { blueprint } = snapshotVerifiedSealedBlueprint(verified);
  const subjectRef = artifactRef(subject);
  const additionalFacts: RootCauseArtifact["facts"][number][] = [
    ...blueprint.section3_key_evidence["3_1_metric_evidence"].map((metric, index) => ({
      evidence_refs: [subjectRef] as [typeof subjectRef],
      id: opaqueId("fact", { index, kind: "metric", value: metric }),
      statement: metric.anomaly_note,
    })),
    ...blueprint.section3_key_evidence["3_2_hotspot_evidence"].map((hotspot, index) => ({
      evidence_refs: [subjectRef] as [typeof subjectRef],
      id: opaqueId("fact", { index, kind: "hotspot", value: hotspot }),
      statement: hotspot.note,
    })),
  ];
  const facts: RootCauseArtifact["facts"] = [
    {
      evidence_refs: [subjectRef],
      id: opaqueId("fact", {
        kind: "anomaly_conclusion",
        value: blueprint.section2_summary.anomaly_conclusion,
      }),
      statement: blueprint.section2_summary.anomaly_conclusion,
    },
    ...additionalFacts,
  ];
  const factIds = nonEmpty(
    facts.map((fact) => fact.id),
    "Root-cause facts",
  );
  const inferenceStatement = blueprint.section4_root_cause.most_likely_root_cause;
  if (inferenceStatement === null) {
    throw new TypeError("A confirmed Blueprint must contain an explicit root-cause statement");
  }
  const inferences = [
    {
      basis_fact_ids: factIds,
      id: opaqueId("inference", {
        kind: "root_cause",
        value: inferenceStatement,
      }),
      statement: inferenceStatement,
    },
  ] satisfies RootCauseArtifact["inferences"];
  const gaps = blueprint.section5_risks_and_gaps.current_gaps.map((gap, index) => ({
    id: opaqueId("gap", { index, value: gap }),
    statement: gap,
  })) satisfies RootCauseArtifact["gaps"];
  const criteria = [
    {
      fact_ids: factIds,
      id: opaqueId("criterion", {
        kind: "recommended_verification",
        value: blueprint.section6_ys_craft_actions.recommended_verification,
      }),
      required: true,
      statement: blueprint.section6_ys_craft_actions.recommended_verification,
    },
  ] satisfies RootCauseArtifact["criteria"];

  return sealContract<RootCauseArtifact>({
    artifact_type: "root-cause",
    artifact_version: 1,
    created_at: attestation.created_at,
    criteria,
    entry_strategy: "root-cause-import",
    facts,
    gaps,
    inferences,
    problem_summary: blueprint.section2_summary.anomaly_conclusion,
    provenance: {
      blueprint: {
        attestation_ref: artifactRef(attestation),
        blueprint_canonical_digest: verified.blueprintCanonicalDigest,
        blueprint_raw_blob_digest: verified.blueprintRawBlobDigest,
        review_subject_ref: subjectRef,
        sealed_function_directory_digest: verified.sealedFunctionDirectoryDigest,
      },
      source: "root-cause-blueprint",
    },
    status: "confirmed",
    workflow_id: workflowId,
  });
}

export function reviewBlueprintForImport(input: {
  readonly binding: RepositoryBinding;
  readonly context: BlueprintReviewContext;
  readonly subject: BlueprintReviewSubject;
  readonly verified: VerifiedSealedBlueprint;
  readonly workflowId: string;
}): BlueprintReviewOutcome {
  const attestation = buildBlueprintReviewAttestation(
    input.verified,
    input.subject,
    input.binding,
    input.context,
  );
  if (attestation.action === "deny") {
    return Object.freeze({
      attestation,
      decision: "deny" as const,
    });
  }
  assertBlueprintPlanningEligible(input.subject, attestation);
  const rootCauseArtifact = convertRootCause(
    input.verified,
    input.subject,
    attestation,
    input.workflowId,
  );
  validateCraftContractGraph([input.binding, input.subject, attestation, rootCauseArtifact]);
  const transaction = Object.freeze({
    attestation,
    contracts: Object.freeze([
      input.subject,
      attestation,
      rootCauseArtifact,
    ]) as BlueprintImportTransaction["contracts"],
    repositoryBindingRef: artifactRef(input.binding),
    rootCauseArtifact,
    reviewSubject: input.subject,
  });
  return Object.freeze({
    attestation,
    decision: "allow" as const,
    transaction,
  });
}
