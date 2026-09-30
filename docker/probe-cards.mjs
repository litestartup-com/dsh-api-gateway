// docker/probe-cards.mjs — question/approval card-chain probe for the standalone stack.
//
// The respond bridge is the facade's differentiating surface (the agent asks YOU
// mid-turn; you answer over HTTP and it continues) and its highest-risk contact
// point across DSH upgrades (agent lifecycle went async in the 0.1.7 corridor,
// auto-review reshaped approval outcomes in 0.1.7-rc.2). This probe walks both
// chains end to end, with the payload shapes proven by the manager's production
// probes (dsh-agent-manager scripts/probe-ask.ps1 / probe-approval.ps1) and the
// card-chain fact card (dsh-facts §10).
//
// Usage: node docker/probe-cards.mjs [--base http://host:port] [--key K]
// Requires: DEEPSEEK_API_KEY on the node (real turns drive the chains).
//
// Chain 1 (question): prompt -> mux `question/requested` frame -> GET answerer/pending
//   lists it (recovery channel) -> respond { answers: [{ id, selected }] } ->
//   `question/resolved` frame -> turn/end not aborted.
// Chain 2 (approval): pin the session read-only via {prefix}/sessions/{id}/sandbox-mode
//   -> prompt a file write -> mux `approval/requested` frame + health.answererPendingIds
//   agree -> respond outcome `allowed-once` -> tool/result event + turn/end completed +
//   the file really exists in the host-side workspace bind mount.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BASE, KEY, PREFIX, REPO_ROOT, isMain,
  log, fail, step, passed, sleep, requireKey,
  post, rpc, respond, getHealth, wsOpen, muxUrl, evOf, typeOf, waitTurnEnd,
} from './probe-lib.mjs'

process.env.PROBE_TAG ||= 'cards'

if (isMain(import.meta.url)) {
  log(`base=${BASE} key=${KEY ? KEY.slice(0, 10) + '…' : '(none)'}`)
  requireKey()

  const health = await getHealth()
  if (health.upstream !== 'ok') fail(`upstream=${health.upstream} — fix the stack first (run smoke.mjs)`)

  const name = `probe-cards-${Date.now()}`
  try { mkdirSync(join(REPO_ROOT, 'workspaces', name), { recursive: true }) } catch { /* remote host: the node mkdirs the cwd itself */ }
  const created = await rpc('session.create', { cwd: `/workspace/${name}` })
  const sessionId = created?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') fail(`session.create returned no sessionId: ${JSON.stringify(created).slice(0, 200)}`)
  log(`session: ${sessionId} (cwd=/workspace/${name})`)

  const mux = await wsOpen(muxUrl(), { 'X-API-Key': KEY })
  log('mux connected')

  try {
    // ---- Chain 1: question card (ask_user_question -> respond -> continue) ----
    await step('question chain: request -> pending -> respond -> resolved -> turn/end', async () => {
      await rpc('session.prompt', {
        sessionId, mode: 'queue',
        content: [{
          type: 'text',
          text: 'Please use only the question card tool (ask_user_question) to ask me one question: what do I want for lunch? Give me three options: rice, noodles, dumplings. Do nothing else, do not read or write any file.',
        }],
      })
      log('prompt queued; waiting for question/requested on the mux (150s)...')
      const frame = await mux.waitJson((f) => f.method === 'question/requested', 150_000)
      const rpcId = frame.rpcId
      const questions = frame.payload?.questions
      if (typeof rpcId !== 'string' || rpcId === '') throw new Error(`frame has no rpcId: ${JSON.stringify(frame).slice(0, 200)}`)
      if (!Array.isArray(questions) || questions.length === 0) throw new Error(`frame has no questions array: ${JSON.stringify(frame.payload).slice(0, 200)}`)
      const qid = questions[0]?.id
      log(`question/requested: rpcId=${rpcId} questionId=${qid} options=${JSON.stringify((questions[0]?.options ?? []).map((o) => o?.label ?? o)).slice(0, 80)}`)

      // Recovery channel: the pending broadcast must be retrievable (facade b592b4f+).
      const pendRes = await fetch(BASE + PREFIX + '/answerer/pending', { headers: { 'x-api-key': KEY }, signal: AbortSignal.timeout(10_000) })
      if (pendRes.status !== 200) throw new Error(`answerer/pending: HTTP ${pendRes.status}`)
      const pend = await pendRes.json()
      const pendList = Array.isArray(pend) ? pend : pend?.items ?? pend?.pending ?? []
      if (!JSON.stringify(pendList).includes(rpcId)) throw new Error(`answerer/pending does not list ${rpcId}: ${JSON.stringify(pend).slice(0, 200)}`)
      log('answerer/pending lists the broadcast (recovery channel ok)')

      // Answer with the proven shape: { sessionId, answer: { answers: [{ id, selected }] } }.
      const receipt = await respond(rpcId, { sessionId, answer: { answers: [{ id: qid, selected: ['noodles'] }] } })
      if (receipt?.accepted === false) throw new Error(`respond declined: ${JSON.stringify(receipt).slice(0, 200)}`)
      log(`respond accepted: ${JSON.stringify(receipt).slice(0, 120)}`)

      const resolved = await mux.waitJson((f) => f.method === 'question/resolved', 30_000)
      log(`question/resolved: ${JSON.stringify(resolved.payload ?? resolved).slice(0, 120)}`)

      const { turnEnd } = await waitTurnEnd(sessionId, { minTurn: 1 })
      const reason = evOf(turnEnd)?.data?.reason?.kind ?? '?'
      if (reason === 'aborted' || reason === 'error') throw new Error(`turn ended as ${reason}`)
      log(`turn/end: reason=${reason} — the model received the answer and finished the turn`)
    })

    // ---- Chain 2: approval card (write attempt under a pinned read-only sandbox) ----
    // Evidence (192.168.33.11, 0.2.0-rc.2): under the default workspace-write preset an
    // in-workspace `write` is allowed with NO card and `bash` is refused outright, so a
    // benign file-creation prompt never reaches human approval. The deterministic
    // trigger is the facade's own sandbox-mode route: pin read-only right after create
    // (the route's documented purpose) — a write attempt must then escalate to an
    // approval request answerable with `allowed-once`.
    await step('approval chain: pin read-only -> request -> respond allowed-once -> tool ran -> file on disk', async () => {
      const pinRes = await post(`${PREFIX}/sessions/${sessionId}/sandbox-mode`, { mode: 'read-only' }, { 'x-api-key': KEY })
      if (pinRes.status !== 200) throw new Error(`sandbox-mode pin: HTTP ${pinRes.status} — ${pinRes.text.slice(0, 200)}`)
      log(`sandbox pinned read-only: ${JSON.stringify(pinRes.json).slice(0, 120)}`)

      await rpc('session.prompt', {
        sessionId, mode: 'queue',
        content: [{
          type: 'text',
          text: 'Please create a file probe-card.txt in the current working directory, containing one line: hello. Do only this one thing.',
        }],
      })
      log('prompt queued; waiting for approval/requested on the mux (150s)...')
      const frame = await mux.waitJson((f) => f.method === 'approval/requested', 150_000)
      const rpcId = frame.rpcId
      if (typeof rpcId !== 'string' || rpcId === '') throw new Error(`frame has no rpcId: ${JSON.stringify(frame).slice(0, 200)}`)
      log(`approval/requested: rpcId=${rpcId} tool=${frame.payload?.toolName ?? '?'} approvalId=${frame.payload?.approvalId ?? '?'}`)

      // Cross-check the health surface agrees (the manager's production poll pattern).
      let listed = false
      for (let i = 0; i < 10 && !listed; i++) {
        const h = await getHealth()
        listed = JSON.stringify(h?.answererPendingIds ?? []).includes(rpcId)
        if (!listed) await sleep(1000)
      }
      if (!listed) throw new Error(`health.answererPendingIds never listed ${rpcId}`)
      log('health.answererPendingIds agrees (dual surface consistent)')

      const receipt = await respond(rpcId, { sessionId, approvalId: rpcId, outcome: 'allowed-once' })
      if (receipt?.accepted === false) throw new Error(`respond declined: ${JSON.stringify(receipt).slice(0, 200)}`)
      log(`respond accepted: ${JSON.stringify(receipt).slice(0, 120)}`)

      // Turn-scoped wait: this session already has turn 1's turn/end from the question
      // chain — matching ANY turn/end would assert on stale data (probe bug found and
      // fixed on the 0.2.0 corridor run).
      const { turnEnd, events } = await waitTurnEnd(sessionId, { minTurn: 2 })
      const reason = evOf(turnEnd)?.data?.reason?.kind ?? '?'
      if (reason === 'aborted' || reason === 'error') throw new Error(`turn ended as ${reason}`)
      const decided = events.map(evOf).find((ev) => ev?.type === 'approval/decided')
      log(`turn/end: reason=${reason}; approval/decided outcome=${decided?.data?.outcome ?? '?'}`)
      if (decided?.data?.outcome !== 'allowed-once') throw new Error(`approval outcome not echoed: ${JSON.stringify(decided?.data ?? null).slice(0, 200)}`)

      // End-to-end evidence: the approved write landed in the host-side bind mount.
      // (0.2.0 flow, measured: the read-only refusal carries an escalation hint, the
      // model retries with sandbox_permissions, and the approval reason reads
      // "escalate sandbox to workspace-write" — allowed-once then lets exactly that
      // one operation through.)
      if (/127\.0\.0\.1|localhost/.test(BASE)) {
        const hostPath = join(REPO_ROOT, 'workspaces', name, 'probe-card.txt')
        let content = null
        for (let i = 0; i < 10 && content === null; i++) {
          try { content = readFileSync(hostPath, 'utf8') } catch { await sleep(1000) }
        }
        if (content === null) throw new Error(`approved write did not land: ${hostPath} missing after 10s`)
        if (!content.includes('hello')) throw new Error(`file content unexpected: ${JSON.stringify(content.slice(0, 80))}`)
        log(`file on the host bind mount: ${hostPath} content=${JSON.stringify(content.trim())}`)
      } else {
        log('note: base is remote — skipping the bind-mount file check (approval/decided + turn/end are the evidence)')
      }
    })
  } finally {
    mux.close()
    // No session.cancel here: a cancel racing the settling tail of the last turn
    // aborts trailing tool calls (measured). The session stays as the audit trail.
  }

  log(`ALL GREEN (${passed()} card chains)`)
}
