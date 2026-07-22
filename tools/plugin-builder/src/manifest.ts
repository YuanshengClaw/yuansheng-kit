import Ajv2020, { type ErrorObject, type JSONSchemaType } from "ajv/dist/2020";

import manifestSchema from "../schema/plugin-manifest-v1.schema.json" with { type: "json" };
import { PluginBuilderError } from "./errors";
import { parseStrictJsonBytes } from "./json";
import { compareUtf8 } from "./paths";
import type { JsonObject } from "./platform-handler";

export interface ManifestSourceV1 {
  readonly kind: "file" | "tree";
  readonly path: string;
  readonly sha256: string;
}

export interface ManifestResourceV1 {
  readonly id: string;
  readonly kind: string;
  readonly logical_path: string;
  readonly requires: readonly string[];
  readonly source: ManifestSourceV1;
}

export interface ManifestHandlerV1 {
  readonly api_version: 1;
  readonly export: string;
  readonly resource: string;
}

export interface ManifestPlatformV1 {
  readonly artifact_name: string;
  readonly configuration: JsonObject;
  readonly handler: ManifestHandlerV1;
  readonly id: string;
  readonly roots: readonly string[];
}

export interface PluginManifestV1 {
  readonly $schema?: string;
  readonly manifest_version: 1;
  readonly platforms: readonly ManifestPlatformV1[];
  readonly plugin: {
    readonly display_name: string;
    readonly id: string;
  };
  readonly resources: readonly ManifestResourceV1[];
}

export interface SelectedManifestV1 {
  readonly manifest: PluginManifestV1;
  readonly platform: ManifestPlatformV1;
  readonly resources: readonly ManifestResourceV1[];
}

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: false,
  strict: true,
});
const validateManifest = ajv.compile(manifestSchema as unknown as JSONSchemaType<PluginManifestV1>);

function formatSchemaErrors(errors: readonly ErrorObject[] | null | undefined): string {
  return [...(errors ?? [])]
    .sort((left, right) => {
      const byPath = compareUtf8(left.instancePath, right.instancePath);
      return byPath === 0 ? compareUtf8(left.keyword, right.keyword) : byPath;
    })
    .map((error) => `${error.instancePath || "/"}: ${error.message ?? error.keyword}`)
    .join("; ");
}

function assertUniqueIds<T extends { readonly id: string }>(
  values: readonly T[],
  code: "resource-duplicate" | "platform-duplicate",
  label: string,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) {
      throw new PluginBuilderError(code, "input", `${label} ID is duplicated: ${value.id}`);
    }
    seen.add(value.id);
  }
}

function assertUniqueReferences(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new PluginBuilderError(
        "resource-duplicate",
        "input",
        `${label} contains duplicate reference ${value}`,
      );
    }
    seen.add(value);
  }
}

function findCycles(resourcesById: ReadonlyMap<string, ManifestResourceV1>): void {
  const state = new Map<string, "active" | "complete">();
  const stack: string[] = [];

  const visit = (id: string): void => {
    const currentState = state.get(id);
    if (currentState === "complete") {
      return;
    }
    if (currentState === "active") {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      throw new PluginBuilderError(
        "resource-cycle",
        "input",
        `Resource dependency cycle: ${cycle.join(" -> ")}`,
      );
    }

    const resource = resourcesById.get(id);
    if (resource === undefined) {
      throw new PluginBuilderError(
        "resource-undeclared",
        "input",
        `Resource is not declared: ${id}`,
      );
    }
    state.set(id, "active");
    stack.push(id);
    for (const dependency of [...resource.requires].sort(compareUtf8)) {
      visit(dependency);
    }
    stack.pop();
    state.set(id, "complete");
  };

  for (const id of [...resourcesById.keys()].sort(compareUtf8)) {
    visit(id);
  }
}

function resolveClosure(
  roots: readonly string[],
  resourcesById: ReadonlyMap<string, ManifestResourceV1>,
): readonly ManifestResourceV1[] {
  const selected = new Set<string>();
  const visit = (id: string): void => {
    if (selected.has(id)) {
      return;
    }
    const resource = resourcesById.get(id);
    if (resource === undefined) {
      throw new PluginBuilderError(
        "resource-undeclared",
        "input",
        `Selected resource is not declared: ${id}`,
      );
    }
    selected.add(id);
    for (const dependency of [...resource.requires].sort(compareUtf8)) {
      visit(dependency);
    }
  };
  for (const root of [...roots].sort(compareUtf8)) {
    visit(root);
  }
  return [...selected].sort(compareUtf8).map((id) => resourcesById.get(id) as ManifestResourceV1);
}

export function selectManifest(bytes: Uint8Array, platformId: string): SelectedManifestV1 {
  const value = parseStrictJsonBytes(bytes);
  if (
    typeof value !== "object" ||
    value === null ||
    !("manifest_version" in value) ||
    value.manifest_version !== 1
  ) {
    throw new PluginBuilderError(
      "manifest-version-unsupported",
      "input",
      "Manifest version must be 1",
    );
  }
  if (!validateManifest(value)) {
    throw new PluginBuilderError(
      "manifest-schema-invalid",
      "input",
      `Manifest does not match Schema: ${formatSchemaErrors(validateManifest.errors)}`,
    );
  }

  const manifest = value;
  assertUniqueIds(manifest.resources, "resource-duplicate", "Resource");
  assertUniqueIds(manifest.platforms, "platform-duplicate", "Platform");

  const resourcesById = new Map(manifest.resources.map((resource) => [resource.id, resource]));
  for (const resource of manifest.resources) {
    assertUniqueReferences(resource.requires, `Resource ${resource.id} dependencies`);
    for (const dependency of resource.requires) {
      if (!resourcesById.has(dependency)) {
        throw new PluginBuilderError(
          "resource-undeclared",
          "input",
          `Resource ${resource.id} depends on undeclared resource ${dependency}`,
        );
      }
    }
  }
  findCycles(resourcesById);

  const platform = manifest.platforms.find((candidate) => candidate.id === platformId);
  if (platform === undefined) {
    throw new PluginBuilderError(
      "platform-unknown",
      "input",
      `Manifest does not declare platform ${platformId}`,
    );
  }
  assertUniqueReferences(platform.roots, `Platform ${platform.id} roots`);
  const handlerResource = resourcesById.get(platform.handler.resource);
  if (handlerResource === undefined) {
    throw new PluginBuilderError(
      "resource-undeclared",
      "input",
      `Platform handler resource is not declared: ${platform.handler.resource}`,
    );
  }
  if (handlerResource.source.kind !== "file") {
    throw new PluginBuilderError(
      "handler-contract-invalid",
      "handler",
      "Platform handler resource must be a single source file",
    );
  }

  const resources = resolveClosure([...platform.roots, platform.handler.resource], resourcesById);
  return { manifest, platform, resources };
}
