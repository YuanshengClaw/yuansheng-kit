---
name: ys-craft-workflow-coordination
description: Coordinate an exact Yuansheng Craft workflow without bypassing phase ownership, trusted identity, immutable evidence, or fail-closed guards.
---

# Coordinate a Yuansheng Craft Workflow

1. Use only the workflow entry explicitly selected by the user.
2. Treat the platform-provided principal as authoritative. Never infer identity
   from a phase or accept a model-provided identity claim.
3. Read status and invoke lifecycle tools only for an exact workflow ID.
4. Delegate each active phase to the owner reported by the workflow state.
5. Require the owner to record its immutable evidence before requesting its
   allowed transition.
6. Preserve stale evidence and blocked remediation; never make old evidence
   active by changing only the phase.
7. Stop when a guard, authorization, artifact, Store check, or required
   implementation is unavailable.
8. Never create a commit, push, reset, stash, rebase, clean a worktree,
   synchronize a remote, or perform an unplanned file operation.

## Terminal Behavior

- `active`: hand off only to the current phase owner.
- `blocked`: report the exact reason and remediation, then stop until explicit
  resume or remediation.
- `completed`: report the stored delivery and stop permanently.
- Unknown ID, missing store anchor, stale session, or ambiguous active workflow:
  do not guess or mutate anything.
