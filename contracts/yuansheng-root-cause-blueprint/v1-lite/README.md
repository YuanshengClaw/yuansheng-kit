# Yuansheng Root Cause Blueprint v1-lite

This directory defines the current pre-release Yuansheng Kit root-cause handoff
contract. The canonical source is [`schema.json`](schema.json); this README and
the examples explain the Schema but do not form a second definition.

## Pre-release reset

The project has not released any v1-lite contract bytes. This revision therefore
uses a one-time incompatible pre-release reset while retaining the existing
path, version label, and `$id`. Earlier draft artifacts are invalid and must be
regenerated from the current `schema.json`; consumers must reject them rather
than translate aliases or accept both field sets.

The unchanged `$id` identifies the first releasable v1-lite contract, not
compatibility with discarded drafts. Once this reset is accepted and frozen,
future incompatible changes require a new version and `$id`.

## Contract rules

- Missing facts use JSON `null`; sentinel strings such as `"unknown"` and
  `"N/A"` are forbidden.
- `section5_risks_and_gaps.current_gaps` is a unique array of machine-readable
  gap codes.
- The contract does not use a Pattern catalog. Every hotspot must set both
  `rvv_pattern` and `pattern_confidence` to `null`, and `current_gaps` must
  contain `pattern_catalog_unavailable`.
- `allow_auto_forward_to_ys_craft` is always `false`, `needs_human_review` is
  always `true`, and both `human_review_focus` and `block_reason` must be
  non-empty.
- `overall_confidence` covers available perf, metadata, and Hardware Profile
  evidence. It excludes unavailable Pattern confidence and stays between `0` and
  `1`.
- Without a cross-architecture timing comparison, `spec_baseline` is `null`. A
  metric may have one unmeasured side as `null`, but at least one side must
  contain a measured number.

## Gap codes

Gap codes use lowercase ASCII snake case. The Schema allows additional codes
with the same syntax and defines these current cross-field requirements:

| Condition                                                   | Required gap code                 |
| ----------------------------------------------------------- | --------------------------------- |
| Every Blueprint                                             | `pattern_catalog_unavailable`     |
| `repository_url`, `test_branch`, or `commit_hash` is `null` | `repository_metadata_unavailable` |
| `spec_baseline` is `null`                                   | `duration_data_unavailable`       |
| Any AArch64 metric value is `null`                          | `aarch64_baseline_unavailable`    |
| A hotspot module or code location is `null`                 | `source_location_unavailable`     |
| `related_knowledge` is `null`                               | `code_knowledge_unavailable`      |

A gap records unavailable evidence; it never authorizes a model to synthesize
the missing fact.

## Consistency rules

`overall_status` and `final_status` use this exact mapping:

| `overall_status`        | `final_status`          |
| ----------------------- | ----------------------- |
| `confirmed`             | `confirmed_root_cause`  |
| `probable`              | `probable_root_cause`   |
| `insufficient_evidence` | `insufficient_evidence` |
| `false_alarm`           | `false_alarm`           |

In v1-lite, `recommend_to_ys_craft` and `proceed_to_optimization` only allow
`no` or `conditional`. Even a confirmed result requires human review before
optimization.

The Schema cannot prove that a natural-language technical conclusion is true or
that a path came from the input evidence. Consumers must validate such claims
against trusted evidence before using them for optimization.

## Examples

- [`examples/valid/openjdk-hashmapbench-001.json`](examples/valid/openjdk-hashmapbench-001.json)
  uses a real OpenJDK `HashMapBench` Blueprint as its content baseline. It
  preserves real metadata, metrics, hotspot, and diagnostic context while
  representing unproven Pattern, benefit, and source facts as `null` and
  structured gaps.
- Each file below `examples/invalid/` demonstrates one primary violation and
  must be rejected.

All examples are strict JSON and use English-only user-visible text. Raw-byte
failures such as duplicate keys, comments, trailing commas, invalid UTF-8,
non-finite numbers, negative zero, and underflow are covered by the shared
strict JSON tests rather than Schema fixtures.
