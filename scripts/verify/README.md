# `scripts/verify`

本目录用于部署验证与 smoke，不负责开发环境安装。

- `check_stack.sh`：检查 `backend-api` / `backend-worker` / `kg-platform` 的 pid / 端口 / HTTP / health 状态
- `verify_stack.sh`：验证前后端入口是否都可达
- `smoke_stack.sh`：统一栈最小 smoke，覆盖 API live/ready/dependencies、worker 存活、kg-platform 首页
- `smoke_api.sh`：后端官方 smoke 入口
- `smoke_import_cleanup.py`：import cleanup 的专项 smoke/验证脚本

验证态约束：

- `verify` 面向“服务已经启动”的场景
- Nebula / Elasticsearch 是外部前置依赖，优先通过 `/api/health/dependencies` 纳入检查
- smoke 只验证可用性与契约，不承担完整测试职责
