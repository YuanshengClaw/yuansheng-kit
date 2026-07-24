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
      requires: ["verification-source-selection-skill", "workflow-coordination-skill"],
    },
    "craft-delivery-coordinator-agent": {
      kind: "agent",
      logicalPath: "agents/ys-craft-delivery-coordinator.md",
      source: {
        kind: "file",
        path: "plugins/craft/agents/ys-craft-delivery-coordinator.md",
      },
      requires: ["workflow-coordination-skill"],
    },
    "craft-patch-builder-agent": {
      kind: "agent",
      logicalPath: "agents/ys-craft-patch-builder.md",
      source: {
        kind: "file",
        path: "plugins/craft/agents/ys-craft-patch-builder.md",
      },
      requires: ["verification-source-selection-skill", "workflow-coordination-skill"],
    },
    "craft-patch-planner-agent": {
      kind: "agent",
      logicalPath: "agents/ys-craft-patch-planner.md",
      source: {
        kind: "file",
        path: "plugins/craft/agents/ys-craft-patch-planner.md",
      },
      requires: ["workflow-coordination-skill"],
    },
    "craft-patch-reviewer-agent": {
      kind: "agent",
      logicalPath: "agents/ys-craft-patch-reviewer.md",
      source: {
        kind: "file",
        path: "plugins/craft/agents/ys-craft-patch-reviewer.md",
      },
      requires: ["workflow-coordination-skill"],
    },
    "craft-regression-verifier-agent": {
      kind: "agent",
      logicalPath: "agents/ys-craft-regression-verifier.md",
      source: {
        kind: "file",
        path: "plugins/craft/agents/ys-craft-regression-verifier.md",
      },
      requires: ["verification-source-selection-skill", "workflow-coordination-skill"],
    },
    "craft-root-cause-analyst-agent": {
      kind: "agent",
      logicalPath: "agents/ys-craft-root-cause-analyst.md",
      source: {
        kind: "file",
        path: "plugins/craft/agents/ys-craft-root-cause-analyst.md",
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
    "craft-state-machine-engine": {
      kind: "workflow",
      logicalPath: "workflows/state-machine/engine.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/state-machine/engine.ts",
      },
      requires: [
        "craft-blueprint-import-transaction",
        "craft-contract-canonical",
        "craft-contract-generated-index",
        "craft-contract-parser",
        "craft-contract-strict-json",
        "craft-state-machine-phases",
        "craft-state-machine-principal",
      ],
    },
    "craft-state-machine-phase-commands": {
      kind: "workflow",
      logicalPath: "workflows/state-machine/phase-commands.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/state-machine/phase-commands.ts",
      },
      requires: [
        "craft-contract-canonical",
        "craft-contract-generated-index",
        "craft-contract-parser",
        "craft-state-machine-principal",
      ],
    },
    "craft-state-machine-phases": {
      kind: "workflow",
      logicalPath: "workflows/state-machine/phases.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/state-machine/phases.ts",
      },
      requires: ["craft-contract-generated-index"],
    },
    "craft-state-machine-principal": {
      kind: "workflow",
      logicalPath: "workflows/state-machine/principal.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/state-machine/principal.ts",
      },
      requires: ["craft-contract-generated-index", "craft-state-machine-phases"],
    },
    "craft-state-machine-stop-gate": {
      kind: "workflow",
      logicalPath: "workflows/state-machine/stop-gate.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/state-machine/stop-gate.ts",
      },
      requires: [
        "craft-contract-canonical",
        "craft-contract-generated-index",
        "craft-contract-parser",
        "craft-state-machine-principal",
      ],
    },
    "craft-store-filesystem": {
      kind: "workflow",
      logicalPath: "workflows/store/filesystem.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/store/filesystem.ts",
      },
    },
    "craft-store-index": {
      kind: "workflow",
      logicalPath: "workflows/store/index.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/store/index.ts",
      },
      requires: ["craft-store-runtime", "craft-store-records"],
    },
    "craft-store-records": {
      kind: "workflow",
      logicalPath: "workflows/store/records.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/store/records.ts",
      },
      requires: [
        "craft-contract-canonical",
        "craft-contract-generated-index",
        "craft-contract-strict-json",
      ],
    },
    "craft-store-runtime": {
      kind: "workflow",
      logicalPath: "workflows/store/atomic-store.ts",
      source: {
        kind: "file",
        path: "plugins/craft/workflows/store/atomic-store.ts",
      },
      requires: [
        "craft-contract-canonical",
        "craft-contract-generated-index",
        "craft-contract-parser",
        "craft-contract-strict-json",
        "craft-state-machine-engine",
        "craft-state-machine-principal",
        "craft-store-filesystem",
        "craft-store-records",
      ],
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
      requires: [
        "craft-entry-strategies",
        "craft-state-machine-phases",
        "craft-tool-surface-schema",
      ],
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
        "craft-delivery-coordinator-agent",
        "craft-patch-builder-agent",
        "craft-patch-planner-agent",
        "craft-patch-reviewer-agent",
        "craft-regression-verifier-agent",
        "craft-root-cause-analyst-agent",
        "craft-tool-surface",
        "opencode-package",
        "opencode-runtime-entry",
        "verification-source-selection-skill",
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
        "craft-state-machine-engine",
        "craft-state-machine-phase-commands",
        "craft-state-machine-phases",
        "craft-state-machine-principal",
        "craft-state-machine-stop-gate",
        "craft-store-index",
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
    "verification-source-selection-skill": {
      kind: "skill",
      logicalPath: "skills/verification-source-selection",
      source: {
        kind: "tree",
        path: "plugins/craft/skills/verification-source-selection",
      },
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
          {
            description:
              "Confirm one evidence-backed root cause for a problem-description workflow.",
            destination: ".opencode/agents/ys-craft-root-cause-analyst.md",
            id: "ys-craft-root-cause-analyst",
            mode: "subagent",
            resource: "craft-root-cause-analyst-agent",
          },
          {
            description: "Plan the smallest causal patch and its exact mutation authorization.",
            destination: ".opencode/agents/ys-craft-patch-planner.md",
            id: "ys-craft-patch-planner",
            mode: "subagent",
            resource: "craft-patch-planner-agent",
          },
          {
            description: "Implement the approved patch and capture its immutable candidate.",
            destination: ".opencode/agents/ys-craft-patch-builder.md",
            id: "ys-craft-patch-builder",
            mode: "subagent",
            resource: "craft-patch-builder-agent",
          },
          {
            description: "Select and run controlled verification for one immutable candidate.",
            destination: ".opencode/agents/ys-craft-regression-verifier.md",
            id: "ys-craft-regression-verifier",
            mode: "subagent",
            resource: "craft-regression-verifier-agent",
          },
          {
            description: "Independently review one verified immutable patch candidate.",
            destination: ".opencode/agents/ys-craft-patch-reviewer.md",
            id: "ys-craft-patch-reviewer",
            mode: "subagent",
            resource: "craft-patch-reviewer-agent",
          },
          {
            description: "Assemble the final immutable delivery and user handoff.",
            destination: ".opencode/agents/ys-craft-delivery-coordinator.md",
            id: "ys-craft-delivery-coordinator",
            mode: "subagent",
            resource: "craft-delivery-coordinator-agent",
          },
        ],
        copies: [
          {
            destination: ".opencode/skills/ys-craft-verification-source-selection",
            resource: "verification-source-selection-skill",
          },
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
          external: ["node:crypto", "node:fs", "node:fs/promises", "node:path"],
          packageResource: "opencode-package",
        },
      } satisfies OpenCodeConfiguration,
    },
  },
} satisfies PluginConfigDefinitionV1;
