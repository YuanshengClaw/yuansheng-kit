import { describe, expect, test } from "bun:test";

import {
  ARTIFACT_ENTRY_ORDER,
  ARTIFACT_FILE_ENTRY_FIELDS,
  ARTIFACT_HASH_CONTRACT,
  ARTIFACT_JSON_CONTRACT,
  ARTIFACT_MANIFEST_FIELDS,
  ARTIFACT_MANIFEST_NAME,
  ARTIFACT_PATH_CONTRACT,
  type ArtifactManifest,
  BUILD_RECEIPT_FIELDS,
  BUILDER_CONTRACT_VERSION,
  BUILDER_EXIT_CODES,
  BUILDER_SUBCOMMAND,
  type BuildReceipt,
  compareArtifactPaths,
  isArtifactContentPath,
  isArtifactRelativePath,
  isCanonicalByteCount,
  isPosixFileMode,
  isSha256Hex,
  RECEIPT_OUTPUT_CONTRACT,
  REQUIRED_BUILD_OPTIONS,
  SUPPORTED_BUN_VERSION,
} from "../src/cli-contract";

const TRACE_PACKAGE_NAME = "@yuansheng-kit/opencode-ys-trace";
const SHA256_EXAMPLE = "a".repeat(64);

describe("plugin-builder CLI contract", () => {
  test("freezes the task 2 command surface", () => {
    expect(BUILDER_CONTRACT_VERSION).toBe(1);
    expect(SUPPORTED_BUN_VERSION).toBe("1.3.13");
    expect(BUILDER_SUBCOMMAND).toBe("build");
    expect(REQUIRED_BUILD_OPTIONS).toEqual([
      "--workspace-root",
      "--manifest",
      "--platform",
      "--output",
    ]);
  });

  test("reserves stable result boundaries", () => {
    expect(ARTIFACT_MANIFEST_NAME).toBe("yuansheng-artifact.json");
    expect(BUILDER_EXIT_CODES).toEqual({
      success: 0,
      usage: 2,
      invalidInput: 3,
      outputConflict: 4,
      platformBuildFailure: 5,
      internalError: 70,
    });
  });

  test("freezes the receipt and artifact field allowlists", () => {
    expect(BUILD_RECEIPT_FIELDS).toEqual([
      "contractVersion",
      "packageName",
      "outputDirectory",
      "sourceManifestSha256",
      "contentTreeSha256",
      "artifactManifestSha256",
    ]);
    expect(ARTIFACT_MANIFEST_FIELDS).toEqual([
      "contractVersion",
      "packageName",
      "contentTreeSha256",
      "files",
    ]);
    expect(ARTIFACT_FILE_ENTRY_FIELDS).toEqual(["path", "bytes", "mode", "sha256"]);

    const receipt = {
      contractVersion: BUILDER_CONTRACT_VERSION,
      packageName: TRACE_PACKAGE_NAME,
      outputDirectory: "/tmp/trace",
      sourceManifestSha256: SHA256_EXAMPLE,
      contentTreeSha256: SHA256_EXAMPLE,
      artifactManifestSha256: SHA256_EXAMPLE,
    } satisfies BuildReceipt;
    const artifactManifest = {
      contractVersion: BUILDER_CONTRACT_VERSION,
      packageName: TRACE_PACKAGE_NAME,
      contentTreeSha256: SHA256_EXAMPLE,
      files: [
        {
          path: "plugin/index.js",
          bytes: "42",
          mode: "0644",
          sha256: SHA256_EXAMPLE,
        },
      ],
    } satisfies ArtifactManifest;

    expect(Object.keys(receipt)).toEqual([...BUILD_RECEIPT_FIELDS]);
    expect(Object.keys(artifactManifest)).toEqual([...ARTIFACT_MANIFEST_FIELDS]);
    expect(Object.keys(artifactManifest.files[0] ?? {})).toEqual([...ARTIFACT_FILE_ENTRY_FIELDS]);
    expect(receipt.packageName).toBe(TRACE_PACKAGE_NAME);
    expect(artifactManifest.packageName).toBe(TRACE_PACKAGE_NAME);
  });

  test("freezes the portable content path rules", () => {
    expect(ARTIFACT_PATH_CONTRACT).toEqual({
      representation: "posix-relative",
      separator: "/",
      encoding: "utf-8",
      forbiddenSegments: ["", ".", ".."],
      forbiddenCharacters: ["\\", "\0"],
      excludedPaths: ["yuansheng-artifact.json"],
    });

    for (const path of ["index.js", "agents/分析.md", "skills/trace/😀.md"]) {
      expect(isArtifactRelativePath(path)).toBe(true);
      expect(isArtifactContentPath(path)).toBe(true);
    }

    for (const path of [
      "",
      "/index.js",
      "C:/index.js",
      "C:\\index.js",
      "C:index.js",
      "../index.js",
      "plugin/../index.js",
      "plugin/./index.js",
      "plugin//index.js",
      "plugin/",
      "plugin\\index.js",
      "plugin/\0index.js",
      "plugin/\ud800.md",
      "plugin/\ud800",
      "plugin/\udc00.md",
    ]) {
      expect(isArtifactRelativePath(path)).toBe(false);
      expect(isArtifactContentPath(path)).toBe(false);
    }

    expect(isArtifactRelativePath(ARTIFACT_MANIFEST_NAME)).toBe(true);
    expect(isArtifactContentPath(ARTIFACT_MANIFEST_NAME)).toBe(false);
  });

  test("orders entries by unsigned UTF-8 path bytes", () => {
    expect(ARTIFACT_ENTRY_ORDER).toEqual({
      key: "path",
      encoding: "utf-8",
      direction: "ascending",
      comparison: "unsigned-byte-lexicographic",
      duplicatePaths: "forbidden",
    });

    const paths = ["中.md", "z.md", "ä.md", "a/β.md", "a/a.md", "😀.md"];
    expect([...paths].sort(compareArtifactPaths)).toEqual([
      "a/a.md",
      "a/β.md",
      "z.md",
      "ä.md",
      "中.md",
      "😀.md",
    ]);
  });

  test("freezes canonical JSON and hash inputs", () => {
    expect(ARTIFACT_HASH_CONTRACT).toEqual({
      algorithm: "sha256",
      digestEncoding: "lowercase-hex",
      sourceManifestInput: "exact-source-manifest-bytes",
      contentTreeInput: "rfc8785-jcs-utf8-file-entry-array",
      artifactManifestInput: "exact-rfc8785-jcs-utf8-artifact-manifest-bytes",
    });
    expect(ARTIFACT_JSON_CONTRACT).toEqual({
      serialization: "rfc8785-jcs",
      encoding: "utf-8",
      byteCountEncoding: "canonical-unsigned-decimal-string",
      modeEncoding: "four-digit-posix-octal-string",
      forbiddenMetadata: ["timestamp", "absolutePath", "hostname", "host"],
    });
    expect(RECEIPT_OUTPUT_CONTRACT).toEqual({
      stream: "stdout",
      format: "single-line-json",
      terminator: "lf",
      diagnosticsStream: "stderr",
    });

    expect(isSha256Hex(SHA256_EXAMPLE)).toBe(true);
    expect(isSha256Hex("A".repeat(64))).toBe(false);
    expect(isSha256Hex(`sha256:${SHA256_EXAMPLE}`)).toBe(false);
    expect(isSha256Hex("a".repeat(63))).toBe(false);

    for (const bytes of ["0", "1", "42", "9007199254740992"]) {
      expect(isCanonicalByteCount(bytes)).toBe(true);
    }
    for (const bytes of ["", "00", "01", "-1", "+1", "1.0"]) {
      expect(isCanonicalByteCount(bytes)).toBe(false);
    }

    for (const mode of ["0000", "0644", "0755", "0777"]) {
      expect(isPosixFileMode(mode)).toBe(true);
    }
    for (const mode of ["644", "0o644", "0844", "10644", "-0644"]) {
      expect(isPosixFileMode(mode)).toBe(false);
    }
  });

  test("forbids volatile and host-specific artifact metadata", () => {
    const artifactFields = [...ARTIFACT_MANIFEST_FIELDS, ...ARTIFACT_FILE_ENTRY_FIELDS];

    for (const forbiddenField of ARTIFACT_JSON_CONTRACT.forbiddenMetadata) {
      expect(artifactFields).not.toContain(forbiddenField);
    }
    expect(artifactFields).not.toContain("outputDirectory");
  });
});
