import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createOpenCodeGitRunner,
  loadOpenCodeCraftController,
} from "../../plugins/craft/opencode/src/controller-runtime";
import {
  buildManagedRepositoryPreparationPlan,
  executeManagedRepositoryPreparation,
  type GitCommandResult,
  type GitRunner,
  prepareRepositoryPreflight,
  RepositoryPreflightError,
} from "../../plugins/craft/workflows/repository-preflight/preflight";

const CREATED_AT = "2026-07-24T09:00:00.000Z";
const REPOSITORY_URL = "https://example.invalid/product.git";

function runtimeConfig() {
  return {
    repository: {
      preparation_policy: "manual-or-managed",
      timeout_ms: 30_000,
    },
    verification: {
      runners: [
        {
          command_proposals: [{ argv: ["bun", "test"], id: "tests" }],
          cwd: ".",
          id: "local",
          timeout_ms: 120_000,
          type: "local",
        },
      ],
    },
    version: 1,
  };
}

async function run(argv: readonly string[], cwd?: string): Promise<GitCommandResult> {
  const child = Bun.spawn([...argv], {
    ...(cwd === undefined ? {} : { cwd }),
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function gitLine(argv: readonly string[], cwd?: string): Promise<string> {
  const result = await run(argv, cwd);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

async function makeRepository() {
  const root = await mkdtemp(join(tmpdir(), "ys-craft-preflight-"));
  await gitLine(["git", "init", "-b", "main", root]);
  await gitLine(["git", "-C", root, "config", "user.name", "Yuansheng Test"]);
  await gitLine(["git", "-C", root, "config", "user.email", "test@example.invalid"]);
  await gitLine(["git", "-C", root, "config", "commit.gpgSign", "false"]);
  const isolatedExcludes = join(root, ".git/isolated-global-excludes");
  await writeFile(isolatedExcludes, "");
  await gitLine(["git", "-C", root, "config", "core.excludesFile", isolatedExcludes]);
  await gitLine(["git", "-C", root, "remote", "add", "origin", REPOSITORY_URL]);
  await mkdir(join(root, ".opencode/yuansheng"), { recursive: true });
  const configPath = join(root, ".opencode/yuansheng/craft.json");
  await writeFile(configPath, `${JSON.stringify(runtimeConfig(), null, 2)}\n`);
  await writeFile(join(root, "product.txt"), "baseline\n");
  await gitLine(["git", "-C", root, "add", ".opencode/yuansheng/craft.json", "product.txt"]);
  await gitLine(["git", "-C", root, "commit", "-m", "test: create baseline"]);
  await writeFile(join(root, ".git/info/exclude"), "/.opencode/yuansheng/workflow/\n");
  return {
    commitSha: await gitLine(["git", "-C", root, "rev-parse", "HEAD"]),
    configPath,
    root,
  };
}

class RecordingGitRunner implements GitRunner {
  readonly calls: string[][] = [];

  constructor(
    private readonly destination: string,
    private readonly failAt: number | null = null,
  ) {}

  async run(argv: readonly string[]): Promise<GitCommandResult> {
    this.calls.push([...argv]);
    if (this.calls.length === 1) {
      await mkdir(this.destination);
    }
    if (this.failAt === this.calls.length) {
      return { exitCode: 1, stderr: "simulated Git failure", stdout: "" };
    }
    return { exitCode: 0, stderr: "", stdout: "" };
  }
}

describe("Yuansheng Craft repository preflight", () => {
  test("rejects a missing or symlinked controller-local config", async () => {
    const repository = await makeRepository();
    const outside = join(await mkdtemp(join(tmpdir(), "ys-craft-config-outside-")), "craft.json");
    await writeFile(outside, JSON.stringify(runtimeConfig()));
    await unlink(repository.configPath);
    await symlink(outside, repository.configPath);
    await expect(
      loadOpenCodeCraftController({
        directory: repository.root,
        worktree: repository.root,
      }),
    ).rejects.toThrow();
    await unlink(repository.configPath);
    await expect(
      loadOpenCodeCraftController({
        directory: repository.root,
        worktree: repository.root,
      }),
    ).rejects.toThrow();
  });

  test("loads only controller-local config and binds a clean exact Git worktree", async () => {
    const repository = await makeRepository();
    const controller = await loadOpenCodeCraftController({
      directory: repository.root,
      worktree: repository.root,
    });
    const receipt = await prepareRepositoryPreflight({
      configDocument: controller.configDocument,
      configPath: controller.configPath,
      controllerRoot: controller.controllerRoot,
      createdAt: CREATED_AT,
      expectation: {
        commitSha: repository.commitSha,
        repositoryUrl: REPOSITORY_URL,
      },
      git: createOpenCodeGitRunner(controller.controllerRoot),
      preparationMode: "manual",
      stateRootPath: controller.stateRootPath,
      targetWorktree: repository.root,
    });

    expect(receipt.controller_root_realpath).toBe(repository.root);
    expect(receipt.state_root_path).toBe(join(repository.root, ".opencode/yuansheng/workflow"));
    expect(receipt.preview).toEqual({
      controller_root: repository.root,
      expected_create_or_update: [join(repository.root, ".opencode/yuansheng/workflow")],
      managed_destination: null,
      state_root: join(repository.root, ".opencode/yuansheng/workflow"),
      target_worktree: repository.root,
    });
    expect(receipt.repository_binding).toMatchObject({
      commit_sha: repository.commitSha,
      git_root_realpath: repository.root,
      preparation_mode: "manual",
      product_root_realpath: repository.root,
      repository_url: REPOSITORY_URL,
      target_worktree_realpath: repository.root,
    });
    expect(receipt.config_digest).toBe(controller.configDocument.configDigest);
  });

  test("rejects missing or parent ignore rules and symlinked state roots", async () => {
    const repository = await makeRepository();
    const controller = await loadOpenCodeCraftController({
      directory: repository.root,
      worktree: repository.root,
    });
    const git = createOpenCodeGitRunner(repository.root);
    const input = {
      configDocument: controller.configDocument,
      configPath: controller.configPath,
      controllerRoot: controller.controllerRoot,
      createdAt: CREATED_AT,
      expectation: {
        commitSha: repository.commitSha,
        repositoryUrl: REPOSITORY_URL,
      },
      git,
      preparationMode: "manual" as const,
      stateRootPath: controller.stateRootPath,
      targetWorktree: repository.root,
    };

    await writeFile(join(repository.root, ".git/info/exclude"), "");
    await expect(prepareRepositoryPreflight(input)).rejects.toMatchObject({
      code: "YS_CRAFT_STATE_NOT_IGNORED",
    });

    await writeFile(join(repository.root, ".git/info/exclude"), "/.opencode/yuansheng/\n");
    await expect(prepareRepositoryPreflight(input)).rejects.toMatchObject({
      code: "YS_CRAFT_STATE_NOT_IGNORED",
    });

    await writeFile(join(repository.root, ".git/info/exclude"), "/.opencode/yuansheng/workflow/\n");
    const outside = await mkdtemp(join(tmpdir(), "ys-craft-state-outside-"));
    const stateRoot = join(repository.root, ".opencode/yuansheng/workflow");
    await symlink(outside, stateRoot);
    await expect(prepareRepositoryPreflight(input)).rejects.toMatchObject({
      code: "YS_CRAFT_STATE_PATH_UNSAFE",
    });
    await unlink(stateRoot);
  });

  test("rejects dirty, wrong HEAD, wrong remote, and non-local config identity", async () => {
    const repository = await makeRepository();
    const controller = await loadOpenCodeCraftController({
      directory: repository.root,
      worktree: repository.root,
    });
    const git = createOpenCodeGitRunner(repository.root);
    const base = {
      configDocument: controller.configDocument,
      configPath: controller.configPath,
      controllerRoot: controller.controllerRoot,
      createdAt: CREATED_AT,
      expectation: {
        commitSha: repository.commitSha,
        repositoryUrl: REPOSITORY_URL,
      },
      git,
      preparationMode: "manual" as const,
      stateRootPath: controller.stateRootPath,
      targetWorktree: repository.root,
    };

    await writeFile(join(repository.root, "untracked.txt"), "dirty\n");
    await expect(prepareRepositoryPreflight(base)).rejects.toMatchObject({
      code: "YS_CRAFT_REPOSITORY_DIRTY",
    });
    await unlink(join(repository.root, "untracked.txt"));

    await expect(
      prepareRepositoryPreflight({
        ...base,
        expectation: {
          ...base.expectation,
          commitSha: "0".repeat(40),
        },
      }),
    ).rejects.toMatchObject({ code: "YS_CRAFT_REPOSITORY_MISMATCH" });

    await expect(
      prepareRepositoryPreflight({
        ...base,
        expectation: {
          ...base.expectation,
          repositoryUrl: "https://example.invalid/other.git",
        },
      }),
    ).rejects.toMatchObject({ code: "YS_CRAFT_REPOSITORY_MISMATCH" });

    const outsideConfig = join(
      await mkdtemp(join(tmpdir(), "ys-craft-config-drift-")),
      "craft.json",
    );
    await expect(
      prepareRepositoryPreflight({
        ...base,
        configPath: outsideConfig,
      }),
    ).rejects.toMatchObject({ code: "YS_CRAFT_CONFIG_DRIFT" });
  });

  test("requires one exact managed authorization before any Git or network operation", async () => {
    const repository = await makeRepository();
    const controller = await loadOpenCodeCraftController({
      directory: repository.root,
      worktree: repository.root,
    });
    const managedParent = await mkdtemp(join(tmpdir(), "ys-craft-managed-"));
    const destination = join(managedParent, "managed-checkout");
    const plan = buildManagedRepositoryPreparationPlan({
      config: controller.configDocument.config,
      controllerRoot: repository.root,
      destination,
      expectation: {
        commitSha: repository.commitSha,
        repositoryUrl: REPOSITORY_URL,
      },
      requestId: "request:MANAGEDPREP00001",
      stateRootPath: controller.stateRootPath,
    });
    const deniedRunner = new RecordingGitRunner(destination);
    await expect(
      executeManagedRepositoryPreparation({
        authorization: null,
        config: controller.configDocument.config,
        controllerRoot: repository.root,
        git: deniedRunner,
        plan,
        stateRootPath: controller.stateRootPath,
      }),
    ).rejects.toMatchObject({ code: "YS_CRAFT_MANAGED_PREPARATION_DENIED" });
    expect(deniedRunner.calls).toEqual([]);

    const allowedRunner = new RecordingGitRunner(destination);
    const result = await executeManagedRepositoryPreparation({
      authorization: {
        decision: "allow",
        plan_digest: plan.plan_digest,
        request_id: plan.request_id,
      },
      config: controller.configDocument.config,
      controllerRoot: repository.root,
      git: allowedRunner,
      plan,
      stateRootPath: controller.stateRootPath,
    });
    expect(allowedRunner.calls).toEqual(plan.git_argv.map((argv) => [...argv]));
    expect(result).toMatchObject({
      created_or_updated_paths: [destination],
      residual_paths: [],
      status: "ready",
    });
  });

  test("reports a preserved managed destination after a partial failure", async () => {
    const repository = await makeRepository();
    const controller = await loadOpenCodeCraftController({
      directory: repository.root,
      worktree: repository.root,
    });
    const managedParent = await mkdtemp(join(tmpdir(), "ys-craft-managed-failed-"));
    const destination = join(managedParent, "failed-checkout");
    const plan = buildManagedRepositoryPreparationPlan({
      config: controller.configDocument.config,
      controllerRoot: repository.root,
      destination,
      expectation: {
        commitSha: repository.commitSha,
        repositoryUrl: REPOSITORY_URL,
      },
      requestId: "request:MANAGEDPREP00002",
      stateRootPath: controller.stateRootPath,
    });
    const runner = new RecordingGitRunner(destination, 2);
    try {
      await executeManagedRepositoryPreparation({
        authorization: {
          decision: "allow",
          plan_digest: plan.plan_digest,
          request_id: plan.request_id,
        },
        config: controller.configDocument.config,
        controllerRoot: repository.root,
        git: runner,
        plan,
        stateRootPath: controller.stateRootPath,
      });
      throw new Error("Expected managed preparation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryPreflightError);
      expect(error).toMatchObject({
        code: "YS_CRAFT_MANAGED_PREPARATION_FAILED",
        residualPaths: [destination],
      });
    }
  });

  test("manual and managed observations produce the same immutable binding shape", async () => {
    const repository = await makeRepository();
    const controller = await loadOpenCodeCraftController({
      directory: repository.root,
      worktree: repository.root,
    });
    const base = {
      configDocument: controller.configDocument,
      configPath: controller.configPath,
      controllerRoot: controller.controllerRoot,
      createdAt: CREATED_AT,
      expectation: {
        commitSha: repository.commitSha,
        repositoryUrl: REPOSITORY_URL,
      },
      git: createOpenCodeGitRunner(repository.root),
      stateRootPath: controller.stateRootPath,
      targetWorktree: repository.root,
    };
    const manual = await prepareRepositoryPreflight({
      ...base,
      preparationMode: "manual",
    });
    const managed = await prepareRepositoryPreflight({
      ...base,
      createdOrUpdatedPaths: [repository.root],
      preparationMode: "managed",
    });
    const {
      artifact_digest: _manualDigest,
      preparation_mode: _manualMode,
      ...manualBinding
    } = manual.repository_binding;
    const {
      artifact_digest: _managedDigest,
      preparation_mode: _managedMode,
      ...managedBinding
    } = managed.repository_binding;
    expect(managedBinding).toEqual(manualBinding);
  });
});
