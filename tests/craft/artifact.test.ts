import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPlugin } from "../../tools/plugin-builder/src/build";

const WORKSPACE_ROOT = join(import.meta.dir, "../..");
const CONFIG_PATH = join(WORKSPACE_ROOT, "plugins/craft/plugin.config.ts");
const EXPECTED_FILES = Object.freeze([
  ".opencode/agents/ys-craft-delivery-coordinator.md",
  ".opencode/agents/ys-craft-patch-builder.md",
  ".opencode/agents/ys-craft-patch-planner.md",
  ".opencode/agents/ys-craft-patch-reviewer.md",
  ".opencode/agents/ys-craft-regression-verifier.md",
  ".opencode/agents/ys-craft-root-cause-analyst.md",
  ".opencode/agents/ys-craft.md",
  ".opencode/plugins/ys-craft.js",
  ".opencode/skills/ys-craft-verification-source-selection/SKILL.md",
  ".opencode/skills/ys-craft-workflow-coordination/SKILL.md",
]);
const FORBIDDEN_ARTIFACT_CONTENT =
  /(?:causaforge|\/nix\/store|\/home\/bingshan|node_modules|packages\/causaforge|\.workflow(?:\/|\\))/iu;
const roots: string[] = [];

interface ArtifactFileRecord {
  readonly bytes: string;
  readonly mode: string;
  readonly path: string;
  readonly sha256: string;
}

interface ArtifactManifest {
  readonly artifact_name: string;
  readonly content_tree_sha256: string;
  readonly files: readonly ArtifactFileRecord[];
  readonly format_version: number;
  readonly kind: string;
  readonly platform: string;
  readonly plugin_id: string;
  readonly source_config_sha256: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function buildArtifact(label: string): Promise<{
  readonly manifest: ArtifactManifest;
  readonly manifestBytes: Uint8Array;
  readonly output: string;
  readonly receipt: Awaited<ReturnType<typeof buildPlugin>>;
}> {
  const root = await mkdtemp(join(tmpdir(), `ys-craft-artifact-${label}-`));
  roots.push(root);
  const output = join(root, "opencode-ys-craft");
  const receipt = await buildPlugin({
    configPath: CONFIG_PATH,
    outputPath: output,
    platform: "opencode",
    workspaceRoot: WORKSPACE_ROOT,
  });
  const manifestBytes = await readFile(join(output, "yuansheng-artifact.json"));
  return {
    manifest: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
    manifestBytes,
    output,
    receipt,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test("formal OpenCode Craft artifacts are minimal, deterministic, and host-independent", async () => {
  const first = await buildArtifact("first");
  const second = await buildArtifact("second");

  expect(first.receipt).toMatchObject({
    artifact_name: "opencode-ys-craft",
    format_version: 2,
    platform: "opencode",
    plugin: "craft",
  });
  expect(second.receipt).toMatchObject({
    artifact_manifest_sha256: first.receipt.artifact_manifest_sha256,
    artifact_name: first.receipt.artifact_name,
    bun_lock_sha256: first.receipt.bun_lock_sha256,
    config_sha256: first.receipt.config_sha256,
    content_tree_sha256: first.receipt.content_tree_sha256,
    format_version: first.receipt.format_version,
    platform: first.receipt.platform,
    plugin: first.receipt.plugin,
  });
  expect(first.manifest).toMatchObject({
    artifact_name: "opencode-ys-craft",
    content_tree_sha256: first.receipt.content_tree_sha256,
    format_version: 2,
    kind: "yuansheng_plugin_artifact",
    platform: "opencode",
    plugin_id: "craft",
    source_config_sha256: first.receipt.config_sha256,
  });
  expect(first.manifest.files.map(({ path }) => path)).toEqual([...EXPECTED_FILES]);
  expect(first.receipt.artifact_manifest_sha256).toBe(sha256(first.manifestBytes));

  for (const record of first.manifest.files) {
    const path = join(first.output, record.path);
    const bytes = await readFile(path);
    expect(record).toMatchObject({
      bytes: String(bytes.byteLength),
      mode: "0644",
      sha256: sha256(bytes),
    });
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    expect(FORBIDDEN_ARTIFACT_CONTENT.test(new TextDecoder().decode(bytes))).toBe(false);
  }

  expect(
    first.manifest.files.some(({ path }) =>
      /(?:^|\/)(?:commands|node_modules)(?:\/|$)|(?:^|\/)(?:package\.json|bun\.lockb?)$/u.test(
        path,
      ),
    ),
  ).toBe(false);
  expect((await stat(join(first.output, "yuansheng-artifact.json"))).mode & 0o777).toBe(0o644);
});
