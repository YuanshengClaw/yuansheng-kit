import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSshSnapshotMapping,
  createSshTransportPlan,
  createSshTransportState,
  parseSshCleanup,
  parseSshInventory,
  parseSshStage,
  SSH_REMOTE_SCRIPT,
  SshTransportError,
  type SshTransportPlanEnvelope,
  transitionSshTransport,
} from "../../../plugins/trace/transport/ssh-transport";
import { canonicalizeJson } from "../../../tools/yuansheng-root-cause-blueprint/src/canonical-json";

interface RemoteResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: Uint8Array;
}

function runId(): string {
  return randomBytes(16).toString("hex");
}

function planFor(
  remoteRoot: string,
  id: string,
  limits: Readonly<Record<string, number>> = {},
): SshTransportPlanEnvelope {
  return createSshTransportPlan({
    alias: "trace-fixture",
    limits,
    localStagingRoot: `/tmp/yuansheng-ssh-local-${id}`,
    remoteRoot,
    runId: id,
    sessionId: "ssh-transport-test-session",
    sftpExecutable: "/usr/bin/sftp",
    sftpExecutableSha256: "2".repeat(64),
    sshExecutable: "/usr/bin/ssh",
    sshExecutableSha256: "1".repeat(64),
  });
}

function remoteOperationName(
  operation: keyof SshTransportPlanEnvelope["plan"]["commands"],
): string {
  return operation === "inventory_cleanup" ? "inventory-cleanup" : operation;
}

async function runRemote(
  plan: SshTransportPlanEnvelope,
  operation: keyof SshTransportPlanEnvelope["plan"]["commands"],
  substitutions: Readonly<Record<string, string>> = {},
): Promise<RemoteResult> {
  const remoteOperation = remoteOperationName(operation);
  const approved = plan.plan.commands[operation].argv;
  const operationIndex = approved.indexOf(remoteOperation);
  if (operationIndex < 0) {
    throw new Error(`The ${operation} plan has no remote operation`);
  }
  const args = approved
    .slice(operationIndex + 1)
    .map((argument) => substitutions[argument] ?? argument);
  const child = Bun.spawn(["bash", "-s", "--", remoteOperation, ...args], {
    stdin: new TextEncoder().encode(SSH_REMOTE_SCRIPT),
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout: new Uint8Array(stdout) };
}

function requireRemoteSuccess(result: RemoteResult): Uint8Array {
  if (result.exitCode !== 0) {
    throw new Error(`Remote protocol failed (${result.exitCode}): ${result.stderr}`);
  }
  return result.stdout;
}

function expectTransportError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected SSH transport operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SshTransportError);
    expect(error).toMatchObject({ code });
  }
}

test("SSH plans bind exact safe commands, session, run, and approval", () => {
  const id = "1".repeat(32);
  const remoteRoot = "/srv/perf data/line\n'$(touch ignored)'";
  const plan = planFor(remoteRoot, id);

  expect(JSON.stringify(plan.plan.commands)).not.toContain(remoteRoot);
  expect(plan.plan.executable_sha256).toEqual({ sftp: "2".repeat(64), ssh: "1".repeat(64) });
  expect(plan.plan.location.remote_root_utf8).toBe(remoteRoot);
  expect(plan.plan.commands.inventory.argv).toContain(
    Buffer.from(remoteRoot, "utf8").toString("base64"),
  );
  expect(planFor(`${remoteRoot}-changed`, id).plan_sha256).not.toBe(plan.plan_sha256);
  expectTransportError(
    () => planFor(remoteRoot, id, { maxFiles: 2, maxEntries: 1 }),
    "input_invalid",
  );
  expectTransportError(
    () =>
      createSshTransportPlan({
        alias: "host;touch-pwned",
        localStagingRoot: `/tmp/yuansheng-ssh-local-${id}`,
        remoteRoot,
        runId: id,
        sessionId: "session",
        sftpExecutable: "/usr/bin/sftp",
        sftpExecutableSha256: "2".repeat(64),
        sshExecutable: "/usr/bin/ssh",
        sshExecutableSha256: "1".repeat(64),
      }),
    "input_invalid",
  );

  const forgedPlan = {
    ...plan.plan,
    commands: {
      ...plan.plan.commands,
      inventory: {
        ...plan.plan.commands.inventory,
        argv: [...plan.plan.commands.inventory.argv, "unexpected-command"],
      },
    },
  };
  const forged = {
    plan: forgedPlan,
    plan_sha256: canonicalizeJson(forgedPlan).sha256,
  } as SshTransportPlanEnvelope;
  expectTransportError(
    () => createSshTransportState(forged, { runId: id, sessionId: "ssh-transport-test-session" }),
    "plan_mismatch",
  );

  const initial = createSshTransportState(plan, {
    runId: id,
    sessionId: "ssh-transport-test-session",
  });
  expectTransportError(
    () => transitionSshTransport(initial, { plan_sha256: "0".repeat(64), type: "approve_plan" }),
    "plan_mismatch",
  );
  expect(
    transitionSshTransport(initial, { plan_sha256: plan.plan_sha256, type: "approve_plan" }).phase,
  ).toBe("awaiting_inventory");
});

test("fixed Linux protocol preserves raw paths and binds inventory, stage, objects, and cleanup", async () => {
  const source = await mkdtemp(join(tmpdir(), "yuansheng-ssh-source-"));
  const id = runId();
  let stagedTemp: string | undefined;
  try {
    await mkdir(join(source, "empty"));
    await mkdir(join(source, "raw"));
    await writeFile(join(source, "normal file"), "normal-content");
    const rawFile = Buffer.concat([
      Buffer.from(`${source}/raw/`, "utf8"),
      Buffer.from([0xff, 0x0a, 0x78]),
    ]);
    await writeFile(rawFile, "raw-content");

    const plan = planFor(source, id, {
      maxEntries: 32,
      maxFileBytes: 1024,
      maxFiles: 8,
      maxTotalBytes: 4096,
    });
    let state = createSshTransportState(plan, {
      runId: id,
      sessionId: "ssh-transport-test-session",
    });
    state = transitionSshTransport(state, {
      plan_sha256: plan.plan_sha256,
      type: "approve_plan",
    });

    const probe = await runRemote(plan, "probe");
    expect(new TextDecoder().decode(requireRemoteSuccess(probe))).toBe("YS_TRACE_SSH_PROBE_V1\n");
    const inventory = parseSshInventory(
      requireRemoteSuccess(await runRemote(plan, "inventory")),
      plan,
    );
    expect(inventory.inventory).toMatchObject({ directories: 2, files: 2 });
    expect(inventory.inventory.entries.some((entry) => entry.path_utf8 === null)).toBeTrue();
    state = transitionSshTransport(state, { inventory, type: "bind_inventory" });
    expect(state.phase).toBe("awaiting_transfer_confirmation");
    state = transitionSshTransport(state, {
      inventory_sha256: inventory.inventory_sha256,
      type: "confirm_transfer",
    });

    const stageResult = parseSshStage(
      requireRemoteSuccess(
        await runRemote(plan, "stage", {
          YS_TRACE_CONFIRMED_INVENTORY_SHA256: inventory.inventory_sha256,
        }),
      ),
      plan,
      inventory.inventory_sha256,
    );
    if (!stageResult.ok) {
      throw new Error(`Expected stage acceptance: ${stageResult.error_message}`);
    }
    const { stage } = stageResult;
    stagedTemp = stage.stage.remote_temp;
    expect(stage.stage.objects.map((object) => object.object_id)).toEqual([
      "f00000001",
      "f00000002",
    ]);
    expect(await readFile(join(stagedTemp, "objects", "f00000001"), "utf8")).toBe("normal-content");
    state = transitionSshTransport(state, { stage, type: "bind_stage" });
    expect(state.phase).toBe("downloading");
    expect(createSshSnapshotMapping({ plan, stage }).mapping.stage_sha256).toBe(stage.stage_sha256);

    const cleanupBytes = requireRemoteSuccess(
      await runRemote(plan, "cleanup", {
        YS_TRACE_OWNER_MARKER_SHA256: stage.stage.owner_marker_sha256,
        YS_TRACE_REMOTE_TEMP_BASE64: stage.stage.remote_temp_base64,
      }),
    );
    expect(
      parseSshCleanup(cleanupBytes, {
        cleanupLease: stageResult.cleanup_lease,
        plan,
      }).remote_temp_removed,
    ).toBeTrue();
    await expect(lstat(stagedTemp)).rejects.toMatchObject({ code: "ENOENT" });
    stagedTemp = undefined;
  } finally {
    if (stagedTemp !== undefined) {
      await rm(stagedTemp, { force: true, recursive: true });
    }
    await rm(source, { force: true, recursive: true });
  }
});

test("a rejected stage retains its exact remote cleanup lease", async () => {
  const source = await mkdtemp(join(tmpdir(), "yuansheng-ssh-changed-"));
  const id = runId();
  let stagedTemp: string | undefined;
  try {
    const sourceFile = join(source, "changing-file");
    await writeFile(sourceFile, "confirmed-content");
    const plan = planFor(source, id, {
      maxEntries: 8,
      maxFileBytes: 1024,
      maxFiles: 4,
      maxTotalBytes: 4096,
    });
    let state = createSshTransportState(plan, {
      runId: id,
      sessionId: "ssh-transport-test-session",
    });
    state = transitionSshTransport(state, {
      plan_sha256: plan.plan_sha256,
      type: "approve_plan",
    });
    const inventory = parseSshInventory(
      requireRemoteSuccess(await runRemote(plan, "inventory")),
      plan,
    );
    state = transitionSshTransport(state, { inventory, type: "bind_inventory" });
    state = transitionSshTransport(state, {
      inventory_sha256: inventory.inventory_sha256,
      type: "confirm_transfer",
    });

    await writeFile(sourceFile, "changed-after-confirmation");
    const stageBytes = requireRemoteSuccess(
      await runRemote(plan, "stage", {
        YS_TRACE_CONFIRMED_INVENTORY_SHA256: inventory.inventory_sha256,
      }),
    );
    const truncatedResult = parseSshStage(
      stageBytes.subarray(0, stageBytes.byteLength - 1),
      plan,
      inventory.inventory_sha256,
    );
    expect(truncatedResult.ok).toBeFalse();
    const oversizedBytes = new Uint8Array(plan.plan.commands.stage.maximum_stdout_bytes + 1);
    oversizedBytes.set(stageBytes);
    const oversizedResult = parseSshStage(oversizedBytes, plan, inventory.inventory_sha256);
    expect(oversizedResult.ok).toBeFalse();

    const stageResult = parseSshStage(stageBytes, plan, inventory.inventory_sha256);
    expect(stageResult.ok).toBeFalse();
    if (stageResult.ok) {
      throw new Error("Expected the changed source stage to be rejected");
    }
    expect(stageResult.error_code).toBe("source_changed");
    if (truncatedResult.ok || oversizedResult.ok) {
      throw new Error("Expected malformed stage bodies to retain rejected cleanup leases");
    }
    expect(truncatedResult.cleanup_lease).toEqual(stageResult.cleanup_lease);
    expect(oversizedResult.cleanup_lease).toEqual(stageResult.cleanup_lease);
    stagedTemp = stageResult.cleanup_lease.remote_temp;
    expect((await lstat(stagedTemp)).isDirectory()).toBeTrue();

    state = transitionSshTransport(state, { rejection: stageResult, type: "reject_stage" });
    expect(state.phase).toBe("cleanup_pending");
    if (state.phase !== "cleanup_pending") {
      throw new Error("Expected rejected stage cleanup to be pending");
    }
    expect(state.cleanup_lease).toEqual(stageResult.cleanup_lease);

    const cleanup = parseSshCleanup(
      requireRemoteSuccess(
        await runRemote(plan, "cleanup", {
          YS_TRACE_OWNER_MARKER_SHA256: state.cleanup_lease.owner_marker_sha256,
          YS_TRACE_REMOTE_TEMP_BASE64: state.cleanup_lease.remote_temp_base64,
        }),
      ),
      { cleanupLease: state.cleanup_lease, plan },
    );
    state = transitionSshTransport(state, {
      cleanup: { ...cleanup, local_staging_removed: true },
      error_code: stageResult.error_code,
      type: "fail",
    });
    expect(state.phase).toBe("failed");
    if (state.phase !== "failed") {
      throw new Error("Expected rejected stage cleanup to produce a failed transport state");
    }
    expect(state.cleanup_lease).toEqual(stageResult.cleanup_lease);
    await expect(lstat(stagedTemp)).rejects.toMatchObject({ code: "ENOENT" });
    stagedTemp = undefined;
  } finally {
    if (stagedTemp !== undefined) {
      await rm(stagedTemp, { force: true, recursive: true });
    }
    await rm(source, { force: true, recursive: true });
  }
});

test("remote inventory rejects unsafe trees and never removes a pre-existing run path", async () => {
  const source = await mkdtemp(join(tmpdir(), "yuansheng-ssh-reject-"));
  const id = runId();
  const plan = planFor(source, id);
  const preexisting = plan.plan.remote_inventory_temp;
  try {
    await writeFile(join(source, "file"), "content");
    await mkdir(preexisting, { mode: 0o700 });
    await writeFile(join(preexisting, "sentinel"), "keep");
    const collision = await runRemote(plan, "inventory");
    expect(collision.exitCode).not.toBe(0);
    expect(await readFile(join(preexisting, "sentinel"), "utf8")).toBe("keep");

    await rm(preexisting, { recursive: true });
    await symlink(join(source, "file"), join(source, "link"));
    const linked = await runRemote(plan, "inventory");
    expect(linked.exitCode).not.toBe(0);
    expect(linked.stderr).toContain("YS_TRACE_REMOTE_ERROR:symbolic_link");
    await expect(lstat(preexisting)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(preexisting, { force: true, recursive: true });
    await rm(source, { force: true, recursive: true });
  }
});
