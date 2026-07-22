import { constants, type Stats } from "node:fs";
import {
  chmod,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";

import { PLUGIN_BUILDER_ARTIFACT_MANIFEST } from "./cli-contract";
import { PluginBuilderError } from "./errors";
import { canonicalJsonBytes, sha256Hex } from "./json";
import { assertNoTargetConflicts, assertSafeRelativePosixPath, compareUtf8 } from "./paths";
import type { JsonValue, SourceFileMode } from "./platform-handler";

const NIX_STORE_MARKER = Buffer.from("/nix/store", "utf8");
const PROC_SELF_FD = "/proc/self/fd";

export interface ArtifactOutputFile {
  readonly bytes: Uint8Array;
  readonly mode: SourceFileMode;
  readonly path: string;
}

export interface ArtifactMetadata {
  readonly artifactName: string;
  readonly bunLockSha256: string;
  readonly manifestSha256: string;
  readonly platform: string;
  readonly pluginId: string;
}

export interface CommittedArtifact {
  readonly artifactManifestSha256: string;
  readonly contentTreeSha256: string;
  readonly outputPath: string;
}

interface OutputBoundary {
  readonly anchoredParent: string;
  readonly finalName: string;
  readonly outputPath: string;
  readonly parentHandle: FileHandle;
  readonly parentIdentity: Stats;
  readonly parentPath: string;
}

function outputError(
  code: "output-conflict" | "output-path-invalid" | "output-write-failed" | "output-commit-failed",
  message: string,
  cause?: unknown,
): PluginBuilderError {
  return new PluginBuilderError(
    code,
    "output",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function normalizeFiles(files: readonly ArtifactOutputFile[]): readonly ArtifactOutputFile[] {
  const copies = files.map((file) => {
    assertSafeRelativePosixPath(file.path, "output-path-invalid", `Output path ${file.path}`);
    if (
      file.path === PLUGIN_BUILDER_ARTIFACT_MANIFEST ||
      file.path.startsWith(`${PLUGIN_BUILDER_ARTIFACT_MANIFEST}/`)
    ) {
      throw outputError(
        "output-path-invalid",
        `${PLUGIN_BUILDER_ARTIFACT_MANIFEST} is reserved for the builder`,
      );
    }
    if (Buffer.from(file.bytes).indexOf(NIX_STORE_MARKER) !== -1) {
      throw outputError(
        "output-path-invalid",
        `Output file contains a Nix store path: ${file.path}`,
      );
    }
    return { ...file, bytes: Uint8Array.from(file.bytes) };
  });
  copies.sort((left, right) => compareUtf8(left.path, right.path));
  assertNoTargetConflicts(copies.map((file) => file.path));
  return copies;
}

function createArtifactManifest(
  metadata: ArtifactMetadata,
  files: readonly ArtifactOutputFile[],
): {
  readonly bytes: Uint8Array;
  readonly contentTreeSha256: string;
  readonly sha256: string;
} {
  const records: readonly JsonValue[] = files.map(
    (file) =>
      ({
        bytes: String(file.bytes.byteLength),
        mode: file.mode,
        path: file.path,
        sha256: sha256Hex(file.bytes),
      }) satisfies JsonValue,
  );
  const contentTreeSha256 = sha256Hex(canonicalJsonBytes(records));
  const manifest = {
    artifact_name: metadata.artifactName,
    bun_lock_sha256: metadata.bunLockSha256,
    content_tree_sha256: contentTreeSha256,
    files: records,
    format_version: 1,
    kind: "yuansheng_plugin_artifact",
    platform: metadata.platform,
    plugin_id: metadata.pluginId,
    source_manifest_sha256: metadata.manifestSha256,
  } satisfies JsonValue;
  const bytes = canonicalJsonBytes(manifest);
  return { bytes, contentTreeSha256, sha256: sha256Hex(bytes) };
}

function descriptorPath(handle: FileHandle): string {
  return join(PROC_SELF_FD, String(handle.fd));
}

function sameDirectoryIdentity(left: Stats, right: Stats): boolean {
  return (
    left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino
  );
}

async function openDirectory(path: string, message: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw outputError(
        "output-path-invalid",
        "Output path must not traverse symbolic links",
        cause,
      );
    }
    throw outputError("output-write-failed", message, cause);
  }
}

async function openDirectoryPath(
  requestedPath: string,
  createMissing: boolean,
): Promise<{ readonly handle: FileHandle; readonly identity: Stats }> {
  const absolutePath = resolve(requestedPath);
  const filesystemRoot = parse(absolutePath).root;
  let current = await openDirectory(filesystemRoot, "Filesystem root cannot be opened");
  try {
    const segments = relative(filesystemRoot, absolutePath)
      .split(sep)
      .filter((segment) => segment !== "");
    for (const segment of segments) {
      const childPath = join(descriptorPath(current), segment);
      let child: FileHandle;
      try {
        child = await openDirectory(childPath, "Output parent cannot be opened");
      } catch (cause) {
        const error = cause as PluginBuilderError;
        const errno = (error.cause as NodeJS.ErrnoException | undefined)?.code;
        if (!createMissing || errno !== "ENOENT") {
          throw cause;
        }
        try {
          await mkdir(childPath, { mode: 0o755 });
        } catch (mkdirCause) {
          if ((mkdirCause as NodeJS.ErrnoException).code !== "EEXIST") {
            throw outputError(
              "output-write-failed",
              "Output parent directory cannot be created",
              mkdirCause,
            );
          }
        }
        child = await openDirectory(childPath, "Output parent cannot be opened");
      }
      await current.close();
      current = child;
    }

    const canonicalPath = await realpath(descriptorPath(current));
    if (canonicalPath !== absolutePath) {
      throw outputError("output-path-invalid", "Output path must not traverse symbolic links");
    }
    const identity = await current.stat();
    if (!identity.isDirectory()) {
      throw outputError("output-path-invalid", "Output parent must be a real directory");
    }
    return { handle: current, identity };
  } catch (cause) {
    await current.close().catch(() => undefined);
    throw cause;
  }
}

async function inspectExistingOutput(boundary: OutputBoundary): Promise<void> {
  const destination = join(boundary.anchoredParent, boundary.finalName);
  let handle: FileHandle;
  try {
    handle = await openDirectory(destination, "Output path cannot be inspected");
  } catch (cause) {
    const error = cause as PluginBuilderError;
    const errno = (error.cause as NodeJS.ErrnoException | undefined)?.code;
    if (errno === "ENOENT") {
      return;
    }
    if (error.code === "output-path-invalid") {
      throw outputError("output-conflict", "Output path must be an empty real directory", cause);
    }
    throw cause;
  }
  try {
    const entries = await readdir(descriptorPath(handle));
    if (entries.length !== 0) {
      throw outputError("output-conflict", "Output directory is not empty");
    }
  } finally {
    await handle.close();
  }
}

async function openOutputBoundary(outputPath: string): Promise<OutputBoundary> {
  const resolvedOutput = resolve(outputPath);
  const filesystemRoot = parse(resolvedOutput).root;
  if (resolvedOutput === filesystemRoot) {
    throw outputError("output-path-invalid", "Filesystem root cannot be an output path");
  }
  const parentPath = dirname(resolvedOutput);
  const opened = await openDirectoryPath(parentPath, true);
  const boundary: OutputBoundary = {
    anchoredParent: descriptorPath(opened.handle),
    finalName: basename(resolvedOutput),
    outputPath: resolvedOutput,
    parentHandle: opened.handle,
    parentIdentity: opened.identity,
    parentPath,
  };
  try {
    await inspectExistingOutput(boundary);
    return boundary;
  } catch (cause) {
    await opened.handle.close().catch(() => undefined);
    throw cause;
  }
}

async function assertOutputParentIdentity(boundary: OutputBoundary): Promise<void> {
  let current: { readonly handle: FileHandle; readonly identity: Stats };
  try {
    current = await openDirectoryPath(boundary.parentPath, false);
  } catch (cause) {
    throw outputError("output-commit-failed", "Output parent identity changed", cause);
  }
  try {
    if (!sameDirectoryIdentity(boundary.parentIdentity, current.identity)) {
      throw outputError("output-commit-failed", "Output parent identity changed");
    }
  } finally {
    await current.handle.close();
  }
}

async function writeStagedFile(
  stage: string,
  file: ArtifactOutputFile,
  directories: Set<string>,
): Promise<void> {
  const target = join(stage, ...file.path.split("/"));
  const targetDirectory = dirname(target);
  try {
    await mkdir(targetDirectory, { mode: 0o755, recursive: true });
    let current = targetDirectory;
    while (current !== stage) {
      directories.add(current);
      current = dirname(current);
    }
    const handle = await open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      file.mode === "0755" ? 0o755 : 0o644,
    );
    try {
      await handle.writeFile(file.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(target, file.mode === "0755" ? 0o755 : 0o644);
  } catch (cause) {
    throw outputError("output-write-failed", `Failed to write output file ${file.path}`, cause);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function commitArtifact(
  outputPath: string,
  metadata: ArtifactMetadata,
  requestedFiles: readonly ArtifactOutputFile[],
): Promise<CommittedArtifact> {
  const files = normalizeFiles(requestedFiles);
  const artifact = createArtifactManifest(metadata, files);
  const boundary = await openOutputBoundary(outputPath);
  const finalOutput = join(boundary.anchoredParent, boundary.finalName);
  let stage: string | undefined;
  try {
    try {
      stage = await mkdtemp(join(boundary.anchoredParent, ".yuansheng-plugin-builder-"));
    } catch (cause) {
      throw outputError(
        "output-write-failed",
        "Private staging directory cannot be created",
        cause,
      );
    }

    let committed = false;
    let succeeded = false;
    const directories = new Set<string>();
    try {
      for (const file of files) {
        await writeStagedFile(stage, file, directories);
      }
      await writeStagedFile(
        stage,
        {
          bytes: artifact.bytes,
          mode: "0644",
          path: PLUGIN_BUILDER_ARTIFACT_MANIFEST,
        },
        directories,
      );
      for (const directory of [...directories].sort(compareUtf8)) {
        await chmod(directory, 0o755);
      }
      await chmod(stage, 0o755);
      await syncDirectory(stage);

      await assertOutputParentIdentity(boundary);
      try {
        await rename(stage, finalOutput);
        committed = true;
      } catch (cause) {
        throw outputError(
          "output-commit-failed",
          "Artifact could not be committed atomically",
          cause,
        );
      }
      await assertOutputParentIdentity(boundary);
      await syncDirectory(boundary.anchoredParent).catch(() => undefined);
      succeeded = true;
    } finally {
      if (!succeeded) {
        const cleanupPath = committed ? finalOutput : stage;
        await rm(cleanupPath, { force: true, recursive: true }).catch(() => undefined);
      }
    }
  } finally {
    await boundary.parentHandle.close();
  }

  return {
    artifactManifestSha256: artifact.sha256,
    contentTreeSha256: artifact.contentTreeSha256,
    outputPath: boundary.outputPath,
  };
}
