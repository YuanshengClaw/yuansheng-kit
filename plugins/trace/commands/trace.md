# Trace

Start a Yuansheng Trace root-cause analysis run with two required inputs:

- `software`: the explicit software identifier supplied by the user.
- `perf_data_root`: the explicit perf-data location supplied by the user.

Accept one optional input:

- `artifact_root`: an artifact-root override that the hosting adapter must
  resolve before starting the platform-neutral workflow.

Accept neither value from conversation history or inference. If either input is
missing, request that value and stop until the user responds. Once both values
are present, pass them unchanged to the hosting adapter. Do not resolve paths or
inspect, classify, or modify the perf-data location in this command. The adapter
must pass an already-resolved absolute artifact root to the platform-neutral
workflow, which presents and binds that root in the execution plan.
