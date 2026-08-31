# dsh-api-gateway

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 API Gateway 插件：把正在运行的 Harness 变成 HTTP API——任何第三方客户端（curl、Python、浏览器、IM 桥）都能创建 Agent 会话、经 SSE 逐 token 流式接收回复、并**继续 UI 里聊到一半的会话**，全程 API 密钥鉴权。API 会话与 GUI 会话驱动同一套 Agent 机器（inbox + 会话日志），两边天然同步。

```sh
dsh plugin --profile web add github:litestartup-com/dsh-api-gateway
```

## 特性

- **REST + SSE**：10 个端点；token 级流式回包（`assistant/chunk`），`turn_end` 后服务端关流
- **GUI 设置卡片**：设置 → 插件 → 可配置 → **dsh-api-gw**（默认折叠，右侧 chevron 展开；状态 / 软开关 / 密钥轮换）。默认英文，页面或浏览器语言为中文时自动切中文
- **工作区归属**：API 会话落进真实工作区，侧边栏分组显示，不再进「未分组」
- **会话发现与接管**：列出全部会话、只读任意会话完整历史、adopt 接管 GUI 会话继续对话——在线共驾或冷恢复，上下文无缝衔接
- **reasoning 分离**：回复拆分为 `text`（正式回答）与 `reasoning`（思考过程），不再混装
- **可扩展**：在 Cordis 事件总线上发布 `gateway/session-created` / `gateway/session-released` / `gateway/message` / `gateway/turn-end`，供其他宿主插件订阅
- **任意语言客户端**：Linux/macOS/Windows 通吃（含 PowerShell；UTF-8 安全、服务端 GBK 兼容）

## 安装

### 推荐：`dsh plugin add`

```sh
# 从 GitHub 安装（已含构建产物，无需构建授权）
dsh plugin --profile web add github:litestartup-com/dsh-api-gateway

# 从 tarball 安装
dsh plugin --profile web add ./dsh-api-gateway-0.1.0.tgz
```

> 已提交构建产物 `lib/`，从 GitHub 安装无需构建授权；构建脚本（`prepack`）只在打包/发布时执行。

卸载：`dsh plugin --profile web remove dsh-api-gateway`。

### 手动组合行（不用 CLI）

插件本质是普通 Cordis 行，也可手工编排。它发布跨会话共享的 HTTP 面，应挂**宿主组合**（或 profile 的补丁层）——绝不能放进 agent preset：

```yaml
- id: dsh-api-gw
  name: dsh-api-gateway
  config:
    prefix: /api-gw/v1          # 路由前缀
    enabled: true               # 主开关（也可运行时软开关）
    apiKeys: []                 # 预置静态 API 密钥
    allowKeyProvision: true     # 首调 POST /key 自助发钥
    adminKey: change-me         # 启用 admin 端点与卡片控件
    maxSessions: 20             # 并发会话上限
    workspaceMode: auto         # auto（默认，自动挂入工作区）/ ungrouped
    defaultWorkspacePath: ''    # auto 模式下无 cwd 时的默认归属目录
    allowDiscover: true         # GET /sessions/discover
    allowAdopt: true            # POST /sessions/:id/adopt
    corsOrigin: '*'             # '*' 或具体域/列表（列表按请求 Origin 匹配回显）
    exposeErrors: true          # 错误响应是否带内部细节
    sseHeartbeatMs: 30000       # SSE 心跳间隔（0 关闭）
    bodyTimeoutMs: 30000        # 请求体读取超时
```

所有键都有 schema 默认值——完整注释版见 `examples/cordis.yml`。

## 快速开始

DSH 跑起来后，直接问 agent 一句话。脚本会自己领 key、建会话、发问并逐 token 打印回答：

```bash
./examples/ask.py "介绍一下你自己"        # 全平台，零依赖
```

```powershell
.\examples\ask.ps1 "介绍一下你自己"       # Windows 原生，零依赖
```

不带问题就进交互模式（同一会话多轮问答）。`--help` 列出全部参数，常用的几个：

| 参数 | 作用 |
| --- | --- |
| `-s <会话id>` | 接管已有会话——包括 GUI 里正开着的那个 |
| `-l` | 列出网关能看到的所有会话 |
| `--no-stream` | 不用 SSE，轮询拿最终答案 |
| `-c <目录>` | 新会话的工作目录（决定归属工作区） |

想直接看协议本身：

```bash
BASE=http://127.0.0.1:3080/api-gw/v1
KEY=$(curl -s -X POST $BASE/key | jq -r .apiKey)                       # 首调领钥，仅一次有效
SID=$(curl -s -X POST $BASE/sessions -H "Authorization: Bearer $KEY" | jq -r .sessionId)
curl -sN $BASE/sessions/$SID/stream -H "Authorization: Bearer $KEY" &   # 先接流，再发问
curl -s -X POST $BASE/sessions/$SID/messages -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"content":"你好"}'          # 202 已受理
```

### 客户端示例

三个可直接读的脚本，参数与行为完全一致：

| 脚本 | 依赖 | 说明 |
| --- | --- | --- |
| `examples/ask.py` | Python 3.8+ | 只用标准库，参考实现 |
| `examples/ask.ps1` | PowerShell 5.1+ | Windows 上 UTF-8 安全 |
| `examples/ask.sh` | bash 4+、curl、jq | |

它们处理好了两个手写片段最容易踩的点：

- **先接流再发问**：服务端在 `turn_end` 关流，回合结束后才接就永远等不到事件；提前接没有代价，首帧 `hello` 会回放已有历史。整个回合都错过了就直接读 `GET /sessions/:id/history`。
- **声明 charset**：服务端按请求 `Content-Type` 的 charset 解码（默认 UTF-8，兼容 GBK）。否则 PowerShell 5.1 会按 ANSI/GBK 发出中文导致乱码；且 PowerShell 5.1 下 `curl.exe -d '{"a":"b"}'` 会丢掉内层引号（非法 JSON → 400，还被 `-s` 静默）。请发 UTF-8 字节，或用 `--data-binary "@file"`。

## 端点

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | 无 | 状态（停用时仍可访问） |
| POST | `/key` | 首次调用 | 一次性发放 API 密钥 |
| POST | `/sessions` | API Key | 创建会话（`provider/model/maxTokens/cwd/workspace`） |
| GET | `/sessions/discover` | API Key | 会话清单（id/title/cwd/live/persisted），不含内容 |
| POST | `/sessions/:id/adopt` | API Key | 接管会话（`live` 共驾 / `resumed` 冷恢复），返回完整历史 |
| POST | `/sessions/:id/messages` | API Key | 发消息（字符串或块数组） |
| GET | `/sessions/:id/stream` | API Key | SSE：hello(回放)→chunk→message→tool_call/tool_result→turn_end |
| GET | `/sessions/:id/history` | API Key | **任意**会话完整历史（只读） |
| POST | `/sessions/:id/cancel` | API Key | 中止当前回合 |
| DELETE | `/sessions/:id` | API Key | 归还该会话占用的 `maxSessions` 名额 —— **历史保留** |
| POST | `/admin/enable` | Admin Key | 运行时软开关 `{"enabled": bool}` |
| POST | `/admin/rotate-key` | Admin Key | 轮换密钥 |

鉴权头二选一，等价：`Authorization: Bearer <key>`（推荐，RFC 6750）或 `X-API-Key: <key>`。

完整规范：[openapi.yaml](./openapi.yaml)。

### 归还会话名额

`maxSessions` 限制网关同时持有的会话数，满了之后建会话会直接失败。`DELETE /sessions/:id` 把名额还回去。对「每个任务开一个会话」的客户端来说这是必需的：否则长期运行的部署迟早撞上限，此后既建不了新会话**也 adopt 不了旧会话**，只能重载网关。

它做什么、不做什么：

| | |
| --- | --- |
| 释放 `maxSessions` 名额 | 是 |
| 关闭该会话上的 SSE 流 | 是 |
| dispose 掉 agent | **仅当**网关持有它（`created` / `resumed`） |
| 影响共驾的 GUI 会话（`live`） | **不会** —— 只解除跟踪，Web UI 那边照旧 |
| 删除对话历史 | **不会** —— `GET /sessions/:id/history` 照样能读，`POST /sessions/:id/adopt` 能把会话拿回来 |

幂等：对未知或已释放的 id 返回 `200` 且 `released: false`，所以客户端可以在清理路径里无条件调用。若回合仍在进行，先取消再释放。

```jsonc
// DELETE /api-gw/v1/sessions/<id>
{ "ok": true, "sessionId": "...", "released": true, "disposed": true, "mode": "created", "historyRetained": true }
```

## 安全模型

**`POST /key` 为什么能直接领到密钥？** 它是"首次调用引导"，不是常开的发钥匙口：

- 仅当**尚无任何密钥**时，`POST /key` 才生成一枚 32 位随机密钥——**仅一次有效**；此后该端点锁死（无钥 401）。
- 默认网关挂回环地址，第一个触达者只可能是部署者本人——等价于首次开机设密码。
- 不信任这个窗口就焊死：`allowKeyProvision: false`，密钥只从 `apiKeys: [...]` 预置。

纵深（生产清单）：

1. `allowKeyProvision: false` + 预置 `apiKeys`
2. 保持回环绑定；对外必走反向代理 + TLS
3. `adminKey` 与 API 密钥分开管理
4. 每会话独立 Agent 上下文；会话 ID 为密码学随机
5. 鉴权头主推 `Authorization: Bearer`（`X-API-Key` 仅作别名）
6. 恒定时间密钥比较（`crypto.timingSafeEqual`）+ CSPRNG 密钥生成

已知缺口（公开透明）：无按密钥限流/配额、吊销清单、多密钥管理 UI、审计——多租户对抗场景等 v0.2+ 或自己前置网关。持有 API Key 即可发现/读取/接管**全部**会话——单机是特性，多租户是风险，可用 `allowDiscover`/`allowAdopt` 关闭（per-key 白名单在 v0.2.0）。

## 工作区归属

API 会话与 GUI 会话一样落进工作区（侧边栏分组，不进「未分组」）。`POST /sessions` 的 `workspace` 三种写法：

```jsonc
{ "workspace": "C:\\projects\\team-a" }                                // 路径字符串
{ "workspace": { "path": "C:\\projects\\team-a", "title": "团队A" } }   // 带标题（新建时生效）
{ "workspace": { "id": "ws-xxx" } }                                    // 已有工作区 ID
```

规则（服务端确定性执行）：

- 路径已有工作区 → 复用；否则**自动创建**（标题默认取目录名）
- `id` 不存在 → 400 附现有工作区清单（id/title/path）
- 未给 `workspace` → `workspaceMode`：`auto`（默认，按会话 cwd/`defaultWorkspacePath` 解析或创建并挂载）或 `ungrouped`
- 同时给 `cwd` 与 `workspace` → workspace 优先，会话 cwd 强制为工作区规范路径（持久成员关系前提：会话头 cwd == 工作区路径）
- 目录不存在 → 400（网关不代为建目录）

响应与 `history` 均回带 `workspace: { id, path, title }`。共享协作工作区（多密钥共用路径）在 v0.2.0。

## 会话发现与接管（UI 会话 → API 续聊）

```bash
# ① 发现会话
curl -s $BASE/sessions/discover -H "Authorization: Bearer $KEY"

# ② 接管：在线共驾 / 冷恢复；返回完整历史
curl -s -X POST $BASE/sessions/$SID/adopt -H "Authorization: Bearer $KEY"
# → { "mode": "live" | "resumed", "history": [...] }

# ③ 继续对话 —— 与网关自建会话用法一致
curl -s -X POST $BASE/sessions/$SID/messages \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"content":"接着上次继续"}'
```

| mode | 含义 | 生命周期 |
| --- | --- | --- |
| `created` | 网关自建会话 | 随网关 |
| `live` | **共驾** GUI 在线会话：API 消息直接出现在 GUI 对话流，双方回合排队 | 只借驾；插件停止 = 解除跟踪 |
| `resumed` | 冷恢复离线会话（需 `sessionPersistence`） | 恢复后归网关持有 |

`GET /sessions/:id/history` 对**任意**会话可用（只读，无需先接管）；`/messages`、`/stream`、`/cancel` 需先 adopt。

## 与官方 Python SDK 的关系

DeepSeek Harness 官方另有 **Python SDK**（[快速上手](https://deepseek-harness.github.io/deepseek-harness/guide/python-sdk) / [SDK 参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.md)）。两者**不是同一种东西，也不互相替代**：

| | 官方 Python SDK | 本网关 |
| --- | --- | --- |
| 本质 | **嵌入式运行时**：`pip install deepseek-harness-sdk` 自带平台 wheel，以**子进程**驱动内置 `dsh-jsonrpc-agent`（JSON-RPC stdio） | **运行中 Harness 的一扇门**：宿主组合插件，REST + SSE |
| 模型凭据 | DeepSeek API Key（`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`） | 网关自管 API Key（与模型凭据无关） |
| 会话 | `session_root` 下私有 JSONL，与部署/GUI 无关 | 部署共享会话库：GUI 可见、工作区分组、可接管 |
| 能力面 | 默认组合极简（本地 bash 等，无 skills、无压缩；可 `cordis` 定制） | 部署默认 agent preset 全部能力（工具/技能/沙箱策略） |
| 平台 | Linux x64/arm64、macOS 14+ arm64；**不支持 Windows** | 客户端任意语言/平台（含 Windows PowerShell） |
| 隔离性 | `danger-full-access`，仅建议容器/可丢弃环境 | 继承部署沙箱与审批策略 |
| 典型场景 | Python 脚本跑**一次性隔离任务**，无长期部署 | 第三方连接**你正在运行的部署**：跨语言、统一鉴权限流审计、续聊 UI 会话 |

一次性 Python 任务 → 官方 SDK；持续部署、跨语言、续聊 UI 会话 → 本网关。**别混用**：DeepSeek 的 `sk-…` 密钥打不开本网关；`pip install deepseek-harness-sdk` 也连不上本网关。

## 扩展性（面向其他插件）

网关在 Cordis 事件总线上发布三个事件，其他宿主插件用 `ctx.on(...)` 订阅（监听器随 fiber 回收，异常不影响网关）：

- `gateway/session-created` → `{ sessionId, mode: 'created' | 'live' | 'resumed', workspace, cwd }`
- `gateway/message` → `{ sessionId, messageId, text, usage }`（每条助手回复提交时；`usage` 为该步 token 用量，无则 `null`）
- `gateway/turn-end` → `{ sessionId, turn, reason, detail, usage, provider, model }`（`usage` 为整回合各步之和，全程无上报则 `null`）

典型用途：审计落盘、外部告警、转发 IM/Webhook、自定义限流旁路。

## 开发与测试

```sh
pnpm install
pnpm build        # tsc
pnpm smoke        # 对运行中的网关跑端到端冒烟
```

冒烟 env：`DSH_AGW_BASE`（默认 `http://127.0.0.1:3080/api-gw/v1`）、`DSH_AGW_KEY`（缺省则领一把）、`DSH_AGW_PROMPT`。CI（`.github/workflows/ci.yml`）跑构建 + 语法检查，可用仓库 vars 开启可选冒烟。

## 路线图

按「先安全、再体验、后生态」排序；各版本独立发布。

| 版本 | 主题 | 内容 |
| --- | --- | --- |
| **v0.1.0** | 基线（当前） | REST+SSE、设置卡片、reasoning/text 分离、工作区归属、会话接管、跨平台文档 |
| **v0.2.0** | 多租户安全 ★ | 多密钥 CRUD/吊销、按密钥限流（429 + `Retry-After`）、**工作区模型：每密钥独立 + 共享协作（`shared`/`isolated`）**、按密钥审批策略、审计（每密钥请求/会话/token 用量）、会话持久化（重启恢复） |
| **v0.3.0** | 管理界面 | 完整 admin 设置页（密钥/限额/工作区绑定、会话监控、用量审计、软开关）+ typert `@Remote` 配置面 + per-key preset 选择 |
| **v0.4.0** | 双工流式 | `webServer.registerUpgrade` WebSocket 全双工；SSE 保留为轻量选项 |
| **v0.5.0** | 生态与运维 | Python/Node HTTP 薄客户端（OpenAPI 生成——**不是**官方嵌入式 SDK，见上文）、部署指南（反代+TLS、Docker Compose）、指标/遥测导出、OpenAPI 生成进 CI |

**不做/缓做**：多进程横向扩展、内置 TLS 终止（反代职责）、OAuth/OIDC（按密钥模型稳定后再议）。

## License

MIT
