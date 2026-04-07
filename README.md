# KG System

KG System 是一个知识图谱检索、统一关系发现与导入治理仓库。当前仓库的目标不是“只在开发机可跑”，而是让团队成员在没有口头补充的情况下也能理解：

- 开发怎么启动
- 内网验证环境怎么部署
- 测试与 smoke 从哪里进入
- 前后端分层边界在哪里
- 历史兼容代码保留在哪里、何时可以删除

核心文档：

- 架构边界：[docs/ARCHITECTURE.md](/home/ray/kg-system/docs/ARCHITECTURE.md)
- 兼容层清单：[docs/COMPATIBILITY_LAYER.md](/home/ray/kg-system/docs/COMPATIBILITY_LAYER.md)
- 内网部署标准：[docs/INTRANET_SINGLE_HOST_DEPLOY_RUNBOOK.md](/home/ray/kg-system/docs/INTRANET_SINGLE_HOST_DEPLOY_RUNBOOK.md)
- Vercel 前端部署：[docs/deploy/VERCEL_FRONTEND_DEPLOY.md](/home/ray/kg-system/docs/deploy/VERCEL_FRONTEND_DEPLOY.md)
- `kg-platform` 前端说明：[/home/ray/workspace/onex-frontend/apps/kg-platform/README.md](/home/ray/workspace/onex-frontend/apps/kg-platform/README.md)

## 仓库约定

- 全栈联调统一入口固定在 `kg-system/scripts/dev` 与 `kg-system/scripts/verify`。
- 当前目标前端是 `/home/ray/workspace/onex-frontend/apps/kg-platform`，不要去 `onex-frontend` 根目录执行默认 `pnpm dev`，因为根入口仍指向 `deeprare-hospital`。
- 前端开发入口是 `kg-platform` 的 `umi dev`。
- 前端部署产物固定为 `/home/ray/workspace/onex-frontend/apps/kg-platform/dist/`。
- 后端开发拆分为 `backend-api` + `backend-worker` 两个启动单元。
- 后端部署必须拆分为单实例 `backend-api` 与单实例 `backend-worker`；`backend-api` 使用单进程 `uvicorn app.main:app`，`backend-worker` 使用 `python -m app.worker_main`。
- 部署态禁止 `--reload`，禁止 `uvicorn --workers`，禁止 API/Worker 多实例并行。
- 部署契约固定为同域 `/api` 反代到 `127.0.0.1:8000`。
- Nebula / Elasticsearch 在本轮是外部前置依赖，只纳入检查与文档，不由本仓脚本托管启动。
- 运行态统一放在 `runtime/`：
  - `runtime/.run/`：pid、registry、导入状态等运行态状态
  - `runtime/logs/`：运行日志
  - `runtime/artifacts/`：衍生制品保留位

## Config

当前仓库已经把“可部署但不直接绑死云环境”的配置模型收敛到 `backend/app/config.py`。

- 推荐优先使用新字段：
  - 应用公共：`APP_ENV`、`LOG_LEVEL`、`API_HOST`、`API_PORT`
  - Nebula：`NEBULA_HOSTS`、`NEBULA_USER`、`NEBULA_PASSWORD`、`NEBULA_TIMEOUT_MS`
  - Elasticsearch：`ES_URLS`、`ES_USERNAME`、`ES_PASSWORD`、`ES_TIMEOUT_MS`、`ES_INDEX_PREFIX`
  - KG 业务：`KG_DEFAULT_SPACE`、`KG_ALLOWED_SPACES`、`KG_IMPORT_ENABLED`、`KG_DISCOVERY_ENABLED`
  - 运行态：`KG_RUNTIME_DIR`、`KG_AUDIT_LOG_DIR`
- 旧字段仍兼容：
  - Nebula：`NEBULA_HOST`、`NEBULA_PORT`、`NEBULA_SPACE`
  - Elasticsearch：`ES_URL`
  - 运行态：`RUN_ROOT`、`AUDIT_LOG_PATH`
- 当前最小兼容策略：
  - `NEBULA_HOSTS` 未设置时，回退到 `NEBULA_HOST` + `NEBULA_PORT`
  - `ES_URLS` 未设置时，回退到 `ES_URL`
  - `KG_DEFAULT_SPACE` 未设置时，回退到 `NEBULA_SPACE`
  - `KG_RUNTIME_DIR` / `KG_AUDIT_LOG_DIR` 未设置时，回退到历史 runtime 路径字段
- 推荐示例见根目录 [`.env.example`](/home/ray/workspace/kg-system/.env.example)。
- `kg-platform` 前端的环境变量示例位于 [`.env.example`](/home/ray/workspace/onex-frontend/apps/kg-platform/.env.example)，前端只配置业务 API 与 UI 开关，不暴露 Nebula / ES 地址。

## Dev

只放本地开发入口，不与部署/测试混写。

1. 环境补齐

```bash
bash scripts/dev/bootstrap_env.sh
```

2. 本地开发栈启停

```bash
bash scripts/dev/start_stack.sh
bash scripts/verify/check_stack.sh
bash scripts/verify/smoke_stack.sh
bash scripts/dev/stop_stack.sh
```

说明：

- `start_stack.sh` 只负责拉起 `backend-api`、`backend-worker`、`kg-platform`。
- Nebula / Elasticsearch 必须作为宿主外部前置依赖先准备好。
- `check_stack.sh` 会分层打印 `/api/health/live`、`/api/health/ready`、`/api/health/dependencies`。
- `smoke_stack.sh` 是统一栈最小验收入口；如需串后端深度 smoke，可执行 `SMOKE_FULL_API=1 bash scripts/verify/smoke_stack.sh`。

3. 单独启动前端开发服务器

```bash
cd /home/ray/workspace/onex-frontend/apps/kg-platform
HOST=127.0.0.1 PORT=5173 DEV_API_PROXY_TARGET=http://127.0.0.1:8000 pnpm dev
```

说明：

- 这只用于开发。
- `kg-platform` 会通过 `.umirc.ts` 中的 `DEV_API_PROXY_TARGET` 代理 `/api/*` 到本地 backend。
- 不要在 `/home/ray/workspace/onex-frontend` 根目录执行 `pnpm dev`，那会启动 `deeprare-hospital`。
- 部署态绝不使用 `umi dev`。

4. 单独启动 `backend-api` 开发服务器

```bash
cd backend
source .venv/bin/activate
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

说明：

- `--reload` 仅限开发态。
- 根目录 `dev.sh` 仍保留为兼容辅助脚本，但不是主推荐入口。

5. 单独启动 `backend-worker`

```bash
cd backend
source .venv/bin/activate
python -m app.worker_main
```

说明：

- `backend-worker` 只负责 import / cleanup / postprocess 后台任务。
- `backend-api` 启动后不会再默认拉起后台 worker。

## Staging

这里只描述内网验证环境，不混入开发与测试命令。

### Docker images

当前仓库已经补齐三类最小镜像交付形态：

- `kg-platform` 前端镜像：在 `/home/ray/workspace/onex-frontend` 构建，使用 Node build + Nginx serve 双阶段镜像
- `kg-system-api` 镜像：在 `/home/ray/workspace/kg-system` 构建，target 为 `api`
- `kg-system-worker` 镜像：在 `/home/ray/workspace/kg-system` 构建，target 为 `worker`

前端构建：

```bash
cd /home/ray/workspace/onex-frontend
docker build \
  -f apps/kg-platform/Dockerfile \
  -t kg-platform:local \
  --build-arg APP_ENV=prod \
  --build-arg API_BASE_PATH=/api \
  --build-arg API_TIMEOUT_MS=15000 \
  --build-arg UI_EXPOSE_SOURCE_SWITCH=0 \
  --build-arg UI_ENABLE_MOCK_FALLBACK=0 \
  .
```

前端运行：

```bash
docker run --rm -p 8080:80 kg-platform:local
```

后端 API 构建：

```bash
cd /home/ray/workspace/kg-system
docker build --target api -t kg-system-api:local .
```

后端 API 运行：

```bash
docker run --rm -p 8000:8000 \
  --add-host=host.docker.internal:host-gateway \
  -e APP_ENV=staging \
  -e API_HOST=0.0.0.0 \
  -e API_PORT=8000 \
  -e NEBULA_HOSTS=host.docker.internal:9669 \
  -e NEBULA_USER=root \
  -e NEBULA_PASSWORD=CHANGE_ME \
  -e ES_URLS=http://host.docker.internal:9200 \
  -e KG_DEFAULT_SPACE=demo_kg \
  -e KG_ALLOWED_SPACES=demo_kg \
  -e KG_RUNTIME_DIR=./runtime \
  kg-system-api:local
```

后端 Worker 构建：

```bash
cd /home/ray/workspace/kg-system
docker build --target worker -t kg-system-worker:local .
```

后端 Worker 运行：

```bash
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e APP_ENV=staging \
  -e NEBULA_HOSTS=host.docker.internal:9669 \
  -e NEBULA_USER=root \
  -e NEBULA_PASSWORD=CHANGE_ME \
  -e ES_URLS=http://host.docker.internal:9200 \
  -e KG_DEFAULT_SPACE=demo_kg \
  -e KG_ALLOWED_SPACES=demo_kg \
  -e KG_RUNTIME_DIR=./runtime \
  kg-system-worker:local
```

镜像约束：

- 前端 `APP_ENV`、`API_BASE_PATH`、`API_TIMEOUT_MS`、`UI_*` 都是 build-time config，不承诺容器启动时切换。
- 后端 `api` / `worker` 镜像只区分启动命令，均保留 `/app/backend/...` 与 `/app/runtime/...` 路径语义。
- 根 `.env` 不会被 COPY 进镜像；部署契约是显式环境变量注入，而不是把本地 `.env` bake 进镜像。
- 当 Nebula / Elasticsearch 跑在宿主机上时，容器内不能使用 `127.0.0.1` 回连宿主机；上面的示例通过 `host.docker.internal` 显式走宿主映射。如果依赖跑在同一 Docker network，请改成对应 service name。

1. 前端构建

```bash
cd /home/ray/workspace/onex-frontend
pnpm install
cd apps/kg-platform
pnpm build
```

部署产物固定为：

```text
/home/ray/workspace/onex-frontend/apps/kg-platform/dist/
```

2. 后端启动

官方部署需要同时启动两个后端单元，使用两个终端或两个进程管理单元分别拉起：

终端 A:

```bash
cd backend
./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --log-level info
```

终端 B:

```bash
cd backend
./.venv/bin/python -m app.worker_main
```

部署约束：

- 禁止 `--reload`
- 禁止 `--workers`
- 禁止 gunicorn 多 worker
- 禁止同机多 `backend-api` 实例并行
- 禁止同机多 `backend-worker` 实例并行

3. 反向代理契约

- Nginx 托管 `/home/ray/workspace/onex-frontend/apps/kg-platform/dist/`
- 浏览器请求同域页面
- 所有 API 请求走同域 `/api`
- `/api` 反代到 `127.0.0.1:8000`

详细步骤见：[docs/INTRANET_SINGLE_HOST_DEPLOY_RUNBOOK.md](/home/ray/kg-system/docs/INTRANET_SINGLE_HOST_DEPLOY_RUNBOOK.md)

## Health

后端健康检查已经拆分为三层：

- `/api/health/live`
  - 只表示 API 进程和基础本地运行态可用
  - 不探测 Nebula / Elasticsearch
- `/api/health/ready`
  - 表示当前 API 实例是否适合接收业务流量
  - 依赖 live 通过、runtime 初始化完成、space registry 可读、默认/当前 space 可解析
  - 不做 Nebula / ES 重探测
- `/api/health/dependencies`
  - 显式返回 Nebula、Elasticsearch、current/default space、index snapshot 的结构化状态
  - 用于排查依赖异常，不作为 liveness 口径

兼容接口：

- `/api/health`
  - 保留为兼容聚合视图
  - 会汇总 live / ready / dependencies 的状态，便于旧调用方过渡
  - 新接入方应优先使用分层接口

## Test

这里只放测试与验证入口。

1. 后端测试

```bash
cd backend && .venv/bin/python -c "import app.main"
```

用于启动前最小导入检查（可提前发现顶层导入期崩溃）。

```bash
cd backend && .venv/bin/python -c "import app.worker_main"
```

用于检查独立 Worker 入口可导入。

```bash
bash scripts/test/backend_pytest.sh -q
```

等价官方入口：

```bash
backend/.venv/bin/python -m pytest -q
```

2. 部署验证 / smoke

```bash
bash scripts/verify/check_stack.sh
bash scripts/verify/smoke_stack.sh
SMOKE_FULL_API=1 bash scripts/verify/smoke_stack.sh
bash scripts/verify/smoke_api.sh
curl -fsS http://127.0.0.1:8000/api/health/live
curl -fsS http://127.0.0.1:8000/api/health/ready
curl -fsS http://127.0.0.1:8000/api/health/dependencies
```

3. 前端 E2E

```bash
cd /home/ray/workspace/onex-frontend/apps/kg-platform
pnpm build
```

## 脚本目录

主入口已经按用途拆分：

- `scripts/dev/`：仅本地开发
- `scripts/verify/`：部署验证与 smoke
- `scripts/test/`：测试入口
- `scripts/deploy/`：部署相关说明

顶级 `scripts/*.sh` 与 `scripts/smoke_import_cleanup.py` 目前只是兼容桥，保留给历史调用路径，不再作为主推荐入口。

## 新人验证流程

```bash
git clone <repo>
cd kg-system
bash scripts/dev/bootstrap_env.sh
bash scripts/dev/start_stack.sh
bash scripts/verify/check_stack.sh
bash scripts/verify/smoke_stack.sh
bash scripts/test/backend_pytest.sh -q
cd /home/ray/workspace/onex-frontend/apps/kg-platform && pnpm build
```

如果以上流程全部通过，说明本地开发入口、验证入口和测试入口都已经打通。
