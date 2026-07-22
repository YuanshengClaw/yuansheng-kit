export const BUILDER_CONTRACT_VERSION = 1 as const;

export const SUPPORTED_BUN_VERSION = "1.3.13" as const;

export const BUILDER_SUBCOMMAND = "build" as const;

export const REQUIRED_BUILD_OPTIONS = [
  "--workspace-root",
  "--manifest",
  "--platform",
  "--output",
] as const;

export const ARTIFACT_MANIFEST_NAME = "yuansheng-artifact.json" as const;

export const BUILD_RECEIPT_FIELDS = [
  "contractVersion",
  "packageName",
  "outputDirectory",
  "sourceManifestSha256",
  "contentTreeSha256",
  "artifactManifestSha256",
] as const;

export const ARTIFACT_MANIFEST_FIELDS = [
  "contractVersion",
  "packageName",
  "contentTreeSha256",
  "files",
] as const;

export const ARTIFACT_FILE_ENTRY_FIELDS = ["path", "bytes", "mode", "sha256"] as const;

export const ARTIFACT_PATH_CONTRACT = {
  representation: "posix-relative",
  separator: "/",
  encoding: "utf-8",
  forbiddenSegments: ["", ".", ".."],
  forbiddenCharacters: ["\\", "\0"],
  excludedPaths: [ARTIFACT_MANIFEST_NAME],
} as const;

export const ARTIFACT_ENTRY_ORDER = {
  key: "path",
  encoding: "utf-8",
  direction: "ascending",
  comparison: "unsigned-byte-lexicographic",
  duplicatePaths: "forbidden",
} as const;

export const ARTIFACT_HASH_CONTRACT = {
  algorithm: "sha256",
  digestEncoding: "lowercase-hex",
  sourceManifestInput: "exact-source-manifest-bytes",
  contentTreeInput: "rfc8785-jcs-utf8-file-entry-array",
  artifactManifestInput: "exact-rfc8785-jcs-utf8-artifact-manifest-bytes",
} as const;

export const ARTIFACT_JSON_CONTRACT = {
  serialization: "rfc8785-jcs",
  encoding: "utf-8",
  byteCountEncoding: "canonical-unsigned-decimal-string",
  modeEncoding: "four-digit-posix-octal-string",
  forbiddenMetadata: ["timestamp", "absolutePath", "hostname", "host"] as const,
} as const;

export const RECEIPT_OUTPUT_CONTRACT = {
  stream: "stdout",
  format: "single-line-json",
  terminator: "lf",
  diagnosticsStream: "stderr",
} as const;

export const BUILDER_EXIT_CODES = {
  success: 0,
  usage: 2,
  invalidInput: 3,
  outputConflict: 4,
  platformBuildFailure: 5,
  internalError: 70,
} as const;

export type BuilderExitCode = (typeof BUILDER_EXIT_CODES)[keyof typeof BUILDER_EXIT_CODES];

export type Sha256Hex = string;
export type ArtifactRelativePath = string;
export type CanonicalByteCount = string;
export type PosixFileMode = string;

export interface ArtifactFileEntry {
  readonly path: ArtifactRelativePath;
  readonly bytes: CanonicalByteCount;
  readonly mode: PosixFileMode;
  readonly sha256: Sha256Hex;
}

export interface ArtifactManifest {
  readonly contractVersion: typeof BUILDER_CONTRACT_VERSION;
  readonly packageName: string;
  readonly contentTreeSha256: Sha256Hex;
  readonly files: readonly ArtifactFileEntry[];
}

export interface BuildReceipt {
  readonly contractVersion: typeof BUILDER_CONTRACT_VERSION;
  readonly packageName: string;
  readonly outputDirectory: string;
  readonly sourceManifestSha256: Sha256Hex;
  readonly contentTreeSha256: Sha256Hex;
  readonly artifactManifestSha256: Sha256Hex;
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const CANONICAL_BYTE_COUNT = /^(?:0|[1-9][0-9]*)$/u;
const POSIX_FILE_MODE = /^0[0-7]{3}$/u;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        return true;
      }
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }

  return false;
}

export function isArtifactRelativePath(value: string): value is ArtifactRelativePath {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    WINDOWS_DRIVE_PATH.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    hasUnpairedSurrogate(value)
  ) {
    return false;
  }

  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isArtifactContentPath(value: string): value is ArtifactRelativePath {
  return isArtifactRelativePath(value) && value !== ARTIFACT_MANIFEST_NAME;
}

export function compareArtifactPaths(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? -1) - (rightBytes[index] ?? -1);
    if (difference !== 0) {
      return difference;
    }
  }

  return leftBytes.length - rightBytes.length;
}

export function isSha256Hex(value: string): value is Sha256Hex {
  return SHA256_HEX.test(value);
}

export function isCanonicalByteCount(value: string): value is CanonicalByteCount {
  return CANONICAL_BYTE_COUNT.test(value);
}

export function isPosixFileMode(value: string): value is PosixFileMode {
  return POSIX_FILE_MODE.test(value);
}
