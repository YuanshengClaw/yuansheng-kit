import type { SelectedPluginConfigV1 } from "./config";
import { PluginBuilderError } from "./errors";
import { assertSafeRelativePosixPath, compareUtf8 } from "./paths";
import type {
  JsonObject,
  JsonValue,
  ResolvedAssemblyV1,
  ResolvedResourceV1,
} from "./platform-handler";
import type { SourceFileSnapshot, SourceResourceSnapshot } from "./sources";

export interface CreateAssemblyOptions {
  readonly bunLockSha256: string;
  readonly configSha256: string;
  readonly selected: SelectedPluginConfigV1;
  readonly snapshots: ReadonlyMap<string, SourceResourceSnapshot>;
}

function freezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeJson(item)));
  }
  if (typeof value === "object" && value !== null) {
    const frozen = Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([key, item]) => [key, freezeJson(item)]),
    );
    return Object.freeze(frozen);
  }
  return value;
}

function findSnapshotFile(
  snapshots: ReadonlyMap<string, SourceResourceSnapshot>,
  resourceId: string,
  relativePath: string,
): SourceFileSnapshot {
  const resource = snapshots.get(resourceId);
  if (resource === undefined) {
    throw new PluginBuilderError(
      "resource-undeclared",
      "input",
      `Resource is outside the resolved closure: ${resourceId}`,
    );
  }
  if (resource.config.source.kind === "file") {
    if (relativePath !== "") {
      throw new PluginBuilderError(
        "resource-undeclared",
        "input",
        `File resource ${resourceId} has no member ${relativePath}`,
      );
    }
  } else {
    assertSafeRelativePosixPath(
      relativePath,
      "source-path-invalid",
      `Resource member ${relativePath}`,
    );
  }
  const file = resource.files.find((candidate) => candidate.relativePath === relativePath);
  if (file === undefined) {
    throw new PluginBuilderError(
      "resource-undeclared",
      "input",
      `Resource member is outside the resolved closure: ${resourceId}/${relativePath}`,
    );
  }
  return file;
}

function resolvedResources(
  snapshots: ReadonlyMap<string, SourceResourceSnapshot>,
): readonly ResolvedResourceV1[] {
  return Object.freeze(
    [...snapshots.values()]
      .sort((left, right) => compareUtf8(left.config.id, right.config.id))
      .map((snapshot) =>
        Object.freeze({
          files: Object.freeze(
            snapshot.files.map((file) =>
              Object.freeze({
                bytes: String(file.bytes.byteLength),
                mode: file.mode,
                relativePath: file.relativePath,
                sha256: file.sha256,
              }),
            ),
          ),
          id: snapshot.config.id,
          kind: snapshot.config.kind,
          logicalPath: snapshot.config.logicalPath,
          requires: Object.freeze([...snapshot.config.requires].sort(compareUtf8)),
          source: Object.freeze({
            kind: snapshot.config.source.kind,
            path: snapshot.config.source.path,
            sha256: snapshot.sourceSha256,
          }),
        }),
      ),
  );
}

export function createResolvedAssembly(options: CreateAssemblyOptions): ResolvedAssemblyV1 {
  const configuration = freezeJson(
    structuredClone(options.selected.platform.configuration) as JsonObject,
  );
  const assembly: ResolvedAssemblyV1 = {
    apiVersion: 1,
    bunLockSha256: options.bunLockSha256,
    configSha256: options.configSha256,
    platform: Object.freeze({
      artifactName: options.selected.platform.artifactName,
      configuration,
      id: options.selected.platform.id,
    }),
    plugin: Object.freeze({
      displayName: options.selected.config.plugin.displayName,
      id: options.selected.config.plugin.id,
    }),
    resources: resolvedResources(options.snapshots),
    async readSource(resourceId, relativePath) {
      return Uint8Array.from(findSnapshotFile(options.snapshots, resourceId, relativePath).bytes);
    },
  };
  return Object.freeze(assembly);
}
