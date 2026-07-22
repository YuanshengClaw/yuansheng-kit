import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import canonicalize from "canonicalize";

import type { BuildReceiptV1 } from "../../tools/plugin-builder/src/build";
import { PLUGIN_BUILDER_ARTIFACT_MANIFEST } from "../../tools/plugin-builder/src/cli-contract";

const WORKSPACE_ROOT = join(import.meta.dir, "../..");
const MANIFEST_PATH = "plugins/trace/manifest.json";
const PLATFORM = "opencode";
const ARTIFACT_NAME = "@yuansheng-kit/opencode-ys-trace";
const NIX_STORE_MARKER = Buffer.from("/nix/store", "utf8");
const WORKSPACE_MARKER = Buffer.from(WORKSPACE_ROOT, "utf8");
const FIXED_MODEL_MARKER = Buffer.from("deepseek/", "utf8");
const FORBIDDEN_ARTIFACT_PATHS = [
  /(?:^|\/)dist(?:\/|$)/iu,
  /(?:^|\/)execution-summary(?:[./-]|$)/iu,
  /(?:^|\/)install-global\.sh$/iu,
  /(?:^|\/)perf-data-validator(?:\/|$)/iu,
  /(?:^|\/)node_modules(?:\/|$)/iu,
  /(?:^|\/)package\.json$/iu,
  /(?:^|\/)(?:bun\.lockb?|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/iu,
  /(?:^|\/)source\.json$/iu,
  /^\.opencode\/yuansheng\/sources(?:\/|$)/iu,
  /(?:^|\/)pattern(?:\/|$)/iu,
];

type ArtifactFileMode = "0644" | "0755";

interface ArtifactFileSnapshot {
  readonly bytes: Uint8Array;
  readonly mode: ArtifactFileMode;
  readonly path: string;
  readonly sha256: string;
}

interface ArtifactFileRecord {
  readonly bytes: string;
  readonly mode: ArtifactFileMode;
  readonly path: string;
  readonly sha256: string;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBytes(value: unknown): Uint8Array {
  const text = canonicalize(value);
  if (text === undefined) {
    throw new TypeError("Expected a canonical JSON value");
  }
  return new TextEncoder().encode(text);
}

function artifactFileMode(mode: number, path: string): ArtifactFileMode {
  const permissions = mode & 0o777;
  if (permissions === 0o644) {
    return "0644";
  }
  if (permissions === 0o755) {
    return "0755";
  }
  throw new Error(`Artifact file has an unsupported mode ${permissions.toString(8)}: ${path}`);
}

async function enumerateArtifactFiles(root: string): Promise<readonly ArtifactFileSnapshot[]> {
  const rootStatus = await lstat(root);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw new Error("Artifact root must be a real directory");
  }

  const files: ArtifactFileSnapshot[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const relativePath =
        relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const status = await lstat(path);
      if (status.isSymbolicLink()) {
        throw new Error(`Artifact contains a symbolic link: ${relativePath}`);
      }
      if (status.isDirectory()) {
        await visit(path, relativePath);
        continue;
      }
      if (!status.isFile()) {
        throw new Error(`Artifact contains a non-regular file: ${relativePath}`);
      }
      const bytes = Uint8Array.from(await readFile(path));
      files.push({
        bytes,
        mode: artifactFileMode(status.mode, relativePath),
        path: relativePath,
        sha256: sha256(bytes),
      });
    }
  }

  await visit(root, "");
  files.sort((left, right) => compareUtf8(left.path, right.path));
  return files;
}

function artifactRecords(files: readonly ArtifactFileSnapshot[]): readonly ArtifactFileRecord[] {
  return files.map((file) => ({
    bytes: String(file.bytes.byteLength),
    mode: file.mode,
    path: file.path,
    sha256: file.sha256,
  }));
}

function expectIdenticalArtifacts(
  first: readonly ArtifactFileSnapshot[],
  second: readonly ArtifactFileSnapshot[],
): void {
  expect(second.map((file) => file.path)).toEqual(first.map((file) => file.path));
  for (const [index, firstFile] of first.entries()) {
    const secondFile = second[index];
    if (secondFile === undefined) {
      throw new Error(`Second artifact is missing ${firstFile.path}`);
    }
    expect(secondFile.mode).toBe(firstFile.mode);
    expect(secondFile.sha256).toBe(firstFile.sha256);
    expect(Buffer.compare(secondFile.bytes, firstFile.bytes)).toBe(0);
  }
}

async function expectVerifiedArtifact(
  outputPath: string,
  receipt: BuildReceiptV1,
): Promise<readonly ArtifactFileSnapshot[]> {
  const files = await enumerateArtifactFiles(outputPath);
  const artifactManifest = files.find((file) => file.path === PLUGIN_BUILDER_ARTIFACT_MANIFEST);
  if (artifactManifest === undefined) {
    throw new Error(`Artifact is missing ${PLUGIN_BUILDER_ARTIFACT_MANIFEST}`);
  }

  const contentFiles = files.filter((file) => file.path !== PLUGIN_BUILDER_ARTIFACT_MANIFEST);
  const records = artifactRecords(contentFiles);
  const contentTreeSha256 = sha256(canonicalBytes(records));
  const expectedManifest = {
    artifact_name: ARTIFACT_NAME,
    bun_lock_sha256: receipt.bun_lock_sha256,
    content_tree_sha256: contentTreeSha256,
    files: records,
    format_version: 1,
    kind: "yuansheng_plugin_artifact",
    platform: PLATFORM,
    plugin_id: "trace",
    source_manifest_sha256: receipt.manifest_sha256,
  };

  expect(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(artifactManifest.bytes)),
  ).toEqual(expectedManifest);
  expect(Buffer.compare(artifactManifest.bytes, canonicalBytes(expectedManifest))).toBe(0);
  expect(artifactManifest.sha256).toBe(receipt.artifact_manifest_sha256);
  expect(contentTreeSha256).toBe(receipt.content_tree_sha256);
  expect(receipt).toMatchObject({
    artifact_name: ARTIFACT_NAME,
    format_version: 1,
    output: outputPath,
    platform: PLATFORM,
    plugin: "trace",
  });
  expect(receipt.manifest_sha256).toBe(
    sha256(Uint8Array.from(await readFile(join(WORKSPACE_ROOT, MANIFEST_PATH)))),
  );
  expect(receipt.bun_lock_sha256).toBe(
    sha256(Uint8Array.from(await readFile(join(WORKSPACE_ROOT, "bun.lock")))),
  );

  for (const file of files) {
    expect(FORBIDDEN_ARTIFACT_PATHS.some((pattern) => pattern.test(file.path))).toBe(false);
    expect(Buffer.from(file.bytes).indexOf(NIX_STORE_MARKER)).toBe(-1);
    expect(Buffer.from(file.bytes).indexOf(WORKSPACE_MARKER)).toBe(-1);
    expect(Buffer.from(file.bytes).indexOf(FIXED_MODEL_MARKER)).toBe(-1);
  }
  return files;
}

async function temporaryOutput(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ys-trace-plugin-builder-test-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

interface BuilderProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function runBuilder(outputPath: string): Promise<BuilderProcessResult> {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "run",
      "plugin-builder",
      "--",
      "build",
      "--workspace-root",
      ".",
      "--manifest",
      MANIFEST_PATH,
      "--platform",
      PLATFORM,
      "--output",
      outputPath,
    ],
    cwd: WORKSPACE_ROOT,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function buildAt(outputPath: string): Promise<BuildReceiptV1> {
  const result = await runBuilder(outputPath);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.endsWith("\n")).toBeTrue();
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  return JSON.parse(result.stdout) as BuildReceiptV1;
}

describe("Yuansheng Trace plugin build", () => {
  test("reproducibly commits the real OpenCode artifact and preserves an occupied output", async () => {
    const firstOutput = await temporaryOutput("missing-parent/first");
    const secondOutput = await temporaryOutput("second");
    const firstReceipt = await buildAt(firstOutput);
    const secondReceipt = await buildAt(secondOutput);

    const firstFiles = await expectVerifiedArtifact(firstOutput, firstReceipt);
    const secondFiles = await expectVerifiedArtifact(secondOutput, secondReceipt);
    expectIdenticalArtifacts(firstFiles, secondFiles);
    expect(firstFiles.filter((file) => file.path === ".opencode/plugins/ys-trace.js")).toHaveLength(
      1,
    );

    expect(secondReceipt).toEqual({ ...firstReceipt, output: secondOutput });

    const occupiedOutput = await temporaryOutput("occupied");
    await mkdir(occupiedOutput);
    const sentinelPath = join(occupiedOutput, "keep.txt");
    await writeFile(sentinelPath, "unchanged\n");
    await chmod(sentinelPath, 0o644);
    const before = await enumerateArtifactFiles(occupiedOutput);

    const rejected = await runBuilder(occupiedOutput);
    expect(rejected.exitCode).toBe(4);
    expect(rejected.stdout).toBe("");
    expect(rejected.stderr).toContain("output-conflict:");
    expectIdenticalArtifacts(before, await enumerateArtifactFiles(occupiedOutput));
  });
});
