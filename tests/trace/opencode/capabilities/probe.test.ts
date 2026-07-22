import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

function requireRecord(label: string, value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`${label} did not return a JSON object`);
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

    const server = await probe.startServer();
    try {
      const command = findRecord(
        await server.request("/command"),
        (record) => record.name === "capability-command",
      );
      expect(command).toBeDefined();
      expect(command?.agent).toBe("capability");
      expect(command?.template).toContain(CapabilitySentinels.command);

      const httpAgent = findRecord(
        await server.request("/agent"),
        (record) => record.name === "capability",
      );
      expect(httpAgent).toBeDefined();
      expect(httpAgent?.prompt).toContain(CapabilitySentinels.agent);

      const httpSkill = findRecord(
        await server.request("/skill"),
        (record) => record.name === "capability-skill",
      );
      expect(httpSkill).toBeDefined();
      expect(httpSkill?.content).toContain(CapabilitySentinels.skill);

      const toolIds = await server.request("/experimental/tool/ids");
      expect(Array.isArray(toolIds)).toBeTrue();
      if (!Array.isArray(toolIds)) {
        throw new Error("OpenCode tool IDs endpoint did not return an array");
      }
      expect(toolIds).toContain("capability_echo");

      const providers = requireRecord(
        "OpenCode providers endpoint",
        await server.request("/config/providers"),
      );
      const capabilityProvider = findRecord(
        providers.providers,
        (record) => record.id === "capability",
      );
      expect(capabilityProvider).toMatchObject({
        id: "capability",
        name: "Local Capability Provider",
      });
      expect(providers.default).toEqual({ capability: "probe" });
    } finally {
      await server.stop();
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

    const requestsBeforeAsk = probe.provider.requests.length;
    const askedTool = await probe.run(
      "plugin-tool-ask",
      [
        "run",
        "--model",
        "capability/probe",
        "--agent",
        "capability-ask",
        "--format",
        "json",
        CapabilitySentinels.askProviderRequest,
      ],
      15_000,
    );
    requireSuccess("plugin tool ask probe", askedTool);
    expect(askedTool.stderr).toContain("permission requested: capability_echo (*); auto-rejecting");
    expect(askedTool.stdout).toContain("tool_use");
    expect(askedTool.stdout).toContain("The user rejected permission");
    expect(askedTool.stdout).toContain(CapabilitySentinels.askInput);
    expect(askedTool.stdout).not.toContain(CapabilitySentinels.toolResult);
    const askAgentRequests = probe.provider.requests
      .slice(requestsBeforeAsk)
      .filter((request) => JSON.stringify(request.body).includes(CapabilitySentinels.askAgent));
    expect(askAgentRequests).toHaveLength(1);

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

test("OpenCode cannot load a plugin that leaves its SDK external", async () => {
  const probe = await createProbeEnvironment({
    evidenceName: "sdk-external",
    pluginPackaging: "external",
  });
  try {
    const initialInventory = await probe.inventory();
    const generatedPlugin = await readFile(
      join(probe.opencodeDirectory, "plugins", "capability.js"),
      "utf8",
    );
    expect(generatedPlugin).toMatch(/from\s*["']@opencode-ai\/plugin(?:\/[^"']*)?["']/u);

    const result = await probe.run("sdk-external", [
      "--print-logs",
      "--log-level",
      "DEBUG",
      "debug",
      "agent",
      "capability",
      "--tool",
      "capability_echo",
      "--params",
      '{"value":"EXTERNAL_INPUT"}',
    ]);
    expect(result.timedOut).toBeFalse();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Tool capability_echo not found for agent capability");
    expect(result.stdout).not.toContain(CapabilitySentinels.toolResult);
    expect(await probe.inventory()).toEqual(initialInventory);
  } finally {
    await probe.cleanup();
  }
}, 60_000);
