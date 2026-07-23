---
name: python-coding
description: Python coding standards, idioms, and review guidance for writing, reviewing, refactoring, and organizing Python code. Use when working on Python modules, functions, tests, package layout, type hints, error handling, context managers, generators, dataclasses, decorators, concurrency patterns, performance improvements, or Python anti-pattern cleanup.
---

# Python Coding

Use this skill to produce Python code that is readable, explicit, typed where
useful, and consistent with the surrounding project.

## Required Workflow

1. Inspect nearby Python code and project configuration before editing. Local
   conventions, supported Python versions, and established test patterns
   override generic guidance.
2. If the task configures Python project tooling, dependencies, package
   metadata, linting, type checking, testing, or migration behavior, also use
   the applicable project setup skill, such as `modern-python` when available.
   This skill is for Python code quality and idioms, not for owning dependency
   policy.
3. Read `references/python-coding-guide.md` when concrete examples or detailed
   idiom guidance would help the task.
4. Keep edits focused on the requested Python behavior. Do not refactor broad
   surfaces only to apply style preferences.
5. Run the narrowest useful validation for the touched code: formatter, linter,
   type checker, and tests as available in the project.

## Coding Standards

- Prefer clear names, direct control flow, and straightforward data structures
  over clever or compressed code.
- Make side effects explicit. Avoid imports or helper calls that silently mutate
  process-wide state unless that is the established project pattern.
- Annotate public function signatures and non-obvious internal data shapes.
  Prefer modern built-in generics such as `list[str]` and `dict[str, int]` when
  the supported Python version allows them.
- Use structural typing with `Protocol` when behavior matters more than a
  concrete class.
- Catch specific exceptions, preserve context with exception chaining, and avoid
  silent failure paths.
- Use context managers for files, locks, transactions, network sessions, and
  other resources with lifecycle requirements.
- Use comprehensions for simple transformations. Expand complex filtering or
  multi-step transformations into named functions or explicit loops.
- Use generators for lazy processing and large inputs when callers can consume
  iterators.
- Use `dataclass` for ordinary data containers and named tuples or frozen data
  classes for small immutable records.
- Use decorators sparingly. Preserve wrapped function metadata with
  `functools.wraps`.
- Choose concurrency by workload: threads for blocking I/O, processes for CPU
  work, and `async`/`await` for high-concurrency asynchronous I/O.
- Prefer `pathlib.Path` for filesystem paths in new code unless local APIs
  expect strings.
- Avoid repeated string concatenation in loops. Use `"".join(...)` or
  `io.StringIO` for incremental construction.

## Review Checklist

Look for these Python-specific problems when reviewing or refactoring:

- mutable default arguments;
- bare `except` blocks or overly broad exception handling;
- `type(x) == ...` instead of `isinstance`;
- `== None` or `!= None` instead of `is None` or `is not None`;
- wildcard imports;
- manual resource cleanup where a context manager is available;
- complex comprehensions that hide branching or error handling;
- accidental eager list materialization for large data;
- untyped public APIs where types would clarify contracts;
- logging, error messages, or exception types that obscure failure causes;
- global mutable state introduced without a clear lifecycle.

## Reference

The detailed source guide is bundled at `references/python-coding-guide.md`.
Load it for concrete examples covering:

- Python readability principles and EAFP style;
- type hints, aliases, generics, and protocols;
- error handling and custom exception hierarchies;
- context managers;
- comprehensions and generators;
- dataclasses, named tuples, and decorators;
- threading, multiprocessing, and async I/O;
- package organization and imports;
- memory, performance, tooling, and anti-patterns.
