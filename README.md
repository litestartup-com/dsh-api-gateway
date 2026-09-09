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

## 安装

```powershell
dsh plugin --profile web add github:litestartup-com/dsh-api-gateway
```

在宿主组合加一行（见 `examples/cordis.yml`），重启 DSH。

> 命名避让：DSH 自带内置包 `@deepseek-ai/dsh-api-gateway`（typert 分发器），与本插件无关。
> 本插件 = **外部 HTTP 门面**；settings 命名空间 / 组合行 / 服务字段均为 `ohdsh-api-facade`。

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
