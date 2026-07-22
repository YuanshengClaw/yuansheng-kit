"""Classify local perf data and write report contract version 1."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import re
import stat
import sys
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

import rfc8785

from .paths import normalize_absolute_path, report_base, report_path
from .report_types import (
    Annotate,
    FileReference,
    Issue,
    Metadata,
    Testcase,
    ValidationReport,
)

_ANNOTATE_NAME = re.compile(r"^([0-9]{3})-(.+)-annotate\.txt$")
_EXPECTED_RFC8785_VERSION = "0.1.4"
_MAX_REPORT_BYTES = 16 * 1024 * 1024
_READ_BLOCK_SIZE = 1024 * 1024


class ValidationRuntimeError(RuntimeError):
    """Report an operational failure outside input classification."""


class _InputChanged(RuntimeError):
    pass


class _FileUnreadable(RuntimeError):
    pass


@dataclass(frozen=True)
class _Entry:
    relative_path: str
    kind: Literal["directory", "file", "special", "symlink"]
    fingerprint: tuple[int, int, int, int, int, int]


@dataclass(frozen=True)
class _Snapshot:
    root_fingerprint: tuple[int, int, int, int, int, int]
    entries: tuple[_Entry, ...]

    def by_path(self) -> dict[str, _Entry]:
        return {entry.relative_path: entry for entry in self.entries}


@dataclass(frozen=True)
class _ReadResult:
    byte_count: int
    content: bytes | None
    sha256: str


class _DuplicateJsonKey(ValueError):
    pass


def _fingerprint(
    file_stat: os.stat_result,
) -> tuple[int, int, int, int, int, int]:
    return (
        file_stat.st_dev,
        file_stat.st_ino,
        file_stat.st_mode,
        file_stat.st_size,
        file_stat.st_mtime_ns,
        file_stat.st_ctime_ns,
    )


def _safe_segment(value: str) -> bool:
    if value in {"", ".", ".."} or "/" in value or "\\" in value:
        return False
    if any(
        ord(character) <= 0x1F or ord(character) == 0x7F for character in value
    ):
        return False
    if unicodedata.normalize("NFC", value) != value:
        return False
    try:
        return len(value.encode("utf-8")) <= 255
    except UnicodeEncodeError:
        return False


def _safe_logical_path(value: str) -> bool:
    if (
        value.startswith("/")
        or "\\" in value
        or re.match(r"^[A-Za-z]:", value)
    ):
        return False
    segments = value.split("/")
    return bool(segments) and all(
        _safe_segment(segment) for segment in segments
    )


def _safe_testcase_name(value: str) -> bool:
    return _safe_segment(value) and re.match(r"^[A-Za-z]:", value) is None


def _issue_path(relative_path: str) -> str | None:
    return relative_path if _safe_logical_path(relative_path) else None


def _issue(
    severity: Literal["error", "warning"],
    code: str,
    path: str | None,
    detail: str,
) -> Issue:
    return {
        "code": code,
        "detail": detail,
        "path": path,
        "severity": severity,
    }


def _utf8_key(value: str) -> bytes:
    return value.encode("utf-8")


def _sort_issues(issues: list[Issue]) -> list[Issue]:
    return sorted(
        issues,
        key=lambda issue: (
            0 if issue["severity"] == "error" else 1,
            0 if issue["path"] is None else 1,
            b"" if issue["path"] is None else _utf8_key(issue["path"]),
            _utf8_key(issue["code"]),
            _utf8_key(issue["detail"]),
        ),
    )


def _entry_kind(
    mode: int,
) -> Literal["directory", "file", "special", "symlink"]:
    if stat.S_ISLNK(mode):
        return "symlink"
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISREG(mode):
        return "file"
    return "special"


def _raw_name_key(name: str) -> bytes:
    return os.fsencode(name)


def _path_has_symlink_component(path: str) -> bool:
    current = os.path.sep
    for component in Path(path).parts[1:]:
        current = os.path.join(current, component)
        try:
            if stat.S_ISLNK(os.lstat(current).st_mode):
                return True
        except OSError:
            return False
    return False


def _walk_directory(
    root: str,
    relative_directory: str,
    entries: list[_Entry],
    issues: list[Issue],
) -> None:
    directory = (
        root
        if relative_directory == ""
        else os.path.join(root, *relative_directory.split("/"))
    )
    try:
        with os.scandir(directory) as iterator:
            children = sorted(
                iterator,
                key=lambda entry: _raw_name_key(entry.name),
            )
    except OSError:
        issues.append(
            _issue(
                "error",
                "input_unreadable",
                _issue_path(relative_directory),
                "An input directory could not be read.",
            )
        )
        return

    for child in children:
        relative_path = (
            child.name
            if relative_directory == ""
            else f"{relative_directory}/{child.name}"
        )
        try:
            child_stat = child.stat(follow_symlinks=False)
        except OSError:
            issues.append(
                _issue(
                    "error",
                    "input_unreadable",
                    _issue_path(relative_path),
                    "An input entry could not be inspected.",
                )
            )
            continue
        kind = _entry_kind(child_stat.st_mode)
        entries.append(
            _Entry(
                relative_path=relative_path,
                kind=kind,
                fingerprint=_fingerprint(child_stat),
            )
        )
        if kind == "directory":
            _walk_directory(root, relative_path, entries, issues)
        elif kind == "symlink":
            issues.append(
                _issue(
                    "error",
                    "symlink_forbidden",
                    _issue_path(relative_path),
                    "Symbolic links are forbidden anywhere in the input tree.",
                )
            )
        elif kind == "special":
            issues.append(
                _issue(
                    "error",
                    "unsupported_entry_type",
                    _issue_path(relative_path),
                    "The input tree contains a non-regular filesystem entry.",
                )
            )


def _snapshot_tree(root: str) -> tuple[_Snapshot | None, list[Issue]]:
    issues: list[Issue] = []
    try:
        root_stat = os.lstat(root)
    except FileNotFoundError:
        return None, [
            _issue(
                "error",
                "input_root_missing",
                None,
                "The perf data root does not exist.",
            )
        ]
    except OSError:
        return None, [
            _issue(
                "error",
                "input_root_unreadable",
                None,
                "The perf data root could not be inspected.",
            )
        ]

    if stat.S_ISLNK(root_stat.st_mode) or _path_has_symlink_component(root):
        return None, [
            _issue(
                "error",
                "symlink_forbidden",
                None,
                "The perf data root must not traverse a symbolic link.",
            )
        ]
    if not stat.S_ISDIR(root_stat.st_mode):
        return None, [
            _issue(
                "error",
                "input_root_not_directory",
                None,
                "The perf data root is not a directory.",
            )
        ]

    entries: list[_Entry] = []
    _walk_directory(root, "", entries, issues)
    entries.sort(key=lambda entry: os.fsencode(entry.relative_path))
    return (
        _Snapshot(
            root_fingerprint=_fingerprint(root_stat),
            entries=tuple(entries),
        ),
        _sort_issues(issues),
    )


def _matches_snapshot(file_stat: os.stat_result, expected: _Entry) -> bool:
    return (
        _entry_kind(file_stat.st_mode) == "file"
        and _fingerprint(file_stat) == expected.fingerprint
    )


def _stable_read(
    root: str,
    entry: _Entry,
    *,
    capture: bool,
) -> _ReadResult:
    path = os.path.join(root, *entry.relative_path.split("/"))
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise _FileUnreadable from error

    blocks: list[bytes] | None = [] if capture else None
    digest = hashlib.sha256()
    byte_count = 0
    try:
        before = os.fstat(descriptor)
        if not _matches_snapshot(before, entry):
            raise _InputChanged
        with os.fdopen(descriptor, "rb", closefd=True) as stream:
            descriptor = -1
            for block in iter(lambda: stream.read(_READ_BLOCK_SIZE), b""):
                byte_count += len(block)
                digest.update(block)
                if blocks is not None:
                    blocks.append(block)
            after = os.fstat(stream.fileno())
        if not _matches_snapshot(after, entry):
            raise _InputChanged
        current = os.stat(path, follow_symlinks=False)
        if not _matches_snapshot(current, entry):
            raise _InputChanged
    except OSError as error:
        raise _FileUnreadable from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)

    content = None if blocks is None else b"".join(blocks)
    return _ReadResult(
        byte_count=byte_count,
        content=content,
        sha256=digest.hexdigest(),
    )


def _file_reference(entry: _Entry, result: _ReadResult) -> FileReference:
    return {
        "bytes": str(result.byte_count),
        "path": entry.relative_path,
        "sha256": result.sha256,
    }


def _missing_metadata() -> Metadata:
    return {
        "build_isa": None,
        "commit_hash": None,
        "file": None,
        "issues": [
            _issue(
                "warning",
                "metadata_missing",
                None,
                "No metadata JSON was present at the input root.",
            )
        ],
        "repository_url": None,
        "status": "missing",
        "test_branch": None,
    }


def _invalid_metadata(
    file: FileReference | None,
    issues: list[Issue],
) -> Metadata:
    return {
        "build_isa": None,
        "commit_hash": None,
        "file": file,
        "issues": _sort_issues(issues),
        "repository_url": None,
        "status": "invalid",
        "test_branch": None,
    }


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"Non-finite JSON number: {value}")


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateJsonKey(key)
        result[key] = value
    return result


def _metadata_value(
    document: dict[str, object],
    field: str,
    path: str,
    issues: list[Issue],
) -> str | None:
    value = document.get(field)
    if isinstance(value, str) and value != "":
        return value
    issues.append(
        _issue(
            "warning",
            "metadata_field_invalid",
            path,
            f"Metadata field {field} is missing or is not a non-empty string.",
        )
    )
    return None


def _validate_metadata(root: str, snapshot: _Snapshot) -> Metadata:
    candidates = [
        entry
        for entry in snapshot.entries
        if entry.kind == "file"
        and "/" not in entry.relative_path
        and entry.relative_path.endswith(".json")
    ]
    candidates.sort(key=lambda entry: os.fsencode(entry.relative_path))
    if not candidates:
        return _missing_metadata()
    if len(candidates) > 1:
        return _invalid_metadata(
            None,
            [
                _issue(
                    "error",
                    "metadata_multiple",
                    None,
                    "The perf data root contains more than one metadata "
                    "JSON file.",
                )
            ],
        )

    candidate = candidates[0]
    if not _safe_logical_path(candidate.relative_path):
        return _invalid_metadata(
            None,
            [
                _issue(
                    "error",
                    "metadata_path_invalid",
                    None,
                    "The metadata filename is not a safe logical path.",
                )
            ],
        )
    try:
        result = _stable_read(root, candidate, capture=True)
    except _FileUnreadable:
        return _invalid_metadata(
            None,
            [
                _issue(
                    "error",
                    "metadata_unreadable",
                    candidate.relative_path,
                    "The metadata JSON file could not be read.",
                )
            ],
        )
    reference = _file_reference(candidate, result)
    assert result.content is not None
    try:
        text = result.content.decode("utf-8")
        parsed = json.loads(
            text,
            object_pairs_hook=_unique_json_object,
            parse_constant=_reject_json_constant,
        )
        if not isinstance(parsed, dict):
            raise ValueError("Metadata root is not an object")
        document = cast(dict[str, object], parsed)
    except UnicodeError, json.JSONDecodeError, ValueError:
        return _invalid_metadata(
            reference,
            [
                _issue(
                    "error",
                    "metadata_invalid",
                    candidate.relative_path,
                    "The metadata file is not a strict UTF-8 JSON object.",
                )
            ],
        )

    issues: list[Issue] = []
    repository_url = _metadata_value(
        document, "repository_url", candidate.relative_path, issues
    )
    test_branch = _metadata_value(
        document, "test_branch", candidate.relative_path, issues
    )
    commit_hash = _metadata_value(
        document, "commit_hash", candidate.relative_path, issues
    )
    return {
        "build_isa": None,
        "commit_hash": commit_hash,
        "file": reference,
        "issues": _sort_issues(issues),
        "repository_url": repository_url,
        "status": "present",
        "test_branch": test_branch,
    }


def _direct_children(snapshot: _Snapshot, directory: str) -> list[_Entry]:
    prefix = f"{directory}/" if directory else ""
    children: list[_Entry] = []
    for entry in snapshot.entries:
        if not entry.relative_path.startswith(prefix):
            continue
        remainder = entry.relative_path[len(prefix) :]
        if remainder != "" and "/" not in remainder:
            children.append(entry)
    children.sort(key=lambda entry: os.fsencode(entry.relative_path))
    return children


def _validate_perf_stat(
    root: str,
    testcase_name: str,
    children: list[_Entry],
    issues: list[Issue],
) -> FileReference | None:
    candidates = [
        entry
        for entry in children
        if entry.kind == "file" and entry.relative_path.endswith(".txt")
    ]
    if not candidates:
        issues.append(
            _issue(
                "error",
                "perf_stat_missing",
                testcase_name,
                "The testcase does not contain a direct perf stat text file.",
            )
        )
        return None
    if len(candidates) > 1:
        issues.append(
            _issue(
                "error",
                "perf_stat_multiple",
                testcase_name,
                "The testcase contains more than one direct perf stat "
                "text file.",
            )
        )
        return None

    candidate = candidates[0]
    if not _safe_logical_path(candidate.relative_path):
        issues.append(
            _issue(
                "error",
                "perf_stat_path_invalid",
                testcase_name,
                "The perf stat filename is not a safe logical path.",
            )
        )
        return None
    try:
        result = _stable_read(root, candidate, capture=False)
    except _FileUnreadable:
        issues.append(
            _issue(
                "error",
                "perf_stat_unreadable",
                candidate.relative_path,
                "The perf stat file could not be read.",
            )
        )
        return None
    reference = _file_reference(candidate, result)
    if result.byte_count == 0:
        issues.append(
            _issue(
                "error",
                "perf_stat_empty",
                candidate.relative_path,
                "The perf stat file is empty.",
            )
        )
    return reference


def _validate_annotates(
    root: str,
    testcase_name: str,
    snapshot: _Snapshot,
    children: list[_Entry],
    issues: list[Issue],
) -> tuple[str | None, list[Annotate]]:
    annotate_path = f"{testcase_name}/annotate"
    annotate_entry = next(
        (entry for entry in children if entry.relative_path == annotate_path),
        None,
    )
    if annotate_entry is None:
        issues.append(
            _issue(
                "error",
                "annotate_directory_missing",
                testcase_name,
                "The testcase does not contain an annotate directory.",
            )
        )
        return None, []
    if annotate_entry.kind != "directory":
        issues.append(
            _issue(
                "error",
                "annotate_directory_invalid",
                annotate_path,
                "The annotate path is not a directory.",
            )
        )
        return None, []

    annotates: list[Annotate] = []
    for candidate in _direct_children(snapshot, annotate_path):
        if candidate.kind != "file" or not candidate.relative_path.endswith(
            ".txt"
        ):
            continue
        filename = candidate.relative_path.rsplit("/", maxsplit=1)[-1]
        match = _ANNOTATE_NAME.fullmatch(filename)
        if match is None:
            issues.append(
                _issue(
                    "warning",
                    "annotate_filename_ignored",
                    _issue_path(candidate.relative_path),
                    "An annotate text filename did not match the frozen "
                    "pattern.",
                )
            )
            continue
        rank, function = match.groups()
        try:
            ranked_length = len(f"{rank}_{function}".encode("utf-8"))
        except UnicodeEncodeError:
            ranked_length = 256
        if not _safe_segment(function) or ranked_length > 255:
            issues.append(
                _issue(
                    "warning",
                    "annotate_filename_ignored",
                    _issue_path(candidate.relative_path),
                    "An annotate text filename contained an unsafe "
                    "function name.",
                )
            )
            continue
        try:
            result = _stable_read(root, candidate, capture=True)
        except _FileUnreadable:
            issues.append(
                _issue(
                    "warning",
                    "annotate_unreadable",
                    candidate.relative_path,
                    "An annotate file could not be read and was ignored.",
                )
            )
            continue
        assert result.content is not None
        try:
            text = result.content.decode("utf-8")
        except UnicodeError:
            issues.append(
                _issue(
                    "warning",
                    "annotate_invalid_utf8",
                    candidate.relative_path,
                    "An annotate file was not strict UTF-8 and was ignored.",
                )
            )
            continue
        first_line = text.split("\n", maxsplit=1)[0].strip()
        if result.byte_count == 0 or first_line == "":
            issues.append(
                _issue(
                    "warning",
                    "annotate_empty",
                    candidate.relative_path,
                    "An annotate file had an empty first line and was "
                    "ignored.",
                )
            )
            continue
        if first_line.startswith("Error:"):
            issues.append(
                _issue(
                    "warning",
                    "annotate_error",
                    candidate.relative_path,
                    "An annotate file began with Error: and was ignored.",
                )
            )
            continue
        annotates.append(
            {
                "file": _file_reference(candidate, result),
                "function": function,
                "rank": rank,
            }
        )

    annotates.sort(
        key=lambda annotate: (
            _utf8_key(annotate["rank"]),
            _utf8_key(annotate["function"]),
            _utf8_key(annotate["file"]["path"]),
        )
    )
    if not annotates:
        issues.append(
            _issue(
                "error",
                "annotate_valid_missing",
                annotate_path,
                "The testcase does not contain a usable annotate text file.",
            )
        )
    ranks: set[str] = set()
    functions: set[str] = set()
    duplicate_rank = False
    duplicate_function = False
    for annotate in annotates:
        if annotate["rank"] in ranks:
            duplicate_rank = True
        if annotate["function"] in functions:
            duplicate_function = True
        ranks.add(annotate["rank"])
        functions.add(annotate["function"])
    if duplicate_rank:
        issues.append(
            _issue(
                "error",
                "annotate_rank_duplicate",
                annotate_path,
                "The testcase repeats an annotate rank.",
            )
        )
    if duplicate_function:
        issues.append(
            _issue(
                "error",
                "annotate_function_duplicate",
                annotate_path,
                "The testcase repeats an annotate function.",
            )
        )
    return annotate_path, annotates


def _validate_testcase(root: str, name: str, snapshot: _Snapshot) -> Testcase:
    issues: list[Issue] = []
    children = _direct_children(snapshot, name)
    perf_stat = _validate_perf_stat(root, name, children, issues)
    annotate_directory, annotates = _validate_annotates(
        root,
        name,
        snapshot,
        children,
        issues,
    )
    sorted_issues = _sort_issues(issues)
    status: Literal["invalid", "valid"] = (
        "invalid"
        if any(issue["severity"] == "error" for issue in sorted_issues)
        else "valid"
    )
    return {
        "annotate_directory": annotate_directory,
        "annotates": annotates,
        "issues": sorted_issues,
        "name": name,
        "perf_stat": perf_stat,
        "status": status,
    }


def _fatal_report(issues: list[Issue]) -> ValidationReport:
    return {
        "contract_version": 1,
        "issues": _sort_issues(issues),
        "kind": "perf_data_validation_report",
        "metadata": _missing_metadata(),
        "report_status": "unusable",
        "testcases": [],
    }


def _validate_tree(root: str) -> ValidationReport:
    first_snapshot, snapshot_issues = _snapshot_tree(root)
    if first_snapshot is None or snapshot_issues:
        return _fatal_report(snapshot_issues)

    testcase_entries = [
        entry
        for entry in first_snapshot.entries
        if entry.kind == "directory" and "/" not in entry.relative_path
    ]
    unsafe_testcases = [
        entry
        for entry in testcase_entries
        if not _safe_testcase_name(entry.relative_path)
    ]
    if unsafe_testcases:
        return _fatal_report(
            [
                _issue(
                    "error",
                    "testcase_name_invalid",
                    None,
                    "A testcase directory name is not a safe path segment.",
                )
            ]
        )

    global_issues: list[Issue] = []
    if not testcase_entries:
        global_issues.append(
            _issue(
                "error",
                "testcase_missing",
                None,
                "The perf data root does not contain a testcase directory.",
            )
        )
    try:
        metadata = _validate_metadata(root, first_snapshot)
        testcases = [
            _validate_testcase(root, entry.relative_path, first_snapshot)
            for entry in testcase_entries
        ]
    except _InputChanged:
        return _fatal_report(
            [
                _issue(
                    "error",
                    "input_changed",
                    None,
                    "The input tree changed while it was being validated.",
                )
            ]
        )

    second_snapshot, second_issues = _snapshot_tree(root)
    if (
        second_snapshot is None
        or second_issues
        or second_snapshot != first_snapshot
    ):
        return _fatal_report(
            [
                _issue(
                    "error",
                    "input_changed",
                    None,
                    "The input tree changed while it was being validated.",
                )
            ]
        )

    testcases.sort(key=lambda testcase: _utf8_key(testcase["name"]))
    usable = not any(
        issue["severity"] == "error" for issue in global_issues
    ) and any(testcase["status"] == "valid" for testcase in testcases)
    report_status: Literal["unusable", "usable"] = (
        "usable" if usable else "unusable"
    )
    return {
        "contract_version": 1,
        "issues": _sort_issues(global_issues),
        "kind": "perf_data_validation_report",
        "metadata": metadata,
        "report_status": report_status,
        "testcases": testcases,
    }


def _ensure_private_directory(path: Path) -> None:
    try:
        file_stat = path.lstat()
    except FileNotFoundError:
        try:
            path.mkdir(mode=0o700)
        except OSError as error:
            raise ValidationRuntimeError(
                "The report directory could not be created."
            ) from error
        file_stat = path.lstat()
    except OSError as error:
        raise ValidationRuntimeError(
            "The report directory could not be inspected."
        ) from error
    if stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISDIR(file_stat.st_mode):
        raise ValidationRuntimeError(
            "A report path component is not a directory."
        )
    try:
        path.chmod(0o700)
    except OSError as error:
        raise ValidationRuntimeError(
            "The report directory permissions could not be secured."
        ) from error


def _prepare_report_directory(destination: Path) -> None:
    base = Path(report_base())
    if _path_has_symlink_component(os.fspath(base)):
        raise ValidationRuntimeError(
            "The report base path traverses a symbolic link."
        )
    try:
        base_stat = base.lstat()
    except FileNotFoundError:
        try:
            base.mkdir(mode=0o700, parents=True)
        except OSError as error:
            raise ValidationRuntimeError(
                "The report base directory could not be created."
            ) from error
        try:
            base_stat = base.lstat()
        except OSError as error:
            raise ValidationRuntimeError(
                "The report base directory could not be inspected."
            ) from error
    except OSError as error:
        raise ValidationRuntimeError(
            "The report base directory could not be inspected."
        ) from error
    if stat.S_ISLNK(base_stat.st_mode) or not stat.S_ISDIR(base_stat.st_mode):
        raise ValidationRuntimeError(
            "The report base path is not a directory."
        )

    current = base
    for component in (
        "yuansheng-kit",
        "ys-trace",
        "reports",
        destination.parent.name,
    ):
        current /= component
        _ensure_private_directory(current)


def _write_atomic(destination: Path, content: bytes) -> None:
    _prepare_report_directory(destination)
    descriptor = -1
    temporary_path = ""
    try:
        descriptor, temporary_path = tempfile.mkstemp(
            dir=destination.parent,
            prefix=".perf-data-validation-report-",
        )
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            descriptor = -1
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(
            temporary_path,
            destination,
            follow_symlinks=False,
        )
        os.unlink(temporary_path)
        temporary_path = ""
        directory_descriptor = os.open(
            destination.parent,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
        )
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except OSError as error:
        raise ValidationRuntimeError(
            "The validation report could not be written atomically."
        ) from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary_path:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass


def _assert_runtime_dependency() -> None:
    try:
        installed = importlib.metadata.version("rfc8785")
    except importlib.metadata.PackageNotFoundError as error:
        raise ValidationRuntimeError(
            "The rfc8785 dependency is not installed."
        ) from error
    if installed != _EXPECTED_RFC8785_VERSION:
        raise ValidationRuntimeError(
            "The installed rfc8785 version does not match requirements.txt."
        )


def validate_and_write(perf_data_root: str, run_id: str) -> dict[str, object]:
    """Validate one local root and return a bounded report receipt."""
    if sys.platform != "linux":
        raise ValidationRuntimeError("The control host must run Linux.")
    if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 14):
        raise ValidationRuntimeError(
            "The validator requires CPython >=3.14,<3.15."
        )
    _assert_runtime_dependency()
    root = normalize_absolute_path(perf_data_root)
    if root.lstrip(os.path.sep) == "":
        raise ValidationRuntimeError(
            "The filesystem root cannot be used as a perf data root."
        )
    destination = report_path(run_id)
    try:
        if os.path.commonpath((root, os.fspath(destination))) == root:
            raise ValidationRuntimeError(
                "The report path must be outside the perf data root."
            )
    except ValueError as error:
        raise ValidationRuntimeError(
            "The report path could not be compared with the input root."
        ) from error

    report = _validate_tree(root)
    try:
        content = rfc8785.dumps(report)
    except rfc8785.CanonicalizationError as error:
        raise ValidationRuntimeError(
            "The validation report could not be canonicalized."
        ) from error
    if len(content) > _MAX_REPORT_BYTES:
        raise ValidationRuntimeError(
            "The canonical validation report exceeds the 16 MiB limit."
        )
    _write_atomic(destination, content)
    return {
        "contract_version": 1,
        "kind": "perf_data_validation_receipt",
        "report_path": os.fspath(destination),
        "report_sha256": hashlib.sha256(content).hexdigest(),
        "run_id": run_id,
    }
