import { lstat, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import type {
  AuthorizedChange,
  MutationAuthorization,
  RepositoryBinding,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../artifacts/generated";
import { validateCraftContractGraph } from "../artifacts/parser";
import {
  auditTrustedPrincipal,
  principalsEqual,
  type TrustedPrincipal,
} from "../state-machine/principal";

export interface FileMutationRequest {
  readonly operation: AuthorizedChange["operation"];
  readonly path: string;
  readonly sourcePath: string | null;
}

export class FileMutationDeniedError extends Error {
  readonly code = "FILE_MUTATION_DENIED";

  constructor(message: string) {
    super(`FILE_MUTATION_DENIED: ${message}`);
    this.name = "FileMutationDeniedError";
  }
}

function deny(message: string): never {
  throw new FileMutationDeniedError(message);
}

function requireOne<T extends YuanshengCraftContractV1["artifact_type"]>(
  artifacts: readonly YuanshengCraftContractV1[],
  artifactType: T,
): Extract<YuanshengCraftContractV1, { artifact_type: T }> {
  const matches = artifacts.filter(
    (artifact): artifact is Extract<YuanshengCraftContractV1, { artifact_type: T }> =>
      artifact.artifact_type === artifactType,
  );
  if (matches.length !== 1) {
    return deny(`Building requires exactly one active ${artifactType}`);
  }
  return matches[0] as Extract<YuanshengCraftContractV1, { artifact_type: T }>;
}

function scopeKey(change: {
  readonly operation: string;
  readonly path: string;
  readonly source_path: string | null;
}): string {
  return `${change.operation}\0${change.source_path ?? ""}\0${change.path}`;
}

function requestKey(request: FileMutationRequest): string {
  return `${request.operation}\0${request.sourcePath ?? ""}\0${request.path}`;
}

function assertInside(root: string, path: string): void {
  const child = relative(root, path);
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`)) {
    deny("Mutation target must be a file strictly inside the bound product root");
  }
}

async function assertDirectoryChain(root: string, parent: string): Promise<void> {
  const segments = relative(root, parent)
    .split(sep)
    .filter((segment) => segment.length > 0);
  let cursor = root;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    const stats = await lstat(cursor);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      deny(`Mutation parent is not a non-symlink directory: ${cursor}`);
    }
    if ((await realpath(cursor)) !== cursor) {
      deny(`Mutation parent does not resolve to its approved path: ${cursor}`);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertRegularFile(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    deny(`Approved existing mutation target is not a regular non-symlink file: ${path}`);
  }
  if ((await realpath(path)) !== path) {
    deny(`Approved existing mutation target does not resolve to itself: ${path}`);
  }
}

function assertAuthorizationBinding(input: {
  readonly artifacts: readonly YuanshengCraftContractV1[];
  readonly authorization: MutationAuthorization;
  readonly binding: RepositoryBinding;
  readonly principal: TrustedPrincipal;
  readonly state: WorkflowState;
}): void {
  const principal = auditTrustedPrincipal(input.principal);
  if (
    input.state.phase !== "building" ||
    input.state.phase_principal === null ||
    !principalsEqual(input.state.phase_principal, principal)
  ) {
    deny("File mutation requires the trusted principal bound to the building phase");
  }
  if (
    principal.agent_id !== "ys-craft-patch-builder" ||
    !principalsEqual(input.authorization.principal, principal)
  ) {
    deny("File mutation authorization belongs to a different patch-builder session");
  }
  if (
    input.authorization.capability !== "file-mutation-only" ||
    input.authorization.baseline_commit !== input.binding.commit_sha ||
    input.authorization.target_worktree_realpath !== input.binding.target_worktree_realpath
  ) {
    deny("File mutation authorization has drifted from its repository binding");
  }
  const activeDigests = new Set(input.state.artifact_refs.map((ref) => ref.digest));
  if (
    !activeDigests.has(input.authorization.artifact_digest) ||
    !activeDigests.has(input.binding.artifact_digest)
  ) {
    deny("File mutation authorization or repository binding is not active");
  }
  const suppliedDigests = new Set(input.artifacts.map((artifact) => artifact.artifact_digest));
  if (
    suppliedDigests.size !== activeDigests.size ||
    [...activeDigests].some((digest) => !suppliedDigests.has(digest))
  ) {
    deny("File mutation guard requires the exact active artifact graph");
  }
  validateCraftContractGraph(input.artifacts);
}

export async function assertAuthorizedFileMutation(input: {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly principal: TrustedPrincipal;
  readonly request: FileMutationRequest;
  readonly state: WorkflowState;
}): Promise<void> {
  try {
    const authorization = requireOne(
      input.activeArtifacts,
      "mutation-authorization",
    ) as MutationAuthorization;
    const binding = requireOne(input.activeArtifacts, "repository-binding") as RepositoryBinding;
    assertAuthorizationBinding({
      artifacts: input.activeArtifacts,
      authorization,
      binding,
      principal: input.principal,
      state: input.state,
    });
    const requested = requestKey(input.request);
    const matches = authorization.authorized_changes.filter(
      (change) => scopeKey(change) === requested,
    );
    if (matches.length !== 1) {
      deny("Requested operation and paths do not exactly match the approved plan");
    }

    const productRoot = binding.product_root_realpath;
    if ((await realpath(productRoot)) !== productRoot) {
      deny("Bound product root is no longer its canonical realpath");
    }
    const rootStats = await lstat(productRoot);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      deny("Bound product root is not a non-symlink directory");
    }
    const target = resolve(productRoot, input.request.path);
    assertInside(productRoot, target);
    await assertDirectoryChain(productRoot, dirname(target));

    if (input.request.operation === "create") {
      if (await pathExists(target)) {
        deny("Approved create target already exists");
      }
      return;
    }
    if (input.request.operation === "rename") {
      if (input.request.sourcePath === null) {
        deny("Approved rename requires a source path");
      }
      const source = resolve(productRoot, input.request.sourcePath);
      assertInside(productRoot, source);
      await assertDirectoryChain(productRoot, dirname(source));
      await assertRegularFile(source);
      if (await pathExists(target)) {
        deny("Approved rename destination already exists");
      }
      return;
    }
    if (input.request.sourcePath !== null) {
      deny("Only rename may have a source path");
    }
    await assertRegularFile(target);
  } catch (error) {
    if (error instanceof FileMutationDeniedError) {
      throw error;
    }
    deny(
      `Filesystem or authorization check failed closed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function assertBuildingProcessDenied(input: {
  readonly principal: TrustedPrincipal;
  readonly state: WorkflowState;
}): never {
  const principal = auditTrustedPrincipal(input.principal);
  if (
    input.state.phase === "building" &&
    input.state.phase_principal !== null &&
    principalsEqual(input.state.phase_principal, principal)
  ) {
    return deny("Building mutation authorization never permits Bash or process execution");
  }
  return deny("Process authorization is not part of the building write guard");
}
