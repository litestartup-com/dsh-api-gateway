# ohdsh-api-facade

DeepSeek Harness 宿主插件：一个**带鉴权、fail-closed 的进程内 HTTP 门面**，把宿主的会话面
（0.1.2 的 typertGateway Remote + follow/control 流 + 问答/审批 waterfall）以**冻结的旧
apiproxy 契约**暴露给另一台机器上的客户端（典型：dsh-agent-manager）。

> 插件只做三件事：**鉴权、白名单、契约翻译**。0.1.1 时代的「回环 HTTP 转发」已随 0.1.2
> 重构删除；对外信封、帧形、回执与 0.1.1 完全一致——版本差异全部由本插件吸收，客户端零改动。

## 为什么需要它

DSH 的 `/api` 面带两层闸（信任栅栏 + 浏览器鉴权），跨机客户端连不上也拿不到进程内缝。
本插件跑在 DSH 进程内直接调用宿主领域服务（typertGateway 分发器、session 流、waterfall），
对外靠 API Key 鉴权 + deny-by-default 白名单保护。

## 支持的 DSH 版本

门面跑在 DSH 宿主**内部**，兼容面 = 宿主版本。声明区间见 `package.json` 的
`peerDependencies`（自门面 0.2.4 起为双区间 `^0.1.2-rc.1 || ^0.2.0-0`：0.2.0
走廊打破了旧上界，且 DSH 宿主在安装期**与启动期**双重强制 peer 校验）；下表是
**端到端实测通过**的配对——wire 契约、问答/授权卡片链、GUI token 捕获——而非仅
semver 声明：

| DSH | 状态 | 依据 |
| --- | --- | --- |
| `0.2.0-rc.2` | ✅ verified | 独立 Docker 栈上全链 smoke + 问答/授权卡片链 + V3→V4 会话卷迁移实测（门面 0.2.4，宿主 192.168.33.11）；npm `latest` 线 |
| `0.1.5-rc.2` | ✅ verified | 门面 0.2.4 上的全链 + 卡片链双兼容回归（0.2.0 走廊改造后复验），以及此前 `#b592b4f` 的全链验证；见下方安装说明 |
| `0.1.2-rc.1` | ✅ verified | 全链 smoke（`dsh-agent-manager/scripts/smoke-proxy-b.ts`，含真实模型回合） |
| `0.1.1-rc.2` | ⚠️ legacy | 契约自该时代冻结；不再是支持基线 |

> **0.1.5 安装说明**：虽然声明区间语义上覆盖 0.1.5，npm 的严格 peer
> 解析仍会拒绝默认安装（ERESOLVE）——组装 0.1.5 profile 时用
> `npm install --legacy-peer-deps`。消费方在自己的版本矩阵里跟踪此项
> （`dsh-agent-manager` `src/dsh-matrix.ts` 的 `needsLegacyPeerDeps`）。
> 0.2.0 线同样适用此姿态。

> **0.2.0 走廊说明**（门面 0.2.4 吸收的差异，客户端零改动）：宿主
> `wireStream.open` 增加了 duplex uplink/peer 参数（按函数元数探测，一份代码
> 双代宿主通吃）；宿主侧 `ctx.settings.register` 已删除，0.2.0 宿主的持久密钥
> 路径改走**组合配置**（Docker 栈 entrypoint 把 `GW_KEY` 注入 profile patch；
> 此时 `POST {prefix}/key` 自助发放的密钥仅存内存）；会话日志升到 V4（V3 卷
> 读取时单向迁移——升级前先备份）；DeepSeek 会话日志上传默认**开启**（Docker
> 栈在 profile patch 里显式钉关）。对外 wire 契约本身不变——钉在旧门面提交上的
> manager 等消费者经本门面访问 0.2.0 宿主零改动。

消费方按**提交**钉版（`github:litestartup-com/dsh-api-gateway#<sha>`），每条 DSH
线在钉版移动前重新实测，验证记录在内部设计库（`dsh-facts`）。`0.1.6-alpha.*` /
`0.1.7-*` 线已被 `0.2.0` 收编，**未单独验证**（0.2.0 走廊经社区跳版卡跨越它们）。

## 安装

```powershell
dsh plugin --profile web add github:litestartup-com/dsh-api-gateway
```

在宿主组合加一行（见 `examples/cordis.yml`），重启 DSH。

> 命名避让：DSH 自带内置包 `@deepseek-ai/dsh-api-gateway`（typert 分发器），与本插件无关。
> 本插件 = **外部 HTTP 门面**；settings 命名空间 / 组合行 / 服务字段均为 `ohdsh-api-facade`。

## Docker 部署（独立 API 栈）

仓库自带一套自包含的 compose 栈，把门面作为**独立对外的 API 服务**跑起来——
不需要 manager，也不需要任何额外接线：

```
客户端 ──HTTP──▶ nginx (:${HTTP_PORT}) ──仅 /api-gw/──▶ gateway 容器
                                                        = DSH 宿主 + 本门面插件
```

gateway 端口不对外发布；nginx 是唯一入口且**失败即关闭**（fail-closed）：只反代
`/api-gw/`，其余路径（DSH 网页 GUI、`/api`、静态资源）一律 404。门后还有门面自身
的 API-Key 鉴权与默认拒绝白名单——两层独立防线。

### 快速开始

```bash
bash docker/gen-env.sh          # 生成 .env（HOST_UID/GID、随机 GW_KEY），幂等
# 编辑 .env：填入 DEEPSEEK_API_KEY（真实会话回合必需）
docker compose up -d --build    # 构建节点镜像（DSH 钉版 + 提交的依赖锁）并启动
node docker/smoke.mjs           # 接线验收；加 --model 跑一发真实模型回合
node docker/probe-cards.mjs     # 问答/审批卡片链（respond 往返；需模型密钥）
```

API 基址为 `http://<host>:${HTTP_PORT}/api-gw/v1`，用 `.env` 里的 `GW_KEY`
作 `X-API-Key` 鉴权：

```bash
curl -s http://127.0.0.1/api-gw/v1/health
curl -s -X POST http://127.0.0.1/api-gw/v1/proxy/session.list \
  -H "X-API-Key: $GW_KEY" -H 'content-type: application/json' \
  -d '{"type":"client-request","rpcId":"1","method":"session.list","payload":{}}'
```

### 文件清单

| 路径 | 作用 |
| --- | --- |
| `docker-compose.yml` | nginx + gateway 两服务，健康门控启动 |
| `docker/Dockerfile` | 一容器 = 一 DSH API 节点（DSH 钉版 + 本 checkout 的门面） |
| `docker/gen-profile.mjs` | 构建期 profile 生成器（锁驱动 `npm ci`；`--lock-only` 刷新锁） |
| `docker/profile-lock/` | 提交的依赖锁（可复现依赖树，每个 DSH 版本一份） |
| `docker/entrypoint.sh` | 幂等 seed：profile → 卷、`GW_KEY` → settings.yaml |
| `docker/nginx/gateway.conf` | 失败即关闭的入口（仅 API 前缀；带 WebSocket 升级） |
| `docker/gen-env.sh` | `.env` 生成器（HOST_UID/GID 红线、随机 `GW_KEY`） |
| `docker/probe-lib.mjs` | 探针共享底座（配置、信封、裸 WS 客户端） |
| `docker/smoke.mjs` | 零依赖栈级验收（含裸 WS 的 mux 检查） |
| `docker/probe-cards.mjs` | 问答/审批卡片链探针（respond 往返 + 沙箱升档 + 文件落盘实证） |

### .env 参考

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HTTP_PORT` | `80` | nginx 对外端口（v1 为纯 HTTP，TLS 未接线） |
| `GW_KEY` | 生成 | 门面静态 API 密钥（`X-API-Key`）。留空则一次性 `POST /key` 自助发放通道保持开放——公网不建议 |
| `DEEPSEEK_API_KEY` | — | 模型凭据；真实会话回合必需 |
| `DSH_VERSION` | `0.2.0-rc.2` | 烘进镜像的 DSH 钉版线（需有对应的 `docker/profile-lock/` 锁文件；`0.1.5-rc.2` 仍在支持范围） |
| `NGINX_IMAGE` | `nginx:alpine` | alpine 拉不动时覆盖（如 `docker.m.daocloud.io/library/nginx:alpine`） |
| `NODE_IMAGE` / `NPM_REGISTRY` | docker.io / npmjs | 构建期镜像源（国内构建） |
| `HOST_UID` / `HOST_GID` | `1000` | 容器运行 uid = 宿主文件属主 uid（`gen-env.sh` 自动写入） |
| `GW_ADMIN_KEY` | — | 可选：启用 `{prefix}/admin/*` 端点 |
| `GW_ALLOW_FULL_ACCESS` | — | 可选 `true`：允许沙箱路由授予 `danger-full-access`（风险告知见「配置」） |
| `GW_EXPOSE_ERRORS` | — | 可选 `false`：错误响应不带内部细节（公网部署建议） |
| `GW_CORS_ORIGIN` | — | 可选：公网部署收紧 CORS 来源 |

### 会话与工作区

宿主 `./workspaces` 挂载为容器内 `/workspace`。通过 API 建会话时 `cwd` 传该挂载点
下的路径（如 `/workspace/my-project`）——同一棵树在宿主上就是
`./workspaces/my-project`。DSH 状态（settings、凭据、会话日志）存于命名卷
`gateway-data`，`docker compose down` 不丢；`down -v` 才会清空。

### 升级与锁刷新

`docker compose up -d --build` 用当前 checkout 重建镜像。entrypoint 在镜像的
seed 版本变化时（DSH 钉版、门面版本或插件内容）自动重新 seed 卷内 profile——
无需手工步骤，`.env` 的 `GW_KEY` 始终是密钥真相源。

`DSH_VERSION` 或门面依赖区间变更时，先刷新提交的锁：

```bash
node docker/gen-profile.mjs --lock-only 0.2.0-rc.2
# → 生成 docker/profile-lock/0.2.0-rc.2.package-lock.json —— 提交它
```

> 调试提示：DSH 网页 GUI 默认不暴露。需要时取消 `docker-compose.yml` 里的回环
> 映射注释（`127.0.0.1:3081:3080`），经 SSH 隧道访问——绝不放到公网面。

### 网页 demo

`examples/demos/` 提供两个跑在本栈之上的网页 demo（compose overlay 把它们挂在同一个
nginx 前门后）：**KB Studio**（`/kb/`——知识库管理，AI 管理员会话钉
`workspace-write` 档）与**智能客服**（`/cs/`——基于同一知识库的 `read-only` 只读
客服；知识库即本项目文档）。两者都是零依赖 BFF + 原生 JS 页面，同时是线协议的
参考客户端——详见 [`examples/demos/README.md`](examples/demos/README.md)。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `prefix` | `/api-gw/v1` | 路由前缀 |
| `enabled` | `true` | 主开关（可 admin 运行时切换） |
| `apiKeys` | `[]` | 静态 API 密钥 |
| `provisionedKey` | — | `POST {prefix}/key` 一次性自助发放的密钥（存 settings） |
| `allowKeyProvision` | `true` | 允许首次无钥自助发放 |
| `adminKey` | — | 设置后启用 admin 端点 |
| `corsOrigin` | `*` | CORS 来源（`'*'` 或具体域/数组） |
| `exposeErrors` | `true` | 错误响应是否带内部细节 |
| `allowFullAccess` | `false` | 允许沙箱路由授予 `danger-full-access`（**风险告知**：开启即授予远端全量沙箱能力，启动与每次命中写告警日志；不做环境限制） |
| `proxyWhitelist` | 默认白名单 | 可选：覆盖默认白名单 |

`proxyTarget` 字段保留仅为兼容 0.1.1 时代配置（已废弃，值不再参与任何请求路径）。

## 端点

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| GET | `{prefix}/health` | 无 |
| POST | `{prefix}/key` | 首次无钥（一次性自助发放） |
| POST | `{prefix}/admin/enable` | X-Admin-Key |
| POST | `{prefix}/admin/rotate-key` | X-Admin-Key |
| POST | `{prefix}/proxy/<method>` | X-API-Key / Bearer |
| POST | `{prefix}/respond` 与 `{prefix}/proxy/respond` | X-API-Key / Bearer |
| POST | `{prefix}/sessions/{id}/sandbox-mode` | X-API-Key / Bearer |
| GET | `{prefix}/events.mux`（WebSocket 升级） | X-API-Key |

`POST {prefix}/proxy/<method>`：client-request 信封进、server-response 信封出（HTTP 恒 200，
业务成败看 `result.ok`）。当前进程内直调方法：`session.list` / `session.create` /
`session.prompt` / `session.cancel` / `session.history`（follow 流首帧快照翻译）/
`host.describe`（合成协议常量 `0.0.1`，DSH-FACTS §6）；白名单其余方法暂 501
`method_not_migrated`（诚实报未迁移，绝不静默走已失效的回环转发）。

`sessions/{id}/sandbox-mode`：请求体 `{ "mode": "read-only" | "workspace-write" }`
（`danger-full-access` 需 `allowFullAccess: true`），给**活会话**写一个 `sandbox/mode`
覆盖事件（持久、冷醒 replay 恢复）。冷/失联会话 → 409 `session_not_live`。这是 wire 上
唯一能按会话设置沙箱模式的通道，供 manager 在创建会话后、首次 prompt 前调用一次。

`respond`：回执 = 老 apiproxy `{ accepted, reason? }`；问题认领 / 拒绝（ASK_CANCELLED 语义）/
审批 outcome 直通，与 0.1.1 行为一致。

同一 mux 升级路径也注册在 `{prefix}/proxy/events.mux`，使客户端「base + method」的统一约定
（manager 的 rpc base 即 `/api-gw/v1/proxy`）无需为 mux 特判。

mux 管道**下行只读**：客户端发任何帧都被 1008 关闭（与宿主 mux 行为一致）。直播 =
每会话 follow 流（会话事件）+ 宿主级 control 流（live projections，逐 key
`session/projection` 帧）。断线重连是客户端的事。

## 白名单（默认）

```
session.list, session.create, session.history,
session.prompt, session.cancel, session.rename,
session.fork, session.updateQueue, session.attachment,
session.models, session.selectModel,
respond,  host.describe
```

白名单外 → `403 { error: 'method_not_allowed' }`，**不触达宿主服务**。特权面
（`credentials.*`、`settings.*`、`host.openPath`、`host.pickDirectory`、`llm.discoverModels` 等）
在门面上不可达。注意：真实方法名是 `host.describe`（`host.version` 不存在）。

## 安全模型

- 鉴权不可退化：constant-time 比较、CSPRNG 密钥、一次性自助发放（已有任何密钥即永久关闭）。
- 白名单 fail-closed；未迁移方法诚实 501，不存在「静默转发到已失效通道」的路径。
- respond 只回填**本插件自己转发出去**的 pending（rpcId 匹配），不认识的一律 not-pending。
- 密钥绝不写日志；`apiKeys`/`adminKey` 在 settings 线上 surface 脱敏。

## 部署步骤

1. 构建并提交：`pnpm build && pnpm test`（全绿；`lib/` 必须同步提交）。
2. 更新宿主安装：`dsh plugin update`（或 `profiles/web` 下 `pnpm install`）。
3. 重启 DSH。
4. 跑验收（见下）。

## 验收步骤

1. `GET {prefix}/health` → 200，`upstream: ok`。
2. `POST {prefix}/proxy/credentials.set`（带正确 key）→ 403 `method_not_allowed`。
3. `POST {prefix}/proxy/session.list` 用错 key → 401。
4. 带正确 key：`POST {prefix}/proxy/host.describe` 返回 `{ version: '0.0.1' }`；
   `session.list` 返回会话列表。
5. WebSocket 连 `ws://host{prefix}/proxy/events.mux`（握手带 `X-API-Key`），
   `session.prompt` 后应实时收到 `session/event` 帧直到 `turn/end`，且投影更新以
   `session/projection` 帧直播。

自动化验收：`dsh-agent-manager/scripts/smoke-proxy-b.ts`（manager 走 proxy 路径的端到端冒烟，
含真模型回合）。

## 卸载

删除组合里的插件行（可选 `dsh plugin remove ohdsh-api-facade`），重启。

## 文档范围

本仓库只保留使用者需要的内容：本 README、`README.zh.md`、`openapi.yaml`、示例与测试。
**内部设计与重构计划不在本仓库**（集中在不公开发布的内部设计库）——代码、接口契约与
示例即完整的可运行、可自托管交付物。

## License

MIT
