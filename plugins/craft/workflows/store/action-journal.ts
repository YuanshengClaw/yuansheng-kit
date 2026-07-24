import { canonicalizeJson, sealArtifact } from "../artifacts/canonical";
import type {
  ActionJournal,
  ArtifactRef,
  PrincipalAudit,
  WorkflowState,
} from "../artifacts/generated";
import { parseCraftContractBytes } from "../artifacts/parser";
import type { JsonValue } from "../artifacts/strict-json";

function sealJournal(payload: Omit<ActionJournal, "artifact_digest">): ActionJournal {
  const sealed = sealArtifact(
    payload as unknown as Record<string, JsonValue>,
  ) as unknown as ActionJournal;
  const parsed = parseCraftContractBytes(canonicalizeJson(sealed).bytes);
  if (parsed.artifact_type !== "action-journal") {
    throw new TypeError("Action journal payload did not produce an action journal");
  }
  return parsed;
}

export function createActionJournal(input: {
  readonly action: string;
  readonly at: string;
  readonly principal: PrincipalAudit;
  readonly result: ActionJournal["entries"][number]["result"];
  readonly state: WorkflowState;
  readonly subjectRefs: readonly ArtifactRef[];
}): ActionJournal {
  return sealJournal({
    artifact_type: "action-journal",
    artifact_version: 1,
    created_at: input.at,
    entries: [
      {
        action: input.action,
        at: input.at,
        principal: input.principal,
        result: input.result,
        sequence: 1,
        subject_refs: [...input.subjectRefs],
      },
    ],
    revision: input.state.revision,
    workflow_id: input.state.workflow_id,
  });
}

export function appendActionJournal(input: {
  readonly action: string;
  readonly at: string;
  readonly journal: ActionJournal;
  readonly principal: PrincipalAudit;
  readonly result: ActionJournal["entries"][number]["result"];
  readonly state: WorkflowState;
  readonly subjectRefs: readonly ArtifactRef[];
}): ActionJournal {
  if (
    input.journal.workflow_id !== input.state.workflow_id ||
    input.state.revision !== input.journal.revision + 1
  ) {
    throw new TypeError("Action journal append must advance the same workflow by one revision");
  }
  return sealJournal({
    artifact_type: "action-journal",
    artifact_version: 1,
    created_at: input.journal.created_at,
    entries: [
      ...input.journal.entries,
      {
        action: input.action,
        at: input.at,
        principal: input.principal,
        result: input.result,
        sequence: input.journal.entries.length + 1,
        subject_refs: [...input.subjectRefs],
      },
    ],
    revision: input.state.revision,
    workflow_id: input.state.workflow_id,
  });
}
