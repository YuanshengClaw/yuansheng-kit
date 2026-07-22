"""Inspect the local runtime without importing product dependencies."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import stat
import sys
import sysconfig
from pathlib import Path
from typing import Any

from .paths import PathConfigurationError, environment_path, requirements_path


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _regular_file(path: Path) -> bool:
    try:
        file_stat = path.stat()
    except OSError:
        return False
    return stat.S_ISREG(file_stat.st_mode)


def _directory(path: Path) -> bool:
    try:
        file_stat = path.stat()
    except OSError:
        return False
    return stat.S_ISDIR(file_stat.st_mode)


def _safe_existing(path: Path, *, directory: bool) -> bool:
    try:
        file_stat = path.lstat()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    expected = (
        stat.S_ISDIR(file_stat.st_mode)
        if directory
        else stat.S_ISREG(file_stat.st_mode)
    )
    return expected and not stat.S_ISLNK(file_stat.st_mode)


def _safe_environment_python(path: Path) -> bool:
    try:
        file_stat = path.lstat()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    if not (
        stat.S_ISREG(file_stat.st_mode) or stat.S_ISLNK(file_stat.st_mode)
    ):
        return False
    try:
        return os.path.samefile(path, sys.executable)
    except OSError:
        return False


def _installed_rfc8785_version(requirements: Path) -> str | None:
    try:
        content = requirements.read_text(encoding="utf-8")
    except OSError, UnicodeError:
        return None
    prefix = "rfc8785=="
    matching_lines = [
        line for line in content.splitlines() if line.startswith(prefix)
    ]
    if len(matching_lines) != 1:
        return None
    requirement = matching_lines[0][len(prefix) :].strip()
    if not requirement.endswith("\\"):
        return None
    version = requirement.removesuffix("\\").strip()
    if version == "" or any(character.isspace() for character in version):
        return None
    return version


def _metadata_matches(path: Path, expected_version: str) -> bool:
    if not _regular_file(path):
        return False
    try:
        content = path.read_text(encoding="utf-8")
    except OSError, UnicodeError:
        return False
    fields: dict[str, str] = {}
    for line in content.splitlines():
        name, separator, value = line.partition(":")
        if separator and name in {"Name", "Version"}:
            fields[name] = value.strip()
    return fields == {"Name": "rfc8785", "Version": expected_version}


def _environment_is_safe(
    path: Path,
    python_major_minor: str,
    expected_version: str | None,
) -> bool:
    try:
        root_stat = path.lstat()
    except FileNotFoundError:
        return True
    except OSError:
        return False
    if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
        return False

    site_packages = (
        path / "lib" / f"python{python_major_minor}" / "site-packages"
    )
    critical_directories = [
        path / "bin",
        path / "lib",
        path / "lib" / f"python{python_major_minor}",
        site_packages,
    ]
    critical_files = [path / "pyvenv.cfg"]
    if expected_version is not None:
        critical_directories.extend(
            [
                site_packages / "rfc8785",
                site_packages / f"rfc8785-{expected_version}.dist-info",
            ]
        )
        critical_files.extend(
            [
                site_packages / "rfc8785" / "__init__.py",
                site_packages
                / f"rfc8785-{expected_version}.dist-info"
                / "METADATA",
            ]
        )
    directories_safe = all(
        _safe_existing(item, directory=True) for item in critical_directories
    )
    files_safe = all(
        _safe_existing(item, directory=False) for item in critical_files
    )
    return (
        directories_safe
        and files_safe
        and _safe_environment_python(path / "bin" / "python")
    )


def _environment_ready(
    path: Path,
    python_major_minor: str,
    expected_version: str | None,
) -> bool:
    if expected_version is None:
        return False
    site_packages = (
        path / "lib" / f"python{python_major_minor}" / "site-packages"
    )
    metadata_name = f"rfc8785-{expected_version}.dist-info"
    metadata_directory = site_packages / metadata_name
    metadata = metadata_directory / "METADATA"
    return (
        _directory(path)
        and _regular_file(path / "pyvenv.cfg")
        and _directory(path / "bin")
        and _regular_file(path / "bin" / "python")
        and _directory(site_packages)
        and _directory(site_packages / "rfc8785")
        and _directory(metadata_directory)
        and _regular_file(site_packages / "rfc8785" / "__init__.py")
        and _metadata_matches(metadata, expected_version)
    )


def _issue(code: str, detail: str) -> dict[str, str]:
    return {"code": code, "detail": detail}


def build_probe(
    expected_requirements_sha256: str | None = None,
) -> dict[str, Any]:
    """Build the versioned, standard-library-only runtime probe."""
    system = platform.system()
    machine = platform.machine()
    version = platform.python_version()
    implementation = sys.implementation.name
    cache_tag = sys.implementation.cache_tag or ""
    soabi_value = sysconfig.get_config_var("SOABI")
    soabi = soabi_value if isinstance(soabi_value, str) else ""
    executable = os.path.abspath(sys.executable)
    requirement_file = requirements_path()
    issues: list[dict[str, str]] = []

    if system != "Linux":
        issues.append(
            _issue("unsupported_platform", "The control host must run Linux.")
        )
    if implementation != "cpython":
        issues.append(
            _issue(
                "unsupported_python_implementation",
                "The validator requires CPython.",
            )
        )
    if sys.version_info[:2] != (3, 14):
        issues.append(
            _issue(
                "unsupported_python_version",
                "The validator requires CPython >=3.14,<3.15.",
            )
        )
    if cache_tag == "" or soabi == "":
        issues.append(
            _issue(
                "python_abi_unavailable",
                "The interpreter did not expose cache_tag and SOABI.",
            )
        )

    requirements_sha256: str | None = None
    try:
        file_stat = requirement_file.lstat()
        if stat.S_ISLNK(file_stat.st_mode) or not stat.S_ISREG(
            file_stat.st_mode
        ):
            raise OSError("requirements.txt is not a regular file")
        requirements_sha256 = _sha256(requirement_file)
    except OSError:
        issues.append(
            _issue(
                "requirements_unavailable",
                "The generated requirements.txt is missing or unreadable.",
            )
        )

    if (
        requirements_sha256 is not None
        and expected_requirements_sha256 is not None
        and requirements_sha256 != expected_requirements_sha256
    ):
        issues.append(
            _issue(
                "requirements_sha256_mismatch",
                "requirements.txt does not match the trusted caller digest.",
            )
        )

    environment: Path | None = None
    environment_key: str | None = None
    if requirements_sha256 is not None and cache_tag != "" and soabi != "":
        key_input = {
            "cache_tag": cache_tag,
            "machine": machine,
            "python_executable": executable,
            "python_version": version,
            "requirements_sha256": requirements_sha256,
            "soabi": soabi,
            "system": system,
        }
        key_bytes = json.dumps(
            key_input,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        environment_key = hashlib.sha256(key_bytes).hexdigest()
        try:
            environment = environment_path(environment_key)
        except PathConfigurationError as error:
            issues.append(_issue("data_home_unavailable", str(error)))

    expected_version = _installed_rfc8785_version(requirement_file)
    if requirements_sha256 is not None and expected_version is None:
        issues.append(
            _issue(
                "requirements_invalid",
                "requirements.txt does not pin the expected rfc8785 package.",
            )
        )
    ready = False
    if environment is not None:
        python_major_minor = (
            f"{sys.version_info.major}.{sys.version_info.minor}"
        )
        if not _environment_is_safe(
            environment,
            python_major_minor,
            expected_version,
        ):
            issues.append(
                _issue(
                    "environment_path_unsafe",
                    "The content-addressed environment contains an unsafe "
                    "path component.",
                )
            )
        else:
            ready = _environment_ready(
                environment,
                python_major_minor,
                expected_version,
            )

    return {
        "compatible": not issues,
        "contract_version": 1,
        "environment": {
            "key": environment_key,
            "path": None if environment is None else os.fspath(environment),
            "python": (
                None
                if environment is None
                else os.fspath(environment / "bin" / "python")
            ),
            "ready": ready,
        },
        "issues": issues,
        "kind": "perf_data_validator_probe",
        "platform": {"machine": machine, "system": system},
        "python": {
            "cache_tag": cache_tag,
            "executable": executable,
            "implementation": implementation,
            "soabi": soabi,
            "version": version,
        },
        "requirements": {
            "expected_sha256": expected_requirements_sha256,
            "path": os.fspath(requirement_file),
            "sha256": requirements_sha256,
        },
    }
