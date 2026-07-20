# Contributing

## Commit messages

All commit messages must follow the
[Conventional Commits 1.0.0 specification](https://www.conventionalcommits.org/en/v1.0.0/#specification):

```text
<type>[optional scope][!]: <description>

[optional body]

[optional footer(s)]
```

Use `feat` for a new feature and `fix` for a bug fix. Other appropriate types
include `build`, `chore`, `ci`, `docs`, `perf`, `refactor`, `revert`, `style`,
and `test`.

- Keep each commit focused on one logical change.
- Use a concise, lowercase type.
- Use an optional scope to identify the affected component.
- Write the description in the imperative mood.
- Mark a breaking change with `!` before the colon or with a `BREAKING CHANGE:`
  footer.
- Separate the body and footers from the preceding section with a blank line.

Examples:

```text
feat(patterns): extract RISC-V vectorization patterns
fix(perf): handle unavailable hardware counters
perf(analyzer): reduce counter-processing overhead
docs: document provenance notices
feat(skills)!: revise the optimization pattern schema
```
