import { type Plugin, type ToolDefinition, tool } from "@opencode-ai/plugin";

import { CRAFT_TOOL_SURFACE, type CraftToolId } from "../../workflows/tool-surface";
import {
  createDefaultOpenCodeCraftRuntimeDependencies,
  OpenCodeCraftRuntime,
} from "./adapter-runtime";
import { createOpenCodeBuilderWriteGuard } from "./builder-write-guard";
import {
  createOpenCodeBinaryGitRunner,
  createOpenCodeGitRunner,
  createOpenCodeLocalProcessRunner,
  createOpenCodeVerificationLogSink,
  loadOpenCodeCraftController,
} from "./controller-runtime";
import {
  createOpenCodeSshVerificationRunner,
  resolveSystemSshExecutable,
} from "./openssh-verification-runtime";

export type * from "../../workflows/artifacts/generated";
export {
  artifactRef,
  assertBlueprintPlanningEligible,
  parseCraftContractBytes,
  parseCraftContractGraph,
  validateCraftContractGraph,
} from "../../workflows/artifacts/parser";
export type {
  TraceFunctionIdentity,
  VerifiedEvidenceDigest,
  VerifiedSealedBlueprint,
  VerifiedSealedBlueprintSnapshot,
} from "../../workflows/blueprint-import/sealed-verifier";
export {
  snapshotVerifiedSealedBlueprint,
  verifySealedBlueprintDirectory,
} from "../../workflows/blueprint-import/sealed-verifier";
export type {
  BlueprintImportTransaction,
  BlueprintReviewContext,
  BlueprintReviewOutcome,
} from "../../workflows/blueprint-import/transaction";
export {
  buildBlueprintReviewAttestation,
  buildBlueprintReviewSubject,
  reviewBlueprintForImport,
} from "../../workflows/blueprint-import/transaction";
export type {
  BinaryGitCommandResult,
  BinaryGitRunner,
  CanonicalDiffSnapshot,
  CapturedPatchCandidate,
} from "../../workflows/building/candidate-capture";
export {
  assertCandidateWorktreeUnchanged,
  CandidateCaptureError,
  canonicalizeCapturedDiff,
  captureCanonicalDiff,
  capturePatchCandidate,
} from "../../workflows/building/candidate-capture";
export type {
  PatchPlanApprovalResult,
  PatchPlanProposal,
} from "../../workflows/building/plan-authorization";
export {
  approvePatchPlan,
  PatchPlanApprovalError,
} from "../../workflows/building/plan-authorization";
export type { FileMutationRequest } from "../../workflows/building/write-guard";
export {
  assertAuthorizedFileMutation,
  assertBuildingProcessDenied,
  FileMutationDeniedError,
} from "../../workflows/building/write-guard";
export type {
  GitCommandResult,
  GitRunner,
  ManagedRepositoryPreparationPlan,
  ManagedRepositoryPreparationResult,
  PreWorkflowPathPreview,
  RepositoryExpectation,
  RepositoryPreflightReceipt,
  RepositoryPreparationAuthorization,
  RepositoryPreparationMode,
} from "../../workflows/repository-preflight/preflight";
export {
  buildManagedRepositoryPreparationPlan,
  executeManagedRepositoryPreparation,
  prepareRepositoryPreflight,
  RepositoryPreflightError,
} from "../../workflows/repository-preflight/preflight";
export type {
  DeliveryProposal,
  DeliveryResult,
  PatchReviewProposal,
  PatchReviewResult,
} from "../../workflows/review-delivery/review-delivery";
export {
  prepareDelivery,
  ReviewDeliveryError,
  requestPatchChanges,
  reviewPatch,
} from "../../workflows/review-delivery/review-delivery";
export type {
  CommandProposal,
  CraftRuntimeConfig,
  LocalVerificationRunner,
  ParsedCraftRuntimeConfig,
  SshVerificationRunner,
  VerificationRunner,
} from "../../workflows/runtime-config/config";
export {
  CraftRuntimeConfigError,
  parseCraftRuntimeConfigBytes,
} from "../../workflows/runtime-config/config";
export type {
  BlockWorkflowInput,
  CreateBlueprintWorkflowInput,
  CreateProblemWorkflowInput,
  RebindBlockedWorkflowInput,
  RecordPhaseArtifactInput,
  ReturnWorkflowInput,
  TransitionWorkflowInput,
  WorkflowGuardCode,
} from "../../workflows/state-machine/engine";
export {
  activeRootCause,
  assertPhaseArtifactWrite,
  bindPhasePrincipal,
  blockWorkflow,
  createBlueprintWorkflowState,
  createProblemWorkflowState,
  rebindBlockedWorkflowCoordinator,
  recordPhaseArtifact,
  remediateBlockedWorkflow,
  returnWorkflowToPhase,
  transitionWorkflow,
} from "../../workflows/state-machine/engine";
export type { AuthorizedPhaseCommand } from "../../workflows/state-machine/phase-commands";
export { authorizePhaseCommandExecution } from "../../workflows/state-machine/phase-commands";
export type {
  ActiveWorkflowPhase,
  RemediationPhase,
  WorkflowPhase,
  YsCraftAgentId,
} from "../../workflows/state-machine/phases";
export {
  FORWARD_TRANSITION,
  PHASE_OWNED_ARTIFACTS,
  PHASE_OWNER,
  WORKFLOW_PHASES,
  YS_CRAFT_AGENT_IDS,
} from "../../workflows/state-machine/phases";
export type { TrustedPrincipal } from "../../workflows/state-machine/principal";
export {
  auditTrustedPrincipal,
  issueTrustedPrincipal,
  principalsEqual,
} from "../../workflows/state-machine/principal";
export type { StopGateResult } from "../../workflows/state-machine/stop-gate";
export { evaluateStopGate } from "../../workflows/state-machine/stop-gate";
export type {
  CommitWorkflowInput,
  InitializeWorkflowInput,
  OperationIntentRecord,
  OperationResultRecord,
  OperationStartedRecord,
  RecordOperationIntentInput,
  RecordOperationResultInput,
  ResumeCheckCode,
  ResumeCheckIssue,
  ResumeExactWorkflowInput,
  ResumeRepositoryObservation,
  ResumeWorkflowResult,
  SideEffectKind,
  StoreResidue,
  WorkflowSnapshot,
  WorkflowStoreErrorCode,
} from "../../workflows/store";
export {
  AtomicWorkflowStore,
  openAtomicWorkflowStore,
  StorePathError,
  WorkflowStoreError,
} from "../../workflows/store";
export type {
  CandidateDiffObserver,
  HumanCriterionDecision,
  LocalProcessResult,
  LocalProcessRunner,
  LocalVerificationRun,
  PreparedVerification,
  VerificationApproval,
  VerificationClock,
  VerificationLogSink,
  VerificationSourceProposal,
} from "../../workflows/verification/local-verification";
export {
  approveVerification,
  LocalVerificationError,
  prepareVerification,
  runLocalVerification,
} from "../../workflows/verification/local-verification";
export type {
  RemoteWorktreeDisposition,
  SshCandidateObservation,
  SshPreflightResult,
  SshVerificationExecutor,
  SshVerificationRun,
} from "../../workflows/verification/ssh-verification";
export {
  runSshVerification,
  SSH_PREFLIGHT_PROTOCOL,
  SshVerificationError,
} from "../../workflows/verification/ssh-verification";
export type { OpenCodeCraftRuntimeDependencies, OpenCodeCraftStatus } from "./adapter-runtime";
export {
  createDefaultOpenCodeCraftRuntimeDependencies,
  OpenCodeCraftRuntime,
} from "./adapter-runtime";
export type { OpenCodeBuilderWriteGuard } from "./builder-write-guard";
export { createOpenCodeBuilderWriteGuard } from "./builder-write-guard";
export type { OpenCodeCraftController } from "./controller-runtime";
export {
  createOpenCodeBinaryGitRunner,
  createOpenCodeGitRunner,
  createOpenCodeLocalProcessRunner,
  createOpenCodeVerificationLogSink,
  loadOpenCodeCraftController,
} from "./controller-runtime";
export {
  buildOpenSshVerificationArgv,
  createOpenCodeSshVerificationRunner,
  OPENSSH_REMOTE_CAPTURE_SCRIPT,
  quoteOpenSshPosixArgument,
  resolveSystemSshExecutable,
} from "./openssh-verification-runtime";
export { canonicalOpenCodeSessionId, issueOpenCodePrincipal } from "./platform-principal";

const TOOL_DESCRIPTIONS = Object.freeze(
  Object.fromEntries(
    CRAFT_TOOL_SURFACE.map((definition) => [
      definition.id,
      definition.visibility === "workflow-entry"
        ? `Start the explicit Yuansheng Craft ${definition.id} workflow entry.`
        : `Run the Yuansheng Craft ${definition.id} lifecycle operation for an exact workflow.`,
    ]),
  ) as Readonly<Record<CraftToolId, string>>,
);

export function createOpenCodeCraftTools(
  runtime: OpenCodeCraftRuntime,
): Record<CraftToolId, ToolDefinition> {
  const craftTools = {
    ys_craft_start_problem: tool({
      description: TOOL_DESCRIPTIONS.ys_craft_start_problem,
      args: {
        problem: tool.schema.string().min(1),
        target_worktree: tool.schema.string().min(1),
      },
      async execute(args, context) {
        return runtime.startProblem(args, context);
      },
    }),
    ys_craft_review_blueprint: tool({
      description: TOOL_DESCRIPTIONS.ys_craft_review_blueprint,
      args: {
        sealed_function_directory: tool.schema.string().min(1),
        target_worktree: tool.schema.string().min(1),
      },
      async execute(args, context) {
        return runtime.reviewBlueprint(args, context);
      },
    }),
    ys_craft_status: tool({
      description: TOOL_DESCRIPTIONS.ys_craft_status,
      args: {
        workflow_id: tool.schema.string().min(1),
      },
      async execute({ workflow_id }, context) {
        return runtime.status(workflow_id, context);
      },
    }),
    ys_craft_resume: tool({
      description: TOOL_DESCRIPTIONS.ys_craft_resume,
      args: {
        store_anchor: tool.schema.string().min(1),
        workflow_id: tool.schema.string().min(1),
      },
      async execute(args, context) {
        return runtime.resume(args, context);
      },
    }),
    ys_craft_prepare_repository: tool({
      description: TOOL_DESCRIPTIONS.ys_craft_prepare_repository,
      args: {
        request_id: tool.schema.string().min(1),
      },
      async execute({ request_id }, context) {
        return runtime.prepareRepository(request_id, context);
      },
    }),
    ys_craft_record_artifact: tool({
      description: TOOL_DESCRIPTIONS.ys_craft_record_artifact,
      args: {
        artifact_kind: tool.schema.string().min(1),
        artifact_payload: tool.schema.string().min(1),
        workflow_id: tool.schema.string().min(1),
      },
      async execute(args, context) {
        return runtime.recordArtifact(args, context);
      },
    }),
    ys_craft_capture_candidate: tool({
      description: TOOL_DESCRIPTIONS.ys_craft_capture_candidate,
      args: {
        expected_revision: tool.schema.number().int().nonnegative(),
        workflow_id: tool.schema.string().min(1),
      },
      async execute(args, context) {
        return runtime.captureCandidate(args, context);
      },
    }),
    ys_craft_prepare_verification: tool({
      description: TOOL_DESCRIPTIONS.ys_craft_prepare_verification,
      args: {
        source: tool.schema.string().min(1),
        workflow_id: tool.schema.string().min(1),
      },
      async execute(args, context) {
        return runtime.prepareVerification(args, context);
      },
    }),
    ys_craft_run_verification: tool({
      description: TOOL_DESCRIPTIONS.ys_craft_run_verification,
      args: {
        expected_revision: tool.schema.number().int().nonnegative(),
        workflow_id: tool.schema.string().min(1),
      },
      async execute(args, context) {
        return runtime.runVerification(args, context);
      },
    }),
    ys_craft_transition: tool({
      description: TOOL_DESCRIPTIONS.ys_craft_transition,
      args: {
        expected_revision: tool.schema.number().int().nonnegative(),
        target_phase: tool.schema.string().min(1),
        workflow_id: tool.schema.string().min(1),
      },
      async execute(args, context) {
        return runtime.transition(args, context);
      },
    }),
    ys_craft_return_to_phase: tool({
      description: TOOL_DESCRIPTIONS.ys_craft_return_to_phase,
      args: {
        expected_revision: tool.schema.number().int().nonnegative(),
        reason: tool.schema.string().min(1),
        target_phase: tool.schema.string().min(1),
        workflow_id: tool.schema.string().min(1),
      },
      async execute(args, context) {
        return runtime.returnToPhase(args, context);
      },
    }),
    ys_craft_complete: tool({
      description: TOOL_DESCRIPTIONS.ys_craft_complete,
      args: {
        expected_revision: tool.schema.number().int().nonnegative(),
        workflow_id: tool.schema.string().min(1),
      },
      async execute(args, context) {
        return runtime.complete(args, context);
      },
    }),
  } satisfies Record<CraftToolId, ToolDefinition>;

  const expectedToolIds = CRAFT_TOOL_SURFACE.map((definition) => definition.id).sort();
  const registeredToolIds = Object.keys(craftTools).sort();
  if (
    expectedToolIds.length !== registeredToolIds.length ||
    expectedToolIds.some((toolId, index) => toolId !== registeredToolIds[index])
  ) {
    throw new Error("Yuansheng Craft runtime tool registration does not match the frozen surface");
  }
  return Object.freeze(craftTools);
}

export const YuanshengCraftPlugin: Plugin = async ({ directory, worktree }) => {
  const controller = await loadOpenCodeCraftController({ directory, worktree });
  const writeGuard = createOpenCodeBuilderWriteGuard();
  const chatParams = writeGuard.hooks["chat.params"];
  const toolExecuteBefore = writeGuard.hooks["tool.execute.before"];
  if (chatParams === undefined || toolExecuteBefore === undefined) {
    throw new TypeError("Yuansheng Craft write guard did not expose its required hooks");
  }
  const runtime = new OpenCodeCraftRuntime(
    createDefaultOpenCodeCraftRuntimeDependencies({
      binaryGit: createOpenCodeBinaryGitRunner(),
      builderWrite: Object.freeze({
        activate: (context, state, artifacts): void => {
          writeGuard.activateFromToolContext(context, state, artifacts);
        },
      }),
      controller,
      git: createOpenCodeGitRunner(controller.controllerRoot),
      localProcess: createOpenCodeLocalProcessRunner(),
      logSink: createOpenCodeVerificationLogSink(),
      reloadController: async () => loadOpenCodeCraftController({ directory, worktree }),
      ssh: async () => createOpenCodeSshVerificationRunner(await resolveSystemSshExecutable()),
    }),
  );
  return {
    "chat.params": async (input, output): Promise<void> => {
      runtime.observeChatAgent(input.sessionID, input.agent);
      await chatParams(input, output);
    },
    event: async ({ event }): Promise<void> => {
      await runtime.handleEvent(event);
    },
    "experimental.compaction.autocontinue": async (input, output): Promise<void> => {
      if (runtime.compactionPointer(input.sessionID) !== null) {
        output.enabled = false;
      }
    },
    "experimental.session.compacting": async ({ sessionID }, output): Promise<void> => {
      const pointer = runtime.compactionPointer(sessionID);
      if (pointer !== null) {
        output.context.push(
          `Yuansheng Craft pointer only; call ys_craft_status or ys_craft_resume explicitly: ${pointer}`,
        );
      }
    },
    "tool.execute.before": toolExecuteBefore,
    tool: createOpenCodeCraftTools(runtime),
  };
};
