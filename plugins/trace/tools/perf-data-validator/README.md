# perf-data-validator

`perf-data-validator` 是 `trace` 插件独立维护和交付的 Python 组件。它的 `pyproject.toml`、唯一依赖锁
`uv.lock` 和 `tests/` 都位于本目录。仓库根不包含该组件的 Python 项目元数据或依赖锁。后续实现任务将在这里创建
`src/perf_data_validator/`。

开发与测试环境使用 CPython `3.14.x`：

```text
uv lock --check
uv run --locked pytest
mypy --strict
```

全仓 Python 格式化与 lint 规则由根目录 `ruff.toml` 提供：

```text
ruff format --check .
ruff check .
```

正式实现由后续迁移任务完成，唯一产品入口冻结为：

```text
python -m perf_data_validator
```

该组件以源码目录直接进入插件产物，不构建 wheel、sdist、zipapp、console script 或冻结二进制。`uv` 只服务开发和
CI，不是安装后运行时前提。
