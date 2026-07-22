"""Derive lexical user paths without resolving symbolic links."""

from __future__ import annotations

import os
from pathlib import Path


class PathConfigurationError(RuntimeError):
    """Report an unusable user path configuration."""


def normalize_absolute_path(value: str) -> str:
    """Return a lexically normalized absolute path."""
    normalized = os.path.normpath(value)
    if not os.path.isabs(normalized):
        raise PathConfigurationError("The path must be absolute.")
    return normalized


def _absolute_non_root(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    normalized = os.path.normpath(value)
    if not os.path.isabs(normalized) or normalized == os.path.sep:
        return None
    return normalized


def _home_directory() -> str:
    home = _absolute_non_root(os.environ.get("HOME"))
    if home is None:
        raise PathConfigurationError(
            "HOME must identify an absolute, non-root directory."
        )
    return home


def data_home() -> str:
    """Return the absolute base for content-addressed environments."""
    configured = _absolute_non_root(os.environ.get("XDG_DATA_HOME"))
    if configured is not None:
        return configured
    return os.path.join(_home_directory(), ".local", "share")


def report_base() -> str:
    """Return the absolute base for transient validation reports."""
    runtime = _absolute_non_root(os.environ.get("XDG_RUNTIME_DIR"))
    if runtime is not None:
        return runtime
    cache = _absolute_non_root(os.environ.get("XDG_CACHE_HOME"))
    if cache is not None:
        return cache
    return os.path.join(_home_directory(), ".cache")


def tool_root() -> Path:
    """Return the lexical absolute path of the installed tool root."""
    package_directory = os.path.dirname(__file__)
    root = os.path.abspath(os.path.join(package_directory, "..", ".."))
    return Path(root)


def requirements_path() -> Path:
    """Return the generated product requirements path."""
    return tool_root() / "requirements.txt"


def environment_path(environment_key: str) -> Path:
    """Return the content-addressed environment path."""
    return Path(
        data_home(),
        "yuansheng-kit",
        "ys-trace",
        "perf-data-validator",
        "environments",
        environment_key,
    )


def report_path(run_id: str) -> Path:
    """Return the per-run validation report path."""
    return Path(
        report_base(),
        "yuansheng-kit",
        "ys-trace",
        "reports",
        run_id,
        "perf-data-validation-report-v1.json",
    )
