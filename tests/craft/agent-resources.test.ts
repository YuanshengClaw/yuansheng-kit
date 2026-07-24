import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import pluginConfig from "../../plugins/craft/plugin.config";
import {
  PHASE_OWNED_ARTIFACTS,
  PHASE_OWNER,
  YS_CRAFT_AGENT_IDS,
} from "../../plugins/craft/workflows/state-machine/phases";
import { CRAFT_TOOL_SURFACE } from "../../plugins/craft/workflows/tool-surface";

const AGENT_DIRECTORY = join(import.meta.dir, "../../plugins/craft/agents");
const SKILL_DIRECTORY = join(import.meta.dir, "../../plugins/craft/skills");

const EXPECTED_AGENT_RESOURCES = Object.freeze({
  "ys-craft": "craft-agent",
  "ys-craft-delivery-coordinator": "craft-delivery-coordinator-agent",
  "ys-craft-patch-builder": "craft-patch-builder-agent",
  "ys-craft-patch-planner": "craft-patch-planner-agent",
  "ys-craft-patch-reviewer": "craft-patch-reviewer-agent",
  "ys-craft-regression-verifier": "craft-regression-verifier-agent",
  "ys-craft-root-cause-analyst": "craft-root-cause-analyst-agent",
} as const);

const EXPECTED_ROLE_CONTRACTS = Object.freeze({
  "ys-craft-delivery-coordinator": {
    artifacts: ["Delivery"],
    phase: "delivering",
    tools: [
      "ys_craft_status",
      "ys_craft_record_artifact",
      "ys_craft_complete",
      "ys_craft_return_to_phase",
    ],
  },
  "ys-craft-patch-builder": {
    artifacts: ["DiffManifest", "PatchCandidate"],
    phase: "building",
    tools: [
      "ys_craft_status",
      "ys_craft_record_artifact",
      "ys_craft_capture_candidate",
      "ys_craft_transition",
      "ys_craft_return_to_phase",
    ],
  },
  "ys-craft-patch-planner": {
    artifacts: ["PatchPlan", "MutationAuthorization"],
    phase: "planning",
    tools: [
      "ys_craft_status",
      "ys_craft_record_artifact",
      "ys_craft_transition",
      "ys_craft_return_to_phase",
    ],
  },
  "ys-craft-patch-reviewer": {
    artifacts: ["PatchReview"],
    phase: "reviewing",
    tools: [
      "ys_craft_status",
      "ys_craft_record_artifact",
      "ys_craft_transition",
      "ys_craft_return_to_phase",
    ],
  },
  "ys-craft-regression-verifier": {
    artifacts: [
      "VerificationSource",
      "VerificationManifest",
      "VerificationAuthorization",
      "CriterionEvidence",
    ],
    phase: "verifying",
    tools: [
      "ys_craft_status",
      "ys_craft_prepare_verification",
      "ys_craft_run_verification",
      "ys_craft_record_artifact",
      "ys_craft_transition",
      "ys_craft_return_to_phase",
    ],
  },
  "ys-craft-root-cause-analyst": {
    artifacts: ["RootCauseArtifact"],
    phase: "root_cause",
    tools: ["ys_craft_status", "ys_craft_record_artifact", "ys_craft_transition"],
  },
} as const);

const EXPECTED_PRIMARY_TOOLS = Object.freeze([
  "ys_craft_start_problem",
  "ys_craft_review_blueprint",
  "ys_craft_prepare_repository",
  "ys_craft_status",
  "ys_craft_resume",
]);

function extractBacktickedTools(prompt: string): readonly string[] {
  return [
    ...new Set([...prompt.matchAll(/`(ys_craft_[a-z_]+)`/gu)].map((match) => match[1] as string)),
  ];
}

function extractSkillReferences(prompt: string): readonly string[] {
  return [
    ...new Set(
      [...prompt.matchAll(/\$([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/gu)].map(
        (match) => match[1] as string,
      ),
    ),
  ];
}

test("OpenCode assembly declares exactly one primary and the six phase subagents", () => {
  const { agents, copies } = pluginConfig.platforms.opencode.configuration;
  expect(agents.map(({ id }) => id)).toEqual([...YS_CRAFT_AGENT_IDS]);
  expect(agents.filter(({ mode }) => mode === "primary").map(({ id }) => id)).toEqual(["ys-craft"]);
  expect(agents.filter(({ mode }) => mode === "subagent")).toHaveLength(6);

  for (const agent of agents) {
    expect(agent.resource).toBe(
      EXPECTED_AGENT_RESOURCES[agent.id as keyof typeof EXPECTED_AGENT_RESOURCES],
    );
    expect(agent.destination).toBe(`.opencode/agents/${agent.id}.md`);
  }

  expect(copies).toEqual([
    {
      destination: ".opencode/skills/ys-craft-verification-source-selection",
      resource: "verification-source-selection-skill",
    },
    {
      destination: ".opencode/skills/ys-craft-workflow-coordination",
      resource: "workflow-coordination-skill",
    },
  ]);

  const handlerRequirements = pluginConfig.resources["opencode-platform-handler"].requires;
  expect(handlerRequirements).toEqual(
    expect.arrayContaining([
      ...Object.values(EXPECTED_AGENT_RESOURCES),
      "verification-source-selection-skill",
      "workflow-coordination-skill",
    ]),
  );
});

test("agent prompts freeze phase ownership, artifacts, tools, and stop boundaries", async () => {
  const toolSurface: ReadonlySet<string> = new Set(CRAFT_TOOL_SURFACE.map(({ id }) => id));
  const promptSkillReferences = new Set<string>();

  for (const [agentId, contract] of Object.entries(EXPECTED_ROLE_CONTRACTS)) {
    const prompt = await readFile(join(AGENT_DIRECTORY, `${agentId}.md`), "utf8");
    expect(String(PHASE_OWNER[contract.phase])).toBe(agentId);
    expect(prompt).toContain(`\`${contract.phase}\``);
    expect(prompt).toMatch(/stop conditions/iu);
    expect(prompt).toMatch(/stop/iu);

    for (const artifact of contract.artifacts) {
      expect(prompt).toContain(`\`${artifact}\``);
    }

    const promptTools = extractBacktickedTools(prompt);
    expect(promptTools).toEqual([...contract.tools]);
    expect(promptTools.every((tool) => toolSurface.has(tool))).toBe(true);
    for (const skill of extractSkillReferences(prompt)) {
      promptSkillReferences.add(skill);
    }
  }

  const primaryPrompt = await readFile(join(AGENT_DIRECTORY, "ys-craft.md"), "utf8");
  expect(primaryPrompt).toContain("You own no phase artifact.");
  expect(extractBacktickedTools(primaryPrompt)).toEqual([...EXPECTED_PRIMARY_TOOLS]);
  for (const skill of extractSkillReferences(primaryPrompt)) {
    promptSkillReferences.add(skill);
  }

  const builderPrompt = await readFile(join(AGENT_DIRECTORY, "ys-craft-patch-builder.md"), "utf8");
  expect(builderPrompt).toContain("the only role allowed to modify product files");
  for (const agentId of ["ys-craft-patch-reviewer", "ys-craft-delivery-coordinator"] as const) {
    const prompt = await readFile(join(AGENT_DIRECTORY, `${agentId}.md`), "utf8");
    expect(prompt).toMatch(/product worktree is\s+strictly read-only/iu);
  }

  expect(promptSkillReferences).toEqual(
    new Set(["ys-craft-verification-source-selection", "ys-craft-workflow-coordination"]),
  );
  expect(PHASE_OWNED_ARTIFACTS.intake).toEqual([]);
});

test("neutral agent and skill resources contain no platform configuration", async () => {
  const agentFiles = (await readdir(AGENT_DIRECTORY)).filter((file) => file.endsWith(".md"));
  const skillDirectories = await readdir(SKILL_DIRECTORY);
  const files = [
    ...agentFiles.map((file) => join(AGENT_DIRECTORY, file)),
    ...skillDirectories.map((directory) => join(SKILL_DIRECTORY, directory, "SKILL.md")),
  ];
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));

  expect(agentFiles.map((file) => basename(file, ".md")).sort()).toEqual(
    [...YS_CRAFT_AGENT_IDS].sort(),
  );
  for (const content of contents) {
    expect(content).not.toMatch(
      /OpenCode|\.opencode|@opencode|\bSDK\b|(?:model|permission|destination)\s*:/iu,
    );
  }

  const skillNames = contents
    .map((content) => content.match(/^name:\s*(.+)$/mu)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort();
  expect(skillNames).toEqual([
    "ys-craft-verification-source-selection",
    "ys-craft-workflow-coordination",
  ]);
});
