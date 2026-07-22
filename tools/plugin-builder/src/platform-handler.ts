export type JsonPrimitive = boolean | null | number | string;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type SourceFileMode = "0644" | "0755";

export type PosixFileModeV1 = SourceFileMode;

export interface ResolvedPluginV1 {
  readonly displayName: string;
  readonly id: string;
}

export interface ResolvedPlatformV1 {
  readonly artifactName: string;
  readonly configuration: unknown;
  readonly id: string;
}

export interface ResolvedResourceSourceV1 {
  readonly kind: "file" | "tree";
  readonly path: string;
  readonly sha256: string;
}

export interface ResolvedSourceFileV1 {
  readonly bytes: string;
  readonly mode: PosixFileModeV1;
  readonly relativePath: string;
  readonly sha256: string;
}

export interface ResolvedResourceV1 {
  readonly files: readonly ResolvedSourceFileV1[];
  readonly id: string;
  readonly kind: string;
  readonly logicalPath: string;
  readonly requires: readonly string[];
  readonly source: ResolvedResourceSourceV1;
}

/**
 * A validated resource closure issued by the plugin builder.
 *
 * For a file resource, the only valid relative path is the empty string. Tree
 * resources use normalized, non-empty POSIX paths relative to their source root.
 * The accessor rejects resources and paths outside this resolved closure.
 */
export interface ResolvedAssemblyV1 {
  readonly apiVersion: 1;
  readonly bunLockSha256: string;
  readonly manifestSha256: string;
  readonly platform: ResolvedPlatformV1;
  readonly plugin: ResolvedPluginV1;
  readonly resources: readonly ResolvedResourceV1[];
  readSource(resourceId: string, relativePath: string): Promise<Uint8Array>;
}

export interface CopyResourceOutputV1 {
  readonly destination: string;
  readonly resourceId: string;
  readonly type: "copy-resource";
}

export interface GeneratedFileOutputV1 {
  readonly bytes: Uint8Array;
  readonly mode: PosixFileModeV1;
  readonly path: string;
  readonly type: "generated-file";
}

export type PlatformOutputV1 = CopyResourceOutputV1 | GeneratedFileOutputV1;

export interface PlatformAssemblyPlanV1 {
  readonly outputs: readonly PlatformOutputV1[];
}

export interface PlatformHandlerV1 {
  readonly apiVersion: 1;
  readonly platform: string;
  /**
   * Handler modules are evaluated from their verified source bytes and must be
   * self-contained at runtime. Type-only imports are removed before evaluation.
   */
  assemble(assembly: ResolvedAssemblyV1): Promise<PlatformAssemblyPlanV1>;
}
