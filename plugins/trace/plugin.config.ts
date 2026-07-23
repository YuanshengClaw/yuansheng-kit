import type {
  PluginConfigDefinitionV1,
  PluginConfigSourceV1,
} from "../../tools/plugin-builder/src/config";
import type { OpenCodeConfiguration } from "./opencode/src/platform-handler";

function file(path: string): PluginConfigSourceV1 {
  return { kind: "file", path };
}

function tree(path: string): PluginConfigSourceV1 {
  return { kind: "tree", path };
}

const openCodeConfiguration = {
  agent: {
    id: "ys-trace",
    resource: "trace-agent",
    destination: ".opencode/agents/ys-trace.md",
    description: "Read-only RISC-V performance root-cause analysis with Yuansheng Trace.",
    mode: "primary",
  },
  command: {
    id: "ys-trace",
    resource: "trace-command",
    destination: ".opencode/commands/ys-trace.md",
    description: "Start a Yuansheng Trace root-cause analysis run.",
    agent: "ys-trace",
    argumentPlaceholder: "$ARGUMENTS",
  },
  copies: [
    {
      resource: "write-root-cause-blueprint-skill",
      destination: ".opencode/skills/write-root-cause-blueprint",
    },
    {
      resource: "perf-data-validator",
      destination: ".opencode/yuansheng/tools/perf-data-validator",
    },
    {
      resource: "sg2044-hardware-profile",
      destination: ".opencode/yuansheng/resources/hardware-profiles/sg2044.json",
    },
  ],
  permissions: {
    bash: {
      "*": "deny",
      "env -u PYTHONHOME -u PYTHONPATH */bin/python* -P -B -s -m pip --isolated install --require-hashes --only-binary=:all: --no-deps --index-url * -r *requirements.txt*":
        "ask",
      "env -u PYTHONHOME -u PYTHONPATH python3.14 -P -B -s -m venv --clear *": "ask",
      "env -u PYTHONHOME PYTHONPATH=* */bin/python* -P -B -s -m perf_data_validator validate *":
        "ask",
      "env -u PYTHONHOME PYTHONPATH=* python3.14 -P -B -s -m perf_data_validator probe *": "ask",
    },
    edit: "deny",
    external_directory: "ask",
    read: "deny",
    skill: "allow",
    webfetch: "deny",
    websearch: "deny",
    write: "deny",
    ys_trace_cleanup_run: "allow",
    ys_trace_inventory_remote_input: "allow",
    ys_trace_provide_validation_report: "allow",
    ys_trace_ssh_transport: "ask",
    ys_trace_ssh_transfer: "ask",
    ys_trace_start: "allow",
    ys_trace_transfer_remote_input: "allow",
  },
  runtime: {
    cleanupTool: "ys_trace_cleanup_run",
    destination: ".opencode/plugins/ys-trace.js",
    entrypointResource: "opencode-runtime-entry",
    external: ["node:crypto", "node:fs", "node:fs/promises", "node:path", "node:url"],
    inventoryTool: "ys_trace_inventory_remote_input",
    packageResource: "opencode-package",
    reportTool: "ys_trace_provide_validation_report",
    startTool: "ys_trace_start",
    transferTool: "ys_trace_transfer_remote_input",
  },
  artifactRoot: {
    defaultRelativePath: ".opencode/yuansheng/blueprint",
    requiresResolvedAbsolutePath: true,
  },
} satisfies OpenCodeConfiguration;

export default {
  version: 1,
  plugin: {
    id: "trace",
    displayName: "Yuansheng Trace",
  },
  resources: {
    "artifact-transaction": {
      kind: "workflow",
      logicalPath: "workflows/artifact-transaction.ts",
      source: file("plugins/trace/workflows/artifact-transaction.ts"),
      requires: ["blueprint-pipeline", "root-cause-canonical-json", "trace-workflow"],
    },
    "blueprint-pipeline": {
      kind: "workflow",
      logicalPath: "workflows/blueprint-pipeline.ts",
      source: file("plugins/trace/workflows/blueprint-pipeline.ts"),
      requires: [
        "hardware-profile",
        "perf-data-validation-report",
        "root-cause-blueprint-type",
        "root-cause-blueprint-validator",
        "root-cause-canonical-json",
        "root-cause-semantic-rules",
        "root-cause-strict-json",
        "trace-workflow",
      ],
    },
    "hardware-profile": {
      kind: "workflow",
      logicalPath: "workflows/hardware-profile.ts",
      source: file("plugins/trace/workflows/hardware-profile.ts"),
      requires: ["root-cause-canonical-json", "root-cause-strict-json"],
    },
    "opencode-package": {
      kind: "platform-package",
      logicalPath: "opencode/package.json",
      source: file("plugins/trace/opencode/package.json"),
    },
    "opencode-local-ssh-snapshot": {
      kind: "platform-runtime",
      logicalPath: "opencode/src/local-ssh-snapshot.ts",
      source: file("plugins/trace/opencode/src/local-ssh-snapshot.ts"),
      requires: ["ssh-transport"],
    },
    "opencode-openssh-runtime": {
      kind: "platform-runtime",
      logicalPath: "opencode/src/openssh-runtime.ts",
      source: file("plugins/trace/opencode/src/openssh-runtime.ts"),
      requires: ["opencode-local-ssh-snapshot", "ssh-transport"],
    },
    "opencode-runtime-entry": {
      kind: "platform-runtime",
      logicalPath: "opencode/src/index.ts",
      source: file("plugins/trace/opencode/src/index.ts"),
      requires: ["hardware-profile", "opencode-openssh-runtime", "ssh-transport", "trace-workflow"],
    },
    "opencode-platform-handler": {
      kind: "platform-handler",
      logicalPath: "opencode/src/platform-handler.ts",
      source: file("plugins/trace/opencode/src/platform-handler.ts"),
      requires: [
        "opencode-package",
        "opencode-runtime-entry",
        "perf-data-validator",
        "sg2044-hardware-profile",
        "trace-agent",
        "trace-command",
        "write-root-cause-blueprint-skill",
      ],
    },
    "perf-data-validator": {
      kind: "tool",
      logicalPath: "tools/perf-data-validator",
      source: tree("plugins/trace/tools/perf-data-validator"),
    },
    "perf-data-validation-report": {
      kind: "workflow",
      logicalPath: "workflows/perf-data-validation-report.ts",
      source: file("plugins/trace/workflows/perf-data-validation-report.ts"),
      requires: [
        "perf-data-validation-report-schema",
        "root-cause-canonical-json",
        "root-cause-strict-json",
      ],
    },
    "perf-data-validation-report-schema": {
      kind: "workflow-schema",
      logicalPath: "workflows/perf-data-validation-report-v1.schema.json",
      source: file("plugins/trace/workflows/perf-data-validation-report-v1.schema.json"),
    },
    "root-cause-blueprint-type": {
      kind: "runtime-library",
      logicalPath:
        "runtime/root-cause-blueprint/generated/yuansheng-root-cause-blueprint-v1-lite.ts",
      source: file(
        "tools/yuansheng-root-cause-blueprint/src/generated/types/yuansheng-root-cause-blueprint-v1-lite.ts",
      ),
    },
    "root-cause-blueprint-validator": {
      kind: "runtime-library",
      logicalPath: "runtime/root-cause-blueprint/generated/validators.ts",
      source: file("tools/yuansheng-root-cause-blueprint/src/generated/validators.ts"),
    },
    "root-cause-canonical-json": {
      kind: "runtime-library",
      logicalPath: "runtime/root-cause-blueprint/canonical-json.ts",
      source: file("tools/yuansheng-root-cause-blueprint/src/canonical-json.ts"),
      requires: ["root-cause-strict-json"],
    },
    "root-cause-semantic-rules": {
      kind: "runtime-library",
      logicalPath: "runtime/root-cause-blueprint/semantic-rules.ts",
      source: file("tools/yuansheng-root-cause-blueprint/src/semantic-rules.ts"),
      requires: ["root-cause-blueprint-type"],
    },
    "root-cause-strict-json": {
      kind: "runtime-library",
      logicalPath: "runtime/root-cause-blueprint/strict-json.ts",
      source: file("tools/yuansheng-root-cause-blueprint/src/strict-json.ts"),
    },
    "sg2044-hardware-profile": {
      kind: "hardware-profile",
      logicalPath: "resources/hardware-profiles/sg2044.json",
      source: file("plugins/trace/resources/hardware-profiles/sg2044.json"),
    },
    "ssh-transport": {
      kind: "runtime-library",
      logicalPath: "transport/ssh-transport.ts",
      source: file("plugins/trace/transport/ssh-transport.ts"),
      requires: ["root-cause-canonical-json"],
    },
    "trace-agent": {
      kind: "agent",
      logicalPath: "agents/trace.md",
      source: file("plugins/trace/agents/trace.md"),
      requires: ["write-root-cause-blueprint-skill"],
    },
    "trace-command": {
      kind: "command",
      logicalPath: "commands/trace.md",
      source: file("plugins/trace/commands/trace.md"),
      requires: ["trace-agent", "trace-workflow"],
    },
    "trace-workflow": {
      kind: "workflow",
      logicalPath: "workflows/trace-workflow.ts",
      source: file("plugins/trace/workflows/trace-workflow.ts"),
      requires: ["hardware-profile", "perf-data-validation-report", "root-cause-canonical-json"],
    },
    "write-root-cause-blueprint-skill": {
      kind: "skill",
      logicalPath: "skills/write-root-cause-blueprint",
      source: tree("plugins/trace/skills/write-root-cause-blueprint"),
    },
  },
  platforms: {
    opencode: {
      artifactName: "@yuansheng-kit/opencode-ys-trace",
      roots: ["opencode-platform-handler"],
      handler: {
        apiVersion: 1,
        resource: "opencode-platform-handler",
        export: "openCodePlatformHandler",
      },
      configuration: openCodeConfiguration,
    },
  },
} satisfies PluginConfigDefinitionV1;
