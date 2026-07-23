import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { canonicalizeJson } from "../../plugins/craft/workflows/artifacts/canonical";
import { validateCraftContractGraph } from "../../plugins/craft/workflows/artifacts/parser";
import {
  snapshotVerifiedSealedBlueprint,
  verifySealedBlueprintDirectory,
} from "../../plugins/craft/workflows/blueprint-import/sealed-verifier";
import {
  buildBlueprintReviewSubject,
  reviewBlueprintForImport,
} from "../../plugins/craft/workflows/blueprint-import/transaction";
import { makeRepositoryBinding } from "./contract-fixtures";
import {
  BLUEPRINT_COMMIT_SHA,
  BLUEPRINT_REPOSITORY_URL,
  BLUEPRINT_SOURCE_PATH,
  createSealedBlueprintFixture,
} from "./sealed-blueprint-fixture";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ys-craft-blueprint-import-"));
  temporaryRoots.push(root);
  return root;
}

function binding(overrides: Parameters<typeof makeRepositoryBinding>[0] = {}) {
  return makeRepositoryBinding({
    commit_sha: BLUEPRINT_COMMIT_SHA,
    git_root_realpath: "/workspace/openblas",
    product_root_realpath: "/workspace/openblas",
    repository_url: BLUEPRINT_REPOSITORY_URL,
    target_worktree_realpath: "/workspace/openblas",
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("Yuansheng Craft sealed Blueprint import", () => {
  test("verifies one exact Trace function directory and builds a reproducible review subject", async () => {
    const fixture = await createSealedBlueprintFixture(await temporaryRoot(), {
      duplicateFunctionHotspot: true,
    });
    const before = await readFile(join(fixture.directoryPath, "blueprint.json"));
    const verified = await verifySealedBlueprintDirectory(fixture.directoryPath);
    const repositoryBinding = binding();
    const firstSubject = buildBlueprintReviewSubject(verified, repositoryBinding);
    const secondSubject = buildBlueprintReviewSubject(verified, repositoryBinding);

    expect(verified.functionIdentity).toEqual({
      functionName: "dgemv_n",
      rank: "001",
      software: "openblas",
      testCase: "dgemv_2048x2048",
    });
    expect(verified.sourcePath).toBe(BLUEPRINT_SOURCE_PATH);
    expect(verified.validation.evidence.map((item) => item.path)).toEqual([
      "evidence/annotate.txt",
      "evidence/hardware-profile.json",
      "evidence/perf-stat.txt",
    ]);
    expect(firstSubject.artifact_digest).toBe(secondSubject.artifact_digest);
    expect(firstSubject.function_identity.function_name).toBe("dgemv_n");
    expect(firstSubject.source_path).toBe(BLUEPRINT_SOURCE_PATH);
    expect(snapshotVerifiedSealedBlueprint(verified).blueprintRawBytes).toEqual(before);
    expect(await readFile(join(fixture.directoryPath, "blueprint.json"))).toEqual(before);
  });

  test("an explicit allow produces only the RootCause transaction payload", async () => {
    const fixture = await createSealedBlueprintFixture(await temporaryRoot());
    const verified = await verifySealedBlueprintDirectory(fixture.directoryPath);
    const repositoryBinding = binding();
    const subject = buildBlueprintReviewSubject(verified, repositoryBinding);
    const outcome = reviewBlueprintForImport({
      binding: repositoryBinding,
      context: {
        action: "allow",
        reviewedAt: "2026-07-24T09:00:00.000Z",
        reviewerSessionId: "session:BLUEPRINTIMPORT1",
      },
      subject,
      verified,
      workflowId: "workflow:BLUEPRINTIMPORT1",
    });

    expect(outcome.decision).toBe("allow");
    if (outcome.decision !== "allow") {
      throw new Error("Expected an allow transaction");
    }
    const rootCause = outcome.transaction.rootCauseArtifact;
    expect(rootCause.artifact_type).toBe("root-cause");
    expect(rootCause.entry_strategy).toBe("root-cause-import");
    expect(rootCause.provenance.source).toBe("root-cause-blueprint");
    expect(rootCause.facts.map((fact) => fact.statement)).toEqual([
      fixture.blueprint.section2_summary.anomaly_conclusion,
      ...fixture.blueprint.section3_key_evidence["3_1_metric_evidence"].map(
        (metric) => metric.anomaly_note,
      ),
      ...fixture.blueprint.section3_key_evidence["3_2_hotspot_evidence"].map(
        (hotspot) => hotspot.note,
      ),
    ]);
    expect(rootCause.gaps.map((gap) => gap.statement)).toEqual(
      fixture.blueprint.section5_risks_and_gaps.current_gaps,
    );
    expect(
      (outcome.transaction.contracts as readonly { artifact_type: string }[]).some(
        (contract) => contract.artifact_type === "workflow-state",
      ),
    ).toBe(false);
    expect(() =>
      validateCraftContractGraph([repositoryBinding, ...outcome.transaction.contracts]),
    ).not.toThrow();
  });

  test("deny and non-confirmed review paths cannot produce a transaction", async () => {
    const deniedFixture = await createSealedBlueprintFixture(await temporaryRoot());
    const deniedVerified = await verifySealedBlueprintDirectory(deniedFixture.directoryPath);
    const repositoryBinding = binding();
    const deniedSubject = buildBlueprintReviewSubject(deniedVerified, repositoryBinding);
    const denied = reviewBlueprintForImport({
      binding: repositoryBinding,
      context: {
        action: "deny",
        reviewedAt: "2026-07-24T09:00:00.000Z",
        reviewerSessionId: "session:BLUEPRINTIMPORT1",
      },
      subject: deniedSubject,
      verified: deniedVerified,
      workflowId: "workflow:BLUEPRINTIMPORT1",
    });
    expect(denied.decision).toBe("deny");
    expect("transaction" in denied).toBe(false);

    const probableFixture = await createSealedBlueprintFixture(await temporaryRoot(), {
      overallStatus: "probable",
    });
    const probableVerified = await verifySealedBlueprintDirectory(probableFixture.directoryPath);
    const probableSubject = buildBlueprintReviewSubject(probableVerified, repositoryBinding);
    expect(() =>
      reviewBlueprintForImport({
        binding: repositoryBinding,
        context: {
          action: "allow",
          reviewedAt: "2026-07-24T09:00:00.000Z",
          reviewerSessionId: "session:BLUEPRINTIMPORT1",
        },
        subject: probableSubject,
        verified: probableVerified,
        workflowId: "workflow:BLUEPRINTIMPORT1",
      }),
    ).toThrow("confirmed/confirmed_root_cause");
  });

  test("requires passing machine and five-dimension semantic validation", async () => {
    const machineFailure = await createSealedBlueprintFixture(await temporaryRoot(), {
      machineStatus: "fail",
    });
    await expect(verifySealedBlueprintDirectory(machineFailure.directoryPath)).rejects.toThrow(
      "Machine validation",
    );

    const semanticFailure = await createSealedBlueprintFixture(await temporaryRoot(), {
      semanticStatus: "fail",
    });
    await expect(verifySealedBlueprintDirectory(semanticFailure.directoryPath)).rejects.toThrow(
      "Every semantic dimension",
    );
  });

  test("rejects checksum tampering, extra files, duplicate identities, and parent discovery", async () => {
    const tampered = await createSealedBlueprintFixture(await temporaryRoot());
    await writeFile(join(tampered.directoryPath, "evidence/annotate.txt"), "tampered evidence\n");
    await expect(verifySealedBlueprintDirectory(tampered.directoryPath)).rejects.toThrow(
      "Checksum manifest",
    );

    const extra = await createSealedBlueprintFixture(await temporaryRoot());
    await writeFile(join(extra.directoryPath, "unexpected.txt"), "unexpected");
    await expect(verifySealedBlueprintDirectory(extra.directoryPath)).rejects.toThrow(
      "exact Trace file set",
    );

    const duplicate = await createSealedBlueprintFixture(await temporaryRoot());
    const checksumPath = join(duplicate.directoryPath, "checksums.json");
    const checksum = JSON.parse(await readFile(checksumPath, "utf8")) as Record<string, unknown>;
    const files = checksum.files as unknown[];
    files.push(structuredClone(files[0]));
    await writeFile(checksumPath, canonicalizeJson(checksum as never).bytes);
    await expect(verifySealedBlueprintDirectory(duplicate.directoryPath)).rejects.toThrow(
      "duplicate file identities",
    );

    const exact = await createSealedBlueprintFixture(await temporaryRoot());
    await expect(verifySealedBlueprintDirectory(dirname(exact.directoryPath))).rejects.toThrow(
      "exact Trace file set",
    );
  });

  test("rejects symlink traversal, multiple function identities, and invalid locators", async () => {
    const exact = await createSealedBlueprintFixture(await temporaryRoot());
    const linkRoot = await temporaryRoot();
    const linkedDirectory = join(linkRoot, "linked-function");
    await symlink(exact.directoryPath, linkedDirectory);
    await expect(verifySealedBlueprintDirectory(linkedDirectory)).rejects.toThrow(
      "only real directories",
    );

    const multiple = await createSealedBlueprintFixture(await temporaryRoot(), {
      multipleFunctionHotspot: true,
    });
    await expect(verifySealedBlueprintDirectory(multiple.directoryPath)).rejects.toThrow(
      "one function",
    );

    const invalidLocator = await createSealedBlueprintFixture(await temporaryRoot(), {
      invalidEvidenceLocator: true,
    });
    await expect(verifySealedBlueprintDirectory(invalidLocator.directoryPath)).rejects.toThrow(
      "outside the evidence bytes",
    );
  });

  test("enforces repository agreement while supplementing null Blueprint metadata", async () => {
    const exact = await createSealedBlueprintFixture(await temporaryRoot());
    const verified = await verifySealedBlueprintDirectory(exact.directoryPath);
    expect(() =>
      buildBlueprintReviewSubject(
        verified,
        binding({ repository_url: "https://example.invalid/conflict.git" }),
      ),
    ).toThrow("repository URL conflicts");
    expect(() =>
      buildBlueprintReviewSubject(
        verified,
        binding({ commit_sha: "0123456789abcdef0123456789abcdef01234567" }),
      ),
    ).toThrow("commit conflicts");

    const missingMetadata = await createSealedBlueprintFixture(await temporaryRoot(), {
      commitSha: null,
      repositoryUrl: null,
      sourcePath: null,
    });
    const missingVerified = await verifySealedBlueprintDirectory(missingMetadata.directoryPath);
    const repositoryBinding = binding();
    const subject = buildBlueprintReviewSubject(missingVerified, repositoryBinding);
    const outcome = reviewBlueprintForImport({
      binding: repositoryBinding,
      context: {
        action: "deny",
        reviewedAt: "2026-07-24T09:00:00.000Z",
        reviewerSessionId: "session:BLUEPRINTIMPORT1",
      },
      subject,
      verified: missingVerified,
      workflowId: "workflow:BLUEPRINTIMPORT1",
    });
    expect(subject.source_path).toBeNull();
    expect(outcome.attestation.resolved_repository).toEqual({
      commit_sha: BLUEPRINT_COMMIT_SHA,
      repository_url: BLUEPRINT_REPOSITORY_URL,
      source_realpath: null,
      target_worktree_realpath: "/workspace/openblas",
    });
    expect(
      snapshotVerifiedSealedBlueprint(missingVerified).blueprint.section1_basic_info.repository_url,
    ).toBeNull();
  });
});
