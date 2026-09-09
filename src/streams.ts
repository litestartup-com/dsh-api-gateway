/**
 * dsh-api-gateway — 0.1.2 mux 桥（每会话 follow 流 → 老 mux 帧广播）。
 *
 * 0.1.2 无全量事件广播：直播流 = 每会话一条 `session/follow` 流
 * （快照帧 + SessionEventEntry 增量）。本模块维护「会话 → 活跃流」注册表，
 * 把增量事件与快照投影翻译成老 mux 帧形（server-request 信封）广播给
 * 所有已连接的下行 WS 客户端（mirror 0.1.1 全量广播语义，manager 本地按
 * sessionId 过滤）。
 */

export interface StreamFrame {
  type?: unknown
  event?: unknown
  projections?: unknown
}

export interface SessionStreamer {
  stream(request: { namespace: string; method: string; args: Record<string, unknown> }): Promise<AsyncIterable<unknown>>
}

export interface MuxBroadcaster {
  send(json: string): void
}

/** 老 mux 帧：server-request 信封 + session/event payload。 */
export const buildEventFrame = (sessionId: string, event: unknown): string => {
  const rpcId = `apigw-${Math.random().toString(16).slice(2, 10)}`
  return JSON.stringify({
    type: 'server-request',
    rpcId,
    method: 'session/event',
    payload: { type: 'session/event', sessionId, event },
  })
}

/**
 * 快照投影 → 逐 key 的 session/projection 帧（老契约：一次一个 key）。
 * `values` 的每个顶层键一帧；manager 的 extractProjectionUsage/Title 按 key 认领。
 */
export const buildProjectionFrames = (sessionId: string, projections: unknown): string[] => {
  const values = (projections as { values?: Record<string, unknown> } | null | undefined)?.values
  if (values === undefined) return []
  return Object.entries(values).map(([key, value]) =>
    JSON.stringify({
      type: 'server-request',
      rpcId: `apigw-${Math.random().toString(16).slice(2, 10)}`,
      method: 'session/projection',
      payload: { type: 'session/projection', sessionId, key, value, seq: 0 },
    }),
  )
}

/** 会话 follow 流注册表：幂等 ensure、事件泵、广播、关闭。 */
export class FollowRegistry {
  private readonly streams = new Map<string, AsyncIterable<unknown>>()
  private readonly pumpLoops = new Map<string, Promise<void>>()
  private readonly pending = new Set<string>()

  constructor(
    private readonly streamer: SessionStreamer,
    private readonly broadcast: (json: string) => void,
    private readonly log: (line: string) => void,
  ) {}

  /** 打开该会话的 follow 流并启动泵（幂等：含开流中的会话，防并发双开）。 */
  ensure(sessionId: string): void {
    if (this.streams.has(sessionId) || this.pending.has(sessionId)) return
    this.pending.add(sessionId)
    void this.start(sessionId).finally(() => this.pending.delete(sessionId))
  }

  private async start(sessionId: string): Promise<void> {
    let stream: AsyncIterable<unknown>
    try {
      stream = await this.streamer.stream({
        namespace: 'session',
        method: 'follow',
        args: { request: { address: { kind: 'session', sessionId } } },
      })
    } catch (error) {
      this.log(`[dsh-api-gw] follow ${sessionId} open failed: ${String((error as Error)?.message ?? error)}`)
      return
    }
    this.streams.set(sessionId, stream)
    const pump = this.pump(sessionId, stream)
    this.pumpLoops.set(sessionId, pump)
  }

  private async pump(sessionId: string, stream: AsyncIterable<unknown>): Promise<void> {
    try {
      for await (const frame of stream) {
        const f = frame as StreamFrame
        if (f.type === 'snapshot') {
          for (const json of buildProjectionFrames(sessionId, f.projections)) this.broadcast(json)
          continue
        }
        if (f.type === 'event' && f.event !== undefined) {
          this.broadcast(buildEventFrame(sessionId, f.event))
        }
      }
    } catch (error) {
      this.log(`[dsh-api-gw] follow ${sessionId} stream ended: ${String((error as Error)?.message ?? error)}`)
    } finally {
      this.streams.delete(sessionId)
      this.pumpLoops.delete(sessionId)
    }
  }

  /** 结束并关闭该会话的流（无 AbortSignal 可用时只能等迭代自然终止）。 */
  close(sessionId: string): void {
    this.streams.delete(sessionId)
    this.pumpLoops.delete(sessionId)
  }

  known(): string[] {
    return [...this.streams.keys()]
  }
}
