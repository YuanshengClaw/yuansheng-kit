import { SourceTextModule } from "node:vm";

import Ajv2020, { type ErrorObject, type JSONSchemaType } from "ajv/dist/2020";

import configSchema from "../schema/plugin-config-v1.schema.json" with { type: "json" };
import { PluginBuilderError } from "./errors";
import { sha256Hex } from "./json";
import { compareUtf8 } from "./paths";
import type { JsonObject } from "./platform-handler";

export interface PluginConfigSourceV1 {
  readonly kind: "file" | "tree";
  readonly path: string;
}

export interface PluginConfigResourceDefinitionV1 {
  readonly kind: string;
  readonly logicalPath: string;
  readonly requires?: readonly string[];
  readonly source: PluginConfigSourceV1;
}

export interface PluginConfigResourceV1 {
  readonly id: string;
  readonly kind: string;
  readonly logicalPath: string;
  readonly requires: readonly string[];
  readonly source: PluginConfigSourceV1;
}

export interface PluginConfigHandlerV1 {
  readonly apiVersion: 1;
  readonly export: string;
  readonly resource: string;
}

export interface PluginConfigPlatformDefinitionV1 {
  readonly artifactName: string;
  readonly configuration: JsonObject;
  readonly handler: PluginConfigHandlerV1;
  readonly roots: readonly string[];
}

export interface PluginConfigPlatformV1 extends PluginConfigPlatformDefinitionV1 {
  readonly id: string;
}

export interface PluginConfigDefinitionV1 {
  readonly platforms: Readonly<Record<string, PluginConfigPlatformDefinitionV1>>;
  readonly plugin: {
    readonly displayName: string;
    readonly id: string;
  };
  readonly resources: Readonly<Record<string, PluginConfigResourceDefinitionV1>>;
  readonly version: 1;
}

export interface SelectedPluginConfigV1 {
  readonly config: PluginConfigDefinitionV1;
  readonly platform: PluginConfigPlatformV1;
  readonly resources: readonly PluginConfigResourceV1[];
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: false,
  strict: true,
});
const validateConfig = ajv.compile(
  configSchema as unknown as JSONSchemaType<PluginConfigDefinitionV1>,
);

function formatSchemaErrors(errors: readonly ErrorObject[] | null | undefined): string {
  return [...(errors ?? [])]
    .sort((left, right) => {
      const byPath = compareUtf8(left.instancePath, right.instancePath);
      return byPath === 0 ? compareUtf8(left.keyword, right.keyword) : byPath;
    })
    .map((error) => `${error.instancePath || "/"}: ${error.message ?? error.keyword}`)
    .join("; ");
}

function pureDataError(path: string, reason: string): never {
  throw new TypeError(`${path} ${reason}`);
}

function assertPureJsonData(
  value: unknown,
  path = "$",
  activeObjects = new WeakSet<object>(),
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      pureDataError(path, "must be a finite JSON number other than negative zero");
    }
    return;
  }
  if (typeof value !== "object") {
    pureDataError(path, "must contain only JSON values");
  }
  if (activeObjects.has(value)) {
    pureDataError(path, "must not contain a reference cycle");
  }

  activeObjects.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      pureDataError(path, "must not contain symbol properties");
    }

    if (Array.isArray(value)) {
      const arrayPrototype = Object.getPrototypeOf(value);
      const objectPrototype =
        arrayPrototype === null ? null : Object.getPrototypeOf(arrayPrototype);
      if (
        arrayPrototype === null ||
        objectPrototype === null ||
        Object.getPrototypeOf(objectPrototype) !== null
      ) {
        pureDataError(path, "must be a plain JSON array");
      }
      const propertyNames = Object.getOwnPropertyNames(value);
      if (propertyNames.length !== value.length + 1) {
        pureDataError(path, "must be a dense JSON array without extra properties");
      }
      for (let index = 0; index < value.length; index += 1) {
        const property = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          pureDataError(`${path}[${index}]`, "must be an enumerable data property");
        }
        assertPureJsonData(descriptor.value, `${path}[${index}]`, activeObjects);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
      pureDataError(path, "must be a plain JSON object");
    }
    for (const property of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, property);
      const propertyPath = `${path}[${JSON.stringify(property)}]`;
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        pureDataError(propertyPath, "must be an enumerable data property");
      }
      assertPureJsonData(descriptor.value, propertyPath, activeObjects);
    }
  } finally {
    activeObjects.delete(value);
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

function findCycles(resourcesById: ReadonlyMap<string, PluginConfigResourceV1>): void {
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
  resourcesById: ReadonlyMap<string, PluginConfigResourceV1>,
): readonly PluginConfigResourceV1[] {
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

  const resolved: PluginConfigResourceV1[] = [];
  for (const id of [...selected].sort(compareUtf8)) {
    const resource = resourcesById.get(id);
    if (resource === undefined) {
      throw new PluginBuilderError(
        "internal-error",
        "internal",
        `Resolved resource disappeared: ${id}`,
      );
    }
    resolved.push(resource);
  }
  return resolved;
}

export async function loadPluginConfig(bytes: Uint8Array): Promise<unknown> {
  try {
    const source = UTF8_DECODER.decode(bytes);
    const transpiled = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(source);
    const configModule = new SourceTextModule(transpiled, {
      identifier: `yuansheng-plugin-config:${sha256Hex(bytes)}`,
    });
    await configModule.link((specifier) => {
      throw new TypeError(`Plugin configuration must be self-contained: ${specifier}`);
    });
    await configModule.evaluate();
    const exports = Object.keys(configModule.namespace);
    if (
      exports.length !== 1 ||
      exports[0] !== "default" ||
      !("default" in configModule.namespace)
    ) {
      throw new TypeError("Plugin configuration must have exactly one default export");
    }
    return configModule.namespace.default;
  } catch (cause) {
    throw new PluginBuilderError(
      "config-load-failed",
      "input",
      "Plugin configuration module could not be loaded",
      { cause },
    );
  }
}

export function selectPluginConfig(value: unknown, platformId: string): SelectedPluginConfigV1 {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1) {
    throw new PluginBuilderError(
      "config-version-unsupported",
      "input",
      "Plugin configuration version must be 1",
    );
  }
  let isValid: boolean;
  try {
    assertPureJsonData(value);
    isValid = validateConfig(value);
  } catch (cause) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    throw new PluginBuilderError(
      "config-schema-invalid",
      "input",
      `Plugin configuration could not be validated as pure JSON data${detail}`,
      { cause },
    );
  }
  if (!isValid) {
    throw new PluginBuilderError(
      "config-schema-invalid",
      "input",
      `Plugin configuration does not match Schema: ${formatSchemaErrors(validateConfig.errors)}`,
    );
  }

  const config = value as PluginConfigDefinitionV1;
  const resources = Object.entries(config.resources)
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(
      ([id, resource]): PluginConfigResourceV1 =>
        Object.freeze({
          id,
          kind: resource.kind,
          logicalPath: resource.logicalPath,
          requires: Object.freeze([...(resource.requires ?? [])]),
          source: Object.freeze({ ...resource.source }),
        }),
    );
  const resourcesById = new Map(resources.map((resource) => [resource.id, resource]));

  for (const resource of resources) {
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

  const platformDefinition = config.platforms[platformId];
  if (platformDefinition === undefined) {
    throw new PluginBuilderError(
      "platform-unknown",
      "input",
      `Plugin configuration does not declare platform ${platformId}`,
    );
  }
  assertUniqueReferences(platformDefinition.roots, `Platform ${platformId} roots`);
  const handlerResource = resourcesById.get(platformDefinition.handler.resource);
  if (handlerResource === undefined) {
    throw new PluginBuilderError(
      "resource-undeclared",
      "input",
      `Platform handler resource is not declared: ${platformDefinition.handler.resource}`,
    );
  }
  if (handlerResource.source.kind !== "file") {
    throw new PluginBuilderError(
      "handler-contract-invalid",
      "handler",
      "Platform handler resource must be a single source file",
    );
  }

  const platform = Object.freeze({
    ...platformDefinition,
    id: platformId,
  });
  return {
    config,
    platform,
    resources: resolveClosure([...platform.roots, platform.handler.resource], resourcesById),
  };
}
