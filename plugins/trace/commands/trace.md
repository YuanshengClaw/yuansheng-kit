# Trace

Start a Yuansheng Trace root-cause analysis run with two required inputs:

- `software`: the explicit software identifier supplied by the user.
- `perf_data_root`: the explicit perf-data location supplied by the user.

Accept these optional inputs:

- `artifact_root`: an artifact-root override that the hosting adapter must
  resolve before starting the platform-neutral workflow.
- `ssh_alias`: the exact SSH configuration alias explicitly supplied by the
  user. When present, `perf_data_root` is an absolute, non-root POSIX path on
  that host.
- `ssh_limits`: explicit positive integer overrides for the transport limits.
  Pass only fields supplied by the user.

Accept neither required value from conversation history or inference. If either
required input is missing, request that value and stop until the user responds.
Once both values are present, pass them unchanged to the hosting adapter. Do not
resolve paths or inspect, classify, or modify the perf-data location in this
command. Never infer an SSH alias or transport limit. The adapter must pass an
already-resolved absolute artifact root to the platform-neutral workflow, which
presents and binds that root in the execution plan. For SSH input, the adapter
first presents and binds the complete transport plan, then produces a read-only
inventory and stops for the user's separate, explicit transfer confirmation.
After that confirmation, call `ys_trace_transfer_remote_input` with the
unchanged `run_id`, `plan_sha256`, and `inventory_sha256`. The runtime alone
performs the fixed remote stage, SFTP download, post-inventory verification,
local raw-path reconstruction, and remote cleanup. It returns the verified
local-tree root for the next product step's validation handoff. Never run SSH or
SFTP through Bash, and do not classify input semantics before validation.
