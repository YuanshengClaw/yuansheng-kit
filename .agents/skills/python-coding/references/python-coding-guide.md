# Python Coding Guide

This reference distills the source `python-coding-guide.md` into stable Markdown
for use by coding agents.

## Contents

- [Core Principles](#core-principles)
- [Type Hints](#type-hints)
- [Error Handling](#error-handling)
- [Context Managers](#context-managers)
- [Comprehensions And Generators](#comprehensions-and-generators)
- [Data Containers](#data-containers)
- [Decorators](#decorators)
- [Concurrency](#concurrency)
- [Package Organization](#package-organization)
- [Memory And Performance](#memory-and-performance)
- [Anti-Patterns](#anti-patterns)

## Core Principles

Readability comes first. Prefer code that makes names, data flow, and failure
behavior obvious.

```python
def get_active_users(users: list[User]) -> list[User]:
    """Return only active users from the provided list."""
    return [user for user in users if user.is_active]
```

Avoid clever compression when it hides intent.

```python
def get_active_users(u):
    return [x for x in u if x.a]
```

Prefer explicit setup over hidden side effects.

```python
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
```

Use EAFP where it gives clearer code than pre-checking every condition.

```python
def get_value(dictionary: dict[str, str], key: str) -> str:
    try:
        return dictionary[key]
    except KeyError:
        return default_value
```

## Type Hints

Annotate public signatures and important internal structures. Prefer built-in
generic types on modern Python.

```python
def process_items(items: list[str]) -> dict[str, int]:
    return {item: len(item) for item in items}
```

Use type aliases for repeated complex shapes.

```python
from typing import Any

JSON = dict[str, Any] | list[Any] | str | int | float | bool | None


def parse_json(data: str) -> JSON:
    return json.loads(data)
```

Use generic type variables for container helpers.

```python
from typing import TypeVar

T = TypeVar("T")


def first(items: list[T]) -> T | None:
    """Return the first item or None if the list is empty."""
    return items[0] if items else None
```

Use protocols for structural behavior.

```python
from typing import Protocol


class Renderable(Protocol):
    def render(self) -> str:
        """Render the object to a string."""


def render_all(items: list[Renderable]) -> str:
    """Render every item."""
    return "\n".join(item.render() for item in items)
```

## Error Handling

Catch specific exceptions and chain failures so callers keep the original
traceback.

```python
def load_config(path: str) -> Config:
    try:
        return Config.from_json(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise ConfigError(f"Config file not found: {path}") from error
    except json.JSONDecodeError as error:
        raise ConfigError(f"Invalid JSON in config: {path}") from error
```

Use a small custom exception hierarchy when the application needs stable error
categories.

```python
class AppError(Exception):
    """Base exception for application errors."""


class ValidationError(AppError):
    """Raised when input validation fails."""


class NotFoundError(AppError):
    """Raised when a requested resource is not found."""
```

Avoid bare `except`, swallowed exceptions, and ambiguous `None` returns for real
failures.

## Context Managers

Use context managers for resource lifetime.

```python
def process_file(path: Path) -> str:
    with path.open(encoding="utf-8") as file:
        return file.read()
```

Create small context managers for repeatable setup and teardown.

```python
from collections.abc import Iterator
from contextlib import contextmanager


@contextmanager
def timer(name: str) -> Iterator[None]:
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed = time.perf_counter() - start
        print(f"{name} took {elapsed:.4f} seconds")
```

For class-based context managers, return `False` from `__exit__` unless the
manager intentionally suppresses exceptions.

## Comprehensions And Generators

Use comprehensions for simple transformations.

```python
names = [user.name for user in users if user.is_active]
```

Expand complex logic into named functions or explicit loops.

```python
def filter_and_transform(items: Iterable[int]) -> list[int]:
    result = []
    for item in items:
        if item > 0 and item % 2 == 0:
            result.append(item * 2)
    return result
```

Use generator expressions to avoid large intermediate lists.

```python
total = sum(value * value for value in range(1_000_000))
```

Use generator functions for large streams.

```python
def read_large_file(path: Path) -> Iterator[str]:
    with path.open(encoding="utf-8") as file:
        for line in file:
            yield line.strip()
```

## Data Containers

Use dataclasses for plain data objects.

```python
from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class User:
    """User entity."""

    id: str
    name: str
    email: str
    created_at: datetime = field(default_factory=datetime.now)
    is_active: bool = True
```

Use `__post_init__` for lightweight validation.

```python
@dataclass
class User:
    email: str
    age: int

    def __post_init__(self) -> None:
        if "@" not in self.email:
            raise ValueError(f"Invalid email: {self.email}")
        if self.age < 0 or self.age > 150:
            raise ValueError(f"Invalid age: {self.age}")
```

Use named tuples or frozen dataclasses for small immutable records.

```python
from typing import NamedTuple


class Point(NamedTuple):
    """Immutable 2D point."""

    x: float
    y: float

    def distance(self, other: "Point") -> float:
        return ((self.x - other.x) ** 2 + (self.y - other.y) ** 2) ** 0.5
```

## Decorators

Use `functools.wraps` for function decorators.

```python
from collections.abc import Callable
from functools import wraps
from typing import ParamSpec, TypeVar

P = ParamSpec("P")
R = TypeVar("R")


def timer(func: Callable[P, R]) -> Callable[P, R]:
    """Time function execution."""

    @wraps(func)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        start = time.perf_counter()
        try:
            return func(*args, **kwargs)
        finally:
            elapsed = time.perf_counter() - start
            print(f"{func.__name__} took {elapsed:.4f}s")

    return wrapper
```

## Concurrency

Choose the model by workload:

| Workload                   | Default tool                  |
| -------------------------- | ----------------------------- |
| Blocking I/O               | `ThreadPoolExecutor`          |
| CPU-bound computation      | `ProcessPoolExecutor`         |
| High-concurrency async I/O | `asyncio` and async libraries |

Threading example:

```python
def fetch_all_urls(urls: list[str]) -> dict[str, str]:
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        future_to_url = {executor.submit(fetch_url, url): url for url in urls}
        results = {}
        for future in concurrent.futures.as_completed(future_to_url):
            url = future_to_url[future]
            try:
                results[url] = future.result()
            except FetchError as error:
                results[url] = f"Error: {error}"
    return results
```

Process example:

```python
def process_all(datasets: list[list[int]]) -> list[int]:
    with concurrent.futures.ProcessPoolExecutor() as executor:
        return list(executor.map(process_data, datasets))
```

Async example:

```python
async def fetch_all(urls: list[str]) -> dict[str, str | BaseException]:
    tasks = [fetch_async(url) for url in urls]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    return dict(zip(urls, results, strict=True))
```

## Package Organization

Prefer `src/` layout for packages unless the repository already uses another
layout.

```text
myproject/
├── src/
│   └── mypackage/
│       ├── __init__.py
│       ├── main.py
│       ├── api/
│       ├── models/
│       └── utils/
├── tests/
├── pyproject.toml
└── README.md
```

Order imports as standard library, third-party, then local imports. Let the
project formatter or linter sort them when configured.

```python
from pathlib import Path

import requests
from fastapi import FastAPI

from mypackage.models import User
from mypackage.utils import format_name
```

Keep `__all__` deliberate when package-level exports are part of the public API.

## Memory And Performance

Use `__slots__` only when memory pressure is real or when the local project
already uses it for value objects.

```python
class Point:
    __slots__ = ("x", "y")

    def __init__(self, x: float, y: float) -> None:
        self.x = x
        self.y = y
```

Prefer generators for large data.

```python
def read_lines(path: Path) -> Iterator[str]:
    with path.open(encoding="utf-8") as file:
        for line in file:
            yield line.strip()
```

Avoid O(n^2) string concatenation in loops.

```python
result = "".join(str(item) for item in items)
```

Use `StringIO` when incremental writes are clearer.

```python
from io import StringIO

buffer = StringIO()
for item in items:
    buffer.write(str(item))
result = buffer.getvalue()
```

## Anti-Patterns

Avoid these patterns:

- mutable default arguments;
- comparing to `None` with `==` or `!=`;
- `type(value) == SomeType` checks instead of `isinstance`;
- wildcard imports;
- bare `except`;
- silent failure paths;
- hidden global setup at import time;
- over-compressed comprehensions;
- manual file or connection cleanup when a context manager is available.

Prefer these replacements:

```python
def append_to(item: str, items: list[str] | None = None) -> list[str]:
    if items is None:
        items = []
    items.append(item)
    return items
```

```python
if value is None:
    process()
```

```python
try:
    risky_operation()
except SpecificError as error:
    logger.exception("Operation failed: %s", error)
```
