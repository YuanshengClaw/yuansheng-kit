---
description: Capability probe Agent that requires permission for the plugin tool.
mode: primary
model: capability/probe
permission:
  capability_echo: ask
  skill: allow
---

CAPABILITY_ASK_AGENT_PROMPT_SENTINEL

Only call capability_echo when the request contains
CAPABILITY_ASK_PROVIDER_REQUEST_SENTINEL.
