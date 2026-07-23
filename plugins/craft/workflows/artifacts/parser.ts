import { posix } from "node:path";
import { canonicalizeJson, computeArtifactDigest } from "./canonical";
import {
  type ActionJournal,
  type ArtifactRef,
  type BlueprintReviewAttestation,
  type BlueprintReviewSubject,
  type CriterionEvidence,
  type PatchCandidate,
  type RootCauseArtifact,
  validateYuanshengCraftContractV1,
  type YuanshengCraftContractV1,
} from "./generated";
import { parseStrictJson } from "./strict-json";

export type CraftContractErrorCode =
  | "attestation-denied"
  | "digest-mismatch"
  | "duplicate-id"
  | "non-canonical-bytes"
  | "not-planning-eligible"
  | "reference-mismatch"
  | "reference-unresolved"
  | "schema-invalid"
  | "semantic-invalid";

export class CraftContractError extends Error {
  readonly code: CraftContractErrorCode;

  constructor(code: CraftContractErrorCode, message: string) {
    super(message);
    this.name = "CraftContractError";
    this.code = code;
  }
}

function fail(code: CraftContractErrorCode, message: string): never {
  throw new CraftContractError(code, message);
}

function assertRefType(ref: ArtifactRef, artifactType: ArtifactRef["artifact_type"]): void {
  if (ref.artifact_type !== artifactType || ref.artifact_version !== 1) {
    fail(
      "reference-mismatch",
      `Expected ${artifactType}:v1 reference, received ${ref.artifact_type}:v${ref.artifact_version}`,
    );
  }
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      fail("duplicate-id", `Duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function assertCanonicalPath(path: string, absolute: boolean): void {
  const normalized = posix.normalize(path);
  const expected = absolute ? normalized.startsWith("/") : !normalized.startsWith("/");
  if (
    !expected ||
    normalized !== path ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("\0")
  ) {
    fail("semantic-invalid", `Non-canonical ${absolute ? "realpath" : "relative path"}: ${path}`);
  }
}

function inspectPaths(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      inspectPaths(item);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "string" && key.endsWith("_realpath")) {
      assertCanonicalPath(field, true);
    } else if (typeof field === "string" && (key === "cwd" || key === "path")) {
      assertCanonicalPath(field, false);
    }
    inspectPaths(field);
  }
}

function assertRootCause(rootCause: RootCauseArtifact): void {
  const facts = new Set(rootCause.facts.map((fact) => fact.id));
  const allItemIds = [
    ...rootCause.facts.map((item) => item.id),
    ...rootCause.inferences.map((item) => item.id),
    ...rootCause.gaps.map((item) => item.id),
    ...rootCause.criteria.map((item) => item.id),
  ];
  assertUnique(allItemIds, "root-cause item ID");

  for (const inference of rootCause.inferences) {
    for (const factId of inference.basis_fact_ids) {
      if (!facts.has(factId)) {
        fail("semantic-invalid", `Inference ${inference.id} references unknown fact ${factId}`);
      }
    }
  }
  for (const criterion of rootCause.criteria) {
    for (const factId of criterion.fact_ids) {
      if (!facts.has(factId)) {
        fail("semantic-invalid", `Criterion ${criterion.id} references unknown fact ${factId}`);
      }
    }
  }

  const fromProblem = rootCause.entry_strategy === "problem-description";
  const hasProblemProvenance = rootCause.provenance.source === "problem-description";
  if (fromProblem !== hasProblemProvenance) {
    fail("semantic-invalid", "Root-cause entry strategy and provenance source must agree");
  }
  if (rootCause.provenance.source === "root-cause-blueprint") {
    assertRefType(rootCause.provenance.blueprint.review_subject_ref, "blueprint-review-subject");
    assertRefType(rootCause.provenance.blueprint.attestation_ref, "blueprint-review-attestation");
  }
}

function assertJournal(journal: ActionJournal): void {
  let previousTime = journal.created_at;
  for (const [index, entry] of journal.entries.entries()) {
    if (entry.sequence !== index + 1) {
      fail("semantic-invalid", "Action journal sequence must be contiguous and one-based");
    }
    if (Date.parse(entry.at) < Date.parse(previousTime)) {
      fail("semantic-invalid", "Action journal timestamps must be monotonic");
    }
    previousTime = entry.at;
  }
}

function assertContractSemantics(contract: YuanshengCraftContractV1): void {
  inspectPaths(contract);
  switch (contract.artifact_type) {
    case "root-cause":
      assertRootCause(contract);
      break;
    case "blueprint-review-subject":
      assertRefType(contract.repository_binding_ref, "repository-binding");
      break;
    case "blueprint-review-attestation":
      assertRefType(contract.repository_binding_ref, "repository-binding");
      assertRefType(contract.review_subject_ref, "blueprint-review-subject");
      if (contract.review_subject_digest !== contract.review_subject_ref.digest) {
        fail("reference-mismatch", "Attestation review subject digest must match its reference");
      }
      break;
    case "repository-binding":
      if (
        !contract.product_root_realpath.startsWith(`${contract.git_root_realpath}/`) &&
        contract.product_root_realpath !== contract.git_root_realpath
      ) {
        fail("semantic-invalid", "Product root must be within the bound Git root");
      }
      if (
        !contract.product_root_realpath.startsWith(`${contract.target_worktree_realpath}/`) &&
        contract.product_root_realpath !== contract.target_worktree_realpath
      ) {
        fail("semantic-invalid", "Product root must be within the target worktree");
      }
      break;
    case "patch-plan":
      assertRefType(contract.root_cause_ref, "root-cause");
      assertUnique(
        contract.changes.map((change) => change.id),
        "planned change ID",
      );
      assertUnique(
        contract.changes.map((change) => change.path),
        "planned path",
      );
      break;
    case "mutation-authorization":
      assertRefType(contract.plan_ref, "patch-plan");
      assertUnique(
        contract.authorized_changes.map((change) => change.planned_change_id),
        "authorized planned change ID",
      );
      assertUnique(
        contract.authorized_changes.map((change) => change.path),
        "authorized path",
      );
      break;
    case "diff-manifest":
      assertRefType(contract.repository_binding_ref, "repository-binding");
      assertRefType(contract.plan_ref, "patch-plan");
      assertRefType(contract.mutation_authorization_ref, "mutation-authorization");
      assertUnique(
        contract.entries.map((entry) => entry.path),
        "diff path",
      );
      for (const entry of contract.entries) {
        const invalidCreate = entry.operation === "create" && entry.old_blob_digest !== null;
        const invalidDelete = entry.operation === "delete" && entry.new_blob_digest !== null;
        const invalidModify =
          entry.operation === "modify" &&
          (entry.old_blob_digest === null || entry.new_blob_digest === null);
        if (invalidCreate || invalidDelete || invalidModify) {
          fail(
            "semantic-invalid",
            `Diff blob digests do not match ${entry.operation}: ${entry.path}`,
          );
        }
      }
      break;
    case "patch-candidate":
      assertRefType(contract.plan_ref, "patch-plan");
      assertRefType(contract.diff_manifest_ref, "diff-manifest");
      break;
    case "verification-source":
      assertRefType(contract.plan_ref, "patch-plan");
      assertRefType(contract.repository_binding_ref, "repository-binding");
      assertUnique(
        contract.commands.map((command) => command.command_id),
        "verification command ID",
      );
      break;
    case "verification-manifest":
      assertRefType(contract.candidate_ref, "patch-candidate");
      assertRefType(contract.source_ref, "verification-source");
      assertUnique(
        contract.commands.map((command) => command.command_id),
        "verification command ID",
      );
      break;
    case "verification-authorization":
      assertRefType(contract.candidate_ref, "patch-candidate");
      assertRefType(contract.manifest_ref, "verification-manifest");
      break;
    case "phase-command-manifest":
      assertUnique(
        contract.commands.map((command) => command.command_id),
        "phase command ID",
      );
      break;
    case "phase-command-authorization":
      assertRefType(contract.manifest_ref, "phase-command-manifest");
      break;
    case "criterion-evidence":
      assertRefType(contract.candidate_ref, "patch-candidate");
      assertRefType(contract.manifest_ref, "verification-manifest");
      if (Date.parse(contract.finished_at) < Date.parse(contract.started_at)) {
        fail("semantic-invalid", "Criterion evidence cannot finish before it starts");
      }
      break;
    case "patch-review":
      assertRefType(contract.candidate_ref, "patch-candidate");
      for (const ref of contract.criterion_evidence_refs) {
        assertRefType(ref, "criterion-evidence");
      }
      assertUnique(
        contract.findings.map((finding) => finding.finding_id),
        "review finding ID",
      );
      if (
        contract.status === "pass" &&
        (!contract.root_cause_eliminated ||
          !contract.within_approved_scope ||
          !contract.verification_sufficient ||
          contract.findings.some((finding) => finding.severity === "blocking"))
      ) {
        fail("semantic-invalid", "Passing review requires all gates and no blocking finding");
      }
      break;
    case "delivery":
      assertRefType(contract.root_cause_ref, "root-cause");
      assertRefType(contract.plan_ref, "patch-plan");
      assertRefType(contract.candidate_ref, "patch-candidate");
      assertRefType(contract.patch_review_ref, "patch-review");
      for (const ref of contract.criterion_evidence_refs) {
        assertRefType(ref, "criterion-evidence");
      }
      break;
    case "workflow-state": {
      assertUnique(
        contract.artifact_refs.map((ref) => ref.digest),
        "workflow artifact reference",
      );
      assertUnique(
        contract.principal_audit.map((principal) => principal.session_id),
        "workflow principal session ID",
      );
      const terminalPhase = contract.phase === "blocked" || contract.phase === "completed";
      if (
        (contract.status === "blocked") !== (contract.phase === "blocked") ||
        (contract.status === "completed") !== (contract.phase === "completed") ||
        (contract.status === "active" && terminalPhase) ||
        Date.parse(contract.updated_at) < Date.parse(contract.created_at)
      ) {
        fail("semantic-invalid", "Workflow status, phase, and timestamps are inconsistent");
      }
      break;
    }
    case "action-journal":
      assertJournal(contract);
      break;
  }
}

function schemaErrors(): string {
  const validator = validateYuanshengCraftContractV1 as unknown as {
    readonly errors?: readonly { instancePath?: string; message?: string }[] | null;
  };
  const errors = validator.errors;
  if (!Array.isArray(errors)) {
    return "unknown schema error";
  }
  return errors
    .slice(0, 8)
    .map((error: { instancePath?: string; message?: string }) => {
      return `${error.instancePath ?? ""} ${error.message ?? "is invalid"}`.trim();
    })
    .join("; ");
}

export function parseCraftContractBytes(input: Uint8Array): YuanshengCraftContractV1 {
  const value = parseStrictJson(input);
  if (!validateYuanshengCraftContractV1(value)) {
    fail("schema-invalid", `Invalid Craft contract: ${schemaErrors()}`);
  }
  const contract = value as unknown as YuanshengCraftContractV1;
  const canonicalBytes = canonicalizeJson(contract).bytes;
  if (
    canonicalBytes.length !== input.length ||
    canonicalBytes.some((byte, index) => byte !== input[index])
  ) {
    fail("non-canonical-bytes", "Craft contracts must use exact RFC 8785 canonical bytes");
  }
  const expectedDigest = computeArtifactDigest(contract);
  if (contract.artifact_digest !== expectedDigest) {
    fail(
      "digest-mismatch",
      `Artifact digest mismatch: expected ${expectedDigest}, received ${contract.artifact_digest}`,
    );
  }
  assertContractSemantics(contract);
  return contract;
}

export function artifactRef(contract: YuanshengCraftContractV1): ArtifactRef {
  return {
    artifact_type: contract.artifact_type,
    artifact_version: contract.artifact_version,
    digest: contract.artifact_digest,
  };
}

function collectRefs(value: unknown, refs: ArtifactRef[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (
    "artifact_type" in value &&
    "artifact_version" in value &&
    "digest" in value &&
    Object.keys(value).length === 3
  ) {
    refs.push(value as ArtifactRef);
    return;
  }
  for (const field of Object.values(value)) {
    collectRefs(field, refs);
  }
}

function getContract<T extends YuanshengCraftContractV1["artifact_type"]>(
  index: ReadonlyMap<string, YuanshengCraftContractV1>,
  ref: ArtifactRef,
  artifactType: T,
): Extract<YuanshengCraftContractV1, { artifact_type: T }> {
  assertRefType(ref, artifactType);
  const contract = index.get(ref.digest);
  if (contract === undefined) {
    fail("reference-unresolved", `Unresolved ${artifactType} reference ${ref.digest}`);
  }
  if (
    contract.artifact_type !== ref.artifact_type ||
    contract.artifact_version !== ref.artifact_version
  ) {
    fail("reference-mismatch", `Reference metadata does not match ${ref.digest}`);
  }
  return contract as Extract<YuanshengCraftContractV1, { artifact_type: T }>;
}

export function assertBlueprintPlanningEligible(
  subject: BlueprintReviewSubject,
  attestation: BlueprintReviewAttestation,
): void {
  if (attestation.action !== "allow") {
    fail("attestation-denied", "A denied Blueprint review cannot start a workflow");
  }
  if (subject.overall_status !== "confirmed" || subject.final_status !== "confirmed_root_cause") {
    fail(
      "not-planning-eligible",
      "Only a confirmed/confirmed_root_cause Blueprint can enter planning",
    );
  }
  if (
    attestation.blueprint_canonical_digest !== subject.blueprint_canonical_digest ||
    attestation.sealed_function_directory_digest !== subject.sealed_function_directory_digest ||
    attestation.review_subject_digest !== subject.artifact_digest ||
    attestation.repository_binding_ref.digest !== subject.repository_binding_ref.digest
  ) {
    fail("reference-mismatch", "Blueprint attestation does not bind the exact review subject");
  }
}

function assertRootCauseGraph(
  rootCause: RootCauseArtifact,
  index: ReadonlyMap<string, YuanshengCraftContractV1>,
): void {
  if (rootCause.provenance.source !== "root-cause-blueprint") {
    return;
  }
  const subject = getContract(
    index,
    rootCause.provenance.blueprint.review_subject_ref,
    "blueprint-review-subject",
  );
  const attestation = getContract(
    index,
    rootCause.provenance.blueprint.attestation_ref,
    "blueprint-review-attestation",
  );
  assertBlueprintPlanningEligible(subject, attestation);
  if (
    rootCause.provenance.blueprint.blueprint_canonical_digest !==
      subject.blueprint_canonical_digest ||
    rootCause.provenance.blueprint.sealed_function_directory_digest !==
      subject.sealed_function_directory_digest
  ) {
    fail("reference-mismatch", "Root-cause Blueprint provenance does not match its review");
  }
}

function assertCandidateGraph(
  candidate: PatchCandidate,
  index: ReadonlyMap<string, YuanshengCraftContractV1>,
): void {
  const diff = getContract(index, candidate.diff_manifest_ref, "diff-manifest");
  if (
    candidate.diff_content_digest !== diff.diff_content_digest ||
    candidate.plan_ref.digest !== diff.plan_ref.digest
  ) {
    fail("reference-mismatch", "Patch candidate must bind the exact diff content and plan");
  }
}

function assertPlanGraph(
  contract: Extract<YuanshengCraftContractV1, { artifact_type: "patch-plan" }>,
  index: ReadonlyMap<string, YuanshengCraftContractV1>,
): void {
  const rootCause = getContract(index, contract.root_cause_ref, "root-cause");
  const criterionIds = new Set(rootCause.criteria.map((criterion) => criterion.id));
  const rootCauseItemIds = new Set([
    ...rootCause.facts.map((item) => item.id),
    ...rootCause.inferences.map((item) => item.id),
    ...rootCause.gaps.map((item) => item.id),
  ]);
  for (const criterionId of contract.criterion_ids) {
    if (!criterionIds.has(criterionId)) {
      fail("reference-mismatch", `Patch plan references unknown criterion ${criterionId}`);
    }
  }
  for (const change of contract.changes) {
    for (const itemId of change.root_cause_item_ids) {
      if (!rootCauseItemIds.has(itemId)) {
        fail("reference-mismatch", `Planned change references unknown root-cause item ${itemId}`);
      }
    }
  }
}

function assertMutationGraph(
  contract: Extract<YuanshengCraftContractV1, { artifact_type: "mutation-authorization" }>,
  index: ReadonlyMap<string, YuanshengCraftContractV1>,
): void {
  const plan = getContract(index, contract.plan_ref, "patch-plan");
  const plannedScope = plan.changes.map(({ id, operation, path }) => ({
    operation,
    path,
    planned_change_id: id,
  }));
  if (
    contract.authorized_revision !== plan.plan_revision ||
    canonicalizeJson(contract.authorized_changes).text !== canonicalizeJson(plannedScope).text
  ) {
    fail(
      "reference-mismatch",
      "Mutation authorization must bind the exact plan revision and scope",
    );
  }
}

function assertDiffGraph(
  contract: Extract<YuanshengCraftContractV1, { artifact_type: "diff-manifest" }>,
  index: ReadonlyMap<string, YuanshengCraftContractV1>,
): void {
  const authorization = getContract(
    index,
    contract.mutation_authorization_ref,
    "mutation-authorization",
  );
  if (authorization.plan_ref.digest !== contract.plan_ref.digest) {
    fail("reference-mismatch", "Diff manifest plan does not match its mutation authorization");
  }
  const authorizedScope = new Set(
    authorization.authorized_changes.map((change) => `${change.operation}\0${change.path}`),
  );
  for (const entry of contract.entries) {
    if (!authorizedScope.has(`${entry.operation}\0${entry.path}`)) {
      fail("reference-mismatch", `Diff entry is outside the authorized scope: ${entry.path}`);
    }
  }
}

function assertSourceGraph(
  contract: Extract<YuanshengCraftContractV1, { artifact_type: "verification-source" }>,
  index: ReadonlyMap<string, YuanshengCraftContractV1>,
): void {
  const plan = getContract(index, contract.plan_ref, "patch-plan");
  const criterionIds = new Set(plan.criterion_ids);
  for (const command of contract.commands) {
    for (const criterionId of command.criterion_ids) {
      if (!criterionIds.has(criterionId)) {
        fail(
          "reference-mismatch",
          `Verification source references unknown criterion ${criterionId}`,
        );
      }
    }
  }
}

function assertEvidenceGraph(
  evidence: CriterionEvidence,
  index: ReadonlyMap<string, YuanshengCraftContractV1>,
): void {
  const manifest = getContract(index, evidence.manifest_ref, "verification-manifest");
  const commandCriterionIds = new Set(
    manifest.commands.flatMap((command) => command.criterion_ids),
  );
  if (!commandCriterionIds.has(evidence.criterion_id)) {
    fail("reference-mismatch", "Criterion evidence is not selected by its manifest");
  }
  if (manifest.candidate_ref.digest !== evidence.candidate_ref.digest) {
    fail("reference-mismatch", "Criterion evidence and manifest bind different candidates");
  }
}

export function validateCraftContractGraph(
  contracts: readonly YuanshengCraftContractV1[],
): ReadonlyMap<string, YuanshengCraftContractV1> {
  const index = new Map<string, YuanshengCraftContractV1>();
  const workflowIds = new Set<string>();
  for (const contract of contracts) {
    if (index.has(contract.artifact_digest)) {
      fail("duplicate-id", `Duplicate artifact digest ${contract.artifact_digest}`);
    }
    index.set(contract.artifact_digest, contract);
    if ("workflow_id" in contract) {
      workflowIds.add(contract.workflow_id);
    }
  }
  if (workflowIds.size > 1) {
    fail("reference-mismatch", "A Craft contract graph must belong to exactly one workflow");
  }

  for (const contract of contracts) {
    const refs: ArtifactRef[] = [];
    collectRefs(contract, refs);
    for (const ref of refs) {
      getContract(index, ref, ref.artifact_type);
    }
    if (contract.artifact_type === "root-cause") {
      assertRootCauseGraph(contract, index);
    } else if (contract.artifact_type === "blueprint-review-attestation") {
      const subject = getContract(index, contract.review_subject_ref, "blueprint-review-subject");
      if (contract.review_subject_digest !== subject.artifact_digest) {
        fail("reference-mismatch", "Attestation subject digest does not resolve to its subject");
      }
    } else if (contract.artifact_type === "patch-plan") {
      assertPlanGraph(contract, index);
    } else if (contract.artifact_type === "mutation-authorization") {
      assertMutationGraph(contract, index);
    } else if (contract.artifact_type === "diff-manifest") {
      assertDiffGraph(contract, index);
    } else if (contract.artifact_type === "patch-candidate") {
      assertCandidateGraph(contract, index);
    } else if (contract.artifact_type === "verification-source") {
      assertSourceGraph(contract, index);
    } else if (contract.artifact_type === "criterion-evidence") {
      assertEvidenceGraph(contract, index);
    } else if (contract.artifact_type === "verification-manifest") {
      const candidate = getContract(index, contract.candidate_ref, "patch-candidate");
      const source = getContract(index, contract.source_ref, "verification-source");
      const plan = getContract(index, candidate.plan_ref, "patch-plan");
      if (source.plan_ref.digest !== plan.artifact_digest) {
        fail("reference-mismatch", "Verification source does not bind the candidate plan");
      }
      if (canonicalizeJson(source.commands).text !== canonicalizeJson(contract.commands).text) {
        fail("reference-mismatch", "Verification manifest must preserve the selected source");
      }
    } else if (contract.artifact_type === "patch-review" && contract.status === "pass") {
      const candidate = getContract(index, contract.candidate_ref, "patch-candidate");
      const mutation = contracts.find(
        (item) =>
          item.artifact_type === "mutation-authorization" &&
          item.plan_ref.digest === candidate.plan_ref.digest,
      );
      if (
        mutation?.artifact_type === "mutation-authorization" &&
        mutation.principal.session_id === contract.reviewer.session_id
      ) {
        fail("semantic-invalid", "Patch reviewer must use a distinct real session");
      }
      for (const ref of contract.criterion_evidence_refs) {
        const evidence = getContract(index, ref, "criterion-evidence");
        if (evidence.candidate_ref.digest !== candidate.artifact_digest) {
          fail("reference-mismatch", "Patch review evidence binds a different candidate");
        }
      }
    } else if (contract.artifact_type === "delivery") {
      const review = getContract(index, contract.patch_review_ref, "patch-review");
      const candidate = getContract(index, contract.candidate_ref, "patch-candidate");
      if (
        review.status !== "pass" ||
        review.candidate_ref.digest !== contract.candidate_ref.digest
      ) {
        fail("reference-mismatch", "Delivery requires the passing review for its exact candidate");
      }
      if (
        candidate.plan_ref.digest !== contract.plan_ref.digest ||
        candidate.diff_content_digest !== contract.delivery_patch_digest
      ) {
        fail("reference-mismatch", "Delivery must bind the exact candidate plan and patch digest");
      }
    }
  }
  return index;
}

export function parseCraftContractGraph(
  inputs: readonly Uint8Array[],
): readonly YuanshengCraftContractV1[] {
  const contracts = inputs.map(parseCraftContractBytes);
  validateCraftContractGraph(contracts);
  return contracts;
}
