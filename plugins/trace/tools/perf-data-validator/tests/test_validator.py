"""Exercise the stable perf data validator command contract."""

from __future__ import annotations

import hashlib
import json
import shutil
import stat
from collections.abc import Callable
from pathlib import Path
from typing import cast

import pytest

from perf_data_validator.cli import main
from perf_data_validator.probe import build_probe
from perf_data_validator.report_types import Issue, ValidationReport

_REPOSITORY_ROOT = Path(__file__).resolve().parents[5]
_REAL_FIXTURE = (
    _REPOSITORY_ROOT
    / "tests"
    / "fixtures"
    / "trace"
    / "openblas-dgemv"
    / "perf-data"
)
_GOLDEN = Path(__file__).parent / "golden" / "openblas-dgemv-report-v1.json"
_RUN_ID = "0123456789abcdef0123456789abcdef"


def _configure_user_paths(
    monkeypatch: pytest.MonkeyPatch,
    temporary_path: Path,
) -> None:
    monkeypatch.setenv("HOME", str(temporary_path / "home"))
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(temporary_path / "runtime"))
    monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
    monkeypatch.delenv("XDG_DATA_HOME", raising=False)


def _run_validator(
    root: Path,
    monkeypatch: pytest.MonkeyPatch,
    temporary_path: Path,
    capfd: pytest.CaptureFixture[str],
) -> tuple[ValidationReport, Path, str]:
    _configure_user_paths(monkeypatch, temporary_path)
    status = main(
        [
            "validate",
            "--perf-data-root",
            str(root),
            "--run-id",
            _RUN_ID,
        ]
    )
    captured = capfd.readouterr()
    assert status == 0
    assert captured.err == ""
    receipt = cast(dict[str, object], json.loads(captured.out))
    assert receipt["contract_version"] == 1
    assert receipt["kind"] == "perf_data_validation_receipt"
    assert receipt["run_id"] == _RUN_ID
    assert set(receipt) == {
        "contract_version",
        "kind",
        "report_path",
        "report_sha256",
        "run_id",
    }
    report_path = Path(cast(str, receipt["report_path"]))
    report_bytes = report_path.read_bytes()
    report_sha = cast(str, receipt["report_sha256"])
    assert hashlib.sha256(report_bytes).hexdigest() == report_sha
    report = cast(ValidationReport, json.loads(report_bytes))
    return report, report_path, report_sha


def _valid_root(path: Path) -> Path:
    root = path / "perf-data"
    annotate = root / "case" / "annotate"
    annotate.mkdir(parents=True)
    (root / "case" / "perf-stat.txt").write_text(
        "cycles,1\n",
        encoding="utf-8",
    )
    (annotate / "001-function-annotate.txt").write_text(
        "valid annotate\n",
        encoding="utf-8",
    )
    return root


def _issue_codes(issues: list[Issue]) -> set[str]:
    return {issue["code"] for issue in issues}


def _remove_perf_stat(root: Path) -> None:
    (root / "case" / "perf-stat.txt").unlink()


def _add_perf_stat(root: Path) -> None:
    (root / "case" / "second.txt").write_text("cycles,2\n", encoding="utf-8")


def _remove_annotate_directory(root: Path) -> None:
    shutil.rmtree(root / "case" / "annotate")


def _replace_with_rejected_annotates(root: Path) -> None:
    annotate = root / "case" / "annotate"
    (annotate / "001-function-annotate.txt").unlink()
    (annotate / "001-empty-annotate.txt").write_text("", encoding="utf-8")
    (annotate / "002-error-annotate.txt").write_text(
        "Error: unavailable\n",
        encoding="utf-8",
    )


def _duplicate_rank(root: Path) -> None:
    (root / "case" / "annotate" / "001-second-annotate.txt").write_text(
        "valid annotate\n",
        encoding="utf-8",
    )


def _duplicate_function(root: Path) -> None:
    (root / "case" / "annotate" / "002-function-annotate.txt").write_text(
        "valid annotate\n",
        encoding="utf-8",
    )


def _replace_with_invalid_annotate_name(root: Path) -> None:
    annotate = root / "case" / "annotate"
    (annotate / "001-function-annotate.txt").unlink()
    (annotate / "not-ranked.txt").write_text(
        "valid annotate\n",
        encoding="utf-8",
    )


@pytest.mark.parametrize(
    ("mutate", "expected_codes"),
    [
        (_remove_perf_stat, {"perf_stat_missing"}),
        (_add_perf_stat, {"perf_stat_multiple"}),
        (_remove_annotate_directory, {"annotate_directory_missing"}),
        (
            _replace_with_rejected_annotates,
            {"annotate_empty", "annotate_error", "annotate_valid_missing"},
        ),
        (_duplicate_rank, {"annotate_rank_duplicate"}),
        (_duplicate_function, {"annotate_function_duplicate"}),
        (
            _replace_with_invalid_annotate_name,
            {"annotate_filename_ignored", "annotate_valid_missing"},
        ),
    ],
)
def test_invalid_testcase_rules_are_deterministic(
    mutate: Callable[[Path], None],
    expected_codes: set[str],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capfd: pytest.CaptureFixture[str],
) -> None:
    """Keep only frozen structural findings in invalid testcases."""
    root = _valid_root(tmp_path)
    mutate(root)
    report, _, _ = _run_validator(root, monkeypatch, tmp_path, capfd)
    assert report["report_status"] == "unusable"
    assert len(report["testcases"]) == 1
    testcase = report["testcases"][0]
    assert testcase["status"] == "invalid"
    assert expected_codes <= _issue_codes(testcase["issues"])


def test_real_fixture_matches_canonical_golden(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capfd: pytest.CaptureFixture[str],
) -> None:
    """Freeze the report produced for the licensed OpenBLAS crop."""
    report, report_path, receipt_sha = _run_validator(
        _REAL_FIXTURE,
        monkeypatch,
        tmp_path,
        capfd,
    )
    stored_golden = _GOLDEN.read_bytes()
    assert stored_golden.endswith(b"\n")
    golden = stored_golden.removesuffix(b"\n")
    assert report_path.read_bytes() == golden
    assert receipt_sha == hashlib.sha256(golden).hexdigest()
    assert report["report_status"] == "usable"
    assert stat.S_IMODE(report_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(report_path.parent.stat().st_mode) == 0o700

    status = main(
        [
            "validate",
            "--perf-data-root",
            str(_REAL_FIXTURE),
            "--run-id",
            _RUN_ID,
        ]
    )
    captured = capfd.readouterr()
    assert status == 2
    assert captured.out == ""
    assert "could not be written atomically" in captured.err
    assert "Traceback" not in captured.err
    assert report_path.read_bytes() == golden


def test_multiple_metadata_is_local_to_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capfd: pytest.CaptureFixture[str],
) -> None:
    """Do not reject valid testcases because metadata is ambiguous."""
    root = _valid_root(tmp_path)
    (root / "one.json").write_text("{}\n", encoding="utf-8")
    (root / "two.json").write_text("{}\n", encoding="utf-8")
    report, _, _ = _run_validator(root, monkeypatch, tmp_path, capfd)
    assert report["report_status"] == "usable"
    assert report["metadata"]["status"] == "invalid"
    assert _issue_codes(report["metadata"]["issues"]) == {"metadata_multiple"}


def test_unsafe_testcase_and_symlink_fail_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capfd: pytest.CaptureFixture[str],
) -> None:
    """Reject unsafe names and every symbolic link without traversal."""
    unsafe_root = _valid_root(tmp_path / "unsafe")
    (unsafe_root / "case").rename(unsafe_root / "e\u0301")
    unsafe_report, _, _ = _run_validator(
        unsafe_root,
        monkeypatch,
        tmp_path / "unsafe-output",
        capfd,
    )
    assert _issue_codes(unsafe_report["issues"]) == {"testcase_name_invalid"}

    drive_root = _valid_root(tmp_path / "drive")
    (drive_root / "case").rename(drive_root / "C:case")
    drive_report, _, _ = _run_validator(
        drive_root,
        monkeypatch,
        tmp_path / "drive-output",
        capfd,
    )
    assert _issue_codes(drive_report["issues"]) == {"testcase_name_invalid"}

    symlink_root = _valid_root(tmp_path / "symlink")
    outside = tmp_path / "outside"
    outside.mkdir()
    (symlink_root / "escape").symlink_to(outside, target_is_directory=True)
    symlink_report, _, _ = _run_validator(
        symlink_root,
        monkeypatch,
        tmp_path / "symlink-output",
        capfd,
    )
    assert _issue_codes(symlink_report["issues"]) == {"symlink_forbidden"}
    assert symlink_report["testcases"] == []


def test_missing_input_still_writes_unusable_report(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capfd: pytest.CaptureFixture[str],
) -> None:
    """Return a receipt for a missing but absolute input root."""
    report, report_path, _ = _run_validator(
        tmp_path / "missing",
        monkeypatch,
        tmp_path,
        capfd,
    )
    assert report_path.is_absolute()
    assert report["report_status"] == "unusable"
    assert _issue_codes(report["issues"]) == {"input_root_missing"}

    status = main(
        [
            "validate",
            "--perf-data-root",
            "/",
            "--run-id",
            "fedcba9876543210fedcba9876543210",
        ]
    )
    captured = capfd.readouterr()
    assert status == 2
    assert captured.out == ""
    assert "filesystem root cannot be used" in captured.err
    assert "Traceback" not in captured.err


def test_report_base_symlink_is_rejected(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capfd: pytest.CaptureFixture[str],
) -> None:
    """Never follow a symbolic link used as the report base."""
    root = _valid_root(tmp_path)
    actual_base = tmp_path / "actual-runtime"
    actual_base.mkdir()
    linked_base = tmp_path / "linked-runtime"
    linked_base.symlink_to(actual_base, target_is_directory=True)
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(linked_base))
    status = main(
        [
            "validate",
            "--perf-data-root",
            str(root),
            "--run-id",
            _RUN_ID,
        ]
    )
    captured = capfd.readouterr()
    assert status == 2
    assert captured.out == ""
    assert "traverses a symbolic link" in captured.err
    assert "Traceback" not in captured.err

    real_home = tmp_path / "real-home"
    real_home.mkdir()
    linked_home = tmp_path / "linked-home"
    linked_home.symlink_to(real_home, target_is_directory=True)
    monkeypatch.setenv("HOME", str(linked_home))
    monkeypatch.setenv("XDG_RUNTIME_DIR", "relative")
    monkeypatch.setenv("XDG_CACHE_HOME", "")
    status = main(
        [
            "validate",
            "--perf-data-root",
            str(root),
            "--run-id",
            "fedcba9876543210fedcba9876543210",
        ]
    )
    captured = capfd.readouterr()
    assert status == 2
    assert captured.out == ""
    assert "traverses a symbolic link" in captured.err
    assert "Traceback" not in captured.err


def test_probe_is_read_only_and_uses_lexical_fallbacks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Expose key inputs without creating the environment."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("XDG_DATA_HOME", "relative")
    probe = build_probe()
    assert probe["compatible"] is True
    python = cast(dict[str, object], probe["python"])
    assert python["cache_tag"] == "cpython-314"
    assert isinstance(python["soabi"], str)
    environment = cast(dict[str, object], probe["environment"])
    expected_prefix = tmp_path / "home" / ".local" / "share"
    assert str(environment["path"]).startswith(str(expected_prefix))
    assert environment["ready"] is False
    assert not expected_prefix.exists()

    environment_path = Path(cast(str, environment["path"]))
    environment_path.parent.mkdir(parents=True)
    outside = tmp_path / "outside-environment"
    outside.mkdir()
    environment_path.symlink_to(outside, target_is_directory=True)
    unsafe_probe = build_probe()
    assert unsafe_probe["compatible"] is False
    unsafe_issues = cast(list[dict[str, str]], unsafe_probe["issues"])
    assert {issue["code"] for issue in unsafe_issues} == {
        "environment_path_unsafe"
    }
