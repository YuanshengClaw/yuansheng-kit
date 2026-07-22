# perf-data-validator

`perf-data-validator` is the sole executable source of perf input validity for
Yuansheng Trace. It classifies directory structure and evidence files. It does
not select anomalous testcases, apply statistical thresholds, interpret perf
metrics, or perform root-cause analysis.

Plugin assembly copies this entire directory unchanged. The tool is distributed
as Python source and is not built as a wheel, sdist, zipapp, console script, or
frozen executable.

## Runtime contract

The control host must run Linux and provide CPython `>=3.14,<3.15`. Invoke the
module from the installed, read-only tool directory with its `src/` directory as
the only explicit module path:

```text
env -u PYTHONHOME PYTHONPATH='<tool_root>/src' python3.14 -P -B -s -m perf_data_validator probe --requirements-sha256 '<requirements_sha256>'
```

`probe` uses only the Python standard library. Its compact JSON result includes:

- `contract_version: 1` and `kind: "perf_data_validator_probe"`;
- Linux system and machine identifiers;
- the full Python version, implementation, `cache_tag`, and `SOABI`;
- the absolute generated `requirements.txt` path and its SHA-256 digest;
- the content-addressed environment key, path, interpreter path, and `ready`
  state; and
- bounded compatibility issues.

The environment key is the SHA-256 digest of compact, key-sorted JSON containing
the system, machine, lexical absolute Python executable, full Python version,
`cache_tag`, `SOABI`, and requirements SHA-256. The environment path is:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/yuansheng-kit/ys-trace/perf-data-validator/environments/<key>
```

Empty, relative, or filesystem-root `XDG_DATA_HOME` values are ignored. The
fallback `HOME` must be absolute and must not be the filesystem root. `probe`
does not create or modify the environment.

If `compatible` is false, stop and show the reported issues. In particular, do
not run setup when `environment_path_unsafe` is present. If `compatible` is true
and `environment.ready` is false, show the interpreter, destination,
requirements digest, approved package index, and the following complete
commands. Run them only after obtaining per-invocation approval:

```text
env -u PYTHONHOME -u PYTHONPATH python3.14 -P -B -s -m venv --clear '<environment>'
env -u PYTHONHOME -u PYTHONPATH '<environment_python>' -P -B -s -m pip --isolated install --require-hashes --only-binary=:all: --no-deps --index-url '<approved_index_url>' -r '<requirements_path>'
```

Only this cold setup may use the approved network index. A partial environment
is cleared before reuse. Hash checking, binary-only installation, disabled
dependency resolution, and the explicit index prevent unapproved build or
resolution paths.

After a second probe reports `environment.ready: true`, validation is local and
must not access the network:

```text
env -u PYTHONHOME PYTHONPATH='<tool_root>/src' '<environment_python>' -P -B -s -m perf_data_validator validate --perf-data-root '<absolute_perf_data_root>' --run-id '<32_lowercase_hex>'
```

The perf data root must be an absolute directory outside the report path and
must not be the filesystem root. Invalid input structure produces an `unusable`
report. Invalid command arguments, unsafe runtime paths, missing dependencies,
and report write failures instead return a bounded diagnostic and a nonzero
status without a traceback.

## Input classification

The validator applies only deterministic structural rules:

- every direct child directory of the perf data root is a testcase;
- zero or one direct root `*.json` file supplies optional metadata;
- each valid testcase has exactly one direct non-empty `*.txt` perf stat file;
- each valid testcase has a direct `annotate/` directory with at least one
  accepted `NNN-<function>-annotate.txt` file;
- annotate files must be strict UTF-8, non-empty on the first line, and must not
  begin with the exact prefix `Error:` after trimming the first line;
- ranks and function names are unique within a valid testcase; and
- symbolic links and non-regular filesystem entries are rejected anywhere in the
  input tree.

Names, logical paths, issue order, testcase order, and annotate order are
normalized deterministically. Every accepted evidence reference records its
relative POSIX path, decimal byte count, and lowercase SHA-256 digest. Files are
read without following symbolic links, and a changed input snapshot fails
closed.

Metadata extracts only non-empty `repository_url`, `test_branch`, and
`commit_hash` strings. `build_isa` remains `null` in report contract version 1.
Metadata problems do not invalidate an otherwise valid testcase. No filename or
file content is used for anomaly or performance classification.

## Report handoff

The validator serializes report contract version 1 with RFC 8785/JCS, rejects a
canonical report larger than 16 MiB, and writes it with mode `0600` into private
`0700` directories. The lexical report path is:

```text
<report_base>/yuansheng-kit/ys-trace/reports/<run_id>/perf-data-validation-report-v1.json
```

`report_base` is the first absolute, non-root value in this order:
`XDG_RUNTIME_DIR`, `XDG_CACHE_HOME`, then `$HOME/.cache`. Optional empty,
relative, or root XDG values are ignored. The base, its existing ancestors, and
managed path components must not be symbolic links. An existing final report is
never overwritten.

Standard output contains only one bounded compact receipt with these exact
fields:

```json
{"contract_version":1,"kind":"perf_data_validation_receipt","report_path":"/absolute/path/perf-data-validation-report-v1.json","report_sha256":"<64_lowercase_hex>","run_id":"<32_lowercase_hex>"}
```

The caller must verify the receipt digest before parsing the report and must
remove the report and empty per-run directory after success, failure, or
cancellation.

## Dependency and development workflow

`pyproject.toml` and the single `uv.lock` are development and resolution inputs.
The generated `requirements.txt` is the only product installation input. It
contains exact versions and SHA-256 hashes and must match this deterministic
export from the repository root:

```text
uv export --project plugins/trace/tools/perf-data-validator --locked --no-dev --format requirements-txt --no-header --no-annotate --no-emit-project
```

Use the focused checks below while editing the component:

```text
uv lock --project plugins/trace/tools/perf-data-validator --check
UV_PROJECT_ENVIRONMENT="${XDG_CACHE_HOME:-$HOME/.cache}/yuansheng-kit/dev/perf-data-validator" uv run --project plugins/trace/tools/perf-data-validator --locked --group dev python -B -m pytest -p no:cacheprovider
mypy --config-file plugins/trace/tools/perf-data-validator/pyproject.toml --cache-dir /tmp/ys-trace-perf-data-validator-mypy plugins/trace/tools/perf-data-validator/src plugins/trace/tools/perf-data-validator/tests
ruff format --check plugins/trace/tools/perf-data-validator
ruff check --no-cache plugins/trace/tools/perf-data-validator
```

The repository root `ruff.toml` owns Python formatting and lint policy. The
component does not require Nix, `uv`, pytest, mypy, or Ruff at product runtime.
