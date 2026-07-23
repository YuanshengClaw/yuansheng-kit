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
    "craft-contract-canonical": {
      kind: "workflow",
      logicalPath: "workflows/artifacts/canonical.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/artifacts/canonical.ts",
      },
      requires: ["craft-contract-strict-json"],
    },
    "craft-contract-generated-index": {
      kind: "workflow",
      logicalPath: "workflows/artifacts/generated/index.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/artifacts/generated/index.ts",
      },
      requires: ["craft-contract-generated-types", "craft-contract-validator"],
    },
    "craft-contract-generated-types": {
      kind: "workflow",
      logicalPath: "workflows/artifacts/generated/types/ys-craft-contract-v1.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/artifacts/generated/types/ys-craft-contract-v1.ts",
      },
    },
    "craft-contract-parser": {
      kind: "workflow",
      logicalPath: "workflows/artifacts/parser.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/artifacts/parser.ts",
      },
      requires: [
        "craft-contract-canonical",
        "craft-contract-generated-index",
        "craft-contract-strict-json",
      ],
    },
    "craft-contract-schema": {
      kind: "workflow-schema",
      logicalPath: "workflows/artifacts/ys-craft-contracts-v1.schema.json",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/artifacts/ys-craft-contracts-v1.schema.json",
      },
    },
    "craft-contract-strict-json": {
      kind: "workflow",
      logicalPath: "workflows/artifacts/strict-json.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/artifacts/strict-json.ts",
      },
    },
    "craft-contract-validator": {
      kind: "workflow",
      logicalPath: "workflows/artifacts/generated/validators.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/artifacts/generated/validators.ts",
      },
      requires: ["craft-contract-schema"],
    },
    "craft-blueprint-import-transaction": {
      kind: "workflow",
      logicalPath: "workflows/blueprint-import/transaction.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/blueprint-import/transaction.ts",
      },
      requires: [
        "craft-blueprint-import-verifier",
        "craft-contract-canonical",
        "craft-contract-generated-index",
        "craft-contract-parser",
        "craft-contract-strict-json",
      ],
    },
    "craft-blueprint-import-verifier": {
      kind: "workflow",
      logicalPath: "workflows/blueprint-import/sealed-verifier.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/blueprint-import/sealed-verifier.ts",
      },
      requires: [
        "craft-contract-canonical",
        "craft-contract-strict-json",
        "root-cause-blueprint-type",
        "root-cause-blueprint-validator",
        "root-cause-semantic-rules",
      ],
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
      requires: [
        "craft-blueprint-import-transaction",
        "craft-blueprint-import-verifier",
        "craft-contract-parser",
        "craft-tool-surface",
      ],
    },
    "root-cause-blueprint-type": {
      kind: "runtime-library",
      logicalPath:
        "runtime/root-cause-blueprint/generated/yuansheng-root-cause-blueprint-v1-lite.ts",
      source: {
        kind: "file",
        path: "tools/yuansheng-root-cause-blueprint/src/generated/types/yuansheng-root-cause-blueprint-v1-lite.ts",
      },
    },
    "root-cause-blueprint-validator": {
      kind: "runtime-library",
      logicalPath: "runtime/root-cause-blueprint/generated/validators.ts",
      source: {
        kind: "file",
        path: "tools/yuansheng-root-cause-blueprint/src/generated/validators.ts",
      },
    },
    "root-cause-semantic-rules": {
      kind: "runtime-library",
      logicalPath: "runtime/root-cause-blueprint/semantic-rules.ts",
      source: {
        kind: "file",
        path: "tools/yuansheng-root-cause-blueprint/src/semantic-rules.ts",
      },
      requires: ["root-cause-blueprint-type"],
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
          external: ["node:crypto", "node:fs/promises", "node:path"],
          packageResource: "opencode-package",
        },
      } satisfies OpenCodeConfiguration,
    },
  },
} satisfies PluginConfigDefinitionV1;
