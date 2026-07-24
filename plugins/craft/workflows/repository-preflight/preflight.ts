import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, parse as parsePath, posix, relative, resolve, sep } from "node:path";

import { canonicalizeJson, computeArtifactDigest, sha256Digest } from "../artifacts/canonical";
import type { RepositoryBinding } from "../artifacts/generated";
import { parseCraftContractBytes } from "../artifacts/parser";
import type { CraftRuntimeConfig, ParsedCraftRuntimeConfig } from "../runtime-config/config";

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REQUEST_ID = /^[a-z][a-z0-9-]*:[A-Za-z0-9_-]{16,128}$/u;
const GIT_PREFIX = ["git", "-c", "core.hooksPath=/dev/null"] as const;
const UTF8_ENCODER = new TextEncoder();

export type RepositoryPreparationMode = "managed" | "manual";

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface GitRunner {
  run(argv: readonly string[], timeoutMs: number): Promise<GitCommandResult>;
}

export interface RepositoryExpectation {
  readonly commitSha: string;
  readonly repositoryUrl: string;
}

export interface ManagedRepositoryPreparationPlan {
  readonly commit_sha: string;
  readonly destination: string;
  readonly git_argv: readonly [readonly string[], readonly string[], readonly string[]];
  readonly kind: "repository-preparation-plan";
  readonly network: "required";
  readonly plan_digest: `sha256:${string}`;
  readonly repository_url: string;
  readonly request_id: string;
  readonly version: 1;
}

export interface RepositoryPreparationAuthorization {
  readonly decision: "allow" | "deny";
  readonly plan_digest: `sha256:${string}`;
  readonly request_id: string;
}

export interface ManagedRepositoryPreparationResult {
  readonly created_or_updated_paths: readonly string[];
  readonly destination: string;
  readonly git_argv: ManagedRepositoryPreparationPlan["git_argv"];
  readonly residual_paths: readonly string[];
  readonly status: "ready";
}

export interface PreWorkflowPathPreview {
  readonly controller_root: string;
  readonly expected_create_or_update: readonly string[];
  readonly managed_destination: string | null;
  readonly state_root: string;
  readonly target_worktree: string;
}

export interface RepositoryPreflightReceipt {
  readonly config: CraftRuntimeConfig;
  readonly config_digest: `sha256:${string}`;
  readonly config_path: string;
  readonly controller_root_realpath: string;
  readonly created_or_updated_paths: readonly string[];
  readonly preparation_mode: RepositoryPreparationMode;
  readonly preview: PreWorkflowPathPreview;
  readonly repository_binding: RepositoryBinding;
  readonly state_root_path: string;
}

export type RepositoryPreflightErrorCode =
  | "YS_CRAFT_CONFIG_DRIFT"
  | "YS_CRAFT_CONTROLLER_INVALID"
  | "YS_CRAFT_GIT_FAILED"
  | "YS_CRAFT_MANAGED_PREPARATION_DENIED"
  | "YS_CRAFT_MANAGED_PREPARATION_FAILED"
  | "YS_CRAFT_MANAGED_PREPARATION_INVALID"
  | "YS_CRAFT_REPOSITORY_DIRTY"
  | "YS_CRAFT_REPOSITORY_MISMATCH"
  | "YS_CRAFT_STATE_NOT_IGNORED"
  | "YS_CRAFT_STATE_PATH_UNSAFE";

export class RepositoryPreflightError extends Error {
  constructor(
    readonly code: RepositoryPreflightErrorCode,
    message: string,
    readonly residualPaths: readonly string[] = [],
  ) {
    super(`${code}: ${message}`);
    this.name = "RepositoryPreflightError";
  }
}

interface PrepareRepositoryPreflightInput {
  readonly configDocument: ParsedCraftRuntimeConfig;
  readonly configPath: string;
  readonly controllerRoot: string;
  readonly createdAt: string;
  readonly createdOrUpdatedPaths?: readonly string[];
  readonly expectation: RepositoryExpectation;
  readonly git: GitRunner;
  readonly preparationMode: RepositoryPreparationMode;
  readonly stateRootPath: string;
  readonly targetWorktree: string;
}

interface RepositoryObservation {
  readonly binding: RepositoryBinding;
  readonly targetWorktreeRealpath: string;
}

function fail(code: RepositoryPreflightErrorCode, message: string): never {
  throw new RepositoryPreflightError(code, message);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function trimLine(result: GitCommandResult, label: string): string {
  if (result.exitCode !== 0) {
    fail(
      "YS_CRAFT_GIT_FAILED",
      `${label} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
    );
  }
  const value = result.stdout.trim();
  if (value.length === 0 || value.includes("\0") || value.includes("\n")) {
    fail("YS_CRAFT_GIT_FAILED", `${label} did not return one non-empty line`);
  }
  return value;
}

async function runGit(
  git: GitRunner,
  timeoutMs: number,
  args: readonly string[],
): Promise<GitCommandResult> {
  return git.run([...GIT_PREFIX, ...args], timeoutMs);
}

async function gitLine(
  git: GitRunner,
  timeoutMs: number,
  args: readonly string[],
  label: string,
): Promise<string> {
  return trimLine(await runGit(git, timeoutMs, args), label);
}

function assertCommit(value: string, label: string): void {
  if (!COMMIT.test(value)) {
    fail("YS_CRAFT_REPOSITORY_MISMATCH", `${label} must be one full lower-case Git object ID`);
  }
}

function assertRepositoryUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail("YS_CRAFT_REPOSITORY_MISMATCH", "repository URL must be an absolute URI");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:") ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  ) {
    fail(
      "YS_CRAFT_REPOSITORY_MISMATCH",
      "repository URL must use http, https, or ssh without embedded credentials or parameters",
    );
  }
}

async function requireCanonicalDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || parsePath(path).root === path) {
    fail("YS_CRAFT_CONTROLLER_INVALID", `${label} must be a canonical absolute path`);
  }
  const resolved = await realpath(path).catch(() => {
    fail("YS_CRAFT_CONTROLLER_INVALID", `${label} does not exist`);
  });
  if (resolved !== path) {
    fail("YS_CRAFT_CONTROLLER_INVALID", `${label} must be supplied as its canonical realpath`);
  }
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("YS_CRAFT_CONTROLLER_INVALID", `${label} must be a non-symlink directory`);
  }
  return resolved;
}

async function assertExistingComponentsNotSymlinks(path: string, root: string): Promise<void> {
  const relativePath = relative(root, path);
  if (!isPathWithin(root, path)) {
    fail("YS_CRAFT_STATE_PATH_UNSAFE", "state root must be below the controller root");
  }
  let current = root;
  for (const segment of relativePath.split(sep)) {
    current = resolve(current, segment);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      fail("YS_CRAFT_STATE_PATH_UNSAFE", `state path component is a symlink: ${current}`);
    }
    if (!stats.isDirectory()) {
      fail("YS_CRAFT_STATE_PATH_UNSAFE", `state path component is not a directory: ${current}`);
    }
  }
}

async function isIgnored(
  git: GitRunner,
  timeoutMs: number,
  controllerRoot: string,
  relativeProbe: string,
): Promise<boolean> {
  const result = await runGit(git, timeoutMs, [
    "-C",
    controllerRoot,
    "check-ignore",
    "--no-index",
    "-q",
    "--",
    relativeProbe,
  ]);
  if (result.exitCode === 0) {
    return true;
  }
  if (result.exitCode === 1) {
    return false;
  }
  fail(
    "YS_CRAFT_GIT_FAILED",
    `git check-ignore failed: ${result.stderr.trim() || result.stdout.trim()}`,
  );
}

async function inspectControllerBoundary(
  controllerRoot: string,
  stateRootPath: string,
  git: GitRunner,
  timeoutMs: number,
): Promise<string> {
  const controllerRootRealpath = await requireCanonicalDirectory(controllerRoot, "controller root");
  const gitRoot = await gitLine(
    git,
    timeoutMs,
    ["-C", controllerRootRealpath, "rev-parse", "--show-toplevel"],
    "controller Git root inspection",
  );
  if ((await realpath(gitRoot)) !== controllerRootRealpath) {
    fail(
      "YS_CRAFT_CONTROLLER_INVALID",
      "controller root must be the exact root of its Git worktree",
    );
  }
  if (!isAbsolute(stateRootPath) || resolve(stateRootPath) !== stateRootPath) {
    fail("YS_CRAFT_STATE_PATH_UNSAFE", "injected state root must be a canonical absolute path");
  }
  await assertExistingComponentsNotSymlinks(stateRootPath, controllerRootRealpath);
  const stateRelativePath = relative(controllerRootRealpath, stateRootPath).split(sep).join("/");
  const stateIgnoreProbe = posix.join(stateRelativePath, ".ys-craft-ignore-probe");
  const stateParentIgnoreProbe = posix.join(
    posix.dirname(stateRelativePath),
    ".ys-craft-parent-probe",
  );
  if (!(await isIgnored(git, timeoutMs, controllerRootRealpath, stateIgnoreProbe))) {
    fail(
      "YS_CRAFT_STATE_NOT_IGNORED",
      `controller Git must ignore exactly ${stateRelativePath}/ before workflow state is written`,
    );
  }
  if (await isIgnored(git, timeoutMs, controllerRootRealpath, stateParentIgnoreProbe)) {
    fail(
      "YS_CRAFT_STATE_NOT_IGNORED",
      "controller Git must not ignore the whole platform state parent",
    );
  }
  return controllerRootRealpath;
}

async function inspectRepository(
  input: Pick<
    PrepareRepositoryPreflightInput,
    "createdAt" | "expectation" | "git" | "preparationMode" | "targetWorktree"
  > & {
    readonly timeoutMs: number;
  },
): Promise<RepositoryObservation> {
  assertCommit(input.expectation.commitSha, "expected commit");
  assertRepositoryUrl(input.expectation.repositoryUrl);
  const targetWorktreeRealpath = await requireCanonicalDirectory(
    input.targetWorktree,
    "target worktree",
  );
  const gitRoot = await gitLine(
    input.git,
    input.timeoutMs,
    ["-C", targetWorktreeRealpath, "rev-parse", "--show-toplevel"],
    "target Git root inspection",
  );
  const gitRootRealpath = await realpath(gitRoot);
  if (gitRootRealpath !== targetWorktreeRealpath) {
    fail(
      "YS_CRAFT_REPOSITORY_MISMATCH",
      "target worktree must be the exact root of one Git worktree",
    );
  }
  const superproject = await runGit(input.git, input.timeoutMs, [
    "-C",
    targetWorktreeRealpath,
    "rev-parse",
    "--show-superproject-working-tree",
  ]);
  if (superproject.exitCode !== 0 || superproject.stdout.trim().length !== 0) {
    fail("YS_CRAFT_REPOSITORY_MISMATCH", "Git submodules cannot be used as target worktrees");
  }
  const status = await runGit(input.git, input.timeoutMs, [
    "-C",
    targetWorktreeRealpath,
    "status",
    "--porcelain=v2",
    "--untracked-files=all",
  ]);
  if (status.exitCode !== 0) {
    fail(
      "YS_CRAFT_GIT_FAILED",
      `target status inspection failed: ${status.stderr.trim() || status.stdout.trim()}`,
    );
  }
  if (status.stdout.length !== 0) {
    fail("YS_CRAFT_REPOSITORY_DIRTY", "target worktree must be clean at its first baseline");
  }
  const commitSha = await gitLine(
    input.git,
    input.timeoutMs,
    ["-C", targetWorktreeRealpath, "rev-parse", "--verify", "HEAD"],
    "target HEAD inspection",
  );
  assertCommit(commitSha, "observed HEAD");
  if (commitSha !== input.expectation.commitSha) {
    fail(
      "YS_CRAFT_REPOSITORY_MISMATCH",
      `target HEAD ${commitSha} does not match expected ${input.expectation.commitSha}`,
    );
  }
  const repositoryUrl = await gitLine(
    input.git,
    input.timeoutMs,
    ["-C", targetWorktreeRealpath, "remote", "get-url", "origin"],
    "target origin inspection",
  );
  assertRepositoryUrl(repositoryUrl);
  if (repositoryUrl !== input.expectation.repositoryUrl) {
    fail(
      "YS_CRAFT_REPOSITORY_MISMATCH",
      `target origin ${repositoryUrl} does not match expected ${input.expectation.repositoryUrl}`,
    );
  }
  const treeObjectId = await gitLine(
    input.git,
    input.timeoutMs,
    ["-C", targetWorktreeRealpath, "rev-parse", "--verify", "HEAD^{tree}"],
    "target tree inspection",
  );
  assertCommit(treeObjectId, "observed tree");
  const draft: RepositoryBinding = {
    artifact_digest: "sha256:pending",
    artifact_type: "repository-binding",
    artifact_version: 1,
    commit_sha: commitSha,
    created_at: input.createdAt,
    git_root_realpath: gitRootRealpath,
    preparation_mode: input.preparationMode,
    product_root_realpath: targetWorktreeRealpath,
    repository_url: repositoryUrl,
    target_worktree_realpath: targetWorktreeRealpath,
    tree_digest: sha256Digest(UTF8_ENCODER.encode(treeObjectId)),
  };
  const binding = Object.freeze({
    ...draft,
    artifact_digest: computeArtifactDigest(draft),
  });
  const parsed = parseCraftContractBytes(canonicalizeJson(binding).bytes);
  if (parsed.artifact_type !== "repository-binding") {
    fail("YS_CRAFT_REPOSITORY_MISMATCH", "repository binding did not validate");
  }
  return Object.freeze({ binding: parsed, targetWorktreeRealpath });
}

function managedPlanPayload(
  plan: Omit<ManagedRepositoryPreparationPlan, "plan_digest">,
): Omit<ManagedRepositoryPreparationPlan, "plan_digest"> {
  return plan;
}

function managedGitArgv(
  repositoryUrl: string,
  commitSha: string,
  destination: string,
): ManagedRepositoryPreparationPlan["git_argv"] {
  return Object.freeze([
    Object.freeze([...GIT_PREFIX, "clone", "--no-checkout", "--", repositoryUrl, destination]),
    Object.freeze([
      ...GIT_PREFIX,
      "-C",
      destination,
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "origin",
      commitSha,
    ]),
    Object.freeze([...GIT_PREFIX, "-C", destination, "checkout", "--detach", commitSha]),
  ] as const);
}

export function buildManagedRepositoryPreparationPlan(input: {
  readonly config: CraftRuntimeConfig;
  readonly controllerRoot: string;
  readonly destination: string;
  readonly expectation: RepositoryExpectation;
  readonly requestId: string;
  readonly stateRootPath: string;
}): ManagedRepositoryPreparationPlan {
  if (input.config.repository.preparation_policy !== "manual-or-managed") {
    fail("YS_CRAFT_MANAGED_PREPARATION_INVALID", "runtime policy permits manual preparation only");
  }
  if (!REQUEST_ID.test(input.requestId)) {
    fail("YS_CRAFT_MANAGED_PREPARATION_INVALID", "request ID is invalid");
  }
  assertCommit(input.expectation.commitSha, "managed expected commit");
  assertRepositoryUrl(input.expectation.repositoryUrl);
  if (
    !isAbsolute(input.destination) ||
    resolve(input.destination) !== input.destination ||
    parsePath(input.destination).root === input.destination
  ) {
    fail(
      "YS_CRAFT_MANAGED_PREPARATION_INVALID",
      "managed destination must be a canonical absolute path below the filesystem root",
    );
  }
  if (
    !isAbsolute(input.controllerRoot) ||
    resolve(input.controllerRoot) !== input.controllerRoot ||
    !isAbsolute(input.stateRootPath) ||
    resolve(input.stateRootPath) !== input.stateRootPath ||
    !isPathWithin(input.controllerRoot, input.stateRootPath)
  ) {
    fail(
      "YS_CRAFT_MANAGED_PREPARATION_INVALID",
      "controller and state roots must form a canonical nested path",
    );
  }
  const destinationRelativeToState = relative(input.stateRootPath, input.destination);
  if (
    destinationRelativeToState === "" ||
    (!destinationRelativeToState.startsWith(`..${sep}`) &&
      destinationRelativeToState !== ".." &&
      !isAbsolute(destinationRelativeToState))
  ) {
    fail(
      "YS_CRAFT_MANAGED_PREPARATION_INVALID",
      "managed destination must not overlap the workflow state root",
    );
  }
  const gitArgv = managedGitArgv(
    input.expectation.repositoryUrl,
    input.expectation.commitSha,
    input.destination,
  );
  const payload = managedPlanPayload({
    commit_sha: input.expectation.commitSha,
    destination: input.destination,
    git_argv: gitArgv,
    kind: "repository-preparation-plan",
    network: "required",
    repository_url: input.expectation.repositoryUrl,
    request_id: input.requestId,
    version: 1,
  });
  return Object.freeze({
    ...payload,
    plan_digest: canonicalizeJson(payload).digest,
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function executeManagedRepositoryPreparation(input: {
  readonly authorization: RepositoryPreparationAuthorization | null;
  readonly config: CraftRuntimeConfig;
  readonly controllerRoot: string;
  readonly git: GitRunner;
  readonly plan: ManagedRepositoryPreparationPlan;
  readonly stateRootPath: string;
}): Promise<ManagedRepositoryPreparationResult> {
  const { authorization, plan } = input;
  if (
    authorization === null ||
    authorization.decision !== "allow" ||
    authorization.plan_digest !== plan.plan_digest ||
    authorization.request_id !== plan.request_id
  ) {
    throw new RepositoryPreflightError(
      "YS_CRAFT_MANAGED_PREPARATION_DENIED",
      "exact repository preparation plan was not authorized",
    );
  }
  const { plan_digest: suppliedDigest, ...payload } = plan;
  if (canonicalizeJson(payload).digest !== suppliedDigest) {
    fail("YS_CRAFT_MANAGED_PREPARATION_INVALID", "repository preparation plan was modified");
  }
  if (
    plan.kind !== "repository-preparation-plan" ||
    plan.version !== 1 ||
    plan.network !== "required" ||
    !REQUEST_ID.test(plan.request_id)
  ) {
    fail("YS_CRAFT_MANAGED_PREPARATION_INVALID", "repository preparation plan identity is invalid");
  }
  assertCommit(plan.commit_sha, "managed plan commit");
  assertRepositoryUrl(plan.repository_url);
  if (
    !isAbsolute(plan.destination) ||
    resolve(plan.destination) !== plan.destination ||
    parsePath(plan.destination).root === plan.destination
  ) {
    fail("YS_CRAFT_MANAGED_PREPARATION_INVALID", "managed plan destination is invalid");
  }
  const expectedPlan = buildManagedRepositoryPreparationPlan({
    config: input.config,
    controllerRoot: input.controllerRoot,
    destination: plan.destination,
    expectation: {
      commitSha: plan.commit_sha,
      repositoryUrl: plan.repository_url,
    },
    requestId: plan.request_id,
    stateRootPath: input.stateRootPath,
  });
  if (canonicalizeJson(plan).text !== canonicalizeJson(expectedPlan).text) {
    fail(
      "YS_CRAFT_MANAGED_PREPARATION_INVALID",
      "repository preparation plan does not match current runtime policy",
    );
  }
  if (await pathExists(plan.destination)) {
    fail(
      "YS_CRAFT_MANAGED_PREPARATION_INVALID",
      "managed destination already exists; preserve it for manual inspection",
    );
  }
  for (const argv of plan.git_argv) {
    const result = await input.git.run(argv, input.config.repository.timeout_ms);
    if (result.exitCode !== 0) {
      const residualPaths = (await pathExists(plan.destination))
        ? Object.freeze([plan.destination])
        : Object.freeze([] as string[]);
      throw new RepositoryPreflightError(
        "YS_CRAFT_MANAGED_PREPARATION_FAILED",
        result.stderr.trim() || result.stdout.trim() || `Git exited ${result.exitCode}`,
        residualPaths,
      );
    }
  }
  return Object.freeze({
    created_or_updated_paths: Object.freeze([plan.destination]),
    destination: plan.destination,
    git_argv: plan.git_argv,
    residual_paths: Object.freeze([]),
    status: "ready",
  });
}

export async function prepareRepositoryPreflight(
  input: PrepareRepositoryPreflightInput,
): Promise<RepositoryPreflightReceipt> {
  if (input.preparationMode === "managed") {
    if (input.configDocument.config.repository.preparation_policy !== "manual-or-managed") {
      fail(
        "YS_CRAFT_MANAGED_PREPARATION_INVALID",
        "runtime policy permits manual preparation only",
      );
    }
    if (
      input.createdOrUpdatedPaths === undefined ||
      !input.createdOrUpdatedPaths.includes(input.targetWorktree)
    ) {
      fail(
        "YS_CRAFT_MANAGED_PREPARATION_INVALID",
        "managed preflight requires the completed preparation result",
      );
    }
  }
  const controllerRootRealpath = await inspectControllerBoundary(
    input.controllerRoot,
    input.stateRootPath,
    input.git,
    input.configDocument.config.repository.timeout_ms,
  );
  if (
    !isAbsolute(input.configPath) ||
    resolve(input.configPath) !== input.configPath ||
    !isPathWithin(controllerRootRealpath, input.configPath)
  ) {
    throw new RepositoryPreflightError(
      "YS_CRAFT_CONFIG_DRIFT",
      "runtime config path is not bound below the controller root",
    );
  }
  const observation = await inspectRepository({
    createdAt: input.createdAt,
    expectation: input.expectation,
    git: input.git,
    preparationMode: input.preparationMode,
    targetWorktree: input.targetWorktree,
    timeoutMs: input.configDocument.config.repository.timeout_ms,
  });
  const createdOrUpdatedPaths = Object.freeze([...(input.createdOrUpdatedPaths ?? [])]);
  return Object.freeze({
    config: input.configDocument.config,
    config_digest: input.configDocument.configDigest,
    config_path: input.configPath,
    controller_root_realpath: controllerRootRealpath,
    created_or_updated_paths: createdOrUpdatedPaths,
    preparation_mode: input.preparationMode,
    preview: Object.freeze({
      controller_root: controllerRootRealpath,
      expected_create_or_update: Object.freeze([input.stateRootPath]),
      managed_destination:
        input.preparationMode === "managed" ? observation.targetWorktreeRealpath : null,
      state_root: input.stateRootPath,
      target_worktree: observation.targetWorktreeRealpath,
    }),
    repository_binding: observation.binding,
    state_root_path: input.stateRootPath,
  });
}
