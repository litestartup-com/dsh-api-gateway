// docker/smoke.mjs — acceptance smoke for the standalone API stack (nginx + gateway).
//
// Zero dependencies by design: it must run from a bare checkout on any host with
// Node >= 20 (the mux WebSocket check uses the minimal client in probe-lib.mjs,
// so the nginx upgrade path is verified even where the `ws` package is not installed).
//
// Usage:
//   node docker/smoke.mjs                       # wiring checks (defaults from .env)
//   node docker/smoke.mjs --model               # + one real model turn (needs DEEPSEEK_API_KEY)
//   node docker/smoke.mjs --base http://host:port --key apigw-xxx
//   node docker/smoke.mjs --skip-front          # when pointed directly at the gateway
//                                               # port instead of the nginx front door
//   node docker/smoke.mjs --model --provider openai-compat
//                                               # assert which LLM route served the turn
//
// Checks (wiring): health open + upstream ok -> front door fail-closed (GET / = 404)
//   -> wrong key 401 -> whitelist 403 (credentials.set) -> host.describe envelope
//   -> session.list -> mux upgrade (auth accepted / wrong key refused / uplink frame
//   closes with 1008).
// Checks (--model): session.create under /workspace -> session.prompt -> poll
//   session.history until turn/end (assistant/message present).
// Card chains (question/approval respond roundtrips) live in docker/probe-cards.mjs.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  BASE, KEY, PREFIX, REPO_ROOT, argVal, hasFlag, isMain,
  log, step, passed, requireKey,
  post, rpc, getHealth, wsOpen, muxUrl, evOf, typeOf, waitTurnEnd,
} from './probe-lib.mjs'

process.env.PROBE_TAG ||= 'smoke'

const MODEL = hasFlag('--model')
const SKIP_FRONT = hasFlag('--skip-front')

if (isMain(import.meta.url)) {
  log(`base=${BASE} key=${KEY ? KEY.slice(0, 10) + '…' : '(none)'} model=${MODEL} front=${!SKIP_FRONT}`)
  requireKey()

  await step('health is open and upstream is ok', async () => {
    const body = await getHealth()
    if (body.status !== 'ok') throw new Error(`status=${body.status}`)
    if (body.upstream !== 'ok') throw new Error(`upstream=${body.upstream} (facade cannot reach host services)`)
    if (body.apiKeySet !== true) throw new Error('apiKeySet=false — GW_KEY did not reach the facade config')
    log(`health: status=${body.status} upstream=${body.upstream} dshVersion=${body.dshVersion ?? '?'} apiKeySet=${body.apiKeySet}`)
  })

  if (!SKIP_FRONT) {
    await step('front door is fail-closed (GET / = 404)', async () => {
      const res = await fetch(BASE + '/', { signal: AbortSignal.timeout(10_000) })
      if (res.status !== 404) throw new Error(`GET / should be 404 through nginx, got ${res.status}`)
      log('GET / -> 404 (only /api-gw/ is proxied)')
    })
  }

  await step('wrong key is 401', async () => {
    const res = await post(PREFIX + '/proxy/session.list', { type: 'client-request', rpcId: 'smoke-neg', method: 'session.list', payload: {} }, { 'x-api-key': 'wrong-key-smoke' })
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`)
    log('session.list with a wrong key -> 401')
  })

  await step('whitelist is fail-closed (credentials.set = 403)', async () => {
    // Auth runs BEFORE the whitelist, so this must carry the valid key to reach the 403.
    const res = await post(PREFIX + '/proxy/credentials.set', { type: 'client-request', rpcId: 'smoke-neg2', method: 'credentials.set', payload: {} }, { 'x-api-key': KEY })
    if (res.status !== 403) throw new Error(`expected 403, got ${res.status}`)
    if (!res.text.includes('method_not_allowed')) throw new Error(`expected method_not_allowed, got: ${res.text.slice(0, 200)}`)
    log('credentials.set with the valid key -> 403 method_not_allowed')
  })

  await step('host.describe returns the envelope with a version', async () => {
    const value = await rpc('host.describe', {})
    if (!value || typeof value.version !== 'string' || value.version === '') throw new Error(`no version in value: ${JSON.stringify(value).slice(0, 200)}`)
    log(`host.describe: version=${value.version}${value.dshVersion ? ' dshVersion=' + value.dshVersion : ''}`)
  })

  await step('session.list works', async () => {
    const value = await rpc('session.list', {})
    // The facade answers with a paged envelope: { items: [...] }.
    const list = Array.isArray(value) ? value : value?.items ?? value?.sessions
    if (!Array.isArray(list)) throw new Error(`unexpected value shape: ${JSON.stringify(value).slice(0, 200)}`)
    log(`session.list: ${list.length} session(s)`)
  })

  await step('mux upgrade through nginx (auth / refuse / downlink-only)', async () => {
    // 1) a wrong key is refused before the upgrade
    try {
      const bad = await wsOpen(muxUrl(), { 'X-API-Key': 'wrong-key-smoke' })
      bad.close()
      throw new Error('wrong key was NOT refused')
    } catch (e) {
      if (e.statusCode !== 401) throw new Error(`expected HTTP 401 refusal, got: ${e.message}`)
      log('wrong key upgrade -> HTTP 401 (refused before negotiation)')
    }
    // 2) the valid key upgrades, and any uplink frame closes the socket with 1008
    const conn = await wsOpen(muxUrl(), { 'X-API-Key': KEY })
    log('mux upgraded (proxy/events.mux path)')
    conn.sendText('{"smoke":"uplink frames are forbidden"}')
    const code = await conn.closePromise
    if (code !== 1008) throw new Error(`expected close code 1008 (downlink only), got ${code}`)
    log('uplink frame -> close 1008 (downlink-only pipe enforced)')
    // 3) the canonical events.mux path upgrades too
    const conn2 = await wsOpen(muxUrl('/events.mux'), { 'X-API-Key': KEY })
    log('mux upgraded (events.mux path)')
    conn2.close()
  })

  if (MODEL) {
    await step('real model turn: create -> prompt -> turn/end', async () => {
      const name = `smoke-${Date.now()}`
      // Best effort: when the smoke runs ON the compose host this pre-creates the bind-mounted
      // dir; when it runs against a remote base the node container mkdirs the cwd itself
      // (session.create creates a missing cwd inside the writable /workspace mount).
      try { mkdirSync(join(REPO_ROOT, 'workspaces', name), { recursive: true }) } catch { /* remote host */ }
      const created = await rpc('session.create', { cwd: `/workspace/${name}` })
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') throw new Error(`no sessionId in create value: ${JSON.stringify(created).slice(0, 200)}`)
      log(`session created: ${sessionId} (cwd=/workspace/${name})`)
      // Typewriter regression gate (0.2.x hosts): the facade opts into the host's
      // assistant live stream and re-emits the frozen assistant/chunk wire shape
      // (facade 0.2.5, dsh-facts §18.13). Attach the mux BEFORE prompting so no
      // delta is missed; legacy hosts (0.1.x) are not expected to stream chunks.
      const health2 = await getHealth()
      const wantChunks = /^0\.[2-9]/.test(String(health2.dshVersion ?? '')) || /^[1-9]/.test(String(health2.dshVersion ?? ''))
      let mux = null
      if (wantChunks) {
        mux = await wsOpen(muxUrl(), { 'X-API-Key': KEY })
        log(`mux attached for typewriter capture (host ${health2.dshVersion})`)
      }
      const prompted = await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: 'Reply with exactly one word: ok' }] })
      if (prompted?.accepted === false) throw new Error(`prompt not accepted: ${JSON.stringify(prompted).slice(0, 200)}`)
      log('prompt queued; polling history for turn/end (timeout 180s)...')
      const { turnEnd, events } = await waitTurnEnd(sessionId)
      if (!events.some((e) => typeOf(e) === 'assistant/message')) throw new Error('turn ended without any assistant/message event')
      const reply = events.map(evOf).find((ev) => ev?.type === 'assistant/message')
      log(`turn/end: reason=${evOf(turnEnd)?.data?.reason?.kind ?? '?'}; assistant reply: ${JSON.stringify(reply?.data?.message?.content ?? null).slice(0, 120)}`)
      // Which LLM route actually served the turn (request/header event evidence).
      // --provider <route> turns the log line into an assertion (e.g. openai-compat).
      const header = events.map(evOf).find((ev) => ev?.type === 'request/header')
      const route = header?.data?.header?.config
      log(`llm route: provider=${route?.provider ?? '?'} model=${route?.model ?? '?'}`)
      const expectProvider = argVal('--provider')
      if (expectProvider !== undefined && route?.provider !== expectProvider) {
        throw new Error(`expected provider ${expectProvider}, got ${route?.provider ?? '?'}`)
      }
      if (mux !== null) {
        const collect = () => {
          const texts = []
          let kinds = 0
          for (const f of mux.frames) {
            if (f.kind !== 'text') continue
            try {
              const j = JSON.parse(f.data)
              if (j?.payload?.event?.type === 'assistant/chunk' && j.payload.sessionId === sessionId) {
                kinds++
                const c = j.payload.event.data?.chunk
                if (c?.type === 'text-delta' && typeof c.text === 'string') texts.push(c.text)
              }
            } catch { /* not JSON */ }
          }
          return { texts, kinds }
        }
        let got = collect()
        if (got.kinds === 0) { await sleep(3000); got = collect() } // trailing frames in flight
        mux.close()
        if (got.kinds === 0) throw new Error('0.2.x host but ZERO assistant/chunk frames on the mux during the turn (typewriter regression)')
        const streamed = got.texts.join('')
        log(`typewriter: ${got.kinds} chunk frame(s), streamed text ${JSON.stringify(streamed.slice(0, 60))}`)
        if (!streamed.includes('ok')) log('note: streamed deltas do not spell the reply (may lag/omit); frame flow is the evidence')
      }
    })
  }

  log(`ALL GREEN (${passed()} checks${MODEL ? ', incl. real model turn' : ', wiring only — add --model for a real turn'})`)
}
