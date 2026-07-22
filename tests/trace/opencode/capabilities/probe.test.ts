import { expect, test } from "bun:test";
import {
  CapabilitySentinels,
  type CommandResult,
  createProbeEnvironment,
  findRecord,
  parseJson,
} from "./harness";

function requireSuccess(label: string, result: CommandResult): void {
  if (result.exitCode === 0 && !result.timedOut) {
    return;
  }
  throw new Error(
    `${label} failed (exit ${result.exitCode}, timeout ${result.timedOut})\n` +
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

test("OpenCode discovers and executes isolated capability fixtures", async () => {
  const probe = await createProbeEnvironment();
  try {
    const initialInventory = await probe.inventory();

    const version = await probe.run("version", ["--version"]);
    requireSuccess("version probe", version);
    expect(version.stdout.trim()).toBe(probe.expectedVersion);

    const paths = await probe.run("paths", ["debug", "paths"]);
    requireSuccess("path isolation probe", paths);
    expect(paths.stdout).toContain(probe.root);
    const userHome = process.env.HOME;
    if (userHome !== undefined && !probe.root.startsWith(userHome)) {
      expect(paths.stdout).not.toContain(userHome);
    }

    const agent = await probe.run("agent", ["debug", "agent", "capability"]);
    requireSuccess("Agent discovery probe", agent);
    expect(agent.stdout).toContain(CapabilitySentinels.agent);
    expect(agent.stdout).toContain('"providerID": "capability"');
    expect(agent.stdout).toContain('"modelID": "probe"');

    const skills = await probe.run("skills", ["debug", "skill"]);
    requireSuccess("Skill discovery probe", skills);
    const skill = findRecord(
      parseJson(skills.stdout),
      (record) => record.name === "capability-skill",
    );
    expect(skill).toBeDefined();
    expect(skill?.content).toContain(CapabilitySentinels.skill);
    expect(skill?.location).toContain(probe.opencodeDirectory);

    const loadedSkill = await probe.run("skill-tool", [
      "debug",
      "agent",
      "capability",
      "--tool",
      "skill",
      "--params",
      '{"name":"capability-skill"}',
    ]);
    requireSuccess("Skill tool probe", loadedSkill);
    expect(loadedSkill.stdout).toContain(CapabilitySentinels.skill);

    const allowedTool = await probe.run("plugin-tool-allow", [
      "debug",
      "agent",
      "capability",
      "--tool",
      "capability_echo",
      "--params",
      JSON.stringify({ value: CapabilitySentinels.toolInput }),
    ]);
    requireSuccess("plugin tool allow probe", allowedTool);
    expect(allowedTool.stdout).toContain(CapabilitySentinels.toolInput);
    expect(allowedTool.stdout).toContain(CapabilitySentinels.toolResult);
    expect(allowedTool.stdout).toContain(probe.projectDirectory);

    const deniedTool = await probe.run("plugin-tool-deny", [
      "debug",
      "agent",
      "capability-denied",
      "--tool",
      "capability_echo",
      "--params",
      '{"value":"MUST_NOT_RUN"}',
    ]);
    expect(deniedTool.timedOut).toBeFalse();
    expect(deniedTool.exitCode).not.toBe(0);
    expect(deniedTool.stderr).toContain("capability_echo");
    expect(deniedTool.stderr.toLowerCase()).toContain("disabled");
    expect(deniedTool.stdout).not.toContain(CapabilitySentinels.toolResult);

    const command = await probe.run("command-provider", [
      "run",
      "--model",
      "capability/probe",
      "--command",
      "capability-command",
      "--format",
      "json",
      "--",
      CapabilitySentinels.argument,
    ]);
    requireSuccess("command and local provider probe", command);
    expect(command.stdout).toContain(CapabilitySentinels.provider);
    const providerRequests = probe.provider.requests.filter(
      (request) => request.path === "/v1/chat/completions",
    );
    expect(providerRequests.length).toBeGreaterThan(0);
    const requestText = JSON.stringify(providerRequests.map((request) => request.body));
    expect(requestText).toContain(CapabilitySentinels.agent);
    expect(requestText).toContain(CapabilitySentinels.command);
    expect(requestText).toContain(CapabilitySentinels.argument);

    expect(await probe.inventory()).toEqual(initialInventory);
  } finally {
    await probe.cleanup();
  }
}, 120_000);
