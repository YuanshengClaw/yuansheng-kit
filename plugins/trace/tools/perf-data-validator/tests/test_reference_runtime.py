"""Verify the task 2 reference Python runtime."""

import sys
from importlib.metadata import version


def test_reference_python_minor_version() -> None:
    """Require the selected CPython 3.14 product series."""
    assert sys.implementation.name == "cpython"
    assert sys.version_info[:2] == (3, 14)


def test_locked_rfc8785_version() -> None:
    """Require the runtime dependency version recorded in uv.lock."""
    assert version("rfc8785") == "0.1.4"
