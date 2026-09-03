# dsh-api-gateway

DeepSeek Harness 宿主插件：一个**带鉴权、fail-closed 的 loopback 反向代理**，把宿主机自身的
`/api` 面（apiproxy = `dsh-client-connection` + `dsh-host-apiproxy`）暴露给另一台机器上的客户端
（典型：dsh-agent-manager）。

> v0.2.0 起（S3）：插件不再自己驱动 agent。会话、消息、问答、授权全部由宿主的 apiproxy 处理，
> 插件只做三件事：**鉴权、白名单、透传**。

## 为什么需要它

DSH 的 `/api` 只认 loopback（Host 头栅栏不是鉴权，跨机直连 `:3080` 不可行也不安全）。
本插件跑在 DSH 进程内，内部 fetch 天然走 loopback，对外靠 API Key 鉴权 + 白名单保护。

## 安装

```powershell
dsh plugin --profile web add github:litestartup-com/dsh-api-gateway
```

在宿主组合加一行（见 `examples/cordis.yml`），重启 DSH。

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
| `proxyTarget` | `http://127.0.0.1:3080/api` | 上游 `/api` 基础地址 |
| `proxyWhitelist` | 默认白名单 | 可选：覆盖默认白名单 |

## 端点

| 方法 | 路径 | 鉴权 |
| --- | --- | --- |
| GET | `{prefix}/health` | 无 |
| POST | `{prefix}/key` | 首次无钥（一次性自助发放） |
| POST | `{prefix}/admin/enable` | X-Admin-Key |
| POST | `{prefix}/admin/rotate-key` | X-Admin-Key |
| POST | `{prefix}/proxy/<method>` | X-API-Key / Bearer |
| POST | `{prefix}/proxy/respond` | X-API-Key / Bearer |
| POST | `{prefix}/sessions/{id}/sandbox-mode` | X-API-Key / Bearer |
| GET | `{prefix}/events.mux`（WebSocket 升级） | X-API-Key |

`sessions/{id}/sandbox-mode`：请求体 `{ "mode": "read-only" | "workspace-write" }`，给**活会话**写一个
`sandbox/mode` 覆盖事件（`dsh-sandbox-policy/session-mode`，持久、冷醒 replay 恢复）。冷/失联会话 → 409
`session_not_live`；`danger-full-access` 不可经 wire 授予（宿主 UI 专属）。这是 wire 上唯一能按会话设置
沙箱模式的通道（`session.create` 无沙箱字段），供 manager 在创建会话后、首次 prompt 前调用一次。

同一 mux 升级路径也注册在 `{prefix}/proxy/events.mux`，使客户端「base + method」的统一约定
（manager 的 rpc base 即 `/api-gw/v1/proxy`）无需为 mux 特判。

mux 管道**下行只读**：客户端发任何帧都被 1008 关闭（与宿主 mux 行为一致）。断线重连是客户端的事。

## 白名单（默认）

```
session.list, session.create, session.history,
session.prompt, session.cancel, session.rename,
session.fork, session.updateQueue, session.attachment,
session.models, session.selectModel,
respond,  host.describe
```

白名单外 → `403 { error: 'method_not_allowed' }`，**不发往上游**。特权面
（`credentials.*`、`settings.*`、`host.openPath`、`host.pickDirectory`、`llm.discoverModels` 等）
在代理上不可达。注意：真实方法名是 `host.describe`（`host.version` 不存在）。

## 安全模型

- 鉴权不可退化：constant-time 比较、CSPRNG 密钥、一次性自助发放（已有任何密钥即永久关闭）。
- 白名单 fail-closed；代理**不解析 RPC 包络**，只按路径段校验方法名，字节透传。
- 密钥绝不写日志；`apiKeys`/`adminKey` 在 settings 线上 surface 脱敏。

## 部署步骤

1. 构建并提交：`pnpm build && pnpm test`（42 测试全绿；`lib/` 必须同步提交）。
2. 更新宿主安装：`dsh plugin update`（或 `profiles/web` 下 `pnpm install`）。
3. 重启 DSH。
4. 跑验收（见下）。

## 验收步骤

1. `GET {prefix}/health` → 200，`upstream: ok`。
2. `POST {prefix}/proxy/credentials.set`（带正确 key）→ 403 `method_not_allowed`。
3. `POST {prefix}/proxy/session.list` 用错 key → 401。
4. 带正确 key：`POST {prefix}/proxy/host.describe` 返回 DSH 版本；`session.list` 返回会话列表。
5. WebSocket 连 `ws://host{prefix}/proxy/events.mux`（握手带 `X-API-Key`），
   `session.prompt` 后应实时收到 `session/event` 帧直到 `turn/end`。

自动化验收：本仓库 `scripts/proxy-host.mjs`（独立验收宿主）+
`dsh-agent-manager/scripts/smoke-proxy-b.ts`（manager 走 proxy 路径的端到端冒烟）。

## 卸载

删除组合里的插件行（可选 `dsh plugin remove dsh-api-gateway`），重启。

## License

MIT
