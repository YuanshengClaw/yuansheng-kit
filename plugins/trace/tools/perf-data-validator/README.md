# perf-data-validator

`perf-data-validator` is a self-contained Python tool of the `ys-trace` plugin.
Plugin assembly copies the tracked contents of this directory unchanged. The
tool is not a Bun workspace, and the assembly process does not build, install,
wrap, or rewrite it.

The target Agent discovers the copied tool, reads this documentation and its
Python metadata, prepares a compatible isolated environment, and invokes the
module directly. Platform-specific plugin code does not own the tool environment
and does not duplicate its validation rules.

The environment metadata targets CPython `3.14.x`. Its dependency lock can be
checked without changing it:

```text
uv lock --check
```

The root `ruff.toml` provides repository-wide Python formatting and lint rules:

```text
ruff format --check .
ruff check .
```

The only product entry point is frozen as:

```text
python -m perf_data_validator
```

The component is distributed as source inside the plugin artifact. It does not
build a wheel, sdist, zipapp, console script, or frozen binary. `pyproject.toml`
and `uv.lock` describe a reproducible development environment; invoking the
installed tool does not require `uv` itself.
