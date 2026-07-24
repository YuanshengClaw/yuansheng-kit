import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Hooks, ToolContext } from "@opencode-ai/plugin";

import type {
  MutationAuthorization,
  WorkflowState,
  YuanshengCraftContractV1,
} from "../../workflows/artifacts/generated";
import {
  assertAuthorizedFileMutation,
  type FileMutationRequest,
} from "../../workflows/building/write-guard";
import {
  auditTrustedPrincipal,
  issueTrustedPrincipal,
  type TrustedPrincipal,
} from "../../workflows/state-machine/principal";

interface ActiveBuilderContext {
  readonly activeArtifacts: readonly YuanshengCraftContractV1[];
  readonly principal: TrustedPrincipal;
  readonly state: WorkflowState;
}

export interface OpenCodeBuilderWriteGuard {
  readonly activateFromToolContext: (
    context: ToolContext,
    state: WorkflowState,
    activeArtifacts: readonly YuanshengCraftContractV1[],
  ) => void;
  readonly deactivate: (sessionId: string) => void;
  readonly hooks: Pick<Hooks, "chat.params" | "tool.execute.before">;
}

const MUTATION_TOOLS = new Set(["edit", "write"]);
const PROCESS_TOOLS = new Set(["bash", "process", "shell", "terminal"]);

function deny(message: string): never {
  throw new Error(`YS_CRAFT_OPENCODE_WRITE_DENIED: ${message}`);
}

function authorizationOf(artifacts: readonly YuanshengCraftContractV1[]): MutationAuthorization {
  const matches = artifacts.filter(
    (artifact): artifact is MutationAuthorization =>
      artifact.artifact_type === "mutation-authorization",
  );
  if (matches.length !== 1) {
    return deny("Active builder context must contain one mutation authorization");
  }
  return matches[0] as MutationAuthorization;
}

function extractToolPath(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return deny("write/edit args must be an object");
  }
  const record = args as Readonly<Record<string, unknown>>;
  const candidates = ["filePath", "file_path", "path"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (new Set(candidates).size !== 1) {
    return deny("write/edit must provide one unambiguous file path");
  }
  return candidates[0] as string;
}

function relativeProductPath(path: string, productRoot: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(productRoot, path);
  const child = relative(productRoot, absolute);
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`)) {
    return deny("write/edit target escaped the product root");
  }
  return child.split(sep).join("/");
}

function mutationRequest(
  toolName: string,
  path: string,
  authorization: MutationAuthorization,
): FileMutationRequest {
  const permittedOperations =
    toolName === "edit"
      ? new Set<FileMutationRequest["operation"]>(["modify"])
      : new Set<FileMutationRequest["operation"]>(["create", "modify"]);
  const matches = authorization.authorized_changes.filter(
    (change) => change.path === path && permittedOperations.has(change.operation),
  );
  if (matches.length !== 1) {
    return deny(`${toolName} path does not have one exact compatible approved operation`);
  }
  const match = matches[0];
  if (match === undefined) {
    return deny("Approved operation disappeared during guard evaluation");
  }
  return {
    operation: match.operation,
    path: match.path,
    sourcePath: match.source_path,
  };
}

export function createOpenCodeBuilderWriteGuard(): OpenCodeBuilderWriteGuard {
  const sessionAgents = new Map<string, string>();
  const activeBuilders = new Map<string, ActiveBuilderContext>();

  const hooks: OpenCodeBuilderWriteGuard["hooks"] = {
    async "chat.params"(input): Promise<void> {
      const previous = sessionAgents.get(input.sessionID);
      if (previous !== undefined && previous !== input.agent) {
        return deny("One OpenCode session cannot change Yuansheng Craft agent identity");
      }
      sessionAgents.set(input.sessionID, input.agent);
    },
    async "tool.execute.before"(input, output): Promise<void> {
      const context = activeBuilders.get(input.sessionID);
      if (PROCESS_TOOLS.has(input.tool)) {
        if (context !== undefined) {
          return deny("Building phase never permits Bash or process tools");
        }
        return;
      }
      if (!MUTATION_TOOLS.has(input.tool)) {
        return;
      }
      if (context === undefined) {
        return deny("write/edit requires an active authorized builder context");
      }
      const agent = sessionAgents.get(input.sessionID);
      const principal = auditTrustedPrincipal(context.principal);
      if (
        agent !== "ys-craft-patch-builder" ||
        principal.agent_id !== agent ||
        principal.session_id !== input.sessionID
      ) {
        return deny("write/edit session does not match platform-provided builder identity");
      }
      const authorization = authorizationOf(context.activeArtifacts);
      const productBinding = context.activeArtifacts.find(
        (artifact) => artifact.artifact_type === "repository-binding",
      );
      if (productBinding?.artifact_type !== "repository-binding") {
        return deny("Builder context lacks its repository binding");
      }
      const path = relativeProductPath(
        extractToolPath(output.args),
        productBinding.product_root_realpath,
      );
      await assertAuthorizedFileMutation({
        activeArtifacts: context.activeArtifacts,
        principal: context.principal,
        request: mutationRequest(input.tool, path, authorization),
        state: context.state,
      });
    },
  };

  return Object.freeze({
    activateFromToolContext(
      context: ToolContext,
      state: WorkflowState,
      activeArtifacts: readonly YuanshengCraftContractV1[],
    ): void {
      if (context.agent !== "ys-craft-patch-builder") {
        deny("Only a platform ToolContext for the patch builder may activate writes");
      }
      const observedAgent = sessionAgents.get(context.sessionID);
      if (observedAgent !== undefined && observedAgent !== context.agent) {
        deny("ToolContext conflicts with the platform chat agent identity");
      }
      sessionAgents.set(context.sessionID, context.agent);
      const principal = issueTrustedPrincipal({
        agentId: context.agent,
        sessionId: context.sessionID,
      });
      const authorization = authorizationOf(activeArtifacts);
      const audit = auditTrustedPrincipal(principal);
      if (
        authorization.principal.agent_id !== audit.agent_id ||
        authorization.principal.session_id !== audit.session_id
      ) {
        deny("ToolContext session differs from the immutable authorization");
      }
      activeBuilders.set(
        context.sessionID,
        Object.freeze({
          activeArtifacts: Object.freeze([...activeArtifacts]),
          principal,
          state,
        }),
      );
    },
    deactivate(sessionId: string): void {
      activeBuilders.delete(sessionId);
    },
    hooks,
  });
}
