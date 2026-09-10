/**
 * ohdsh-api-facade — 0.1.2 应答器（respond 桥）。
 *
 * manager 的问答/审批走老契约：mux 收到 question/approval 帧 → respond 回填。
 * 两条挂载路径（index.ts 择一）：
 *
 * 1. **mountRemote（首选，方案 A）**：进程内远程事件客户端——宿主把
 *    user-questions/request、approval/request 瀑布经 web-app 的 remotes 桥
 *    转发进 typertGateway 的 `$events` 流；facade 以浏览器同款流程订阅、
 *    翻译成老帧广播、等 manager respond、经 `$events/result` 认领。
 *    依据：remotes 桥在无远程客户端时无限期占住瀑布（占位实测 134 秒，
 *    manager 收不到任何帧）；进程内客户端认领后瀑布立即结算。
 * 2. **mount(ctx)（兜底）**：直接挂 Cordis 瀑布监听器——仅用于没有
 *    web-app/remotes（无 `$events` 能力）的部署；监听顺序在 remotes 之后，
 *    只处理「无人认领」的请求。
 *
 * 0.1.2 的正缝词汇（0.1.2-rc.1 源码实证）：
 * - AskUserQuestionAnswerItem {id, selected, custom?} ≡ manager QuestionAnswer
 * - ApprovalOutcome 'allowed-once'|'rejected'|'cancelled'|'unavailable'
 *   ⊇ manager decideApproval 词汇（直通）
 * - 拒绝语义：manager declineQuestion = not-ok + error.code 'cancelled'；
 *   0.1.2 UI 等价 = 以 code 'ASK_CANCELLED' 拒绝 waterfall（ui-user-questions
 *   的 cancel() 行为）。错误对象按 name/message/code 复原成 UserQuestionError
 *   —— 这正是 dsh-user-questions restoreUserQuestionError 支持的跨 worker 形。
 */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'

/** manager 拒绝问题的标记：settle 对它 reject，监听器凭它把「认领并失败」与「超时让位」分开。 */
class ManagerDeclined extends Error {
  constructor() {
    super('the user cancelled ask_user_question')
    this.name = 'ManagerDeclined'
  }
}

/** 0.1.2 ApprovalOutcome 全集；manager 只发 allowed-once/rejected，其余直通备用。 */
const APPROVAL_OUTCOMES: ReadonlySet<string> = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable'])

interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

/**
 * 进程内远程事件流的 carrier（index.ts 用 typertGateway.wireStream 与
 * 宿主 connection.rpc 装配——与浏览器 ClientRemoteEvents 同一套 wire 词汇）。
 *
 * 端点与载荷 = 0.1.2 网关协议常量（packages/api/gateway/src/stream-protocol.ts）：
 * - 流：`$events`，payload `{ args: {} }`；首帧 ready{ clientId, host }；
 *   其后 waterfall{ event, eventId, agentId, request } / cancel{ eventId } / emit。
 * - 认领：RPC `$events/result`，args = { clientId, eventId, outcome }，
 *   outcome ∈ {kind:'result',value?} | {kind:'next'} | {kind:'rejected',error}。
 * 常量按协议钉死在本地（facade 保持与 dsh 仓库解耦的既有风格）。
 */
export interface RemoteEventCarrier {
  openStream: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<AsyncIterable<unknown>>
  sendResult: (args: unknown, signal: AbortSignal) => Promise<unknown>
  /** 每收到一帧回调（诊断计数用；kind=帧类型，event=瀑布事件名）。 */
  onFrame?: (kind: string, event?: string) => void
}

const REMOTE_EVENT_STREAM_ENDPOINT = '$events'
const REMOTE_EVENT_STREAM_PAYLOAD = { args: {} }

/** manager 不回应的最长期限（超时让位给链上其它应答器，如浏览器 UI）。 */
export const ANSWER_TIMEOUT_MS = 10 * 60_000

const mintId = (): string => `apigw-${randomBytes(16).toString('hex')}`

export class Answerer {
  private readonly pending = new Map<string, PendingEntry>()
  private disposers: Array<() => void> = []

  constructor(
    private readonly broadcast: (json: string) => void,
    private readonly log: (line: string) => void,
  ) {}

  /** 挂载两个 waterfall 监听器；返回卸载器（fiber 销毁时调用）。 */
  mount(ctx: Context): () => void {
    const onQuestions = ctx.on('user-questions/request', async (
      request: AskUserQuestionRequest,
      next: () => Promise<AskUserQuestionAnswer>,
    ): Promise<AskUserQuestionAnswer> => {
      const rpcId = mintId()
      const sessionId = request.agent?.id ?? ''
      this.broadcast(JSON.stringify({
        type: 'server-request',
        rpcId,
        method: 'question/requested',
        payload: { type: 'question/requested', sessionId, questions: request.questions },
      }))
      try {
        // respond 值 = { sessionId, answer: { answers: [...] } }；认领返回值 = { answers }。
        const value = await this.awaitAnswer(rpcId, request.signal) as { answer?: { answers?: unknown } } | null | undefined
        const answers = (value?.answer?.answers ?? []) as AskUserQuestionAnswerItem[]
        this.broadcastResolved('question/resolved', sessionId, rpcId, 'answered', null)
        return { answers }
      } catch (error) {
        if (error instanceof ManagerDeclined) {
          this.broadcastResolved('question/resolved', sessionId, rpcId, 'cancelled', null)
          // 与 ui-user-questions cancel() 一致：waterfall 抛错 = 认领并失败。
          // 不带 ASK_CANCELLED 抛错而 next() 会让浏览器 UI 重问一遍同一问题。
          throw { name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED' }
        }
        this.log(`[ohdsh-api-facade] question ${rpcId} unanswered (${String((error as Error)?.message ?? error)}), delegating`)
        return next()
      }
    })

    const onApprovals = ctx.on('approval/request', async (
      request: ApprovalRequest,
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome> => {
      const approvalId = mintId()
      this.broadcast(JSON.stringify({
        type: 'server-request',
        rpcId: approvalId,
        method: 'approval/requested',
        payload: {
          type: 'approval/requested',
          sessionId: request.agent.id,
          approvalId,
          toolName: request.toolName,
          callId: request.callId ?? null,
          reason: request.reason ?? null,
        },
      }))
      try {
        // respond 值 = { sessionId, approvalId, outcome }；outcome 词汇直通。
        const value = await this.awaitAnswer(approvalId, request.signal) as { outcome?: unknown } | null | undefined
        const outcome = value?.outcome
        if (typeof outcome === 'string' && APPROVAL_OUTCOMES.has(outcome)) {
          this.broadcastResolved('approval/resolved', request.agent.id, approvalId, outcome, approvalId)
          return outcome as ApprovalOutcome
        }
        return next()
      } catch (error) {
        this.log(`[ohdsh-api-facade] approval ${approvalId} unanswered (${String((error as Error)?.message ?? error)}), delegating`)
        return next()
      }
    })

    this.disposers = [onQuestions, onApprovals]
    return () => {
      for (const dispose of this.disposers) dispose()
      this.disposers = []
      for (const entry of this.pending.values()) entry.reject(new Error('gateway unloaded'))
      this.pending.clear()
    }
  }

  private awaitAnswer(id: string, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('answer timeout'))
      }, ANSWER_TIMEOUT_MS)
      const onAbort = (): void => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('cancelled'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const entry: PendingEntry = {
        resolve: (value) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          this.pending.delete(id)
          resolve(value)
        },
        reject: (reason) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          this.pending.delete(id)
          reject(reason)
        },
      }
      this.pending.set(id, entry)
    })
  }

  // ---- 进程内远程事件客户端应答器（方案 A：browser 同款流程，无监听顺序依赖）----

  /**
   * 打开 `$events` 流并泵帧：waterfall 帧翻译成老 mux 帧广播给 manager，
   * manager 的 respond 到达后经 `$events/result` 认领。
   *
   * 打不开流（宿主无 typertGateway.wireStream / connection / 未注册转发事件源）
   * 时直接抛错——调用方（index.ts）接住后回退 ctx.on 瀑布监听器路径。
   * @returns 卸载器（中止流 + 拒绝全部挂起项）。
   */
  async mountRemote(carrier: RemoteEventCarrier): Promise<() => void> {
    const controller = new AbortController()
    const source = await carrier.openStream(REMOTE_EVENT_STREAM_ENDPOINT, REMOTE_EVENT_STREAM_PAYLOAD, controller.signal)
    void this.pumpRemote(source, carrier, controller.signal)
    return () => {
      controller.abort()
      for (const [rpcId, entry] of this.pending) {
        entry.reject(new Error('gateway unloaded'))
        this.pending.delete(rpcId)
      }
    }
  }

  private async pumpRemote(
    source: AsyncIterable<unknown>,
    carrier: RemoteEventCarrier,
    signal: AbortSignal,
  ): Promise<void> {
    // eventId → 挂起项的 respond rpcId（cancel 帧到达时据此拒绝挂起项）。
    const eventEntries = new Map<string, string>()
    try {
      let clientId: string | null = null
      for await (const value of source) {
        if (signal.aborted) return
        if (value === null || typeof value !== 'object') continue
        const frame = value as Record<string, unknown>
        carrier.onFrame?.(
          typeof frame.type === 'string' ? frame.type : 'unknown',
          typeof frame.event === 'string' ? frame.event : undefined,
        )
        if (clientId === null) {
          if (frame.type === 'ready' && typeof frame.clientId === 'string') {
            clientId = frame.clientId
            continue
          }
          this.log('[ohdsh-api-facade] remote event stream did not begin with ready — closing')
          return
        }
        if (frame.type === 'cancel' && typeof frame.eventId === 'string') {
          const rpcId = eventEntries.get(frame.eventId)
          eventEntries.delete(frame.eventId)
          if (rpcId !== undefined) this.pending.get(rpcId)?.reject(new Error('the host cancelled the request'))
          continue
        }
        if (frame.type !== 'waterfall'
          || typeof frame.eventId !== 'string'
          || typeof frame.agentId !== 'string'
          || typeof frame.event !== 'string') continue
        if (frame.request === null || typeof frame.request !== 'object') continue
        // agentId 即 sessionId（0.1.2 host agent 上下文身份 = agent.id，wire 类型
        // 就是 SessionId——core/agent/src/index.ts 实证），manager 按它路由。
        void this.handleRemoteWaterfall(
          frame.event, frame.eventId, clientId, frame.agentId,
          frame.request as Record<string, unknown>, eventEntries, carrier, signal,
        )
      }
    } catch (error) {
      this.log(`[ohdsh-api-facade] remote event stream ended (${String((error as Error)?.message ?? error)})`)
    } finally {
      for (const rpcId of eventEntries.values()) this.pending.get(rpcId)?.reject(new Error('remote answerer disposed'))
    }
  }

  private async handleRemoteWaterfall(
    event: string,
    eventId: string,
    clientId: string,
    sessionId: string,
    request: Record<string, unknown>,
    eventEntries: Map<string, string>,
    carrier: RemoteEventCarrier,
    signal: AbortSignal,
  ): Promise<void> {
    if (event === 'user-questions/request') {
      const rpcId = mintId()
      eventEntries.set(eventId, rpcId)
      this.broadcast(JSON.stringify({
        type: 'server-request',
        rpcId,
        method: 'question/requested',
        payload: {
          type: 'question/requested',
          sessionId,
          questions: Array.isArray(request.questions) ? request.questions : [],
        },
      }))
      try {
        // respond 值 = { answer: { answers } }；认领值 = { answers }（与 ctx.on 路径同形）。
        const value = await this.awaitAnswer(rpcId) as { answer?: { answers?: unknown } } | null | undefined
        const answers = (value?.answer?.answers ?? []) as AskUserQuestionAnswerItem[]
        await this.sendRemoteResult(carrier, clientId, eventId, { kind: 'result', value: { answers } }, signal)
        this.broadcastResolved('question/resolved', sessionId, rpcId, 'answered', null)
      } catch (error) {
        if (error instanceof ManagerDeclined) {
          this.broadcastResolved('question/resolved', sessionId, rpcId, 'cancelled', null)
          await this.sendRemoteResult(carrier, clientId, eventId, {
            kind: 'rejected',
            error: { name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED' },
          }, signal)
        } else {
          this.log(`[ohdsh-api-facade] question ${rpcId} unanswered (${String((error as Error)?.message ?? error)}), delegating`)
          this.broadcastResolved('question/resolved', sessionId, rpcId, 'cancelled', null)
          await this.sendRemoteResult(carrier, clientId, eventId, { kind: 'next' }, signal)
        }
      } finally {
        eventEntries.delete(eventId)
      }
      return
    }
    if (event === 'approval/request') {
      const approvalId = mintId()
      eventEntries.set(eventId, approvalId)
      this.broadcast(JSON.stringify({
        type: 'server-request',
        rpcId: approvalId,
        method: 'approval/requested',
        payload: {
          type: 'approval/requested',
          sessionId,
          approvalId,
          toolName: typeof request.toolName === 'string' ? request.toolName : '',
          callId: typeof request.callId === 'string' ? request.callId : null,
          reason: typeof request.reason === 'string' ? request.reason : null,
        },
      }))
      try {
        // respond 值 = { outcome }；认领值 = outcome 字符串（词汇直通）。
        const value = await this.awaitAnswer(approvalId) as { outcome?: unknown } | null | undefined
        const outcome = value?.outcome
        if (typeof outcome === 'string' && APPROVAL_OUTCOMES.has(outcome)) {
          await this.sendRemoteResult(carrier, clientId, eventId, { kind: 'result', value: outcome }, signal)
          this.broadcastResolved('approval/resolved', sessionId, approvalId, outcome, approvalId)
        } else {
          await this.sendRemoteResult(carrier, clientId, eventId, { kind: 'next' }, signal)
        }
      } catch (error) {
        this.log(`[ohdsh-api-facade] approval ${approvalId} unanswered (${String((error as Error)?.message ?? error)}), delegating`)
        this.broadcastResolved('approval/resolved', sessionId, approvalId, 'cancelled', approvalId)
        await this.sendRemoteResult(carrier, clientId, eventId, { kind: 'next' }, signal)
      } finally {
        eventEntries.delete(eventId)
      }
    }
  }

  private async sendRemoteResult(
    carrier: RemoteEventCarrier,
    clientId: string,
    eventId: string,
    outcome: { kind: 'result'; value?: unknown } | { kind: 'next' } | { kind: 'rejected'; error: unknown },
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await carrier.sendResult({ clientId, eventId, outcome }, signal)
    } catch (error) {
      this.log(`[ohdsh-api-facade] remote result delivery failed (${String((error as Error)?.message ?? error)})`)
    }
  }

  private broadcastResolved(
    method: 'question/resolved' | 'approval/resolved',
    sessionId: string,
    id: string,
    outcome: string,
    approvalId: string | null,
  ): void {
    const payload: Record<string, unknown> = { type: method, sessionId, outcome }
    if (method === 'question/resolved') payload.questionRpcId = id
    else payload.approvalId = approvalId ?? id
    this.broadcast(JSON.stringify({ type: 'server-request', rpcId: id, method, payload }))
  }

  /**
   * manager 的 respond 到达：解析 client-response 信封，回填挂起项。
   * not-ok + code 'cancelled'（manager declineQuestion）按老契约算已认领，
   * 但以 ManagerDeclined 拒绝挂起项，让监听器走 ASK_CANCELLED 路径。
   */
  settle(envelope: { rpcId?: unknown; result?: { ok?: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } } }): { found: boolean } {
    const id = typeof envelope.rpcId === 'string' ? envelope.rpcId : ''
    const entry = this.pending.get(id)
    if (entry === undefined) return { found: false }
    const result = envelope.result
    if (result?.ok === true) {
      entry.resolve(result.value)
    } else {
      const code = typeof result?.error?.code === 'string' ? result.error.code : ''
      const message = typeof result?.error?.message === 'string' ? result.error.message : 'manager rejected'
      entry.reject(code === 'cancelled' ? new ManagerDeclined() : new Error(message))
    }
    return { found: true }
  }

  pendingCount(): number {
    return this.pending.size
  }

  /** 挂起项的 respond rpcId 清单（诊断/探针用）。 */
  pendingIds(): string[] {
    return [...this.pending.keys()]
  }
}
