---
name: workflow-coordination
description: Coordinate an explicitly selected Yuansheng Craft workflow without bypassing phase ownership, trusted identity, or fail-closed guards.
---

# Coordinate a Craft Workflow

1. Use only the entry strategy explicitly selected by the user.
2. Treat the platform-provided principal as authoritative; never infer identity
   from a phase or accept a model-provided identity claim.
3. Call agent-internal lifecycle tools only for an exact workflow identifier and
   an allowed phase.
4. Stop when a guard, authorization, artifact, or implementation is unavailable.
5. Never create a commit, push, reset, remote synchronization, or unplanned file
   operation.
