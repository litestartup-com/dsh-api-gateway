/**
 * ohdsh-api-facade — 0.1.2 mux 桥（每会话 follow 流 → 老 mux 帧广播）。
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
 * seq 取投影水位 asOfSeq（老契约帧形带 seq）。
 */
export const buildProjectionFrames = (sessionId: string, projections: unknown): string[] => {
  const block = projections as { asOfSeq?: unknown; values?: Record<string, unknown> } | null | undefined
  const values = block?.values
  if (values === undefined) return []
  const seq = typeof block?.asOfSeq === 'number' ? block.asOfSeq : 0
  return Object.entries(values).map(([key, value]) => buildProjectionFrame(sessionId, key, value, seq))
}

/** 单条 live 投影增量 → 老 session/projection 帧（control 流逐条投递）。 */
export const buildProjectionFrame = (sessionId: string, key: string, value: unknown, seq: number): string => {
  const rpcId = `apigw-${Math.random().toString(16).slice(2, 10)}`
  return JSON.stringify({
    type: 'server-request',
    rpcId,
    method: 'session/projection',
    payload: { type: 'session/projection', sessionId, key, value, seq },
  })
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
      this.log(`[ohdsh-api-facade] follow ${sessionId} open failed: ${String((error as Error)?.message ?? error)}`)
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
      this.log(`[ohdsh-api-facade] follow ${sessionId} stream ended: ${String((error as Error)?.message ?? error)}`)
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

/**
 * 宿主级 `session/control` 流桥（0.1.2-rc.1 源码实证，session-controller
 * control.ts）：live projections **不在** follow 流里（其联合只有 snapshot |
 * SessionEventEntry），而在 host-wide control 流——首帧 baseline
 * （全部会话的 {asOfSeq, values}）+ `{type:'projection', sessionId, key,
 * value, seq}` 增量（sessionProjections.onChanged 驱动）。翻译成老 mux 的
 * 逐 key session/projection 帧广播。
 *
 * queue/jobs 帧不翻译：老契约里 manager 的 mux 分发显式忽略它们，无消费者。
 * 流终止（宿主失败）3 秒后重开，mirror manager mux 的重连语义。
 */
export class ControlBridge {
  private disposed = false
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly streamer: SessionStreamer,
    private readonly broadcast: (json: string) => void,
    private readonly log: (line: string) => void,
    private readonly retryMs = 3_000,
  ) {}

  /** 开流并泵帧；幂等，dispose 后不再重连。 */
  start(): void {
    this.disposed = false
    void this.loop()
  }

  private async loop(): Promise<void> {
    if (this.running || this.disposed) return
    this.running = true
    try {
      const stream = await this.streamer.stream({ namespace: 'session', method: 'control', args: {} })
      for await (const frame of stream) {
        const f = frame as {
          type?: unknown
          value?: unknown
          sessionId?: unknown
          key?: unknown
          seq?: unknown
          [k: string]: unknown
        }
        if (f.type === 'baseline') {
          // value.projections: Record<sessionId, { asOfSeq, values }> —— 每会话
          // 每个 key 一帧（与 follow 快照投影同形）。
          const projections = (f.value as { projections?: Record<string, unknown> } | null | undefined)?.projections ?? {}
          for (const [sessionId, block] of Object.entries(projections)) {
            for (const json of buildProjectionFrames(sessionId, block)) this.broadcast(json)
          }
          continue
        }
        if (f.type === 'projection' && typeof f.sessionId === 'string' && typeof f.key === 'string') {
          this.broadcast(buildProjectionFrame(f.sessionId, f.key, f.value, typeof f.seq === 'number' ? f.seq : 0))
        }
      }
    } catch (error) {
      this.log(`[ohdsh-api-facade] control stream ended: ${String((error as Error)?.message ?? error)}`)
    } finally {
      this.running = false
    }
    if (!this.disposed) {
      this.timer = setTimeout(() => { this.timer = null; void this.loop() }, this.retryMs)
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }
}
