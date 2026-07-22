"""Type the versioned validation report payload."""

from __future__ import annotations

from typing import Literal, TypedDict


class FileReference(TypedDict):
    """Identify immutable input evidence."""

    bytes: str
    path: str
    sha256: str


class Issue(TypedDict):
    """Describe one deterministic validation finding."""

    code: str
    detail: str
    path: str | None
    severity: Literal["error", "warning"]


class Metadata(TypedDict):
    """Describe optional perf data root metadata."""

    build_isa: str | None
    commit_hash: str | None
    file: FileReference | None
    issues: list[Issue]
    repository_url: str | None
    status: Literal["invalid", "missing", "present"]
    test_branch: str | None


class Annotate(TypedDict):
    """Describe one accepted perf annotate file."""

    file: FileReference
    function: str
    rank: str


class Testcase(TypedDict):
    """Describe one discovered testcase directory."""

    annotate_directory: str | None
    annotates: list[Annotate]
    issues: list[Issue]
    name: str
    perf_stat: FileReference | None
    status: Literal["invalid", "valid"]


class ValidationReport(TypedDict):
    """Represent perf data validation report contract version 1."""

    contract_version: Literal[1]
    issues: list[Issue]
    kind: Literal["perf_data_validation_report"]
    metadata: Metadata
    report_status: Literal["unusable", "usable"]
    testcases: list[Testcase]
