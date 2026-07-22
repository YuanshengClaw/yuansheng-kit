import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PluginBuilderError, type PluginBuilderErrorCode } from "../src/errors";
import { type ManifestResourceV1, type PluginManifestV1, selectManifest } from "../src/manifest";
import { assertNoTargetConflicts } from "../src/paths";
import { resolveResourceSources } from "../src/sources";
import { WorkspaceReader } from "../src/workspace-fs";

const WORKSPACE_ROOT = resolve(import.meta.dir, "../../..");
const MANIFEST_PATH = resolve(WORKSPACE_ROOT, "plugins/trace/manifest.json");
const UTF8_ENCODER = new TextEncoder();

async function readManifestBytes(): Promise<Uint8Array> {
  return new Uint8Array(await readFile(MANIFEST_PATH));
}

function encodeManifest(manifest: PluginManifestV1): Uint8Array {
  return UTF8_ENCODER.encode(JSON.stringify(manifest));
}

function requireResource(manifest: PluginManifestV1, id: string): ManifestResourceV1 {
  const resource = manifest.resources.find((candidate) => candidate.id === id);
  if (resource === undefined) {
    throw new Error(`Real trace manifest does not declare required resource ${id}`);
  }
  return resource;
}

function replaceResource(
  manifest: PluginManifestV1,
  id: string,
  replacement: (resource: ManifestResourceV1) => ManifestResourceV1,
): PluginManifestV1 {
  requireResource(manifest, id);
  return {
    ...manifest,
    resources: manifest.resources.map((resource) =>
      resource.id === id ? replacement(resource) : resource,
    ),
  };
}

function expectBuilderError(operation: () => unknown, code: PluginBuilderErrorCode): void {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PluginBuilderError);
  if (!(caught instanceof PluginBuilderError)) {
    throw new Error(`Expected PluginBuilderError with code ${code}`);
  }
  expect(caught.code).toBe(code);
}

async function resolveSources(resources: readonly ManifestResourceV1[]) {
  const workspace = await WorkspaceReader.open(WORKSPACE_ROOT);
  try {
    return await resolveResourceSources(workspace, resources);
  } finally {
    await workspace.close();
  }
}

describe("plugin manifest resolution", () => {
  test("resolves the real OpenCode closure without deferred or provenance-only assets", async () => {
    const selected = selectManifest(await readManifestBytes(), "opencode");
    const selectedIds = new Set(selected.resources.map((resource) => resource.id));
    const selectedPaths = selected.resources.map((resource) => resource.source.path);

    expect(selected.manifest.plugin.id).toBe("trace");
    expect(selected.platform.artifact_name).toBe("@yuansheng-kit/opencode-ys-trace");
    for (const required of [
      "opencode-platform-handler",
      "sg2044-hardware-profile",
      "trace-agent",
      "trace-command",
      "trace-workflow",
      "write-root-cause-blueprint-skill",
    ]) {
      expect(selectedIds.has(required)).toBeTrue();
    }

    expect(selectedPaths.some((path) => path.includes("tools/perf-data-validator"))).toBeFalse();
    expect(selectedPaths.some((path) => path.endsWith("/SOURCE.json"))).toBeFalse();
    expect(selectedPaths.some((path) => /pattern/iu.test(path))).toBeFalse();
  });

  test("returns stable graph and platform errors for single-point manifest variants", async () => {
    const real = selectManifest(await readManifestBytes(), "opencode").manifest;
    const duplicateId = requireResource(real, "trace-agent").id;
    const duplicateResource = replaceResource(real, "trace-command", (resource) => ({
      ...resource,
      id: duplicateId,
    }));
    const undeclaredDependency = replaceResource(real, "trace-agent", (resource) => ({
      ...resource,
      requires: [...resource.requires, "missing-resource"],
    }));
    const dependencyCycle = replaceResource(
      real,
      "write-root-cause-blueprint-skill",
      (resource) => ({
        ...resource,
        requires: [...resource.requires, "trace-agent"],
      }),
    );
    const unknownPlatform = {
      ...real,
      platforms: real.platforms.map((platform) =>
        platform.id === "opencode" ? { ...platform, id: "different-platform" } : platform,
      ),
    } satisfies PluginManifestV1;

    for (const [manifest, code] of [
      [duplicateResource, "resource-duplicate"],
      [undeclaredDependency, "resource-undeclared"],
      [dependencyCycle, "resource-cycle"],
      [unknownPlatform, "platform-unknown"],
    ] as const) {
      expectBuilderError(() => selectManifest(encodeManifest(manifest), "opencode"), code);
    }
  });

  test("rejects missing and parent-traversing variants against the real workspace", async () => {
    const real = selectManifest(await readManifestBytes(), "opencode").manifest;
    const traceAgent = requireResource(real, "trace-agent");
    const missingSource: ManifestResourceV1 = {
      ...traceAgent,
      source: {
        ...traceAgent.source,
        path: "plugins/trace/agents/missing-trace-agent.md",
      },
    };
    const escapingSource: ManifestResourceV1 = {
      ...traceAgent,
      source: {
        ...traceAgent.source,
        path: "../outside-workspace.md",
      },
    };

    await expect(resolveSources([missingSource])).rejects.toMatchObject({
      code: "source-missing",
    });
    await expect(resolveSources([escapingSource])).rejects.toMatchObject({
      code: "source-path-invalid",
    });
  });

  test("rejects exact and file-prefix output conflicts", () => {
    for (const paths of [
      ["plugin/index.js", "plugin/index.js"],
      ["plugin/index.js", "plugin/index.js/chunk.js"],
    ]) {
      expectBuilderError(() => assertNoTargetConflicts(paths), "output-path-conflict");
    }
  });
});
