# KG System 内网单机验证环境部署 Runbook

本文档是当前仓库唯一的内网验证环境部署标准。目标是让仓库在 Ubuntu 24.04 单机环境达到“可构建、可启动、可 smoke、可交接”的状态。

这不是生产部署文档，不覆盖高可用、弹性扩缩、零停机发布、外网暴露、TLS、容灾或多实例编排。

## 1. 部署范围与约束

- 操作系统：Ubuntu 24.04
- 前端：静态构建产物
- 后端：FastAPI + uvicorn
- 反向代理：Nginx
- 运行模式：单机、单实例 API + 单实例 Worker

严格禁止：

- `uvicorn --reload`
- `uvicorn --workers N`
- gunicorn 多 worker
- 同机多 `backend-api` 实例并行
- 同机多 `backend-worker` 实例并行

官方后端启动命令需要分两个终端，或交给两个独立 systemd unit：

终端 A:

```bash
cd /path/to/kg-system/backend
./.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --log-level info
```

终端 B:

```bash
cd /path/to/kg-system/backend
./.venv/bin/python -m app.worker_main
```

## 2. 部署契约

- 前端部署产物固定为 `/home/ray/workspace/onex-frontend/apps/kg-platform/dist/`
- 浏览器访问同域页面
- 前端请求固定走同域 `/api`
- Nginx 将 `/api` 反代到 `127.0.0.1:8000`
- 部署入口绝不使用 Vite dev server
- `onex-frontend` 根目录默认 `pnpm dev` 仍指向 `deeprare-hospital`，不能把它当成 `kg-platform` 的标准入口
- Nebula / Elasticsearch 在本轮是外部前置依赖，不由 `kg-system/scripts` 托管启动

## 3. 运行目录治理

仓库运行态统一位于根目录 `runtime/`：

- `runtime/.run/`
  - pid、space registry、import drafts、import jobs、cleanup jobs 等运行态状态
- `runtime/logs/`
  - backend-api / backend-worker / kg-platform / 批处理日志
- `runtime/artifacts/`
  - 衍生制品保留位

仍需长期持久化的目录：

- `runtime/.run/`
- `runtime/logs/`
- `backend/state/`

说明：

- `runtime/` 可以整体清理，但会丢失 pid、registry、导入状态、cleanup 状态与运行日志。
- `/home/ray/workspace/onex-frontend/apps/kg-platform/dist/` 不是持久化目录，每次发布都可重新构建。

## 4. 依赖准备

在仓库根目录执行：

```bash
bash scripts/dev/bootstrap_env.sh
```

这会补齐：

- `backend/.venv`
- `backend/requirements.txt`
- `/home/ray/workspace/onex-frontend` workspace 依赖

## 5. 前端构建

```bash
cd /path/to/onex-frontend
pnpm install
cd apps/kg-platform
pnpm build
```

构建完成后，由 Nginx 直接托管：

```text
/path/to/onex-frontend/apps/kg-platform/dist/
```

## 6. Nginx 同域反向代理

示例配置：

```nginx
server {
    listen 80;
    server_name _;

    root /path/to/onex-frontend/apps/kg-platform/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

## 7. systemd 建议

`backend-api.service`

```ini
[Unit]
Description=KG System Backend API
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/kg-system/backend
EnvironmentFile=/path/to/kg-system/.env
ExecStart=/path/to/kg-system/backend/.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --log-level info
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`backend-worker.service`

```ini
[Unit]
Description=KG System Backend Worker
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/kg-system/backend
EnvironmentFile=/path/to/kg-system/.env
ExecStart=/path/to/kg-system/backend/.venv/bin/python -m app.worker_main
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## 8. 官方测试与部署前检查

从仓库根目录执行：

```bash
bash scripts/test/backend_pytest.sh -q
```

这是一条官方测试入口，不隐式启动开发栈。

## 9. 部署 smoke 与放行门槛

部署完成后必须执行：

```bash
bash scripts/verify/check_stack.sh
bash scripts/verify/smoke_stack.sh
curl -fsS http://127.0.0.1:8000/api/health/live
curl -fsS http://127.0.0.1:8000/api/health/ready
curl -fsS http://127.0.0.1:8000/api/health/dependencies
curl -fsS http://127.0.0.1:8000/api/spaces/current
bash scripts/verify/smoke_api.sh
curl -fsS http://127.0.0.1/api/health/live
curl -fsS http://127.0.0.1/api/health/ready
curl -fsS http://127.0.0.1/api/health/dependencies
curl -fsS http://127.0.0.1/ >/dev/null
```

放行标准：

- `bash scripts/verify/check_stack.sh` 能分别报告 `backend-api`、`backend-worker`、`kg-platform`
- `bash scripts/verify/smoke_stack.sh` 能给出最小统一栈结论
- `/api/health/live` 可达，且不依赖 Nebula / ES 探测成功
- `/api/health/ready` 可达，表示 API 实例可接业务流量
- `/api/health/dependencies` 可达，且能返回结构化依赖状态
- `/api/spaces/current` 可达
- `bash scripts/verify/smoke_api.sh` 输出 `[smoke] completed`
- Nginx 同域 `/api/health/live`、`/api/health/ready`、`/api/health/dependencies` 可达
- Nginx 首页可达
- `backend-worker` 进程保持运行且无启动异常日志
- 当 `dependencies=degraded` 时，输出必须能区分“依赖连接失败”和“space/index readiness 未全绿”

兼容说明：

- `/api/health` 仍保留，但现在是兼容聚合视图，不再等价于单一 Nebula 探测。
- 接入层活性探测应使用 `/api/health/live`。
- 接入层就绪探测应使用 `/api/health/ready`。
- 依赖排障与监控明细应查看 `/api/health/dependencies`。

## 10. 推荐发布顺序

```bash
cd /path/to/kg-system
bash scripts/dev/bootstrap_env.sh
bash scripts/test/backend_pytest.sh -q
cd /path/to/onex-frontend && pnpm install && cd apps/kg-platform && pnpm build
sudo systemctl restart backend-api
sudo systemctl restart backend-worker
sudo nginx -t
sudo systemctl reload nginx
cd /path/to/kg-system && bash scripts/verify/check_stack.sh && bash scripts/verify/smoke_stack.sh && bash scripts/verify/smoke_api.sh
```

若 smoke 未通过：

- 不视为部署完成
- 优先检查 `.env`、Nebula、ES、`runtime/` 持久化、Nginx `/api` 反代
