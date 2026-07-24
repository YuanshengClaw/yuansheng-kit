---
name: ys-craft-verification-source-selection
description: Require an explicit official or user-provided verification source for the active Yuansheng Craft patch plan before creating and authorizing a candidate-specific verification manifest.
---

# Select Yuansheng Craft Verification Evidence

Use this skill after a `PatchCandidate` is ready and before any verification
command runs. Source selection is a hard workflow gate, not advisory text.

## Selection Protocol

1. Read exact workflow status and confirm the active phase is `verifying`.
2. Ask the user to choose exactly one source:
   - `official`: tests maintained by the bound product repository;
   - `user-provided`: a concrete test path or command proposal supplied by the
     user.
3. For `official`, require a ready `RepositoryBinding`, inspect only the bound
   product tree, and identify concrete repository-relative tests covering the
   patch-plan criteria.
4. For `user-provided`, require a concrete path or named command proposal.
   Reject vague descriptions, Store paths, paths outside the bound product, and
   commands not represented as argv.
5. Call `ys_craft_prepare_verification` with the exact selected source. Treat
   the returned `VerificationSource` as immutable.
6. Build one candidate-specific `VerificationManifest` from that source. It must
   bind the candidate, every required local or SSH runner group, exact argv,
   cwd, environment allowlist, timeout, criterion mapping, and log target.
7. Show the entire manifest for one explicit authorization. Run only the exact
   authorized manifest through `ys_craft_run_verification`.

## Iteration Rules

- Preserve the selected source while the active `PatchPlan` is unchanged.
- Generate a new manifest and authorization for every candidate revision.
- If the plan or source changes, repeat selection instead of editing an existing
  source or manifest.
- On candidate failure, preserve criterion evidence, return to `building`, and
  wait for a new candidate. Never reset the worktree.
- On source, manifest, authorization, runner, or candidate mismatch, stop before
  executing any command.

## Done Criteria

- Exactly one explicit source is active for the current plan.
- The immutable manifest binds the exact candidate and selected source.
- Every required criterion has its own evidence mapping.
- Execution uses the authorized manifest unchanged.
