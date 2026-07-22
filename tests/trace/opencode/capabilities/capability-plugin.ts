import { type Plugin, tool } from "@opencode-ai/plugin";

const TOOL_RESULT_SENTINEL = "CAPABILITY_TOOL_RESULT_SENTINEL";

export const CapabilityPlugin: Plugin = async () => ({
  tool: {
    capability_echo: tool({
      description: "Echo a capability-probe value and the OpenCode context.",
      args: {
        value: tool.schema.string(),
      },
      async execute({ value }, context) {
        await context.ask({
          always: ["*"],
          metadata: { value },
          patterns: ["*"],
          permission: "capability_echo",
        });
        return JSON.stringify({
          agent: context.agent,
          directory: context.directory,
          sentinel: TOOL_RESULT_SENTINEL,
          value,
          worktree: context.worktree,
        });
      },
    }),
  },
});
