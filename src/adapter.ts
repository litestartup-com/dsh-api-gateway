/**
 * ohdsh-api-facade — 0.1.2 适配层（进程内 typertGateway 直调）。
 *
 * 0.1.2 起网关不再回环 HTTP 转发（/api 带两层鉴权、dotted 端点 404），
 * 改为直调宿主内置的 `typertGateway`（@deepseek-ai/dsh-api-gateway 提供的
 * 进程内 Remote 分发器）：白名单方法 → invoke → 同一套严格 descriptor
 * 校验与业务实现。对外信封（client-request / server-response）不变。
 */

import { randomBytes } from 'node:crypto'

export interface GatewayInvoker {
  invoke(request: InvokeRemoteRequest): Promise<unknown>
  stream?(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>
}

/** 提供 stream 面的宿主分发器（typertGateway 的 stream 子集）。 */
export interface GatewayStreamer {
  stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>
}

/** 进程内 Remote 请求（字段名必须与 descriptor 精确一致）。 */
export interface InvokeRemoteRequest {
  readonly namespace: string
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
  readonly signal?: AbortSignal
}

/** 白名单方法 → 0.1.2 Remote 坐标。Phase 2 起逐个补齐其余白名单方法。 */
export const REMOTE_METHODS: Readonly<Record<string, { readonly namespace: string; readonly method: string }>> = {
  'session.list': { namespace: 'session', method: 'list' },
  'session.create': { namespace: 'session', method: 'create' },
  'session.prompt': { namespace: 'session', method: 'prompt' },
  'session.cancel': { namespace: 'session', method: 'cancel' },
  // 2026-09-09 拍板「功能面 = web 全集」：白名单余下方法全部补映射
  // （老契约字段形状取自生产安装的 0.1.1 dsh-host-apiproxy sessions.d.ts 实证）。
  'session.rename': { namespace: 'session', method: 'rename' },
  'session.fork': { namespace: 'session', method: 'fork' },
  'session.updateQueue': { namespace: 'session', method: 'updateQueue' },
  'session.attachment': { namespace: 'session', method: 'attachment' },
  'session.models': { namespace: 'session', method: 'modelCatalog' },
  'session.selectModel': { namespace: 'session', method: 'selectModel' },
}

/**
 * 0.1.2 无 host.describe Remote；老契约里它的 version 恒为协议号 '0.0.1'
 * （DSH-FACTS §6 双机实测：与 DSH 包版本无关，manager 只作信息展示）。
 * 网关原样合成该常量，manager 的探活/状态页零感知。
 */
export const HOST_DESCRIBE: Readonly<{ version: string }> = Object.freeze({ version: '0.0.1' })

/** 无 0.1.2 Remote 对应、由网关合成的白名单方法。 */
const SYNTHETIC_METHODS: ReadonlySet<string> = new Set(['host.describe'])

/** 已迁移（含合成）的方法才能直调。 */
export const isMigrated = (method: string): boolean => REMOTE_METHODS[method] !== undefined || SYNTHETIC_METHODS.has(method)

/**
 * manager 的旧 payload → 0.1.2 的命名 args（wire 字段名由 descriptor 决定）。
 * `session.list` 的 Host 签名是 `list(_request: SessionListRequest, signal)`：
 * 参数名就是 `_request`，且 `cursor?: string` 可选项不能带 null（strict codec）。
 */
export const argsFor = (method: string, payload: unknown): Record<string, unknown> => {
  switch (method) {
    case 'session.list': {
      const p = (payload ?? {}) as { cursor?: unknown }
      return { _request: { ...(typeof p.cursor === 'string' ? { cursor: p.cursor } : {}) } }
    }
    case 'session.create': {
      // Host 签名 create(request: SessionCreateRequest)：wire 字段名 = request
      //（A1-01 实测：workspace/create 与 session/create 都用 {request:{...}}）。
      // 可选字段一律剔除 null/undefined（strict codec 只认 string 或缺失）。
      const p = (payload ?? {}) as { cwd?: unknown; sessionId?: unknown; agentPreset?: unknown; workspaceId?: unknown }
      return {
        request: {
          ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}),
          ...(typeof p.sessionId === 'string' ? { sessionId: p.sessionId } : {}),
          ...(typeof p.agentPreset === 'string' ? { agentPreset: p.agentPreset } : {}),
          ...(typeof p.workspaceId === 'string' ? { workspaceId: p.workspaceId } : {}),
        },
      }
    }
    case 'session.prompt': {
      // 0.1.2 要求必填 requestId（客户端铸的身份，落在被接受的用户消息上）。
      // 旧契约没有这个字段——由翻译员铸造，契约冻结的代价归网关扛。
      const p = (payload ?? {}) as {
        requestId?: unknown; sessionId?: unknown; mode?: unknown; content?: unknown; clientTimeZone?: unknown
      }
      return {
        request: {
          requestId: typeof p.requestId === 'string' ? p.requestId : `apigw-${randomBytes(16).toString('hex')}`,
          ...(typeof p.sessionId === 'string' ? { sessionId: p.sessionId } : {}),
          ...(p.mode === 'queue' || p.mode === 'steer' ? { mode: p.mode } : { mode: 'queue' }),
          ...(Array.isArray(p.content) ? { content: p.content } : { content: [] }),
          ...(typeof p.clientTimeZone === 'string' ? { clientTimeZone: p.clientTimeZone } : {}),
        },
      }
    }
    case 'session.cancel': {
      const p = (payload ?? {}) as { sessionId?: unknown }
      return { request: { ...(typeof p.sessionId === 'string' ? { sessionId: p.sessionId } : {}) } }
    }
    // ---- 2026-09-09 补齐：老契约（0.1.1 sessions.d.ts）→ 0.1.2 request 命名 ----
    case 'session.rename': {
      const p = (payload ?? {}) as { sessionId?: unknown; title?: unknown }
      return {
        request: {
          ...(typeof p.sessionId === 'string' ? { sessionId: p.sessionId } : {}),
          ...(typeof p.title === 'string' ? { title: p.title } : {}),
        },
      }
    }
    case 'session.fork': {
      const p = (payload ?? {}) as { sessionId?: unknown; atSeq?: unknown }
      return {
        request: {
          ...(typeof p.sessionId === 'string' ? { sessionId: p.sessionId } : {}),
          ...(typeof p.atSeq === 'number' ? { atSeq: p.atSeq } : {}),
        },
      }
    }
    case 'session.updateQueue': {
      // QueueAction 词汇两端一致（edit/remove/steer），原样透传。
      const p = (payload ?? {}) as { sessionId?: unknown; itemId?: unknown; action?: unknown }
      return {
        request: {
          ...(typeof p.sessionId === 'string' ? { sessionId: p.sessionId } : {}),
          ...(typeof p.itemId === 'string' ? { itemId: p.itemId } : {}),
          ...(p.action === undefined ? {} : { action: p.action }),
        },
      }
    }
    case 'session.attachment': {
      const p = (payload ?? {}) as { sessionId?: unknown; attachmentId?: unknown }
      return {
        request: {
          ...(typeof p.sessionId === 'string' ? { sessionId: p.sessionId } : {}),
          ...(typeof p.attachmentId === 'string' ? { attachmentId: p.attachmentId } : {}),
        },
      }
    }
    case 'session.selectModel': {
      const p = (payload ?? {}) as { sessionId?: unknown; provider?: unknown; model?: unknown; reasoningEffort?: unknown }
      return {
        request: {
          ...(typeof p.sessionId === 'string' ? { sessionId: p.sessionId } : {}),
          ...(typeof p.provider === 'string' ? { provider: p.provider } : {}),
          ...(typeof p.model === 'string' ? { model: p.model } : {}),
          ...(typeof p.reasoningEffort === 'string' ? { reasoningEffort: p.reasoningEffort } : {}),
        },
      }
    }
    case 'session.models':
      // 0.1.2 只有 host-wide modelCatalog()（无 request 参数）——strict codec
      // 下多传 args 会被拒，直接给空 args；返回值由 invokeRemote 翻译回老形状。
      return {}
    default:
      return {}
  }
}

/**
 * 0.1.2 `session/modelCatalog` 返回值 → 老契约 `SessionModels`
 * （两端口径都来自 dsh 类型实证：0.1.1 dsh-host-apiproxy sessions.d.ts 的
 * SessionModels vs 0.1.2 session-controller types.ts 的 ModelCatalog）：
 * - `current` ← `default`（老契约的「会话下一步模型选择」）
 * - `routable` ← `routableProviders` 包含 `default.provider`（老契约语义 =
 *   当前 provider 是否有 adapter 在服务）
 * - `groups` / `failures` 字段形状两端一致，原样透传。
 */
export const translateModelCatalog = (catalog: unknown): unknown => {
  const c = catalog as {
    default?: { provider?: unknown } | null
    routableProviders?: unknown
    groups?: unknown
    failures?: unknown
  } | null | undefined
  if (c === null || c === undefined) return null
  const provider = typeof c.default?.provider === 'string' ? c.default.provider : ''
  const routableProviders = Array.isArray(c.routableProviders) ? c.routableProviders : []
  return {
    current: c.default ?? null,
    routable: routableProviders.includes(provider),
    groups: c.groups ?? [],
    failures: c.failures ?? [],
  }
}

/** 一次直调：返回业务 value；抛错时由调用方翻译成 server-response 错误信封。 */
export const invokeRemote = async (
  invoker: GatewayInvoker,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> => {
  if (SYNTHETIC_METHODS.has(method)) {
    // 合成面不触碰 invoker：值由网关按冻结契约直接给出。
    if (method === 'host.describe') return HOST_DESCRIBE
    throw new Error(`gateway: synthetic method ${JSON.stringify(method)} has no producer`)
  }
  const target = REMOTE_METHODS[method]
  if (target === undefined) {
    throw new Error(`gateway: method ${JSON.stringify(method)} is not migrated to the in-process adapter`)
  }
  const value = await invoker.invoke({ namespace: target.namespace, method: target.method, args: argsFor(method, payload), signal })
  return method === 'session.models' ? translateModelCatalog(value) : value
}

/**
 * `session.history` 的 0.1.2 翻译：0.1.2 无同名 Remote，历史经
 * `session/follow` 流（先出 snapshot 帧再出增量）。网关只取首帧快照，
 * 记录翻译回老契约形状：
 * - SessionWireEvent（{type,seq,time,data,ignorable?}）**原样透传**——
 *   manager 的 eventPayload 已按 data/seq 信封解析（不得平铺）
 * - `{type:'chunks', ...}` 打包的流式增量 → **丢弃**（message 帧已带全文，
 *   与 manager compactHistory 的既有语义一致）
 * - 词汇映射：`agent/inbox/spliced` → 老词汇 `user/message`（仅 user 角色的
 *   inserted 消息；0.1.2 把用户消息放进 inbox 事件，manager 不认 spliced）
 * - projections 原样透传（values.title 对齐）
 */
export const readHistory = async (
  streamer: { stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>> },
  sessionId: string,
): Promise<{ events: unknown[]; hasMore: boolean; projections: unknown }> => {
  const stream = await streamer.stream({
    namespace: 'session',
    method: 'follow',
    args: { request: { address: { kind: 'session', sessionId } } },
  })
  const first = await stream[Symbol.asyncIterator]().next()
  if (first.done) throw new Error('session/follow stream closed without a snapshot frame')
  const snapshot = first.value as {
    type?: unknown
    records?: unknown
    hasMore?: unknown
    projections?: unknown
  }
  if (snapshot.type !== 'snapshot') throw new Error(`session/follow first frame is ${String(snapshot.type)}, expected snapshot`)
  const events: unknown[] = []
  for (const record of (snapshot.records ?? []) as Array<{ type?: unknown; event?: { type?: unknown; data?: unknown } }>) {
    if (record.type !== 'event' || record.event === undefined) continue // chunks 打包记录丢弃
    if (record.event.type === 'agent/inbox/spliced') {
      // 词汇映射：0.1.2 把用户消息放进 inbox/spliced 事件，manager 认老词汇
      // user/message。只译 user 角色的 inserted 消息；spliced 事件本身不产出。
      const d = (record.event.data ?? {}) as { inserted?: unknown }
      for (const item of (d.inserted ?? []) as Array<{ role?: unknown; id?: unknown; content?: unknown }>) {
        if (item.role === 'user') {
          events.push({ event: { type: 'user/message', data: { id: item.id, content: item.content } } })
        }
      }
      continue
    }
    // SessionWireEvent 原样透传：manager 的 eventPayload 已按 {type,seq,data} 信封解析，
    // 不得平铺 data（平铺会弄丢 manager 要读的 data 字段）。
    events.push({ event: record.event })
  }
  return { events, hasMore: snapshot.hasMore === true, projections: snapshot.projections ?? null }
}
