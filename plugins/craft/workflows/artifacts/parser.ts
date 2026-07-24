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
  type VerificationCommand,
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

function assertMutationPathShape(
  change: {
    readonly operation: "create" | "delete" | "modify" | "rename";
    readonly path: string;
    readonly source_path: string | null;
  },
  label: string,
): void {
  if (change.operation === "rename") {
    if (change.source_path === null || change.source_path === change.path) {
      fail("semantic-invalid", `${label} rename requires distinct source and destination paths`);
    }
    return;
  }
  if (change.source_path !== null) {
    fail("semantic-invalid", `${label} ${change.operation} must not contain a source path`);
  }
}

function mutationScopeKey(change: {
  readonly operation: "create" | "delete" | "modify" | "rename";
  readonly path: string;
  readonly source_path: string | null;
}): string {
  return `${change.operation}\0${change.source_path ?? ""}\0${change.path}`;
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
    } else if (typeof field === "string" && (key === "path" || key === "source_path")) {
      assertCanonicalPath(field, false);
    }
    inspectPaths(field);
  }
}

function assertVerificationCommand(command: VerificationCommand): void {
  assertCanonicalPath(command.cwd, command.runner_type === "ssh");
  assertCanonicalPath(command.log_path, false);
  if (
    (command.runner_type === "local" && command.host_alias !== null) ||
    (command.runner_type === "ssh" && command.host_alias === null) ||
    (command.runner_type === "ssh" && command.environment_allowlist.length !== 0)
  ) {
    fail(
      "semantic-invalid",
      `Verification command ${command.command_id} has an invalid runner target`,
    );
  }
  if (command.argv.some((argument) => argument.includes("\0"))) {
    fail("semantic-invalid", `Verification command ${command.command_id} contains NUL argv`);
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

function samePrincipal(
  left: { readonly agent_id: string; readonly session_id: string },
  right: { readonly agent_id: string; readonly session_id: string },
): boolean {
  return left.agent_id === right.agent_id && left.session_id === right.session_id;
}

const PHASE_OWNER = Object.freeze({
  building: "ys-craft-patch-builder",
  delivering: "ys-craft-delivery-coordinator",
  intake: "ys-craft",
  planning: "ys-craft-patch-planner",
  reviewing: "ys-craft-patch-reviewer",
  root_cause: "ys-craft-root-cause-analyst",
  verifying: "ys-craft-regression-verifier",
} as const);

function assertContractSemantics(contract: YuanshengCraftContractV1): void {
  inspectPaths(contract);
  switch (contract.artifact_type) {
    case "root-cause":
      assertRootCause(contract);
      break;
    case "blueprint-review-subject":
      assertRefType(contract.repository_binding_ref, "repository-binding");
      assertUnique(
        contract.validation.evidence.map((evidence) => evidence.path),
        "sealed evidence path",
      );
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
      for (const change of contract.changes) {
        assertMutationPathShape(change, "Planned change");
      }
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
      assertRefType(contract.repository_binding_ref, "repository-binding");
      for (const change of contract.authorized_changes) {
        assertMutationPathShape(change, "Authorized change");
      }
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
        assertMutationPathShape(entry, "Diff entry");
        const invalidCreate =
          entry.operation === "create" &&
          (entry.old_blob_digest !== null ||
            entry.old_mode !== null ||
            entry.new_blob_digest === null ||
            entry.new_mode === null);
        const invalidDelete =
          entry.operation === "delete" &&
          (entry.new_blob_digest !== null ||
            entry.new_mode !== null ||
            entry.old_blob_digest === null ||
            entry.old_mode === null);
        const invalidModify =
          entry.operation === "modify" &&
          (entry.old_blob_digest === null ||
            entry.old_mode === null ||
            entry.new_blob_digest === null ||
            entry.new_mode === null);
        const invalidRename =
          entry.operation === "rename" &&
          (entry.old_blob_digest === null ||
            entry.old_mode === null ||
            entry.new_blob_digest === null ||
            entry.new_mode === null);
        if (invalidCreate || invalidDelete || invalidModify || invalidRename) {
          fail(
            "semantic-invalid",
            `Diff blob digests do not match ${entry.operation}: ${entry.path}`,
          );
        }
      }
      if (
        contract.diff_content_digest !==
        canonicalizeJson({
          binary_patch_digest: contract.binary_patch_digest,
          entries: contract.entries,
        }).digest
      ) {
        fail(
          "digest-mismatch",
          "Diff content digest does not match its manifest entries and patch",
        );
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
      assertUnique(
        contract.commands.map((command) => command.log_path),
        "verification command log path",
      );
      for (const command of contract.commands) {
        assertVerificationCommand(command);
      }
      break;
    case "verification-manifest":
      assertRefType(contract.candidate_ref, "patch-candidate");
      assertRefType(contract.repository_binding_ref, "repository-binding");
      assertRefType(contract.source_ref, "verification-source");
      assertUnique(
        contract.commands.map((command) => command.command_id),
        "verification command ID",
      );
      assertUnique(
        contract.commands.map((command) => command.log_path),
        "verification command log path",
      );
      for (const command of contract.commands) {
        assertVerificationCommand(command);
      }
      if (
        contract.commands.some((command) => command.runner_type === "ssh")
          ? contract.ssh_preflight_protocol !== "ys-craft-canonical-diff-v1"
          : contract.ssh_preflight_protocol !== null
      ) {
        fail("semantic-invalid", "Verification manifest preflight does not match its runners");
      }
      break;
    case "verification-authorization":
      assertRefType(contract.candidate_ref, "patch-candidate");
      assertRefType(contract.manifest_ref, "verification-manifest");
      break;
    case "phase-command-manifest":
      assertRefType(contract.repository_binding_ref, "repository-binding");
      assertUnique(
        contract.commands.map((command) => command.command_id),
        "phase command ID",
      );
      for (const command of contract.commands) {
        assertCanonicalPath(command.cwd, false);
      }
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
      assertUnique(
        contract.command_results.map((result) => result.command_id),
        "verification command result ID",
      );
      for (const result of contract.command_results) {
        if (
          Date.parse(result.finished_at) < Date.parse(result.started_at) ||
          Date.parse(result.started_at) < Date.parse(contract.started_at) ||
          Date.parse(result.finished_at) > Date.parse(contract.finished_at)
        ) {
          fail("semantic-invalid", "Command result timestamps escape criterion evidence");
        }
        const invalidExit =
          (result.status === "pass" && result.exit_code !== 0) ||
          (result.status === "fail" && (result.exit_code === null || result.exit_code === 0)) ||
          (result.status === "infra_error") !== (result.infra_error !== null) ||
          (result.infra_error === "log_write_failure" && result.log_persisted);
        if (invalidExit) {
          fail("semantic-invalid", "Command result status and exit code disagree");
        }
      }
      if (
        (contract.evidence_kind === "machine" &&
          (contract.command_results.length === 0 || contract.human_confirmation !== null)) ||
        (contract.evidence_kind === "human" &&
          (contract.command_results.length !== 0 || contract.human_confirmation === null))
      ) {
        fail("semantic-invalid", "Criterion evidence kind does not match its payload");
      }
      if (
        contract.evidence_kind === "human" &&
        contract.human_confirmation !== null &&
        ((contract.status === "pass" && contract.human_confirmation.action !== "allow") ||
          (contract.status === "fail" && contract.human_confirmation.action !== "deny") ||
          contract.status === "infra_error")
      ) {
        fail("semantic-invalid", "Human confirmation action does not match evidence status");
      }
      break;
    case "patch-review":
      assertRefType(contract.candidate_ref, "patch-candidate");
      assertRefType(contract.diff_manifest_ref, "diff-manifest");
      assertRefType(contract.manifest_ref, "verification-manifest");
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
      assertRefType(contract.diff_manifest_ref, "diff-manifest");
      assertRefType(contract.manifest_ref, "verification-manifest");
      assertRefType(contract.patch_review_ref, "patch-review");
      for (const ref of contract.criterion_evidence_refs) {
        assertRefType(ref, "criterion-evidence");
      }
      break;
    case "workflow-state": {
      const activeDigests = new Set(contract.artifact_refs.map((ref) => ref.digest));
      assertUnique(
        contract.artifact_refs.map((ref) => ref.digest),
        "workflow artifact reference",
      );
      assertUnique(
        contract.stale_artifact_refs.map((ref) => ref.digest),
        "stale workflow artifact reference",
      );
      if (contract.stale_artifact_refs.some((ref) => activeDigests.has(ref.digest))) {
        fail("semantic-invalid", "A workflow artifact cannot be both active and stale");
      }
      assertUnique(
        contract.principal_audit.map((principal) => principal.session_id),
        "workflow principal session ID",
      );
      if (
        contract.coordinator.agent_id !== "ys-craft" ||
        !contract.principal_audit.some((principal) =>
          samePrincipal(principal, contract.coordinator),
        )
      ) {
        fail("semantic-invalid", "Workflow coordinator must be an audited ys-craft principal");
      }
      const phasePrincipal = contract.phase_principal;
      if (
        phasePrincipal !== null &&
        (!contract.principal_audit.some((principal) => samePrincipal(principal, phasePrincipal)) ||
          contract.phase === "blocked" ||
          contract.phase === "completed" ||
          PHASE_OWNER[contract.phase] !== phasePrincipal.agent_id)
      ) {
        fail("semantic-invalid", "Workflow phase principal does not own the active phase");
      }
      if (contract.entry_context.strategy !== contract.entry_strategy) {
        fail("semantic-invalid", "Workflow entry strategy and context must agree");
      }
      assertRefType(contract.entry_context.repository_binding_ref, "repository-binding");
      const entryRefs =
        contract.entry_context.strategy === "root-cause-import"
          ? [
              contract.entry_context.repository_binding_ref,
              contract.entry_context.review_subject_ref,
              contract.entry_context.attestation_ref,
              contract.entry_context.root_cause_ref,
            ]
          : [contract.entry_context.repository_binding_ref];
      if (entryRefs.some((ref) => !activeDigests.has(ref.digest))) {
        fail("semantic-invalid", "Workflow entry evidence must remain active");
      }
      if (contract.entry_context.strategy === "root-cause-import") {
        assertRefType(contract.entry_context.review_subject_ref, "blueprint-review-subject");
        assertRefType(contract.entry_context.attestation_ref, "blueprint-review-attestation");
        assertRefType(contract.entry_context.root_cause_ref, "root-cause");
      }
      const terminalPhase = contract.phase === "blocked" || contract.phase === "completed";
      if (
        (contract.status === "blocked") !== (contract.phase === "blocked") ||
        (contract.status === "completed") !== (contract.phase === "completed") ||
        (contract.status === "active" && terminalPhase) ||
        (contract.phase === "blocked") !== (contract.blocked_context !== null) ||
        (contract.phase === "completed") !== (contract.completed_at !== null) ||
        (contract.completed_at !== null &&
          Date.parse(contract.completed_at) !== Date.parse(contract.updated_at)) ||
        (terminalPhase && contract.phase_principal !== null) ||
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
  if (
    rootCause.criteria.some(
      (criterion) => criterion.required && !contract.criterion_ids.includes(criterion.id),
    )
  ) {
    fail("reference-mismatch", "Patch plan must retain every required root-cause criterion");
  }
  for (const change of contract.changes) {
    for (const criterionId of change.criterion_ids) {
      if (!criterionIds.has(criterionId) || !contract.criterion_ids.includes(criterionId)) {
        fail("reference-mismatch", `Planned change references an unbound criterion ${criterionId}`);
      }
    }
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
  const binding = getContract(index, contract.repository_binding_ref, "repository-binding");
  const plannedScope = plan.changes.map(({ id, operation, path, source_path }) => ({
    operation,
    path,
    planned_change_id: id,
    source_path,
  }));
  if (
    contract.authorized_revision !== plan.plan_revision ||
    contract.baseline_commit !== binding.commit_sha ||
    contract.target_worktree_realpath !== binding.target_worktree_realpath ||
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
  if (authorization.repository_binding_ref.digest !== contract.repository_binding_ref.digest) {
    fail("reference-mismatch", "Diff manifest repository does not match its authorization");
  }
  const authorizedScope = new Set(authorization.authorized_changes.map(mutationScopeKey));
  for (const entry of contract.entries) {
    if (!authorizedScope.has(mutationScopeKey(entry))) {
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
  const machineCriterionIds = new Set<string>();
  for (const command of contract.commands) {
    if (!criterionIds.has(command.criterion_id)) {
      fail(
        "reference-mismatch",
        `Verification source references unknown criterion ${command.criterion_id}`,
      );
    }
    machineCriterionIds.add(command.criterion_id);
  }
  const humanCriterionIds = new Set(contract.human_criterion_ids);
  if (
    contract.human_criterion_ids.some(
      (criterionId) => !criterionIds.has(criterionId) || machineCriterionIds.has(criterionId),
    )
  ) {
    fail(
      "reference-mismatch",
      "Human verification criteria must be known and distinct from machine criteria",
    );
  }
  if (
    [...criterionIds].some(
      (criterionId) => !machineCriterionIds.has(criterionId) && !humanCriterionIds.has(criterionId),
    )
  ) {
    fail("reference-mismatch", "Verification source must classify every plan criterion");
  }
  for (const criterionId of machineCriterionIds) {
    if (
      !contract.commands.some((command) => command.criterion_id === criterionId && command.required)
    ) {
      fail("semantic-invalid", `Machine criterion has no required check: ${criterionId}`);
    }
  }
}

function assertEvidenceGraph(
  evidence: CriterionEvidence,
  index: ReadonlyMap<string, YuanshengCraftContractV1>,
): void {
  const manifest = getContract(index, evidence.manifest_ref, "verification-manifest");
  const commands = manifest.commands.filter(
    (command) => command.criterion_id === evidence.criterion_id,
  );
  const isHuman = manifest.human_criterion_ids.includes(evidence.criterion_id);
  if (
    (evidence.evidence_kind === "machine" && commands.length === 0) ||
    (evidence.evidence_kind === "human" && !isHuman)
  ) {
    fail("reference-mismatch", "Criterion evidence kind is not selected by its manifest");
  }
  if (manifest.candidate_ref.digest !== evidence.candidate_ref.digest) {
    fail("reference-mismatch", "Criterion evidence and manifest bind different candidates");
  }
  if (
    evidence.status === "blocked"
      ? evidence.observed_diff_content_digest === manifest.diff_content_digest
      : evidence.observed_diff_content_digest !== manifest.diff_content_digest
  ) {
    fail(
      "reference-mismatch",
      "Criterion evidence drift status does not match its observed candidate diff",
    );
  }
  if (evidence.evidence_kind === "machine") {
    const expectedResults = commands.map((command) => command.command_id).sort();
    const actualResults = evidence.command_results.map((result) => result.command_id).sort();
    if (
      evidence.status !== "blocked" &&
      (expectedResults.length !== actualResults.length ||
        expectedResults.some((commandId, resultIndex) => commandId !== actualResults[resultIndex]))
    ) {
      fail("reference-mismatch", "Machine evidence must record every selected command");
    }
    const requiredStatuses = commands
      .filter((command) => command.required)
      .map((command) =>
        evidence.command_results.find((result) => result.command_id === command.command_id),
      );
    if (
      evidence.status === "pass" &&
      requiredStatuses.some((result) => result?.status !== "pass")
    ) {
      fail("semantic-invalid", "Passing criterion evidence requires every required check to pass");
    }
    if (
      evidence.status === "infra_error" &&
      !requiredStatuses.some((result) => result?.status === "infra_error")
    ) {
      fail("semantic-invalid", "Infrastructure evidence requires an infrastructure error result");
    }
    if (
      evidence.status === "fail" &&
      !requiredStatuses.some((result) => result?.status === "fail")
    ) {
      fail("semantic-invalid", "Failing criterion evidence requires a failed required check");
    }
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
      const binding = getContract(index, contract.repository_binding_ref, "repository-binding");
      if (contract.review_subject_digest !== subject.artifact_digest) {
        fail("reference-mismatch", "Attestation subject digest does not resolve to its subject");
      }
      if (
        contract.resolved_repository.commit_sha !== binding.commit_sha ||
        contract.resolved_repository.repository_url !== binding.repository_url ||
        contract.resolved_repository.target_worktree_realpath !==
          binding.target_worktree_realpath ||
        (subject.source_path === null) !==
          (contract.resolved_repository.source_realpath === null) ||
        (subject.source_path !== null &&
          contract.resolved_repository.source_realpath !==
            `${binding.product_root_realpath}/${subject.source_path}`)
      ) {
        fail("reference-mismatch", "Attestation repository resolution does not match its binding");
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
      const binding = getContract(index, contract.repository_binding_ref, "repository-binding");
      const plan = getContract(index, candidate.plan_ref, "patch-plan");
      if (
        source.plan_ref.digest !== plan.artifact_digest ||
        source.repository_binding_ref.digest !== binding.artifact_digest
      ) {
        fail("reference-mismatch", "Verification source does not bind the candidate plan");
      }
      if (
        canonicalizeJson(source.commands).text !== canonicalizeJson(contract.commands).text ||
        canonicalizeJson(source.human_criterion_ids).text !==
          canonicalizeJson(contract.human_criterion_ids).text ||
        source.config_digest !== contract.config_digest
      ) {
        fail("reference-mismatch", "Verification manifest must preserve the selected source");
      }
      if (
        contract.diff_content_digest !== candidate.diff_content_digest ||
        contract.baseline_commit !== binding.commit_sha ||
        contract.target_worktree_realpath !== binding.target_worktree_realpath ||
        contract.log_root_realpath === binding.target_worktree_realpath ||
        contract.log_root_realpath.startsWith(`${binding.target_worktree_realpath}/`)
      ) {
        fail(
          "reference-mismatch",
          "Verification manifest preflight or log root does not match its candidate binding",
        );
      }
    } else if (contract.artifact_type === "verification-authorization") {
      const manifest = getContract(index, contract.manifest_ref, "verification-manifest");
      const candidate = getContract(index, contract.candidate_ref, "patch-candidate");
      if (
        manifest.candidate_ref.digest !== candidate.artifact_digest ||
        contract.principal.agent_id !== "ys-craft-regression-verifier"
      ) {
        fail(
          "reference-mismatch",
          "Verification authorization must bind the exact manifest candidate and verifier",
        );
      }
    } else if (contract.artifact_type === "patch-review") {
      const candidate = getContract(index, contract.candidate_ref, "patch-candidate");
      const diff = getContract(index, contract.diff_manifest_ref, "diff-manifest");
      const manifest = getContract(index, contract.manifest_ref, "verification-manifest");
      const plan = getContract(index, candidate.plan_ref, "patch-plan");
      const rootCause = getContract(index, plan.root_cause_ref, "root-cause");
      const mutation = getContract(
        index,
        diff.mutation_authorization_ref,
        "mutation-authorization",
      );
      if (
        contract.reviewer.agent_id !== "ys-craft-patch-reviewer" ||
        mutation.principal.session_id !== contract.builder_session_id ||
        mutation.principal.session_id === contract.reviewer.session_id
      ) {
        fail("semantic-invalid", "Patch reviewer must use a distinct real session");
      }
      if (
        candidate.diff_manifest_ref.digest !== diff.artifact_digest ||
        candidate.diff_content_digest !== contract.diff_content_digest ||
        diff.diff_content_digest !== contract.diff_content_digest ||
        manifest.candidate_ref.digest !== candidate.artifact_digest
      ) {
        fail("reference-mismatch", "Patch review does not bind the exact candidate diff manifest");
      }
      const expectedGapIds = rootCause.gaps.map((gap) => gap.id).sort();
      const actualGapIds = [...contract.unresolved_gap_ids].sort();
      if (
        expectedGapIds.length !== actualGapIds.length ||
        expectedGapIds.some((gapId, gapIndex) => gapId !== actualGapIds[gapIndex])
      ) {
        fail("reference-mismatch", "Patch review must preserve every unresolved root-cause gap");
      }
      const evidenceByCriterion = new Map<string, CriterionEvidence[]>();
      for (const ref of contract.criterion_evidence_refs) {
        const evidence = getContract(index, ref, "criterion-evidence");
        if (
          evidence.candidate_ref.digest !== candidate.artifact_digest ||
          evidence.manifest_ref.digest !== manifest.artifact_digest
        ) {
          fail("reference-mismatch", "Patch review evidence binds a different candidate manifest");
        }
        const existing = evidenceByCriterion.get(evidence.criterion_id) ?? [];
        existing.push(evidence);
        evidenceByCriterion.set(evidence.criterion_id, existing);
      }
      for (const criterion of rootCause.criteria.filter((item) => item.required)) {
        const matching = evidenceByCriterion.get(criterion.id) ?? [];
        if (matching.length !== 1 || matching[0]?.status !== "pass") {
          fail(
            "reference-mismatch",
            `Patch review requires one passing evidence artifact for ${criterion.id}`,
          );
        }
      }
    } else if (contract.artifact_type === "delivery") {
      const review = getContract(index, contract.patch_review_ref, "patch-review");
      const candidate = getContract(index, contract.candidate_ref, "patch-candidate");
      const diff = getContract(index, contract.diff_manifest_ref, "diff-manifest");
      const manifest = getContract(index, contract.manifest_ref, "verification-manifest");
      const plan = getContract(index, contract.plan_ref, "patch-plan");
      if (
        review.status !== "pass" ||
        review.candidate_ref.digest !== contract.candidate_ref.digest ||
        review.diff_manifest_ref.digest !== diff.artifact_digest ||
        review.manifest_ref.digest !== manifest.artifact_digest ||
        candidate.diff_manifest_ref.digest !== diff.artifact_digest
      ) {
        fail("reference-mismatch", "Delivery requires the passing review for its exact candidate");
      }
      if (
        candidate.plan_ref.digest !== plan.artifact_digest ||
        plan.root_cause_ref.digest !== contract.root_cause_ref.digest ||
        candidate.diff_content_digest !== contract.delivery_patch_digest ||
        diff.diff_content_digest !== contract.delivery_patch_digest
      ) {
        fail("reference-mismatch", "Delivery must bind the exact candidate plan and patch digest");
      }
      const reviewEvidence = review.criterion_evidence_refs.map((ref) => ref.digest).sort();
      const deliveryEvidence = contract.criterion_evidence_refs.map((ref) => ref.digest).sort();
      if (
        reviewEvidence.length !== deliveryEvidence.length ||
        reviewEvidence.some((digest, evidenceIndex) => digest !== deliveryEvidence[evidenceIndex])
      ) {
        fail("reference-mismatch", "Delivery must preserve the independently reviewed evidence");
      }
      const evidence = contract.criterion_evidence_refs.map((ref) =>
        getContract(index, ref, "criterion-evidence"),
      );
      const expectedPaths = diff.entries.map((entry) => entry.path).sort();
      const actualPaths = [...contract.changed_paths].sort();
      const expectedCriteria = evidence.map((item) => item.criterion_id).sort();
      const actualCriteria = [...contract.verified_criterion_ids].sort();
      const expectedHumanCriteria = evidence
        .filter((item) => item.evidence_kind === "human")
        .map((item) => item.criterion_id)
        .sort();
      const actualHumanCriteria = [...contract.human_criterion_ids].sort();
      if (
        expectedPaths.length !== actualPaths.length ||
        expectedPaths.some((path, pathIndex) => path !== actualPaths[pathIndex]) ||
        expectedCriteria.length !== actualCriteria.length ||
        expectedCriteria.some(
          (criterionId, criterionIndex) => criterionId !== actualCriteria[criterionIndex],
        ) ||
        expectedHumanCriteria.length !== actualHumanCriteria.length ||
        expectedHumanCriteria.some(
          (criterionId, criterionIndex) => criterionId !== actualHumanCriteria[criterionIndex],
        )
      ) {
        fail("reference-mismatch", "Delivery summary differs from reviewed files or criteria");
      }
    } else if (contract.artifact_type === "workflow-state") {
      const entry = contract.entry_context;
      getContract(index, entry.repository_binding_ref, "repository-binding");
      if (entry.strategy === "root-cause-import") {
        const subject = getContract(index, entry.review_subject_ref, "blueprint-review-subject");
        const attestation = getContract(
          index,
          entry.attestation_ref,
          "blueprint-review-attestation",
        );
        const rootCause = getContract(index, entry.root_cause_ref, "root-cause");
        if (
          attestation.action !== "allow" ||
          attestation.review_subject_ref.digest !== subject.artifact_digest ||
          rootCause.entry_strategy !== "root-cause-import" ||
          rootCause.provenance.source !== "root-cause-blueprint" ||
          rootCause.provenance.blueprint.attestation_ref.digest !== attestation.artifact_digest ||
          rootCause.provenance.blueprint.review_subject_ref.digest !== subject.artifact_digest
        ) {
          fail(
            "reference-mismatch",
            "Imported workflow entry does not bind its allowed Blueprint evidence chain",
          );
        }
      } else {
        for (const ref of contract.artifact_refs) {
          if (ref.artifact_type !== "root-cause") {
            continue;
          }
          const rootCause = getContract(index, ref, "root-cause");
          if (
            rootCause.entry_strategy !== "problem-description" ||
            rootCause.provenance.source !== "problem-description"
          ) {
            fail("reference-mismatch", "Problem workflow cannot activate an imported root cause");
          }
        }
      }
    }
  }
  const candidateGroups = new Map<string, PatchCandidate[]>();
  for (const contract of contracts) {
    if (contract.artifact_type !== "patch-candidate") {
      continue;
    }
    const key = `${contract.workflow_id}\0${contract.plan_ref.digest}`;
    const group = candidateGroups.get(key) ?? [];
    group.push(contract);
    candidateGroups.set(key, group);
  }
  for (const candidates of candidateGroups.values()) {
    candidates.sort((left, right) => left.candidate_revision - right.candidate_revision);
    for (let candidateIndex = 1; candidateIndex < candidates.length; candidateIndex += 1) {
      const previous = candidates[candidateIndex - 1];
      const current = candidates[candidateIndex];
      if (
        previous === undefined ||
        current === undefined ||
        current.candidate_revision <= previous.candidate_revision ||
        current.iteration <= previous.iteration
      ) {
        fail(
          "semantic-invalid",
          "Patch candidate revision and iteration must both increase strictly for one plan",
        );
      }
    }
  }
  const manifestedCandidates = new Set<string>();
  const authorizedManifests = new Set<string>();
  for (const contract of contracts) {
    if (contract.artifact_type === "verification-manifest") {
      if (manifestedCandidates.has(contract.candidate_ref.digest)) {
        fail(
          "semantic-invalid",
          "One immutable candidate revision cannot have multiple verification manifests",
        );
      }
      manifestedCandidates.add(contract.candidate_ref.digest);
    } else if (contract.artifact_type === "verification-authorization") {
      if (authorizedManifests.has(contract.manifest_ref.digest)) {
        fail(
          "semantic-invalid",
          "One immutable verification manifest cannot have multiple authorizations",
        );
      }
      authorizedManifests.add(contract.manifest_ref.digest);
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
