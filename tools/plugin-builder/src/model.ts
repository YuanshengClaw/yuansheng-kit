import { PluginBuilderError } from "./errors";
import type { SelectedManifestV1 } from "./manifest";
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
  readonly manifestSha256: string;
  readonly selected: SelectedManifestV1;
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
  if (resource.manifest.source.kind === "file") {
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
      .sort((left, right) => compareUtf8(left.manifest.id, right.manifest.id))
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
          id: snapshot.manifest.id,
          kind: snapshot.manifest.kind,
          logicalPath: snapshot.manifest.logical_path,
          requires: Object.freeze([...snapshot.manifest.requires].sort(compareUtf8)),
          source: Object.freeze({
            kind: snapshot.manifest.source.kind,
            path: snapshot.manifest.source.path,
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
    manifestSha256: options.manifestSha256,
    platform: Object.freeze({
      artifactName: options.selected.platform.artifact_name,
      configuration,
      id: options.selected.platform.id,
    }),
    plugin: Object.freeze({
      displayName: options.selected.manifest.plugin.display_name,
      id: options.selected.manifest.plugin.id,
    }),
    resources: resolvedResources(options.snapshots),
    async readSource(resourceId, relativePath) {
      return Uint8Array.from(findSnapshotFile(options.snapshots, resourceId, relativePath).bytes);
    },
  };
  return Object.freeze(assembly);
}
