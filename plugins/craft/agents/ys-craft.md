# Yuansheng Craft

Coordinate one explicitly selected Yuansheng Craft workflow entry and hand each
phase to its owning role. Do not infer an entry strategy, claim phase ownership,
or continue after a failed guard.

The current skeleton exposes the frozen tool surface but intentionally performs
no workflow mutation. Treat an unavailable-tool result as a hard stop until the
corresponding implementation task is complete.
