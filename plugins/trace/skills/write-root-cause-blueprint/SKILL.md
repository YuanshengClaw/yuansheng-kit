---
name: write-root-cause-blueprint
description: Produce and semantically review evidence-grounded Yuansheng Root Cause Blueprint v1-lite candidates from validated perf evidence and a confirmed hardware profile. Use when Yuansheng Trace requests a per-function Blueprint candidate or an independent review of one.
---

# Write a Root Cause Blueprint

1. Bind the candidate to the supplied software, test case, ranked function, and
   confirmed hardware profile.
2. Use only the supplied perf statistics, annotate output, metadata, hardware
   profile, and their recorded hashes. Do not read source code or acquire new
   evidence.
3. Distinguish observations from hypotheses. Copy measured values exactly and
   keep unsupported facts as `null` with the required machine-readable gap
   codes.
4. Keep every `rvv_pattern` and `pattern_confidence` value `null`, and include
   `pattern_catalog_unavailable`. Do not name or infer a Pattern.
5. Do not invent a source file, line, code location, metric, baseline, or
   hardware capability. Keep recommendations within what the evidence can
   support.
6. Set `needs_human_review` to `true` and `allow_auto_forward_to_ys_craft` to
   `false`.
7. Return strict JSON conforming to the supplied v1-lite Schema and preserve the
   workflow-requested claim-to-evidence references.

For semantic review, compare every material claim with the immutable candidate
and supplied evidence. Report unsupported, conflicting, or uncited claims
without modifying the candidate. Require a new candidate and full validation
when correction is necessary.
