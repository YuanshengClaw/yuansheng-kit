import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const READ_NOFOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;
const WRITE_EXCLUSIVE_NOFOLLOW =
  constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY;

export interface FilesystemIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface DirectoryAnchor {
  readonly identity: FilesystemIdentity;
  readonly realpath: string;
}

export interface OwnedFile {
  readonly bytes: Uint8Array;
  readonly identity: FilesystemIdentity;
  readonly path: string;
}

export class StorePathError extends Error {
  readonly code = "STORE_PATH_UNSAFE";

  constructor(message: string) {
    super(`STORE_PATH_UNSAFE: ${message}`);
    this.name = "StorePathError";
  }
}

export async function anchorExistingDirectory(path: string): Promise<DirectoryAnchor> {
  if (!isAbsolute(path)) {
    throw new StorePathError("Store root must be an absolute path");
  }
  const resolved = await realpath(path);
  if (resolved !== path) {
    throw new StorePathError("Store root must be supplied as its canonical realpath");
  }
  const handle = await openDirectoryNoFollow(path);
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isDirectory()) {
      throw new StorePathError("Store root must be a regular directory");
    }
    return {
      identity: identityOf(stats),
      realpath: resolved,
    };
  } finally {
    await handle.close();
  }
}

export async function assertDirectoryAnchor(path: string, anchor: DirectoryAnchor): Promise<void> {
  const handle = await openDirectoryNoFollow(path);
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isDirectory() || !sameIdentity(identityOf(stats), anchor.identity)) {
      throw new StorePathError(`Directory identity changed: ${path}`);
    }
  } finally {
    await handle.close();
  }
  if ((await realpath(path)) !== anchor.realpath) {
    throw new StorePathError(`Directory realpath changed: ${path}`);
  }
}

export async function ensureAnchoredChildDirectory(
  parentPath: string,
  parent: DirectoryAnchor,
  name: string,
): Promise<DirectoryAnchor> {
  assertSafeSegment(name);
  await assertDirectoryAnchor(parentPath, parent);
  const childPath = join(parentPath, name);
  try {
    await mkdir(childPath, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (!hasCode(error, "EEXIST")) {
      throw error;
    }
  }
  await assertDirectoryAnchor(parentPath, parent);
  return anchorChildDirectory(parentPath, parent, childPath);
}

export async function createAnchoredChildDirectoryExclusive(
  parentPath: string,
  parent: DirectoryAnchor,
  name: string,
): Promise<DirectoryAnchor> {
  assertSafeSegment(name);
  await assertDirectoryAnchor(parentPath, parent);
  const childPath = join(parentPath, name);
  await mkdir(childPath, { mode: DIRECTORY_MODE });
  await fsyncDirectory(parentPath, parent);
  await assertDirectoryAnchor(parentPath, parent);
  return anchorChildDirectory(parentPath, parent, childPath);
}

export async function readRegularFileNoFollow(
  path: string,
  parentPath: string,
  parent: DirectoryAnchor,
): Promise<Uint8Array> {
  assertDirectChild(path, parentPath);
  await assertDirectoryAnchor(parentPath, parent);
  const handle = await open(path, READ_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new StorePathError(`Expected a regular file: ${path}`);
    }
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || !sameIdentity(identityOf(before), identityOf(after))) {
      throw new StorePathError(`File identity changed while reading: ${path}`);
    }
    await assertDirectoryAnchor(parentPath, parent);
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function claimRegularFile(
  path: string,
  parentPath: string,
  parent: DirectoryAnchor,
): Promise<OwnedFile> {
  assertDirectChild(path, parentPath);
  await assertDirectoryAnchor(parentPath, parent);
  const handle = await open(path, READ_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new StorePathError(`Expected a regular file: ${path}`);
    }
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat({ bigint: true });
    const identity = identityOf(before);
    if (!after.isFile() || !sameIdentity(identity, identityOf(after))) {
      throw new StorePathError(`File identity changed while claiming: ${path}`);
    }
    await assertDirectoryAnchor(parentPath, parent);
    return { bytes, identity, path };
  } finally {
    await handle.close();
  }
}

export async function readRegularFileIfPresent(
  path: string,
  parentPath: string,
  parent: DirectoryAnchor,
): Promise<Uint8Array | null> {
  try {
    return await readRegularFileNoFollow(path, parentPath, parent);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

export async function writeFileExclusive(
  path: string,
  bytes: Uint8Array,
  parentPath: string,
  parent: DirectoryAnchor,
): Promise<OwnedFile> {
  assertDirectChild(path, parentPath);
  await assertDirectoryAnchor(parentPath, parent);
  const handle = await open(path, WRITE_EXCLUSIVE_NOFOLLOW, FILE_MODE);
  let identity: FilesystemIdentity;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) {
      throw new StorePathError(`Exclusive file is not regular: ${path}`);
    }
    identity = identityOf(stats);
  } finally {
    await handle.close();
  }
  await fsyncDirectory(parentPath, parent);
  await assertFileIdentity(path, identity);
  return { bytes, identity, path };
}

export async function writeImmutableFile(
  path: string,
  bytes: Uint8Array,
  parentPath: string,
  parent: DirectoryAnchor,
): Promise<void> {
  assertDirectChild(path, parentPath);
  const existing = await readRegularFileIfPresent(path, parentPath, parent);
  if (existing !== null) {
    if (!equalBytes(existing, bytes)) {
      throw new StorePathError(`Immutable file collision: ${path}`);
    }
    return;
  }

  const stagePath = stageName(path);
  const stage = await writeFileExclusive(stagePath, bytes, parentPath, parent);
  try {
    await assertDirectoryAnchor(parentPath, parent);
    try {
      await link(stagePath, path);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
      const raced = await readRegularFileNoFollow(path, parentPath, parent);
      if (!equalBytes(raced, bytes)) {
        throw new StorePathError(`Immutable file collision after concurrent create: ${path}`);
      }
      return;
    }
    await assertFileIdentity(path, stage.identity);
    await fsyncDirectory(parentPath, parent);
  } finally {
    await unlinkOwnedFile(stage, parentPath, parent);
  }
}

export async function atomicReplaceFile(
  path: string,
  bytes: Uint8Array,
  parentPath: string,
  parent: DirectoryAnchor,
): Promise<void> {
  assertDirectChild(path, parentPath);
  const stagePath = stageName(path);
  const stage = await writeFileExclusive(stagePath, bytes, parentPath, parent);
  try {
    const existing = await fileIdentityIfPresent(path, parentPath, parent);
    await assertDirectoryAnchor(parentPath, parent);
    if (existing !== null) {
      await assertFileIdentity(path, existing);
    }
    await rename(stagePath, path);
    await assertFileIdentity(path, stage.identity);
    await fsyncDirectory(parentPath, parent);
    await assertDirectoryAnchor(parentPath, parent);
  } catch (error) {
    try {
      await unlinkOwnedFile(stage, parentPath, parent);
    } catch {
      // Preserve the original failure. A remaining stage is reported by recovery.
    }
    throw error;
  }
}

export async function unlinkOwnedFile(
  owned: OwnedFile,
  parentPath: string,
  parent: DirectoryAnchor,
): Promise<void> {
  assertDirectChild(owned.path, parentPath);
  const current = await fileIdentityIfPresent(owned.path, parentPath, parent);
  if (current === null) {
    return;
  }
  if (!sameIdentity(current, owned.identity)) {
    throw new StorePathError(`Refusing to unlink a replaced file: ${owned.path}`);
  }
  const bytes = await readRegularFileNoFollow(owned.path, parentPath, parent);
  if (!equalBytes(bytes, owned.bytes)) {
    throw new StorePathError(`Refusing to unlink a modified file: ${owned.path}`);
  }
  await unlink(owned.path);
  await fsyncDirectory(parentPath, parent);
}

export async function listDirectoryNames(
  path: string,
  anchor: DirectoryAnchor,
): Promise<readonly string[]> {
  await assertDirectoryAnchor(path, anchor);
  const entries = await readdir(path, { withFileTypes: true });
  await assertDirectoryAnchor(path, anchor);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new StorePathError(
        `Symbolic links are forbidden in the Store: ${join(path, entry.name)}`,
      );
    }
  }
  return entries.map((entry) => entry.name).sort();
}

export async function anchorChildDirectory(
  parentPath: string,
  parent: DirectoryAnchor,
  childPath: string,
): Promise<DirectoryAnchor> {
  assertDirectChild(childPath, parentPath);
  await assertDirectoryAnchor(parentPath, parent);
  const childRealpath = await realpath(childPath);
  if (childRealpath !== childPath || !isWithin(parent.realpath, childRealpath)) {
    throw new StorePathError(`Child directory escapes its anchored parent: ${childPath}`);
  }
  const handle = await openDirectoryNoFollow(childPath);
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isDirectory()) {
      throw new StorePathError(`Expected a directory: ${childPath}`);
    }
    await assertDirectoryAnchor(parentPath, parent);
    return {
      identity: identityOf(stats),
      realpath: childRealpath,
    };
  } finally {
    await handle.close();
  }
}

export function isMissingPathError(error: unknown): boolean {
  return hasCode(error, "ENOENT");
}

export function isExistingPathError(error: unknown): boolean {
  return hasCode(error, "EEXIST");
}

function stageName(path: string): string {
  return join(dirname(path), `.${basename(path)}.${randomUUID()}.stage`);
}

async function fileIdentityIfPresent(
  path: string,
  parentPath: string,
  parent: DirectoryAnchor,
): Promise<FilesystemIdentity | null> {
  assertDirectChild(path, parentPath);
  await assertDirectoryAnchor(parentPath, parent);
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(path, { bigint: true });
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new StorePathError(`Expected a regular non-symlink file: ${path}`);
  }
  return identityOf(stats);
}

async function assertFileIdentity(path: string, expected: FilesystemIdentity): Promise<void> {
  const stats = await lstat(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || !sameIdentity(identityOf(stats), expected)) {
    throw new StorePathError(`File identity changed: ${path}`);
  }
}

async function fsyncDirectory(path: string, anchor: DirectoryAnchor): Promise<void> {
  const handle = await openDirectoryNoFollow(path);
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isDirectory() || !sameIdentity(identityOf(stats), anchor.identity)) {
      throw new StorePathError(`Directory identity changed before fsync: ${path}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function openDirectoryNoFollow(path: string): Promise<FileHandle> {
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

function identityOf(stats: { readonly dev: bigint; readonly ino: bigint }): FilesystemIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
  };
}

function sameIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertSafeSegment(value: string): void {
  if (!SAFE_SEGMENT.test(value) || value === "." || value === "..") {
    throw new StorePathError(`Unsafe Store path segment: ${JSON.stringify(value)}`);
  }
}

function assertDirectChild(path: string, parentPath: string): void {
  if (dirname(path) !== parentPath || basename(path) === "." || basename(path) === "..") {
    throw new StorePathError(`Path is not a direct anchored child: ${path}`);
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: unknown }).code === code
  );
}
