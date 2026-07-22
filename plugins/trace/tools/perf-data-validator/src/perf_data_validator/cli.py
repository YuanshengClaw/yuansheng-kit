"""Expose the stable probe and validate command-line protocol."""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections.abc import Sequence

from .paths import PathConfigurationError
from .probe import build_probe

_RUN_ID = re.compile(r"^[0-9a-f]{32}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_MAX_STDOUT_BYTES = 8192


class CommandError(RuntimeError):
    """Report a bounded command failure without a traceback."""


def _run_id(value: str) -> str:
    if _RUN_ID.fullmatch(value) is None:
        raise argparse.ArgumentTypeError(
            "run id must contain exactly 32 lowercase hexadecimal characters"
        )
    return value


def _sha256(value: str) -> str:
    if _SHA256.fullmatch(value) is None:
        raise argparse.ArgumentTypeError(
            "SHA-256 must contain exactly 64 lowercase hexadecimal characters"
        )
    return value


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="perf_data_validator")
    subparsers = parser.add_subparsers(dest="command", required=True)
    probe = subparsers.add_parser(
        "probe",
        help="inspect the interpreter and content-addressed environment",
    )
    probe.add_argument(
        "--requirements-sha256",
        required=True,
        type=_sha256,
    )
    validate = subparsers.add_parser(
        "validate",
        help="validate a local perf data root and write report v1",
    )
    validate.add_argument("--perf-data-root", required=True)
    validate.add_argument("--run-id", required=True, type=_run_id)
    return parser


def _emit(payload: object) -> None:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    if len(encoded) > _MAX_STDOUT_BYTES:
        raise CommandError("Command output exceeded the protocol limit.")
    sys.stdout.buffer.write(encoded + b"\n")


def _validate(perf_data_root: str, run_id: str) -> object:
    try:
        from .validation import ValidationRuntimeError, validate_and_write
    except ModuleNotFoundError as error:
        if error.name != "rfc8785":
            raise CommandError(
                "The validator runtime could not be loaded."
            ) from error
        raise CommandError(
            "The rfc8785 dependency is unavailable; prepare the "
            "content-addressed environment first."
        ) from error
    except ImportError as error:
        raise CommandError(
            "The validator runtime could not be loaded."
        ) from error
    try:
        return validate_and_write(perf_data_root, run_id)
    except ValidationRuntimeError as error:
        raise CommandError(str(error)) from error


def main(argv: Sequence[str] | None = None) -> int:
    """Run the module command and return its process status."""
    arguments = _parser().parse_args(argv)
    try:
        if arguments.command == "probe":
            _emit(build_probe(arguments.requirements_sha256))
        else:
            _emit(_validate(arguments.perf_data_root, arguments.run_id))
    except (CommandError, PathConfigurationError) as error:
        print(f"perf-data-validator: {error}", file=sys.stderr)
        return 2
    return 0
