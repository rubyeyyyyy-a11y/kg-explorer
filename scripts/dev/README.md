# `scripts/dev`

本目录只承载本地开发入口，不作为部署命令。

- `bootstrap_env.sh`：补齐 `backend/.venv` 与 `/home/ray/workspace/onex-frontend` workspace 依赖
- `start_stack.sh`：启动本地 `backend-api` + `backend-worker` + `kg-platform`
- `stop_stack.sh`：停止本地开发栈
- `common.sh`：开发/验证脚本共享的运行目录、health 解析与进程检查函数

开发态约束：

- 前端入口是 `/home/ray/workspace/onex-frontend/apps/kg-platform` 的 `umi dev`
- 不要去 `/home/ray/workspace/onex-frontend` 根目录执行默认 `pnpm dev`
- Nebula / Elasticsearch 是外部前置依赖，只检查不托管
- `runtime/.run` 与 `runtime/logs` 只服务于本地开发和验证过程
