import { describe, expect, test } from "bun:test";
import { canonicalizeJson, sealArtifact } from "../../plugins/craft/workflows/artifacts/canonical";
import { generateCraftContracts } from "../../plugins/craft/workflows/artifacts/generate";
import type {
  CriterionEvidence,
  PatchCandidate,
  RootCauseArtifact,
  YuanshengCraftContractV1,
} from "../../plugins/craft/workflows/artifacts/generated";
import {
  parseCraftContractBytes,
  parseCraftContractGraph,
  validateCraftContractGraph,
} from "../../plugins/craft/workflows/artifacts/parser";
import type { JsonValue } from "../../plugins/craft/workflows/artifacts/strict-json";
import {
  encodeContracts,
  makeBlueprintEntryGraph,
  makeCompleteContractGraph,
  makeProblemEntryGraph,
} from "./contract-fixtures";

function rootCauseOf(contracts: readonly YuanshengCraftContractV1[]): RootCauseArtifact {
  const rootCause = contracts.find(
    (contract): contract is RootCauseArtifact => contract.artifact_type === "root-cause",
  );
  if (rootCause === undefined) {
    throw new Error("Fixture does not contain a root-cause artifact");
  }
  return rootCause;
}

function reseal<T extends YuanshengCraftContractV1>(
  contract: T,
  mutate: (draft: Record<string, unknown>) => void,
): T {
  const draft = structuredClone(contract) as unknown as Record<string, unknown>;
  delete draft.artifact_digest;
  mutate(draft);
  return sealArtifact(draft as Record<string, JsonValue>) as unknown as T;
}

function encode(contract: YuanshengCraftContractV1): Uint8Array {
  return canonicalizeJson(contract).bytes;
}

describe("Yuansheng Craft v1 contracts", () => {
  test("parses every versioned contract family and validates its reference graph", () => {
    const graph = makeCompleteContractGraph();
    const parsed = parseCraftContractGraph(encodeContracts(graph.artifacts));

    expect(new Set(parsed.map((contract) => contract.artifact_type))).toEqual(
      new Set([
        "action-journal",
        "blueprint-review-attestation",
        "blueprint-review-subject",
        "criterion-evidence",
        "delivery",
        "diff-manifest",
        "mutation-authorization",
        "patch-candidate",
        "patch-plan",
        "patch-review",
        "phase-command-authorization",
        "phase-command-manifest",
        "repository-binding",
        "root-cause",
        "verification-authorization",
        "verification-manifest",
        "verification-source",
        "workflow-state",
      ]),
    );
    expect(parsed).toHaveLength(19);
  });

  test("both explicit entries converge on the same evidence-shaped RootCauseArtifact", () => {
    const problemGraph = parseCraftContractGraph(encodeContracts(makeProblemEntryGraph()));
    const blueprintGraph = parseCraftContractGraph(encodeContracts(makeBlueprintEntryGraph()));
    const problem = rootCauseOf(problemGraph);
    const blueprint = rootCauseOf(blueprintGraph);

    expect(problem.artifact_type).toBe("root-cause");
    expect(blueprint.artifact_type).toBe("root-cause");
    expect(blueprint.facts).toEqual(problem.facts);
    expect(blueprint.criteria).toEqual(problem.criteria);
    expect(problem.facts).toHaveLength(1);
    expect(blueprint.gaps).toEqual([
      {
        id: "gap:LOGGING123456789",
        statement: "Logging behavior was not present in the sealed evidence.",
      },
    ]);
    expect(blueprint.provenance.source).toBe("root-cause-blueprint");
  });

  test("separates normalized diff identity from candidate revision identity", () => {
    const { candidate, repeatedDiffCandidate } = makeCompleteContractGraph();

    expect(candidate.diff_content_digest).toBe(repeatedDiffCandidate.diff_content_digest);
    expect(candidate.artifact_digest).not.toBe(repeatedDiffCandidate.artifact_digest);
    expect(candidate.candidate_revision).toBe(1);
    expect(repeatedDiffCandidate.candidate_revision).toBe(2);
  });

  test("rejects deny attestations and non-optimizable Blueprint status pairs", () => {
    expect(() => validateCraftContractGraph(makeBlueprintEntryGraph("deny"))).toThrow(
      "denied Blueprint review",
    );
    expect(() =>
      validateCraftContractGraph(
        makeBlueprintEntryGraph("allow", "probable", "confirmed_root_cause"),
      ),
    ).toThrow("confirmed/confirmed_root_cause");
    expect(() =>
      validateCraftContractGraph(
        makeBlueprintEntryGraph("allow", "confirmed", "probable_root_cause"),
      ),
    ).toThrow("confirmed/confirmed_root_cause");
  });

  test("rejects unknown fields, duplicate IDs, non-canonical paths, invalid time, and version drift", () => {
    const rootCause = rootCauseOf(makeProblemEntryGraph());
    const unknownField = reseal(rootCause, (draft) => {
      draft.unexpected = true;
    });
    expect(() => parseCraftContractBytes(encode(unknownField))).toThrow("Invalid Craft contract");

    const duplicateId = reseal(rootCause, (draft) => {
      const facts = structuredClone(draft.facts) as unknown[];
      facts.push(structuredClone(facts[0]));
      draft.facts = facts;
    });
    expect(() => parseCraftContractBytes(encode(duplicateId))).toThrow(
      "Duplicate root-cause item ID",
    );

    const graph = makeCompleteContractGraph();
    const plan = graph.artifacts.find((artifact) => artifact.artifact_type === "patch-plan");
    if (plan?.artifact_type !== "patch-plan") {
      throw new Error("Fixture does not contain a patch plan");
    }
    const invalidPath = reseal(plan, (draft) => {
      const changes = structuredClone(draft.changes) as Array<Record<string, unknown>>;
      if (changes[0] !== undefined) {
        changes[0].path = "src/../escape.ts";
      }
      draft.changes = changes;
    });
    expect(() => parseCraftContractBytes(encode(invalidPath))).toThrow("Invalid Craft contract");

    const invalidTime = reseal(rootCause, (draft) => {
      draft.created_at = "2026-07-24T16:00:00+08:00";
    });
    expect(() => parseCraftContractBytes(encode(invalidTime))).toThrow("Invalid Craft contract");

    const invalidVersion = reseal(rootCause, (draft) => {
      draft.artifact_version = 2;
    });
    expect(() => parseCraftContractBytes(encode(invalidVersion))).toThrow("Invalid Craft contract");
  });

  test("provides a strict invalid fixture for every contract family", () => {
    const { artifacts } = makeCompleteContractGraph();
    for (const artifact of artifacts) {
      const invalid = reseal(artifact, (draft) => {
        draft.unknown_contract_field = artifact.artifact_type;
      });
      expect(() => parseCraftContractBytes(encode(invalid))).toThrow("Invalid Craft contract");
    }
  });

  test("rejects non-canonical bytes, duplicate JSON properties, invalid numbers, and payload tampering", () => {
    const rootCause = rootCauseOf(makeProblemEntryGraph());
    const canonicalText = canonicalizeJson(rootCause).text;
    const nonCanonical = new TextEncoder().encode(`${canonicalText}\n`);
    expect(() => parseCraftContractBytes(nonCanonical)).toThrow("exact RFC 8785 canonical bytes");

    const duplicateProperty = canonicalText.replace(
      '"artifact_version":1',
      '"artifact_version":1,"artifact_version":1',
    );
    expect(() => parseCraftContractBytes(new TextEncoder().encode(duplicateProperty))).toThrow(
      "Duplicate JSON property",
    );

    const invalidNumber = canonicalText.replace('"artifact_version":1', '"artifact_version":1e999');
    expect(() => parseCraftContractBytes(new TextEncoder().encode(invalidNumber))).toThrow(
      "Craft JSON numbers must be finite",
    );

    const tamperedPayload = canonicalText.replace(
      "Configuration normalization drops a required field.",
      "Configuration normalization silently drops a required field.",
    );
    expect(() => parseCraftContractBytes(new TextEncoder().encode(tamperedPayload))).toThrow(
      "Artifact digest mismatch",
    );
  });

  test("rejects tampered artifact references and criterion bindings", () => {
    const graph = makeCompleteContractGraph();
    const candidateIndex = graph.artifacts.findIndex(
      (artifact) => artifact.artifact_type === "patch-candidate",
    );
    const candidate = graph.artifacts[candidateIndex];
    if (candidate?.artifact_type !== "patch-candidate") {
      throw new Error("Fixture does not contain a patch candidate");
    }
    const badCandidate = reseal<PatchCandidate>(candidate, (draft) => {
      const ref = structuredClone(draft.diff_manifest_ref) as Record<string, unknown>;
      ref.digest = `sha256:${"0".repeat(64)}`;
      draft.diff_manifest_ref = ref;
    });
    const badReferenceGraph = [...graph.artifacts];
    badReferenceGraph[candidateIndex] = badCandidate;
    expect(() => validateCraftContractGraph(badReferenceGraph)).toThrow("Unresolved");

    const wrongTypeCandidate = reseal<PatchCandidate>(candidate, (draft) => {
      const ref = structuredClone(draft.diff_manifest_ref) as Record<string, unknown>;
      ref.artifact_type = "patch-plan";
      draft.diff_manifest_ref = ref;
    });
    const wrongTypeGraph = [...graph.artifacts];
    wrongTypeGraph[candidateIndex] = wrongTypeCandidate;
    expect(() => validateCraftContractGraph(wrongTypeGraph)).toThrow(
      "Reference metadata does not match",
    );

    const evidenceIndex = graph.artifacts.findIndex(
      (artifact) => artifact.artifact_type === "criterion-evidence",
    );
    const evidence = graph.artifacts[evidenceIndex];
    if (evidence?.artifact_type !== "criterion-evidence") {
      throw new Error("Fixture does not contain criterion evidence");
    }
    const badEvidence = reseal<CriterionEvidence>(evidence, (draft) => {
      draft.criterion_id = "criterion:UNKNOWN123456789";
    });
    const badCriterionGraph = [...graph.artifacts];
    badCriterionGraph[evidenceIndex] = badEvidence;
    expect(() => validateCraftContractGraph(badCriterionGraph)).toThrow(
      "not selected by its manifest",
    );
  });

  test("keeps generated types and standalone parser in sync with the canonical schema", async () => {
    await expect(generateCraftContracts("check")).resolves.toBeUndefined();
  });
});
