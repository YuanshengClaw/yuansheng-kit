---
name: typescript-coding
description: >-
  TypeScript and JavaScript implementation, review, refactoring, debugging, and
  testing guidance covering safe advanced type-system design and Metabase
  frontend conventions. Use for .ts, .tsx, .js, and .jsx work; generics,
  conditional, mapped, template-literal, or recursive types; API, state, form,
  and config typing; type guards, assertion functions, and type-level tests; or
  Metabase React, Redux, RTK Query, Mantine, Storybook, CSS module, unit, and
  Cypress work.
---

# TypeScript Coding

Apply these rules to TypeScript and JavaScript work while preserving the
project's runtime contracts and local conventions.

## Route Task-Specific Guidance

- Read [Advanced Type Design](references/advanced-types.md) when ordinary
  interfaces and simple unions cannot express the required relationship, or when
  the task involves generics, conditional or mapped types, template literal
  types, recursive utilities, guards, assertion functions, or type-level tests.
- Read [Metabase Frontend](references/metabase-frontend.md) before changing
  Metabase frontend code, tests, state, data fetching, UI components, or
  styling.
- Read both references when advanced type design appears in Metabase code.
- For dependency, package-manager, package-script, CI, or TypeScript project
  configuration changes, follow the project's tooling instructions and use
  `$typescript-tooling` if that skill is available. Do not assume it is
  installed.

## Required Workflow

1. Read the repository instructions, package scripts, TypeScript configuration,
   and the nearest relevant implementation and tests.
2. Trace the runtime data flow, public boundaries, values that actually exist,
   and expected failure modes before changing types.
3. Search for established shared types, helpers, naming, component patterns, and
   test conventions before adding new abstractions.
4. Start with the simplest type and implementation that preserve the contract.
   Introduce advanced type machinery only for a concrete invariant, useful
   inference, removed duplication, or a demonstrated class of bugs.
5. For behavior changes and bug fixes, add or adjust a focused failing test
   first when practical. Add compile-time assertions for reusable or non-obvious
   type utilities.
6. Work in small, testable increments and keep changes limited to the requested
   behavior and adjacent coverage.
7. Run the narrowest project-native test first, then the relevant type check,
   lint, and format commands. Expand validation only when risk or failures
   justify it.
8. Report commands run and explain any validation that could not be completed.

Keep inspection and edits within the user-authorized project scope unless
toolchain validation requires additional read-only access. Do not commit unless
the user asks.

## Type Safety

- Prefer TypeScript for touched frontend code. Convert JavaScript only when the
  conversion is small, directly supports the requested change, and matches
  nearby practice.
- Model runtime data rather than an idealized shape. Keep API response, store,
  component, and local domain types aligned with their actual boundaries.
- Prefer `unknown` over `any`, then narrow with control flow, honest type
  guards, or assertion functions.
- Avoid broad type assertions and non-null assertions. First try a generic
  constraint, overload, indexed access, discriminated union, or runtime guard.
- Use `as const` deliberately to preserve literal values; prefer `satisfies`
  when a value must also be checked against a shape.
- Prefer inference at call sites and built-in utility types over custom
  machinery.
- Check the project's TypeScript version before using version-dependent features
  such as `satisfies` or the built-in `NoInfer`.

## Readability And Scope

- Avoid nested ternaries. Use a direct branch, object map, `switch`, or an
  established pattern-matching library when it makes the cases clearer.
- Extract complex conditions into well-named booleans.
- Keep comments rare and explain why, not what.
- Use `ALL_CAPS` for constants and name meaningful values instead of leaving
  magic strings or numbers inline.
- Prefer declarative array and object transformations when they are clearer than
  loops.
- Keep component and helper boundaries meaningful. Do not extract code merely to
  hide a few lines.
- Avoid unrelated refactors and new abstractions that do not support the
  requested behavior or its tests.

## Testing And Validation

- Cover changed behavior with the narrowest useful test.
- Prefer the repository's existing test helpers, fixtures, type-test tools, and
  file naming conventions.
- Use type-level tests for reusable conditional, recursive, distributive, or
  mapped utilities. Use `// @ts-expect-error` for focused negative cases; do not
  use `// @ts-ignore`.
- Use the project's package manager and scripts. Do not replace a precise local
  command with a generic `tsc`, linter, or test invocation unless no project
  command exists.
- Re-run the type checker after changes to public signatures, API models, state
  shapes, generic relationships, or component props.
- Run relevant lint and formatting before handoff.

## Review Checklist

Before handing work back, verify:

- types describe the real runtime contract and public boundary;
- no unnecessary `any`, broad assertion, or non-null assertion was added;
- the simplest adequate type was used before advanced machinery;
- reusable advanced utilities have positive and negative type coverage;
- conditional distributivity, mapped modifiers, recursion, and literal unions
  are intentional where used;
- behavior tests cover changed outcomes;
- project-specific guidance was loaded and followed;
- targeted tests, type checking, lint, and formatting were run or their omission
  was explained.
