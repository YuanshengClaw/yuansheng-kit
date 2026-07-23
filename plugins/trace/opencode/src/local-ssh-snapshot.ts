import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, parse as parsePath, resolve, sep } from "node:path";

import {
  assertApprovedSshTransportState,
  createSshSnapshotMapping,
  type SshSnapshotMappingEnvelope,
  type SshTransportState,
} from "../../transport/ssh-transport";

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const OBJECT_ID = /^f[0-9]{8}$/u;
const READ_CHUNK_BYTES = 64 * 1024;
const GROUP_OR_OTHER_WRITE_BITS = 0o022n;
const STICKY_BIT = 0o1000n;

type DownloadingSshTransportState = Extract<SshTransportState, { phase: "downloading" }>;
type MaterializedSshTransportState = Extract<SshTransportState, { phase: "staged" }>;
type SnapshotBoundSshTransportState = DownloadingSshTransportState | MaterializedSshTransportState;

export type LocalSshSnapshotErrorCode =
  | "cleanup_residual"
  | "operation_cancelled"
  | "snapshot_mismatch"
  | "staging_unavailable"
  | "state_invalid";

export class LocalSshSnapshotError extends Error {
  constructor(
    readonly code: LocalSshSnapshotErrorCode,
    message: string,
    readonly residualRoot: string | null = null,
  ) {
    super(message);
    this.name = "LocalSshSnapshotError";
  }
}

export interface LocalSshSnapshotHandle {
  readonly kind: "ys_trace_local_ssh_snapshot";
  readonly local_staging_root: string;
  readonly local_tree_root: string;
  readonly plan_sha256: string;
  readonly stage_sha256: string;
}

export type LocalSshSnapshotCleanupResult =
  | Readonly<{
      local_staging_removed: true;
      ok: true;
      residual_paths: readonly [];
    }>
  | Readonly<{
      local_staging_removed: false;
      ok: false;
      residual_paths: readonly [string];
    }>;

interface ExpectedEntry {
  readonly key: string;
  readonly name: Buffer;
  readonly objectId: string | null;
  readonly parentKey: string;
  readonly path: Buffer;
  readonly sha256: string | null;
  readonly size: number;
  readonly type: "directory" | "regular_file";
}

interface ExpectedObject {
  readonly entry: ExpectedEntry;
  readonly id: string;
  readonly nameKey: string;
  readonly sha256: string;
  readonly size: number;
}

interface ExpectedLayout {
  readonly children: ReadonlyMap<string, ReadonlyMap<string, ExpectedEntry>>;
  readonly entries: readonly ExpectedEntry[];
  readonly objects: readonly ExpectedObject[];
  readonly objectsById: ReadonlyMap<string, ExpectedObject>;
  readonly objectsByName: ReadonlyMap<string, ExpectedObject>;
}

type SnapshotPhase = "download_authorized" | "materialized" | "ready" | "residual";

interface SnapshotCapability {
  readonly expected: ExpectedLayout;
  readonly mapping: SshSnapshotMappingEnvelope;
  materializedDirectories?: ReadonlyMap<string, VerifiedFilesystemIdentity>;
  materializedObjects?: ReadonlyMap<string, VerifiedFilesystemIdentity>;
  readonly objectsHandle: FileHandle;
  readonly objectsIdentity: BigIntStats;
  readonly objectsPath: string;
  readonly parentHandle: FileHandle;
  readonly parentIdentity: BigIntStats;
  readonly parentPath: string;
  phase: SnapshotPhase;
  readonly rootEntryPath: string;
  readonly rootHandle: FileHandle;
  readonly rootIdentity: BigIntStats;
  readonly rootPath: string;
  readonly treeHandle: FileHandle;
  readonly treeIdentity: BigIntStats;
  readonly treePath: string;
}

interface VerifiedFilesystemIdentity {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly gid: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly nlink: bigint;
  readonly size: bigint;
  readonly uid: bigint;
}

interface CollectedTreeEntries {
  readonly directories: ExpectedEntry[];
  readonly files: ExpectedEntry[];
}

const SNAPSHOT_CAPABILITIES = new WeakMap<LocalSshSnapshotHandle, SnapshotCapability>();

function fail(
  code: LocalSshSnapshotErrorCode,
  message: string,
  residualRoot: string | null = null,
): never {
  throw new LocalSshSnapshotError(code, message, residualRoot);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function pathStillExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return errorCode(error) !== "ENOENT";
  }
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    fail("operation_cancelled", "The local SSH snapshot operation was cancelled");
  }
}

function descriptorPath(handle: FileHandle): string {
  return join(parsePath(process.execPath).root, "proc", "self", "fd", String(handle.fd));
}

function controllerDescriptorPath(handle: FileHandle): string {
  return join(
    parsePath(process.execPath).root,
    "proc",
    String(process.pid),
    "fd",
    String(handle.fd),
  );
}

function descriptorChildPath(handle: FileHandle, name: string | Uint8Array): Buffer {
  const prefix = Buffer.from(`${descriptorPath(handle)}/`);
  return Buffer.concat([prefix, typeof name === "string" ? Buffer.from(name) : Buffer.from(name)]);
}

function sameDirectoryObject(expected: BigIntStats, actual: BigIntStats): boolean {
  return actual.isDirectory() && expected.dev === actual.dev && expected.ino === actual.ino;
}

function sameRegularFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function verifiedFilesystemIdentity(status: BigIntStats): VerifiedFilesystemIdentity {
  return {
    ctimeNs: status.ctimeNs,
    dev: status.dev,
    gid: status.gid,
    ino: status.ino,
    mode: status.mode,
    mtimeNs: status.mtimeNs,
    nlink: status.nlink,
    size: status.size,
    uid: status.uid,
  };
}

function sameVerifiedFilesystemIdentity(
  left: VerifiedFilesystemIdentity,
  right: VerifiedFilesystemIdentity,
): boolean {
  return (
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.gid === right.gid &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.uid === right.uid
  );
}

function sameObjectStorageIdentity(
  left: VerifiedFilesystemIdentity,
  right: VerifiedFilesystemIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameDirectorySnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameDirectoryObject(left, right) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function hasMode(status: BigIntStats, mode: number): boolean {
  return Number(status.mode & 0o777n) === mode;
}

function effectiveUserId(): bigint {
  const id = process.geteuid?.() ?? process.getuid?.();
  if (id === undefined || !Number.isSafeInteger(id) || id < 0) {
    fail("staging_unavailable", "The local SSH staging owner cannot be determined");
  }
  return BigInt(id);
}

function requireSafeSystemRoot(status: BigIntStats): bigint {
  if (!status.isDirectory() || (status.mode & GROUP_OR_OTHER_WRITE_BITS) !== 0n) {
    fail("staging_unavailable", "The local filesystem root has unsafe write permissions");
  }
  return status.uid;
}

function requireSafeExistingParent(status: BigIntStats, systemOwnerId: bigint): void {
  const userId = effectiveUserId();
  const trustedOwner = status.uid === systemOwnerId || status.uid === userId;
  const writableByAnotherSubject = (status.mode & GROUP_OR_OTHER_WRITE_BITS) !== 0n;
  const protectedSystemTemporaryDirectory =
    status.uid === systemOwnerId && (status.mode & STICKY_BIT) !== 0n;
  if (
    !status.isDirectory() ||
    !trustedOwner ||
    (writableByAnotherSubject && !protectedSystemTemporaryDirectory)
  ) {
    fail(
      "staging_unavailable",
      "A local SSH staging parent has unsafe ownership or write permissions",
    );
  }
}

async function privatizeNewBoundDirectory(
  bound: Readonly<{ handle: FileHandle; identity: BigIntStats }>,
  expectedPath: string,
): Promise<Readonly<{ handle: FileHandle; identity: BigIntStats }>> {
  await bound.handle.chmod(0o700);
  const [opened, located, actualPath] = await Promise.all([
    bound.handle.stat({ bigint: true }),
    lstat(expectedPath, { bigint: true }),
    realpath(descriptorPath(bound.handle)),
  ]);
  if (
    located.isSymbolicLink() ||
    !sameDirectoryObject(bound.identity, opened) ||
    !sameDirectoryObject(opened, located) ||
    opened.uid !== effectiveUserId() ||
    located.uid !== opened.uid ||
    !hasMode(opened, 0o700) ||
    !hasMode(located, 0o700) ||
    actualPath !== expectedPath
  ) {
    fail("staging_unavailable", "A new local SSH staging directory is not privately bound");
  }
  return { handle: bound.handle, identity: opened };
}

async function directoryLocationMatches(
  handle: FileHandle,
  identity: BigIntStats,
  expectedPath: string,
  mode?: number,
): Promise<boolean> {
  try {
    const [opened, located, actualPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(expectedPath, { bigint: true }),
      realpath(descriptorPath(handle)),
    ]);
    return (
      !located.isSymbolicLink() &&
      sameDirectoryObject(identity, opened) &&
      sameDirectoryObject(identity, located) &&
      actualPath === expectedPath &&
      (mode === undefined || (hasMode(opened, mode) && hasMode(located, mode)))
    );
  } catch {
    return false;
  }
}

async function assertCapabilityLocations(capability: SnapshotCapability): Promise<void> {
  const locations = await Promise.all([
    directoryLocationMatches(
      capability.parentHandle,
      capability.parentIdentity,
      capability.parentPath,
    ),
    directoryLocationMatches(
      capability.rootHandle,
      capability.rootIdentity,
      capability.rootPath,
      0o700,
    ),
    directoryLocationMatches(
      capability.objectsHandle,
      capability.objectsIdentity,
      capability.objectsPath,
      0o700,
    ),
    directoryLocationMatches(
      capability.treeHandle,
      capability.treeIdentity,
      capability.treePath,
      0o700,
    ),
  ]);
  if (locations.some((matches) => !matches)) {
    fail(
      "staging_unavailable",
      "The capability-bound local SSH staging directories changed",
      capability.rootPath,
    );
  }
}

async function openBoundDirectory(
  openPath: string | Buffer,
  expectedPath: string,
): Promise<Readonly<{ handle: FileHandle; identity: BigIntStats }>> {
  const pathBefore = await lstat(expectedPath, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isDirectory()) {
    fail("staging_unavailable", "A local SSH staging path is not a regular directory");
  }
  const handle = await open(
    openPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const pathAfter = await lstat(expectedPath, { bigint: true });
    if (
      pathAfter.isSymbolicLink() ||
      !sameDirectoryObject(pathBefore, opened) ||
      !sameDirectoryObject(opened, pathAfter) ||
      (await realpath(descriptorPath(handle))) !== expectedPath
    ) {
      fail("staging_unavailable", "A local SSH staging directory changed while it was bound");
    }
    return { handle, identity: opened };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openOrCreateCanonicalDirectory(
  expectedPath: string,
  signal: AbortSignal,
): Promise<Readonly<{ handle: FileHandle; identity: BigIntStats }>> {
  const parsed = parsePath(expectedPath);
  if (resolve(expectedPath) !== expectedPath || parsed.root.length === 0) {
    fail("staging_unavailable", "A local SSH staging parent path is not canonical");
  }
  const components = expectedPath
    .slice(parsed.root.length)
    .split(sep)
    .filter((component) => component.length > 0);
  let currentPath = parsed.root;
  let current = await openBoundDirectory(parsed.root, parsed.root);
  try {
    const systemOwnerId = requireSafeSystemRoot(await current.handle.stat({ bigint: true }));
    for (const component of components) {
      checkCancelled(signal);
      if (component === "." || component === ".." || component.includes("\0")) {
        fail("staging_unavailable", "A local SSH staging parent component is unsafe");
      }
      const entryPath = join(descriptorPath(current.handle), component);
      const nextPath = join(currentPath, component);
      let created = false;
      try {
        const existing = await lstat(entryPath, { bigint: true });
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          fail("staging_unavailable", "A local SSH staging parent component is not a directory");
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          throw error;
        }
        await mkdir(entryPath, { mode: 0o700 });
        created = true;
      }
      const opened = await openBoundDirectory(entryPath, nextPath);
      let next: Readonly<{ handle: FileHandle; identity: BigIntStats }>;
      try {
        if (created) {
          next = await privatizeNewBoundDirectory(opened, nextPath);
        } else {
          requireSafeExistingParent(await opened.handle.stat({ bigint: true }), systemOwnerId);
          next = opened;
        }
      } catch (error) {
        await opened.handle.close().catch(() => undefined);
        throw error;
      }
      const previous = current.handle;
      current = next;
      currentPath = nextPath;
      await previous.close();
    }
    return current;
  } catch (error) {
    await current.handle.close().catch(() => undefined);
    throw error;
  }
}

function requireDownloadingState(state: SshTransportState): DownloadingSshTransportState {
  assertApprovedSshTransportState(state);
  if (state.phase !== "downloading") {
    fail("state_invalid", "The local SSH snapshot requires the downloading transport phase");
  }
  return state;
}

function requireMaterializedState(state: SshTransportState): MaterializedSshTransportState {
  assertApprovedSshTransportState(state);
  if (state.phase !== "staged") {
    fail("state_invalid", "The local SSH snapshot requires the staged transport phase");
  }
  return state;
}

function requireCapability(
  handle: LocalSshSnapshotHandle,
  state: SnapshotBoundSshTransportState,
): SnapshotCapability {
  const capability = SNAPSHOT_CAPABILITIES.get(handle);
  if (
    capability === undefined ||
    handle.plan_sha256 !== state.plan.plan_sha256 ||
    handle.stage_sha256 !== state.stage.stage_sha256 ||
    capability.mapping.mapping_sha256 !==
      createSshSnapshotMapping({ plan: state.plan, stage: state.stage }).mapping_sha256
  ) {
    fail("state_invalid", "The local SSH snapshot capability does not match this transfer");
  }
  return capability;
}

function decodeRawPath(value: string, maximumBytes: number): Buffer {
  if (value.length === 0 || !BASE64.test(value)) {
    fail("snapshot_mismatch", "The snapshot mapping contains a non-canonical raw path");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes ||
    bytes.toString("base64") !== value ||
    bytes[0] === 0x2f
  ) {
    fail("snapshot_mismatch", "The snapshot mapping contains an invalid raw path");
  }
  let segmentStart = 0;
  for (let index = 0; index <= bytes.byteLength; index += 1) {
    const byte = bytes[index];
    if (byte === 0) {
      fail("snapshot_mismatch", "The snapshot mapping contains a raw path with NUL");
    }
    if (index !== bytes.byteLength && byte !== 0x2f) {
      continue;
    }
    const segment = bytes.subarray(segmentStart, index);
    if (
      segment.byteLength === 0 ||
      (segment.byteLength === 1 && segment[0] === 0x2e) ||
      (segment.byteLength === 2 && segment[0] === 0x2e && segment[1] === 0x2e)
    ) {
      fail("snapshot_mismatch", "The snapshot mapping contains an unsafe raw path segment");
    }
    segmentStart = index + 1;
  }
  return bytes;
}

function rawPathParts(path: Buffer): Readonly<{ name: Buffer; parentKey: string }> {
  const separator = path.lastIndexOf(0x2f);
  if (separator < 0) {
    return { name: Buffer.from(path), parentKey: "" };
  }
  return {
    name: Buffer.from(path.subarray(separator + 1)),
    parentKey: Buffer.from(path.subarray(0, separator)).toString("base64"),
  };
}

function createExpectedLayout(
  state: DownloadingSshTransportState,
  mapping: SshSnapshotMappingEnvelope,
): ExpectedLayout {
  const entries: ExpectedEntry[] = [];
  const children = new Map<string, Map<string, ExpectedEntry>>();
  const objects: ExpectedObject[] = [];
  const objectsById = new Map<string, ExpectedObject>();
  const objectsByName = new Map<string, ExpectedObject>();
  const maximumPathBytes = state.plan.plan.limits.max_path_bytes;

  for (const mapped of mapping.mapping.entries) {
    const path = decodeRawPath(mapped.path_base64, maximumPathBytes);
    const { name, parentKey } = rawPathParts(path);
    const size = Number(BigInt(mapped.status.size));
    if (!Number.isSafeInteger(size) || size < 0) {
      fail("snapshot_mismatch", "The snapshot mapping contains an unsupported file size");
    }
    const entry: ExpectedEntry = {
      key: mapped.path_base64,
      name,
      objectId: mapped.object_id,
      parentKey,
      path,
      sha256: mapped.sha256,
      size,
      type: mapped.type,
    };
    let siblings = children.get(parentKey);
    if (siblings === undefined) {
      siblings = new Map<string, ExpectedEntry>();
      children.set(parentKey, siblings);
    }
    const nameKey = name.toString("base64");
    if (siblings.has(nameKey)) {
      fail("snapshot_mismatch", "The snapshot mapping repeats a raw tree entry");
    }
    siblings.set(nameKey, entry);
    entries.push(entry);

    if (entry.type !== "regular_file") {
      if (entry.objectId !== null || entry.sha256 !== null) {
        fail("snapshot_mismatch", "A snapshot directory has file object metadata");
      }
      continue;
    }
    if (
      entry.objectId === null ||
      entry.sha256 === null ||
      !OBJECT_ID.test(entry.objectId) ||
      entry.objectId !== `f${String(objects.length + 1).padStart(8, "0")}`
    ) {
      fail("snapshot_mismatch", "The snapshot file object sequence is invalid");
    }
    const object: ExpectedObject = {
      entry,
      id: entry.objectId,
      nameKey: Buffer.from(entry.objectId).toString("base64"),
      sha256: entry.sha256,
      size: entry.size,
    };
    objects.push(object);
    objectsById.set(object.id, object);
    objectsByName.set(object.nameKey, object);
  }

  if (objects.length !== state.stage.stage.objects.length) {
    fail("snapshot_mismatch", "The snapshot object count differs from the staged transfer");
  }
  return { children, entries, objects, objectsById, objectsByName };
}

async function listRawNames(handle: FileHandle): Promise<Buffer[]> {
  const entries = await readdir(descriptorPath(handle), {
    encoding: "buffer",
  });
  return entries.map((entry) => Buffer.from(entry)).sort(Buffer.compare);
}

async function requireEmptyDirectory(handle: FileHandle): Promise<void> {
  const before = await handle.stat({ bigint: true });
  if ((await listRawNames(handle)).length !== 0) {
    fail("snapshot_mismatch", "A new local SSH staging directory is not empty");
  }
  const after = await handle.stat({ bigint: true });
  if (!sameDirectorySnapshot(before, after)) {
    fail("staging_unavailable", "A local SSH staging directory changed while it was inspected");
  }
}

async function hashStableRegularFile(
  path: Buffer,
  expected: ExpectedObject,
  signal: AbortSignal,
  setPrivateMode: boolean,
): Promise<BigIntStats> {
  checkCancelled(signal);
  const pathBefore = await lstat(path, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    fail("snapshot_mismatch", "A downloaded snapshot object is not a regular file");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat({ bigint: true });
    if (!sameRegularFile(pathBefore, opened)) {
      fail("snapshot_mismatch", "A downloaded snapshot object changed before verification");
    }
    if (opened.size !== BigInt(expected.size)) {
      fail("snapshot_mismatch", "A downloaded snapshot object has the wrong size");
    }
    if (setPrivateMode) {
      await file.chmod(0o400);
    }
    const stableBefore = await file.stat({ bigint: true });
    const locatedBefore = await lstat(path, { bigint: true });
    if (
      !sameRegularFile(stableBefore, locatedBefore) ||
      !hasMode(stableBefore, 0o400) ||
      stableBefore.size !== BigInt(expected.size)
    ) {
      fail("snapshot_mismatch", "A downloaded snapshot object is not privately bound");
    }

    const hash = createHash("sha256");
    const chunk = new Uint8Array(READ_CHUNK_BYTES);
    let offset = 0;
    while (offset < expected.size) {
      checkCancelled(signal);
      const requested = Math.min(chunk.byteLength, expected.size - offset);
      const result = await file.read(chunk, 0, requested, offset);
      if (result.bytesRead === 0) {
        fail("snapshot_mismatch", "A downloaded snapshot object changed while it was read");
      }
      hash.update(chunk.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const tail = await file.read(chunk, 0, 1, expected.size);
    const stableAfter = await file.stat({ bigint: true });
    const locatedAfter = await lstat(path, { bigint: true });
    if (
      tail.bytesRead !== 0 ||
      !sameRegularFile(stableBefore, stableAfter) ||
      !sameRegularFile(stableBefore, locatedAfter) ||
      hash.digest("hex") !== expected.sha256
    ) {
      fail("snapshot_mismatch", "A downloaded snapshot object failed stable digest verification");
    }
    return stableAfter;
  } finally {
    await file.close();
  }
}

async function verifyObjectSet(
  capability: SnapshotCapability,
  signal: AbortSignal,
  setPrivateMode: boolean,
  requiredIdentities?: ReadonlyMap<string, VerifiedFilesystemIdentity>,
  requireExactIdentity = false,
): Promise<ReadonlyMap<string, VerifiedFilesystemIdentity>> {
  checkCancelled(signal);
  const before = await capability.objectsHandle.stat({ bigint: true });
  const names = await listRawNames(capability.objectsHandle);
  if (names.length !== capability.expected.objects.length) {
    fail("snapshot_mismatch", "The downloaded snapshot object set is incomplete or unexpected");
  }
  const identities = new Map<string, VerifiedFilesystemIdentity>();
  for (const name of names) {
    checkCancelled(signal);
    const expected = capability.expected.objectsByName.get(name.toString("base64"));
    if (expected === undefined || Buffer.compare(name, Buffer.from(expected.id)) !== 0) {
      fail("snapshot_mismatch", "The downloaded snapshot object set contains an unexpected entry");
    }
    const status = await hashStableRegularFile(
      descriptorChildPath(capability.objectsHandle, expected.id),
      expected,
      signal,
      setPrivateMode,
    );
    const identity = verifiedFilesystemIdentity(status);
    const required = requiredIdentities?.get(expected.id);
    if (
      required !== undefined &&
      !(requireExactIdentity
        ? sameVerifiedFilesystemIdentity(required, identity)
        : sameObjectStorageIdentity(required, identity))
    ) {
      fail("snapshot_mismatch", "A downloaded snapshot object was replaced during reconstruction");
    }
    identities.set(expected.id, identity);
  }
  const after = await capability.objectsHandle.stat({ bigint: true });
  if (!sameDirectorySnapshot(before, after)) {
    fail("staging_unavailable", "The local snapshot object directory changed during verification");
  }
  return identities;
}

async function createPrivateDirectory(path: Buffer): Promise<void> {
  await mkdir(path, { mode: 0o700 });
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.chmod(0o700);
    const status = await handle.stat({ bigint: true });
    const located = await lstat(path, { bigint: true });
    if (
      located.isSymbolicLink() ||
      !sameDirectoryObject(status, located) ||
      status.uid !== effectiveUserId() ||
      located.uid !== status.uid ||
      !hasMode(status, 0o700) ||
      !hasMode(located, 0o700)
    ) {
      fail("snapshot_mismatch", "A reconstructed snapshot directory is not privately bound");
    }
  } finally {
    await handle.close();
  }
}

function rawPathSegments(path: Buffer): Buffer[] {
  const segments: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= path.byteLength; index += 1) {
    if (index !== path.byteLength && path[index] !== 0x2f) {
      continue;
    }
    segments.push(Buffer.from(path.subarray(start, index)));
    start = index + 1;
  }
  return segments;
}

async function openDirectPrivateDirectory(
  parent: FileHandle,
  name: Buffer,
): Promise<Readonly<{ handle: FileHandle; identity: BigIntStats }>> {
  const path = descriptorChildPath(parent, name);
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory() || !hasMode(before, 0o700)) {
    fail("snapshot_mismatch", "The reconstructed snapshot contains an invalid directory");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const after = await lstat(path, { bigint: true });
    if (
      !sameDirectoryObject(before, opened) ||
      !sameDirectoryObject(opened, after) ||
      !hasMode(opened, 0o700)
    ) {
      fail("snapshot_mismatch", "A reconstructed snapshot directory changed while it was opened");
    }
    return { handle, identity: opened };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function withRawParentDirectory<T>(
  root: FileHandle,
  entry: ExpectedEntry,
  operation: (parent: FileHandle, name: Buffer) => Promise<T>,
): Promise<T> {
  const segments = rawPathSegments(entry.path);
  const name = segments.pop();
  if (name === undefined || Buffer.compare(name, entry.name) !== 0) {
    fail("snapshot_mismatch", "The snapshot mapping raw path is inconsistent");
  }
  let current = root;
  let owned: FileHandle | undefined;
  try {
    for (const segment of segments) {
      const next = await openDirectPrivateDirectory(current, segment);
      const previous = owned;
      owned = next.handle;
      current = next.handle;
      await previous?.close();
    }
    return await operation(current, name);
  } finally {
    await owned?.close().catch(() => undefined);
  }
}

async function reconstructTree(
  capability: SnapshotCapability,
  objectIdentities: ReadonlyMap<string, VerifiedFilesystemIdentity>,
  signal: AbortSignal,
): Promise<void> {
  await requireEmptyDirectory(capability.treeHandle);
  for (const entry of capability.expected.entries) {
    checkCancelled(signal);
    await withRawParentDirectory(capability.treeHandle, entry, async (parent, name) => {
      const target = descriptorChildPath(parent, name);
      if (entry.type === "directory") {
        await createPrivateDirectory(target);
        return;
      }
      if (entry.objectId === null || !objectIdentities.has(entry.objectId)) {
        fail("snapshot_mismatch", "A reconstructed snapshot file has no verified object");
      }
      await link(descriptorChildPath(capability.objectsHandle, entry.objectId), target);
      const linked = await lstat(target, { bigint: true });
      const source = objectIdentities.get(entry.objectId);
      if (
        source === undefined ||
        linked.isSymbolicLink() ||
        !linked.isFile() ||
        linked.dev !== source.dev ||
        linked.ino !== source.ino ||
        linked.size !== source.size ||
        !hasMode(linked, 0o400)
      ) {
        fail(
          "snapshot_mismatch",
          "A reconstructed snapshot file is not bound to its verified object",
        );
      }
    });
  }
}

function compareNameSets(actual: readonly Buffer[], expected: readonly ExpectedEntry[]): boolean {
  const expectedNames = expected.map((entry) => entry.name).sort(Buffer.compare);
  return (
    actual.length === expectedNames.length &&
    actual.every(
      (name, index) => Buffer.compare(name, expectedNames[index] ?? Buffer.alloc(0)) === 0,
    )
  );
}

async function verifyTree(
  capability: SnapshotCapability,
  objectIdentities: ReadonlyMap<string, VerifiedFilesystemIdentity>,
  signal: AbortSignal,
  requiredDirectories?: ReadonlyMap<string, VerifiedFilesystemIdentity>,
): Promise<ReadonlyMap<string, VerifiedFilesystemIdentity>> {
  const expectedDirectoryCount =
    capability.expected.entries.filter((entry) => entry.type === "directory").length + 1;
  if (requiredDirectories !== undefined && requiredDirectories.size !== expectedDirectoryCount) {
    fail("snapshot_mismatch", "The materialized snapshot directory set is incomplete");
  }
  const directoryIdentities = new Map<string, VerifiedFilesystemIdentity>();

  async function verifyDirectory(
    handle: FileHandle,
    identity: BigIntStats,
    key: string,
  ): Promise<void> {
    checkCancelled(signal);
    const before = await handle.stat({ bigint: true });
    const beforeIdentity = verifiedFilesystemIdentity(before);
    const requiredIdentity = requiredDirectories?.get(key);
    if (
      requiredDirectories !== undefined &&
      (requiredIdentity === undefined ||
        !sameVerifiedFilesystemIdentity(requiredIdentity, beforeIdentity))
    ) {
      fail("snapshot_mismatch", "A materialized snapshot directory changed after reconstruction");
    }
    const names = await listRawNames(handle);
    const expectedChildren = [...(capability.expected.children.get(key)?.values() ?? [])];
    if (!compareNameSets(names, expectedChildren)) {
      fail("snapshot_mismatch", "The reconstructed snapshot tree is incomplete or unexpected");
    }
    for (const child of expectedChildren) {
      checkCancelled(signal);
      const path = descriptorChildPath(handle, child.name);
      const status = await lstat(path, { bigint: true });
      if (status.isSymbolicLink()) {
        fail("snapshot_mismatch", "The reconstructed snapshot tree contains a symbolic link");
      }
      if (child.type === "directory") {
        const opened = await openDirectPrivateDirectory(handle, child.name);
        try {
          await verifyDirectory(opened.handle, opened.identity, child.key);
        } finally {
          await opened.handle.close();
        }
        continue;
      }
      const object =
        child.objectId === null ? undefined : capability.expected.objectsById.get(child.objectId);
      if (object === undefined || child.objectId === null) {
        fail("snapshot_mismatch", "The reconstructed snapshot file mapping is invalid");
      }
      const verified = await hashStableRegularFile(path, object, signal, false);
      const source = objectIdentities.get(child.objectId);
      if (
        source === undefined ||
        verified.dev !== source.dev ||
        verified.ino !== source.ino ||
        verified.size !== source.size
      ) {
        fail("snapshot_mismatch", "The reconstructed snapshot file changed after linking");
      }
    }
    const after = await handle.stat({ bigint: true });
    const afterIdentity = verifiedFilesystemIdentity(after);
    if (
      !sameVerifiedFilesystemIdentity(beforeIdentity, afterIdentity) ||
      !sameDirectoryObject(identity, after)
    ) {
      fail("snapshot_mismatch", "The reconstructed snapshot directory changed while verified");
    }
    directoryIdentities.set(key, afterIdentity);
  }

  await verifyDirectory(capability.treeHandle, capability.treeIdentity, "");
  if (directoryIdentities.size !== expectedDirectoryCount) {
    fail("snapshot_mismatch", "The reconstructed snapshot directory set is incomplete");
  }
  return directoryIdentities;
}

async function verifyMaterializedDirectoryIdentities(
  capability: SnapshotCapability,
  requiredDirectories: ReadonlyMap<string, VerifiedFilesystemIdentity>,
  signal: AbortSignal,
): Promise<void> {
  const expectedDirectoryCount =
    capability.expected.entries.filter((entry) => entry.type === "directory").length + 1;
  if (requiredDirectories.size !== expectedDirectoryCount) {
    fail("snapshot_mismatch", "The materialized snapshot directory set is incomplete");
  }
  let verifiedDirectories = 0;

  async function verifyDirectory(handle: FileHandle, key: string): Promise<void> {
    checkCancelled(signal);
    const identity = verifiedFilesystemIdentity(await handle.stat({ bigint: true }));
    const required = requiredDirectories.get(key);
    if (required === undefined || !sameVerifiedFilesystemIdentity(required, identity)) {
      fail("snapshot_mismatch", "A materialized snapshot directory changed after reconstruction");
    }
    verifiedDirectories += 1;
    const expectedChildren = [...(capability.expected.children.get(key)?.values() ?? [])];
    for (const child of expectedChildren) {
      if (child.type !== "directory") {
        continue;
      }
      const opened = await openDirectPrivateDirectory(handle, child.name);
      try {
        await verifyDirectory(opened.handle, child.key);
      } finally {
        await opened.handle.close();
      }
    }
  }

  await verifyDirectory(capability.treeHandle, "");
  if (verifiedDirectories !== expectedDirectoryCount) {
    fail("snapshot_mismatch", "The materialized snapshot directory set is incomplete");
  }
}

async function collectKnownTreeEntries(
  capability: SnapshotCapability,
): Promise<CollectedTreeEntries | null> {
  const directories: ExpectedEntry[] = [];
  const files: ExpectedEntry[] = [];

  async function collect(handle: FileHandle, parentKey: string): Promise<boolean> {
    const before = await handle.stat({ bigint: true });
    const names = await listRawNames(handle);
    const expected = capability.expected.children.get(parentKey);
    for (const name of names) {
      const entry = expected?.get(name.toString("base64"));
      if (entry === undefined || Buffer.compare(name, entry.name) !== 0) {
        return false;
      }
      const path = descriptorChildPath(handle, entry.name);
      const status = await lstat(path, { bigint: true });
      if (status.isSymbolicLink()) {
        return false;
      }
      if (entry.type === "regular_file") {
        if (!status.isFile()) {
          return false;
        }
        files.push(entry);
        continue;
      }
      if (!status.isDirectory()) {
        return false;
      }
      const child = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const opened = await child.stat({ bigint: true });
        if (!sameDirectoryObject(status, opened) || !(await collect(child, entry.key))) {
          return false;
        }
      } finally {
        await child.close();
      }
      directories.push(entry);
    }
    const after = await handle.stat({ bigint: true });
    return sameDirectorySnapshot(before, after);
  }

  return (await collect(capability.treeHandle, "")) ? { directories, files } : null;
}

async function collectKnownObjects(capability: SnapshotCapability): Promise<string[] | null> {
  const before = await capability.objectsHandle.stat({ bigint: true });
  const names = await listRawNames(capability.objectsHandle);
  const objects: string[] = [];
  for (const name of names) {
    const object = capability.expected.objectsByName.get(name.toString("base64"));
    if (object === undefined || Buffer.compare(name, Buffer.from(object.id)) !== 0) {
      return null;
    }
    const status = await lstat(descriptorChildPath(capability.objectsHandle, object.id), {
      bigint: true,
    });
    if (status.isSymbolicLink() || !status.isFile()) {
      return null;
    }
    objects.push(object.id);
  }
  const after = await capability.objectsHandle.stat({ bigint: true });
  return sameDirectorySnapshot(before, after) ? objects : null;
}

async function closeCapability(capability: SnapshotCapability): Promise<void> {
  await Promise.allSettled([
    capability.treeHandle.close(),
    capability.objectsHandle.close(),
    capability.rootHandle.close(),
    capability.parentHandle.close(),
  ]);
}

function cleanupRemoved(): LocalSshSnapshotCleanupResult {
  return Object.freeze({
    local_staging_removed: true as const,
    ok: true as const,
    residual_paths: Object.freeze([]) as readonly [],
  });
}

function cleanupResidual(root: string): LocalSshSnapshotCleanupResult {
  return Object.freeze({
    local_staging_removed: false as const,
    ok: false as const,
    residual_paths: Object.freeze([root]) as readonly [string],
  });
}

export async function createLocalSshSnapshot(
  receivedState: SshTransportState,
  signal: AbortSignal,
): Promise<LocalSshSnapshotHandle> {
  const state = requireDownloadingState(receivedState);
  checkCancelled(signal);
  const mapping = createSshSnapshotMapping({ plan: state.plan, stage: state.stage });
  const rootPath = state.plan.plan.local_staging_root;
  if (
    rootPath.includes("\0") ||
    resolve(rootPath) !== rootPath ||
    parsePath(rootPath).root === rootPath ||
    mapping.mapping.local_objects_root !== join(rootPath, "objects") ||
    mapping.mapping.local_tree_root !== join(rootPath, "tree")
  ) {
    fail("snapshot_mismatch", "The snapshot mapping has invalid local staging paths");
  }
  const parentPath = dirname(rootPath);
  const rootName = basename(rootPath);
  const parent = await openOrCreateCanonicalDirectory(parentPath, signal);
  let root: Readonly<{ handle: FileHandle; identity: BigIntStats }> | undefined;
  let objects: Readonly<{ handle: FileHandle; identity: BigIntStats }> | undefined;
  let tree: Readonly<{ handle: FileHandle; identity: BigIntStats }> | undefined;
  let rootCreated = false;
  const rootEntryPath = join(descriptorPath(parent.handle), rootName);
  try {
    checkCancelled(signal);
    await mkdir(rootEntryPath, { mode: 0o700 });
    rootCreated = true;
    root = await openBoundDirectory(rootEntryPath, rootPath);
    root = await privatizeNewBoundDirectory(root, rootPath);
    const objectsPath = mapping.mapping.local_objects_root;
    const treePath = mapping.mapping.local_tree_root;
    const objectsEntry = join(descriptorPath(root.handle), "objects");
    const treeEntry = join(descriptorPath(root.handle), "tree");
    await mkdir(objectsEntry, { mode: 0o700 });
    objects = await openBoundDirectory(objectsEntry, objectsPath);
    objects = await privatizeNewBoundDirectory(objects, objectsPath);
    await mkdir(treeEntry, { mode: 0o700 });
    tree = await openBoundDirectory(treeEntry, treePath);
    tree = await privatizeNewBoundDirectory(tree, treePath);
    checkCancelled(signal);

    const expected = createExpectedLayout(state, mapping);
    const handle: LocalSshSnapshotHandle = Object.freeze({
      kind: "ys_trace_local_ssh_snapshot" as const,
      local_staging_root: rootPath,
      local_tree_root: treePath,
      plan_sha256: state.plan.plan_sha256,
      stage_sha256: state.stage.stage_sha256,
    });
    SNAPSHOT_CAPABILITIES.set(handle, {
      expected,
      mapping,
      objectsHandle: objects.handle,
      objectsIdentity: objects.identity,
      objectsPath,
      parentHandle: parent.handle,
      parentIdentity: parent.identity,
      parentPath,
      phase: "ready",
      rootEntryPath,
      rootHandle: root.handle,
      rootIdentity: root.identity,
      rootPath,
      treeHandle: tree.handle,
      treeIdentity: tree.identity,
      treePath,
    });
    return handle;
  } catch (error) {
    await Promise.allSettled([tree?.handle.close(), objects?.handle.close()]);
    if (root !== undefined) {
      await rmdir(join(descriptorPath(root.handle), "tree")).catch(() => undefined);
      await rmdir(join(descriptorPath(root.handle), "objects")).catch(() => undefined);
      await root.handle.close().catch(() => undefined);
    }
    if (rootCreated) {
      await rmdir(rootEntryPath).catch(() => undefined);
    }
    await parent.handle.close().catch(() => undefined);
    const residualRoot = (await pathStillExists(rootPath)) ? rootPath : null;
    if (error instanceof LocalSshSnapshotError) {
      throw new LocalSshSnapshotError(error.code, error.message, residualRoot);
    }
    fail(
      "staging_unavailable",
      "The exclusive local SSH staging root could not be created",
      residualRoot,
    );
  }
}

export async function validatedLocalSshObjectsCwd(
  handle: LocalSshSnapshotHandle,
  receivedState: SshTransportState,
  signal: AbortSignal,
): Promise<string> {
  const state = requireDownloadingState(receivedState);
  const capability = requireCapability(handle, state);
  if (capability.phase !== "ready") {
    fail("state_invalid", "The local SSH snapshot download has already been authorized");
  }
  checkCancelled(signal);
  await assertCapabilityLocations(capability);
  await requireEmptyDirectory(capability.objectsHandle);
  await requireEmptyDirectory(capability.treeHandle);
  const cwd = controllerDescriptorPath(capability.objectsHandle);
  if ((await realpath(cwd)) !== capability.objectsPath) {
    fail("staging_unavailable", "The SFTP working directory is not capability-bound");
  }
  capability.phase = "download_authorized";
  return cwd;
}

export async function materializeLocalSshSnapshot(
  handle: LocalSshSnapshotHandle,
  receivedState: SshTransportState,
  signal: AbortSignal,
): Promise<SshSnapshotMappingEnvelope> {
  const state = requireDownloadingState(receivedState);
  const capability = requireCapability(handle, state);
  const maySkipEmptyDownload =
    capability.phase === "ready" && capability.expected.objects.length === 0;
  if (capability.phase !== "download_authorized" && !maySkipEmptyDownload) {
    fail("state_invalid", "The local SSH snapshot download has not been authorized");
  }
  checkCancelled(signal);
  await assertCapabilityLocations(capability);
  const downloadedIdentities = await verifyObjectSet(capability, signal, true);
  await reconstructTree(capability, downloadedIdentities, signal);
  capability.materializedDirectories = await verifyTree(capability, downloadedIdentities, signal);
  capability.materializedObjects = await verifyObjectSet(
    capability,
    signal,
    false,
    downloadedIdentities,
  );
  await assertCapabilityLocations(capability);
  await verifyMaterializedDirectoryIdentities(
    capability,
    capability.materializedDirectories,
    signal,
  );
  capability.phase = "materialized";
  return capability.mapping;
}

export async function verifyMaterializedLocalSshSnapshot(
  handle: LocalSshSnapshotHandle,
  receivedState: SshTransportState,
  signal: AbortSignal,
): Promise<void> {
  const state = requireMaterializedState(receivedState);
  const capability = requireCapability(handle, state);
  if (capability.phase !== "materialized") {
    fail("state_invalid", "The local SSH snapshot has not been materialized");
  }
  const materializedObjects = capability.materializedObjects;
  const materializedDirectories = capability.materializedDirectories;
  if (materializedObjects === undefined || materializedDirectories === undefined) {
    fail("state_invalid", "The local SSH snapshot has no materialized identities");
  }
  checkCancelled(signal);
  await assertCapabilityLocations(capability);
  const identities = await verifyObjectSet(capability, signal, false, materializedObjects, true);
  await verifyTree(capability, identities, signal, materializedDirectories);
  await verifyObjectSet(capability, signal, false, identities, true);
  await assertCapabilityLocations(capability);
  await verifyMaterializedDirectoryIdentities(capability, materializedDirectories, signal);
  checkCancelled(signal);
}

export async function cleanupLocalSshSnapshot(
  handle: LocalSshSnapshotHandle,
): Promise<LocalSshSnapshotCleanupResult> {
  const capability = SNAPSHOT_CAPABILITIES.get(handle);
  if (capability === undefined) {
    fail("state_invalid", "The local SSH snapshot capability is unknown");
  }
  if (capability.phase === "residual") {
    return cleanupResidual(capability.rootPath);
  }

  try {
    await assertCapabilityLocations(capability);
    const [tree, objects] = await Promise.all([
      collectKnownTreeEntries(capability),
      collectKnownObjects(capability),
    ]);
    if (tree === null || objects === null) {
      capability.phase = "residual";
      await closeCapability(capability);
      return cleanupResidual(capability.rootPath);
    }

    for (const entry of tree.files) {
      await withRawParentDirectory(capability.treeHandle, entry, async (parent, name) => {
        await unlink(descriptorChildPath(parent, name));
      });
    }
    for (const entry of tree.directories) {
      await withRawParentDirectory(capability.treeHandle, entry, async (parent, name) => {
        await rmdir(descriptorChildPath(parent, name));
      });
    }
    for (const object of objects) {
      await unlink(descriptorChildPath(capability.objectsHandle, object));
    }
    await assertCapabilityLocations(capability);
    await capability.treeHandle.close();
    await capability.objectsHandle.close();
    await rmdir(join(descriptorPath(capability.rootHandle), "tree"));
    await rmdir(join(descriptorPath(capability.rootHandle), "objects"));
    if (
      !(await directoryLocationMatches(
        capability.rootHandle,
        capability.rootIdentity,
        capability.rootPath,
        0o700,
      )) ||
      !(await directoryLocationMatches(
        capability.parentHandle,
        capability.parentIdentity,
        capability.parentPath,
      ))
    ) {
      fail("cleanup_residual", "The local SSH staging root changed before cleanup");
    }
    await rmdir(capability.rootEntryPath);
    await Promise.allSettled([capability.rootHandle.close(), capability.parentHandle.close()]);
    SNAPSHOT_CAPABILITIES.delete(handle);
    return cleanupRemoved();
  } catch {
    capability.phase = "residual";
    await closeCapability(capability);
    return cleanupResidual(capability.rootPath);
  }
}
