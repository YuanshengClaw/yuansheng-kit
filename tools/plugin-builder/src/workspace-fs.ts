import { constants, type Stats } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { PluginBuilderError } from "./errors";
import { isPathWithin, resolveInsideRoot } from "./paths";
import type { SourceFileMode } from "./platform-handler";

const PROC_SELF_FD = "/proc/self/fd";

export interface AnchoredHandle {
  readonly canonicalPath: string;
  readonly handle: FileHandle;
}

export interface StableFileRead {
  readonly bytes: Uint8Array;
  readonly mode: SourceFileMode;
}

function procFileDescriptorPath(handle: FileHandle): string {
  return join(PROC_SELF_FD, String(handle.fd));
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sourceOpenError(label: string, cause: unknown): PluginBuilderError {
  const errorCode = (cause as NodeJS.ErrnoException).code;
  if (errorCode === "ELOOP") {
    return new PluginBuilderError(
      "source-outside-workspace",
      "input",
      `${label} traverses a symbolic link`,
      { cause },
    );
  }
  return new PluginBuilderError("source-missing", "input", `${label} cannot be opened`, {
    cause,
  });
}

export async function readStableOpenFile(
  anchored: AnchoredHandle,
  label: string,
): Promise<StableFileRead> {
  const before = await anchored.handle.stat();
  if (!before.isFile()) {
    throw new PluginBuilderError(
      "source-type-forbidden",
      "input",
      `${label} is not a regular file`,
    );
  }
  const buffer = await anchored.handle.readFile();
  const after = await anchored.handle.stat();
  if (!sameFileIdentity(before, after) || buffer.byteLength !== after.size) {
    throw new PluginBuilderError("source-changed", "input", `${label} changed while it was read`);
  }
  return {
    bytes: Uint8Array.from(buffer),
    mode: (before.mode & 0o111) === 0 ? "0644" : "0755",
  };
}

export class WorkspaceReader {
  readonly rootPath: string;
  readonly #rootHandle: FileHandle;

  private constructor(rootPath: string, rootHandle: FileHandle) {
    this.rootPath = rootPath;
    this.#rootHandle = rootHandle;
  }

  static async open(requestedRoot: string): Promise<WorkspaceReader> {
    const absoluteRoot = resolve(requestedRoot);
    let rootHandle: FileHandle;
    try {
      rootHandle = await open(
        absoluteRoot,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
    } catch (cause) {
      throw new PluginBuilderError(
        "workspace-invalid",
        "input",
        "Workspace root cannot be opened as a real directory",
        { cause },
      );
    }

    try {
      const metadata = await rootHandle.stat();
      const canonicalRoot = await realpath(procFileDescriptorPath(rootHandle));
      if (!metadata.isDirectory() || canonicalRoot !== absoluteRoot) {
        throw new PluginBuilderError(
          "workspace-invalid",
          "input",
          "Workspace root must be a canonical real directory",
        );
      }
      return new WorkspaceReader(canonicalRoot, rootHandle);
    } catch (cause) {
      await rootHandle.close().catch(() => undefined);
      if (cause instanceof PluginBuilderError) {
        throw cause;
      }
      throw new PluginBuilderError(
        "workspace-invalid",
        "input",
        "Workspace root identity cannot be verified",
        { cause },
      );
    }
  }

  async close(): Promise<void> {
    await this.#rootHandle.close();
  }

  async openFile(relativePath: string, label: string): Promise<AnchoredHandle> {
    return this.#openRelative(relativePath, label, false);
  }

  async openDirectory(relativePath: string, label: string): Promise<AnchoredHandle> {
    return this.#openRelative(relativePath, label, true);
  }

  async openChildFile(parent: FileHandle, name: string, label: string): Promise<AnchoredHandle> {
    return this.#openChild(parent, name, label, false);
  }

  async openChildDirectory(
    parent: FileHandle,
    name: string,
    label: string,
  ): Promise<AnchoredHandle> {
    return this.#openChild(parent, name, label, true);
  }

  directoryPath(handle: FileHandle): string {
    return procFileDescriptorPath(handle);
  }

  async #openRelative(
    relativePath: string,
    label: string,
    directory: boolean,
  ): Promise<AnchoredHandle> {
    resolveInsideRoot(this.rootPath, relativePath, "source-path-invalid", label);
    const segments = relativePath.split("/");
    let parent = this.#rootHandle;
    let ownedParent: FileHandle | undefined;
    try {
      for (const [index, segment] of segments.entries()) {
        const child = await this.#openChild(
          parent,
          segment,
          label,
          index < segments.length - 1 || directory,
        );
        if (ownedParent !== undefined) {
          await ownedParent.close();
        }
        parent = child.handle;
        ownedParent = child.handle;
        if (index === segments.length - 1) {
          return child;
        }
      }
    } catch (cause) {
      await ownedParent?.close().catch(() => undefined);
      throw cause;
    }
    throw new PluginBuilderError("source-missing", "input", `${label} is empty`);
  }

  async #openChild(
    parent: FileHandle,
    name: string,
    label: string,
    directory: boolean,
  ): Promise<AnchoredHandle> {
    const path = join(procFileDescriptorPath(parent), name);
    let handle: FileHandle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY |
          constants.O_NOFOLLOW |
          (directory ? constants.O_DIRECTORY : constants.O_NONBLOCK),
      );
    } catch (cause) {
      throw sourceOpenError(label, cause);
    }
    try {
      const metadata = await handle.stat();
      if ((directory && !metadata.isDirectory()) || (!directory && !metadata.isFile())) {
        throw new PluginBuilderError(
          "source-type-forbidden",
          "input",
          `${label} has an unsupported file type`,
        );
      }
      const canonicalPath = await realpath(procFileDescriptorPath(handle));
      if (!isPathWithin(this.rootPath, canonicalPath)) {
        throw new PluginBuilderError(
          "source-outside-workspace",
          "input",
          `${label} resolves outside the workspace`,
        );
      }
      return { canonicalPath, handle };
    } catch (cause) {
      await handle.close().catch(() => undefined);
      if (cause instanceof PluginBuilderError) {
        throw cause;
      }
      throw sourceOpenError(label, cause);
    }
  }
}
