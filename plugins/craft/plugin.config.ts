import type { PluginConfigDefinitionV1 } from "../../tools/plugin-builder/src/config";
import type { OpenCodeConfiguration } from "./opencode/src/platform-handler";

export default {
  version: 1,
  plugin: {
    id: "craft",
    displayName: "Yuansheng Craft",
  },
  resources: {
    "craft-agent": {
      kind: "agent",
      logicalPath: "agents/ys-craft.md",
      source: {
        kind: "file",
        path: "plugins/craft/agents/ys-craft.md",
      },
      requires: ["workflow-coordination-skill"],
    },
    "craft-entry-strategies": {
      kind: "workflow",
      logicalPath: "workflows/entry-strategies/catalog.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/entry-strategies/catalog.ts",
      },
    },
    "craft-tool-surface": {
      kind: "workflow",
      logicalPath: "workflows/tool-surface.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/tool-surface.ts",
      },
      requires: ["craft-entry-strategies", "craft-tool-surface-schema"],
    },
    "craft-tool-surface-schema": {
      kind: "workflow-schema",
      logicalPath: "workflows/tool-surface-v1.schema.json",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/tool-surface-v1.schema.json",
      },
    },
    "opencode-package": {
      kind: "platform-package",
      logicalPath: "opencode/package.json",
      source: {
        kind: "file",
        path: "plugins/craft/opencode/package.json",
      },
    },
    "opencode-platform-handler": {
      kind: "platform-handler",
      logicalPath: "opencode/src/platform-handler.ts",
      source: {
        kind: "file",
        path: "plugins/craft/opencode/src/platform-handler.ts",
      },
      requires: [
        "craft-agent",
        "craft-tool-surface",
        "opencode-package",
        "opencode-runtime-entry",
        "workflow-coordination-skill",
      ],
    },
    "opencode-runtime-entry": {
      kind: "platform-runtime",
      logicalPath: "opencode/src/index.ts",
      source: {
        kind: "file",
        path: "plugins/craft/opencode/src/index.ts",
      },
      requires: ["craft-tool-surface"],
    },
    "workflow-coordination-skill": {
      kind: "skill",
      logicalPath: "skills/workflow-coordination",
      source: {
        kind: "tree",
        path: "plugins/craft/skills/workflow-coordination",
      },
    },
  },
  platforms: {
    opencode: {
      artifactName: "opencode-ys-craft",
      roots: ["opencode-platform-handler"],
      handler: {
        apiVersion: 1,
        resource: "opencode-platform-handler",
        export: "openCodePlatformHandler",
      },
      configuration: {
        agents: [
          {
            description:
              "Coordinate explicit Yuansheng Craft workflows without owning phase artifacts.",
            destination: ".opencode/agents/ys-craft.md",
            id: "ys-craft",
            mode: "primary",
            resource: "craft-agent",
          },
        ],
        copies: [
          {
            destination: ".opencode/skills/ys-craft-workflow-coordination",
            resource: "workflow-coordination-skill",
          },
        ],
        permissions: {
          "*": "deny",
          "ys_craft_*": "allow",
          skill: "allow",
        },
        runtime: {
          destination: ".opencode/plugins/ys-craft.js",
          entrypointResource: "opencode-runtime-entry",
          external: ["node:path"],
          packageResource: "opencode-package",
        },
      } satisfies OpenCodeConfiguration,
    },
  },
} satisfies PluginConfigDefinitionV1;
