import type { Dirent } from "node:fs";
import { type FileHandle, readdir } from "node:fs/promises";

import type { PluginConfigResourceV1 } from "./config";
import { PluginBuilderError } from "./errors";
import { canonicalJsonBytes, sha256Hex } from "./json";
import { assertSafeRelativePosixPath, compareUtf8 } from "./paths";
import type { JsonValue, SourceFileMode } from "./platform-handler";
import { readStableOpenFile, type WorkspaceReader } from "./workspace-fs";

export interface SourceFileSnapshot {
  readonly bytes: Uint8Array;
  readonly mode: SourceFileMode;
  readonly relativePath: string;
  readonly sha256: string;
}

export interface SourceResourceSnapshot {
  readonly absoluteRoot: string;
  readonly files: readonly SourceFileSnapshot[];
  readonly config: PluginConfigResourceV1;
  readonly sourceSha256: string;
}

function sourceError(
  code: "source-missing" | "source-type-forbidden" | "source-changed",
  message: string,
  cause?: unknown,
): PluginBuilderError {
  return new PluginBuilderError(
    code,
    "input",
    message,
    cause === undefined ? undefined : { cause },
  );
}

async function readTree(
  workspace: WorkspaceReader,
  directoryHandle: FileHandle,
  relativeDirectory = "",
): Promise<readonly SourceFileSnapshot[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(workspace.directoryPath(directoryHandle), { withFileTypes: true });
  } catch (cause) {
    throw sourceError("source-missing", `Source tree cannot be read: ${relativeDirectory}`, cause);
  }
  entries.sort((left, right) => compareUtf8(left.name, right.name));

  const files: SourceFileSnapshot[] = [];
  for (const entry of entries) {
    const relativePath =
      relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
    assertSafeRelativePosixPath(
      relativePath,
      "source-path-invalid",
      `Source tree entry ${relativePath}`,
    );
    if (entry.isSymbolicLink()) {
      throw new PluginBuilderError(
        "source-outside-workspace",
        "input",
        `Source tree contains a symbolic link: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      const child = await workspace.openChildDirectory(
        directoryHandle,
        entry.name,
        `Source tree entry ${relativePath}`,
      );
      try {
        files.push(...(await readTree(workspace, child.handle, relativePath)));
      } finally {
        await child.handle.close();
      }
      continue;
    }
    if (!entry.isFile()) {
      throw sourceError(
        "source-type-forbidden",
        `Source tree contains a non-regular file: ${relativePath}`,
      );
    }
    const child = await workspace.openChildFile(
      directoryHandle,
      entry.name,
      `Source tree entry ${relativePath}`,
    );
    try {
      const stable = await readStableOpenFile(child, `Source tree entry ${relativePath}`);
      files.push({
        bytes: stable.bytes,
        mode: stable.mode,
        relativePath,
        sha256: sha256Hex(stable.bytes),
      });
    } finally {
      await child.handle.close();
    }
  }
  return files;
}

function treeHash(files: readonly SourceFileSnapshot[]): string {
  const inventory = files.map(
    (file) =>
      ({
        bytes: String(file.bytes.byteLength),
        mode: file.mode,
        path: file.relativePath,
        sha256: file.sha256,
      }) satisfies JsonValue,
  );
  return sha256Hex(canonicalJsonBytes(inventory));
}

async function readResource(
  workspace: WorkspaceReader,
  resource: PluginConfigResourceV1,
): Promise<SourceResourceSnapshot> {
  const sourceLabel = `Resource ${resource.id} source`;
  let files: readonly SourceFileSnapshot[];
  let sourceSha256: string;
  let sourceRoot: string;

  if (resource.source.kind === "file") {
    const anchored = await workspace.openFile(resource.source.path, sourceLabel);
    sourceRoot = anchored.canonicalPath;
    try {
      const stable = await readStableOpenFile(anchored, sourceLabel);
      const file = {
        bytes: stable.bytes,
        mode: stable.mode,
        relativePath: "",
        sha256: sha256Hex(stable.bytes),
      } satisfies SourceFileSnapshot;
      files = [file];
      sourceSha256 = file.sha256;
    } finally {
      await anchored.handle.close();
    }
  } else {
    const anchored = await workspace.openDirectory(resource.source.path, sourceLabel);
    sourceRoot = anchored.canonicalPath;
    try {
      files = await readTree(workspace, anchored.handle);
      sourceSha256 = treeHash(files);
    } finally {
      await anchored.handle.close();
    }
  }

  return { absoluteRoot: sourceRoot, config: resource, files, sourceSha256 };
}

export async function resolveResourceSources(
  workspace: WorkspaceReader,
  resources: readonly PluginConfigResourceV1[],
): Promise<ReadonlyMap<string, SourceResourceSnapshot>> {
  const entries: [string, SourceResourceSnapshot][] = [];
  for (const resource of resources) {
    entries.push([resource.id, await readResource(workspace, resource)]);
  }
  return new Map(entries);
}

export async function verifyResourceSources(
  workspace: WorkspaceReader,
  snapshots: ReadonlyMap<string, SourceResourceSnapshot>,
): Promise<void> {
  for (const [resourceId, snapshot] of [...snapshots].sort(([left], [right]) =>
    compareUtf8(left, right),
  )) {
    const current = await readResource(workspace, snapshot.config);
    const currentInventory = current.files.map((file) => [
      file.relativePath,
      file.mode,
      file.sha256,
      String(file.bytes.byteLength),
    ]);
    const snapshotInventory = snapshot.files.map((file) => [
      file.relativePath,
      file.mode,
      file.sha256,
      String(file.bytes.byteLength),
    ]);
    if (
      current.sourceSha256 !== snapshot.sourceSha256 ||
      JSON.stringify(currentInventory) !== JSON.stringify(snapshotInventory)
    ) {
      throw sourceError("source-changed", `Source changed after resolution: ${resourceId}`);
    }
  }
}
