# Advanced Type Design

Use advanced types only when ordinary interfaces and simple unions are not
expressive enough. Prefer the simplest type that preserves the real runtime
contract.

## Contents

- [Workflow](#workflow)
- [Design Rules](#design-rules)
- [Generics](#generics)
- [Conditional Types](#conditional-types)
- [Mapped Types](#mapped-types)
- [Template Literal Types](#template-literal-types)
- [Discriminated Unions](#discriminated-unions)
- [Type Guards And Assertion Functions](#type-guards-and-assertion-functions)
- [Utility Type Patterns](#utility-type-patterns)
- [Type-Level Testing](#type-level-testing)
- [Common Patterns](#common-patterns)
- [Review Checklist](#review-checklist)
- [References](#references)

## Workflow

1. Inspect runtime data flow, public API boundaries, values that actually exist,
   and failure modes.
2. Search nearby code for established helpers, naming, and type-test style.
3. Start with interfaces, type aliases, literal unions, indexed access, and
   discriminated unions.
4. Introduce advanced machinery only when it removes duplication, preserves a
   public invariant, improves inference, or prevents a real class of bugs.
5. Add type-level tests or compile-time assertions for reusable utilities,
   especially conditional, recursive, or distributive types.
6. Run the project's type checker and narrowest relevant tests.

Check the project's TypeScript version before recommending newer features.
`satisfies` requires TypeScript 4.9 or newer, and the built-in `NoInfer`
requires TypeScript 5.4 or newer.

## Design Rules

- Prefer inference at call sites. Require explicit type arguments only when the
  compiler cannot infer the intended relationship.
- Prefer `unknown` over `any`. Use narrowing, type guards, and assertion
  functions to recover specific types.
- Avoid broad type assertions. First check whether a better generic constraint,
  overload, discriminated union, or guard can express the contract.
- Use `as const` for intentional literal preservation. Prefer `satisfies` when
  the source value must also be structurally checked.
- Keep public type utilities small and composable. Name helpers after the
  relationship they model, not the syntax they use.
- Avoid deeply nested conditional types in product code. Split them into named
  helper aliases and document the runtime contract they represent.
- Preserve literal types when a value is the source of truth for a union, route
  table, event map, or configuration shape.
- Use built-in utility types before writing custom versions.

## Generics

Use generics to express a relationship between inputs and outputs, not merely to
make a function flexible.

Prefer constrained generics when the implementation relies on structure:

```ts
type WithId = { id: string };

function indexById<T extends WithId>(items: readonly T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]));
}
```

Use multiple type parameters only when they vary independently. If one type can
be derived from another, prefer indexed access or a small conditional type.

## Conditional Types

Use conditional types to model a branch in type space, especially when a generic
input determines an output type.

```ts
type ApiResult<T> = T extends { error: infer E }
  ? { ok: false; error: E }
  : { ok: true; data: T };
```

Follow these rules:

- Keep the checked side narrow and intentional.
- Use `infer` to name extracted pieces instead of repeating indexed access.
- Remember that a conditional type distributes over unions when its checked type
  is a naked type parameter.
- Disable distributivity with tuple wrapping when the whole union must be
  treated as one value:

```ts
type AsArray<T> = T extends unknown ? T[] : never;
type AsSingleArray<T> = [T] extends [unknown] ? T[] : never;
```

## Mapped Types

Use mapped types to transform an existing object type without repeating keys.

```ts
type AsyncActions<T> = {
  [K in keyof T as `${string & K}Async`]: () => Promise<T[K]>;
};
```

Follow these rules:

- Use `readonly`, `?`, `-readonly`, and `-?` modifiers deliberately.
- Use key remapping with `as` for API reshaping, generated getter or setter
  names, event maps, and filtered object types.
- Filter properties by remapping unwanted keys to `never`.
- Avoid transforming broad types such as `object` or `Record<string, unknown>`
  unless arbitrary keys are truly supported.

## Template Literal Types

Use template literal types for small, finite string protocols such as event
names, route names, configuration paths, feature flags, CSS token names, or
generated getter names.

```ts
type FieldEvent<T> = `${Extract<keyof T, string>}Changed`;
```

Follow these rules:

- Keep generated unions small enough to understand. For large sets, prefer
  ahead-of-time generation or data-derived `as const` values.
- Combine template literal types with key remapping when generating object APIs.
- Use intrinsic string helpers such as `Capitalize`, `Uncapitalize`,
  `Uppercase`, and `Lowercase` only when casing is part of the API.

## Discriminated Unions

Prefer discriminated unions over optional fields plus assertions for state
machines, async state, UI modes, parse results, and domain events.

```ts
type RemoteData<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; error: Error };
```

Follow these rules:

- Use a stable discriminant such as `type`, `kind`, `status`, or `state`.
- Make variant-specific fields required on the variant that owns them.
- Use exhaustive `switch` checks when behavior depends on all variants.
- Do not use non-null assertions to access variant fields. Narrow on the
  discriminant.

## Type Guards And Assertion Functions

Use type guards when runtime validation and static narrowing must agree.

```ts
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
```

Use assertion functions when invalid input must throw and the caller should
continue with a narrowed type:

```ts
function assertHasId(value: unknown): asserts value is { id: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    throw new Error("Expected object with string id");
  }
}
```

Follow these rules:

- Keep guards honest: validate every property promised by the predicate.
- Prefer `unknown` inputs at validation boundaries.
- Do not use guards to paper over impossible states created by weak types.

## Utility Type Patterns

Use built-ins first:

- `Pick`, `Omit`, `Partial`, `Required`, `Readonly`
- `Record`, `Extract`, `Exclude`, `NonNullable`
- `Parameters`, `ReturnType`, `ConstructorParameters`, `InstanceType`
- `Awaited`, `ThisParameterType`, `OmitThisParameter`, `NoInfer`

When creating custom utility types:

- Make distribution explicit in the name or documentation when it matters.
- Preserve `readonly` and optional modifiers unless the utility intentionally
  changes them.
- Treat recursive utilities such as `DeepPartial`, `DeepReadonly`, `Path<T>`,
  and deep key transforms as expensive. Prefer shallow utilities unless deep
  behavior is required.
- Handle arrays, tuples, functions, `Date`, `Map`, `Set`, and branded types
  intentionally in deep utilities.

## Type-Level Testing

Use the project's existing type-test tool, such as `tsd`, `expect-type`, Vitest
type tests, or custom `Equal` and `Expect` helpers.

Minimal helpers:

```ts
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? true
    : false;

type Expect<T extends true> = T;
```

Use `// @ts-expect-error` for negative tests, and keep the following line
focused on the exact invalid case. Do not use `// @ts-ignore` for type tests.

## Common Patterns

### Type-Safe Event Map

```ts
type Handlers<Events extends Record<string, unknown>> = {
  [K in keyof Events]: (payload: Events[K]) => void;
};

type DashboardEvents = {
  created: { id: string };
  renamed: { id: string; name: string };
};

const handlers: Handlers<DashboardEvents> = {
  created: (event) => event.id,
  renamed: (event) => event.name,
};
```

### API Operation Extraction

```ts
type OperationResponse<T> = T extends { response: infer Response }
  ? Response
  : never;

type OperationBody<T> = T extends { body: infer Body } ? Body : never;
```

Use this pattern when a route table is the source of truth and caller helpers
must infer valid paths, request bodies, parameters, and responses.

### Config Path Types

```ts
type DotPath<T> = T extends object
  ? {
      [K in Extract<keyof T, string>]:
        | K
        | `${K}.${DotPath<T[K]>}`;
    }[Extract<keyof T, string>]
  : never;
```

Use path utilities sparingly. They work well for small configuration objects and
form paths but can become slow or unreadable on large schemas.

## Review Checklist

- Confirm that the utility models a real runtime contract.
- Consider a simpler type, overload, or discriminated union first.
- Avoid `any`, non-null assertions, and broad type assertions.
- Make conditional type distributivity intentional.
- Give `infer` variables meaningful names.
- Preserve or change mapped-type mutability and optionality deliberately.
- Keep template literal unions small or derive them from a source of truth.
- Handle arrays, functions, and special objects in deep recursive types, or
  document the utility as plain-object-only.
- Add type-level tests and useful negative cases for reusable utilities.
- Run the project's type checker or explain why it was skipped.

## References

- [Reference skill](https://raw.githubusercontent.com/Activer007/ordinary-claude-skills/refs/heads/main/skills_all/typescript-advanced-types/SKILL.md)
- [TypeScript conditional types](https://www.typescriptlang.org/docs/handbook/2/conditional-types.html)
- [TypeScript mapped types](https://www.typescriptlang.org/docs/handbook/2/mapped-types.html)
- [TypeScript template literal types](https://www.typescriptlang.org/docs/handbook/2/template-literal-types.html)
- [TypeScript narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
- [TypeScript utility types](https://www.typescriptlang.org/docs/handbook/utility-types.html)
