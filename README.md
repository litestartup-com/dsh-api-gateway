# dsh-api-gateway

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的开源 API Gateway 插件：任何第三方客户端都能通过一组极简的 **REST + SSE** 接口与你的 Agent 会话交互，完全绕开 Web GUI。API 会话与 GUI 会话驱动的是同一套 Agent 机器（inbox + 会话日志），互不依赖。

## 特性

- **REST + SSE**：7 个端点，token 级流式回包（`assistant/chunk`），回合结束自动关流
- **GUI 管理卡片**：设置 → 插件 → 可配置 → API Gateway（状态 / 软开关 / 密钥轮换）
- **灵活配置**：组合行配置 + 调用时参数（`provider` / `model` / `maxTokens` / `cwd`）
- **原生能力**：API 会话自动挂载默认 agent preset（工具、技能与 GUI 会话一致）、继承默认模型选择
- **工作区归属**：API 会话与 GUI 会话一样落进工作区（侧边栏分组显示，不再进「未分组」）
- **会话续聊**：discover 发现会话 → 只读任意会话历史 → adopt 接管（在线共驾 / 冷会话恢复），UI 里聊到一半的会话可无缝交给第三方继续
- **干净卸载**：删一行组合配置即可

## 安装（两步）

```bash
# 1. 安装 npm 包（在你的 DSH 部署目录）
pnpm add dsh-api-gateway
```

```yaml
# 2. 在你的宿主组合（cordis.yml）中加一行插件行，然后重启。
# 行格式与组合内现有行一致（- id: … / name: 包名 / config: …）：
- id: api-gateway
  name: dsh-api-gateway
  config:
    prefix: /api-gw/v1          # 可选，默认 /api-gw/v1
    enabled: true               # 可选，默认 true
    apiKeys: []                 # 可选，预置静态 API 密钥
    allowKeyProvision: true     # 可选，允许首次 POST /key 自助发放
    adminKey: change-me         # 可选；设置后启用 admin 端点与 GUI 卡片开关
    maxSessions: 20             # 可选，并发会话上限
    workspaceMode: auto         # 可选：auto（默认，会话自动挂入工作区）/ ungrouped（保持不挂载）
    defaultWorkspacePath: ''    # 可选：auto 模式下无 cwd 时的默认归属目录
    allowDiscover: true         # 可选：允许 GET /sessions/discover（列出全部会话）
    allowAdopt: true            # 可选：允许 POST /sessions/:id/adopt（接管任意会话）
    corsOrigin: '*'             # 可选：CORS 源（'*' 或具体域/数组；公开部署建议收敛）
    exposeErrors: true          # 可选：错误响应是否带内部细节（公开部署建议 false）
    sseHeartbeatMs: 30000       # 可选：SSE 心跳间隔（毫秒），0 关闭
    bodyTimeoutMs: 30000        # 可选：请求体读取超时（毫秒）
```

完整示意见 [examples/cordis.yml](./examples/cordis.yml)。

> 宿主组合归属说明：API Gateway 发布的是跨会话共享的 HTTP 面，应挂在**宿主组合**（host composition），而不是某个 agent preset。

## 卸载

删掉组合里的 `dsh-api-gateway` 行（可选 `pnpm remove dsh-api-gateway`），重启。

## 快速开始

```bash
BASE=http://127.0.0.1:3080/api-gw/v1
KEY=$(curl -s -X POST $BASE/key | jq -r .apiKey)             # 首调领钥，仅一次有效（见「安全模型」）
SID=$(curl -s -X POST $BASE/sessions -H "Authorization: Bearer $KEY" | jq -r .sessionId)
curl -N $BASE/sessions/$SID/stream -H "Authorization: Bearer $KEY" &    # SSE 流式回包
curl -s -X POST $BASE/sessions/$SID/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"content":"你好，介绍一下你自己"}'
```

> 没有 `jq`？（macOS 非预装，`brew install jq` 即可；或直接用下面的 Python/PowerShell 版）

**Windows PowerShell（原生，零额外依赖）：**

```powershell
$BASE = 'http://127.0.0.1:3080/api-gw/v1'
$KEY  = (Invoke-RestMethod -Method Post "$BASE/key").apiKey          # 首调领钥
$SID  = (Invoke-RestMethod -Method Post "$BASE/sessions" -Headers @{ Authorization = "Bearer $KEY" }).sessionId
# 中文消息务必按 UTF-8 发送（PowerShell 5.1 默认 ANSI/GBK，会导致乱码）：
$json  = '{"content":"你好，介绍一下你自己"}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
Invoke-RestMethod -Method Post "$BASE/sessions/$SID/messages" `
  -Headers @{ Authorization = "Bearer $KEY" } -ContentType 'application/json; charset=utf-8' `
  -Body $bytes
```

> PowerShell 5.1 中文乱码速解：要么如上用 `[System.Text.Encoding]::UTF8.GetBytes(...)` 转字节，要么 `-ContentType 'application/json; charset=utf-8'` 声明字符集；PowerShell 7（pwsh）默认 UTF-8 无此问题。服务端也按 `Content-Type` 的 charset 解码（默认 UTF-8，兼容 GBK）。

**Python（Linux / macOS / Windows 通用）：**

```python
import httpx, json            # 需要 pip install httpx（或改用标准库 urllib）
base = "http://127.0.0.1:3080/api-gw/v1"
key = httpx.post(f"{base}/key").json()["apiKey"]
h = {"Authorization": f"Bearer {key}"}
sid = httpx.post(f"{base}/sessions", headers=h).json()["sessionId"]
httpx.post(f"{base}/sessions/{sid}/messages", headers=h,
           json={"content": "你好，介绍一下你自己"})
with httpx.stream("GET", f"{base}/sessions/{sid}/stream", headers=h) as r:
    for line in r.iter_lines():
        if line.startswith("data: "):
            print(json.loads(line[6:])["kind"])
```

## 端点

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 无 | 状态（停用时仍可访问） |
| POST | `/key` | 首次调用 | 一次性发放 API 密钥 |
| POST | `/sessions` | API Key | 创建会话，可传 `provider/model/maxTokens/cwd/workspace` |
| GET | `/sessions/discover` | API Key | 会话清单（id/title/cwd/live/persisted），**不含内容** |
| POST | `/sessions/:id/adopt` | API Key | 接管会话：`live`=共驾在线会话；`resumed`=冷恢复；返回完整历史 |
| POST | `/sessions/:id/messages` | API Key | 投递消息 `{"content":"..."}`（字符串或块数组） |
| GET | `/sessions/:id/stream` | API Key | SSE：hello(含历史回放)→chunk→message→tool_call/tool_result→turn_end |
| GET | `/sessions/:id/history` | API Key | **任意**会话的完整历史（只读，含 GUI 会话） |
| POST | `/sessions/:id/cancel` | API Key | 中止当前回合 |
| POST | `/admin/enable` | Admin Key | 运行时软开关 `{"enabled":bool}` |
| POST | `/admin/rotate-key` | Admin Key | 轮换密钥 |

鉴权头二选一，完全等价：`Authorization: Bearer <key>`（推荐，RFC 6750 标准）或 `X-API-Key: <key>`（兼容别名）。

完整规范见 [openapi.yaml](./openapi.yaml)。

## 安全模型

**`POST /key` 为什么能直接领到密钥？** 它是"首次调用引导"（bootstrap），不是常开的发钥匙口：

- 只有当**尚无任何密钥**时，`POST /key` 才会生成一枚 32 位随机密钥并返回——**仅第一次有效**；此后该端点即被锁死，未持密钥者调用只会得到 401。
- 默认部署里网关挂在回环地址（`127.0.0.1`）上，所以"第一个触达者"只可能是**部署者本机**上的进程——窗口期是你安装后到第一次调用的那几秒到几分钟，本质上等同于"初始化时给自己设一个密码"。
- 不信任这个窗口就把口子焊死：组合行配置 `allowKeyProvision: false`，密钥只从 `apiKeys: [...]` 预置——之后没有任何自助发放路径。

**纵深（生产部署建议清单）：**

1. `allowKeyProvision: false` + 组合行预置 `apiKeys`（密钥只存在于组合文件，由部署者管理）
2. 网关保持回环绑定；确需对外时自行前置反向代理 + TLS，绝不让明文 HTTP 出网
3. `adminKey` 与 API 密钥分开管理（软开关/轮换密钥属于管理面）
4. 每个会话独立 Agent 上下文，会话 ID 为 32 位随机串不可枚举
5. 鉴权头用 `Authorization: Bearer <key>`（标准、客户端生态与日志脱敏友好）；`X-API-Key` 仅保留为兼容别名

**已知缺口（见路线图，公开透明）：** 目前无按密钥限流/配额、无吊销清单、无多密钥管理 UI、无审计；持有 API Key 即可发现/读取/接管**全部会话**（`allowDiscover`/`allowAdopt` 可关闭对应面，per-key 白名单见 v0.2.0）。多租户高强度对抗场景请等待 v0.2+，或自己加一层网关。

## 工作区归属

API 会话与 GUI 会话一样落进工作区：侧边栏按工作区分组显示，不再堆在「未分组」。`POST /sessions` 可带 `workspace` 字段（三选一写法）：

```jsonc
{ "workspace": "C:\\projects\\team-a" }                 // ① 路径字符串
{ "workspace": { "path": "C:\\projects\\team-a", "title": "团队A" } }  // ② 带标题（新建时生效）
{ "workspace": { "id": "ws-xxx" } }                     // ③ 已有工作区 ID 精确指定
```

解析规则（服务端确定性执行）：

- 路径已有工作区 → 复用；尚无 → **自动创建**（标题默认取目录 basename）
- `id` 不存在 → 400，错误体附带现有工作区清单（id/title/path）
- 未给 `workspace` → 按组合配置 `workspaceMode`：`auto`（默认，用会话 `cwd`/`defaultWorkspacePath` 做解析或创建并挂载）或 `ungrouped`（保持不挂载）
- 同时给 `cwd` 与 `workspace` → workspace 优先；会话 `cwd` 强制为工作区**规范路径**（Durable 成员关系成立的前提：会话头 cwd == 工作区路径）
- 路径指向不存在的目录 → 400 明确报错（网关不代为创建目录）

响应与 `history` 均回带 `workspace: { id, path, title }`。`auto` 模式会在侧边栏自动出现以沙箱根（或 `defaultWorkspacePath`）命名的工作区——这是特性而非意外；共享协作工作区（多密钥共用同一路径）见路线图 v0.2.0。

## 会话发现与接管（UI 会话 → API 续聊）

在 UI 里聊到一半的会话，可以无缝交给第三方 API 继续：

```bash
# ① 发现会话（拿 sessionId）
curl -s $BASE/sessions/discover -H "Authorization: Bearer $KEY"

# ② 接管：在线会话共驾（live）；离线会话冷恢复（resumed）；返回完整历史
curl -s -X POST $BASE/sessions/$SID/adopt -H "Authorization: Bearer $KEY"
# → { "mode": "live" | "resumed", "history": [...完整历史事件...] }

# ③ 继续对话 / 流式 / 取消 —— 与网关自建会话用法完全一致
curl -s -X POST $BASE/sessions/$SID/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"content":"接着上次继续……"}'
```

| mode | 含义 | 生命周期 |
| --- | --- | --- |
| `created` | 网关自建会话 | 随网关 |
| `live` | **共驾** UI 在线会话：API 消息直接出现在 GUI 对话流，双方回合排队执行 | 网关只借驾；插件停止 = 解除跟踪，GUI 会话不受影响 |
| `resumed` | 冷恢复离线会话（需部署配置 `sessionPersistence`） | 恢复后由网关持有，随网关消亡 |

历史端点（`GET /sessions/:id/history`）对**任意**会话可用（只读，不要求先接管）；`/messages`、`/stream`、`/cancel` 需先 adopt。

**隐私边界**：持有 API Key 即可发现/读取/接管全部会话——单机自用是特性，多租户是风险。可用 `allowDiscover` / `allowAdopt` 关闭对应面；per-key 会话白名单列入 v0.2.0。

## SSE 事件流

`data:` 行均为 JSON，`kind` 取值：`hello` / `user` / `chunk`(text-delta·reasoning-delta·tool-call-delta·usage·finish) / `message`(整条+usage) / `tool_call` / `tool_result` / `turn_start` / `turn_end`(含 `reason` 与错误 `detail`)。服务端在 `turn_end` 后关闭连接，客户端可重连继续监听。

## 架构

- **host 半**（`src/index.ts`）：注册 `webServer` 前缀路由；用 `agentLoop.createAgent(ctx, ...)` 创建由插件 fiber 拥有的 Agent（插件停止/更新时自动销毁）；`setup` 中挂载默认 agent preset；默认模型解析链：调用参数 → `agentDefaultModel.currentSelection()` → 组合行配置的首个 agent 路由；`cwd` 默认取 `sandboxPolicy.workspaceRoot`。
- **client 半**（`src/client.tsx`）：通过 `dsh.client` 声明自动打包进 Web GUI，在 `settings.plugin.item` 注册管理卡片，走网关自身 HTTP 面（无需 RPC 机器）。
- 会话为**内存态**；接入 `sessionPersistence` 做跨重启恢复列入路线图。

## 扩展性（面向其他插件）

网关在 Cordis 事件总线上发布三个事件，其他宿主插件可用 `ctx.on(...)` 订阅（监听器随插件 fiber 自动回收，异常不影响网关）：

- `gateway/session-created` → `{ sessionId, mode: 'created' | 'live' | 'resumed', workspace, cwd }`
- `gateway/message` → `{ sessionId, messageId, text }`（助手整条回复提交时触发）
- `gateway/turn-end` → `{ sessionId, turn, reason, detail }`

典型用途：审计落盘、外部告警、转发到 IM/Webhook、自定义限流旁路。

> 注意：这是宿主组合内的事件总线。不要把网关行放进 agent preset——它发布进程级服务，预设挂载会被拒绝。

## 开发与测试

- `pnpm build`（tsc 构建）；`pnpm smoke` 对运行中的网关跑端到端冒烟（env：`DSH_AGW_BASE` / `DSH_AGW_KEY`）
- CI（`.github/workflows/ci.yml`）：构建 + 语法检查 + 可选冒烟（在仓库 vars 配置 `DSH_AGW_BASE` 后启用）
- 发布前把 `package.json` 中 `repository` / `bugs` 的占位符 `YOUR_NAME` 改成你的仓库地址

## 与官方 Python SDK 的关系

DeepSeek Harness 官方另有一个 **Python SDK**（[快速上手](https://deepseek-harness.github.io/deepseek-harness/guide/python-sdk) / [SDK 参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.md)）。两者**不是同一种东西，也不互相替代**——选错会白费功夫，先看区别：

| 维度 | 官方 Python SDK | 本网关（dsh-api-gateway） |
| --- | --- | --- |
| 本质 | **嵌入式运行时**：`pip install deepseek-harness-sdk` 自带平台 wheel（无需 Node），以**子进程**方式启动内置 `dsh-jsonrpc-agent`，经 **JSON-RPC stdio** 调用 | **运行中部署的一扇门**：作为宿主组合插件挂在已启动的 Harness 里，对外提供 REST + SSE |
| 模型凭据 | DeepSeek 官方 API Key（`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`，直接打模型端点） | 网关自管 API Key（Bearer / X-API-Key），与模型凭据无关 |
| 会话 | 私有 JSONL（`session_root`），与任何部署、GUI 无关 | 部署共享会话库：GUI 可见、工作区分组、**可发现/可接管续聊** |
| 能力面 | 默认组合只有本地 `bash` 等极简工具、无 skills、无压缩（可用 `cordis` 参数自定义组合） | 部署默认 agent preset 的全部能力（工具/技能/沙箱策略） |
| 平台 | Linux x64/arm64、macOS 14+ arm64；**不支持 Windows** | 客户端任意语言、任意平台（含 Windows PowerShell） |
| 隔离性 | `danger-full-access`，官方建议仅在可丢弃环境/容器中运行 | 继承部署的沙箱与审批策略 |
| 典型场景 | 没有长期部署、Python 脚本内跑**一次性隔离任务** | 有持续运行的部署，开放给第三方/跨机器/多客户端，或续聊 UI 会话 |

**选择指南：**

- 你是 Python 程序、要一次性隔离任务、不关心部署里的 GUI 会话 → **官方 SDK**
- 你要连"正在运行的这个 Harness"、任何语言、要统一鉴权/限流/审计、要续聊 UI 会话 → **本网关**

**常见误用（别踩）：**

1. 不要拿 DeepSeek 的 `sk-…` 密钥来打本网关（网关不认模型凭据，只认自己发的 API Key）；
2. 不要期望 `pip install deepseek-harness-sdk` 能连上本网关（SDK 是自起运行时，不是 HTTP 客户端）；
3. 在 Windows 上只能用本网关（官方 SDK 不支持 Windows）。

## 路线图

里程碑按「先安全、再体验、后生态」排序；每个版本可独立发布。

| 版本 | 主题 | 内容 |
| --- | --- | --- |
| **v0.1.0** | 发布基线（当前） | REST + SSE、GUI 设置卡片（软开关/轮换密钥）、reasoning/text 分离、跨平台文档与安全模型 |
| **v0.2.0** | 多租户安全 ★ | 多密钥管理（增删查改/吊销）、按密钥限流（429 + `Retry-After`）、**工作区模型：每密钥独立工作区 + 共享协作工作区（`shared`/`isolated`）**、按密钥审批策略、审计（每密钥请求/会话/token 用量）、会话持久化（重启后 `agentLoop.resume` 恢复） |
| **v0.3.0** | 管理界面 | **完整 admin 管理界面**（设置 → API Gateway 独立页：密钥 CRUD/限额/工作区绑定、会话监控、用量审计、软开关）+ typert `@Remote` 配置面（管理界面的地基）+ per-key agent preset 选择 |
| **v0.4.0** | 双工流式 | `webServer.registerUpgrade` WebSocket 全双工（发消息/收流/取消同一条连接）；SSE 保留为轻量选项 |
| **v0.5.0** | 生态与运维 | 本网关的 Python/Node HTTP 薄客户端（OpenAPI 生成，**不是**官方嵌入式 SDK，分工见上文）、部署指南（反向代理 + TLS、Docker Compose）、指标/遥测导出、OpenAPI 生成进 CI |

**共享协作工作区（v0.2.0）**：同一工作区可绑定多个密钥，各自会话仍是独立 Agent 上下文（互不见对方的对话记忆），但对工作区文件的读写互通——团队协作、联调场景用 `shared:<name>`；默认每密钥 `isolated` 独立目录。目录级隔离由网关保证；强文件系统隔离依赖部署的沙箱后端，边界在文档中说明。

**不做 / 缓做**：多进程横向扩展、内置 TLS 终止（反向代理的职责）、OAuth/OIDC（先跑通按密钥模型再议）。

## License

MIT
