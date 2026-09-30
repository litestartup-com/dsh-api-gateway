// Support widget front-end — vanilla JS, no build step.
// Talks only to this demo's BFF (same origin); the facade API key never reaches the browser.
'use strict'

const $ = (s) => document.querySelector(s)
const state = {
  sid: localStorage.getItem('csdemo.sid') || '',
  es: null,
  streamText: '',
  streamReasoning: '',
  streamBubble: null,
  thinkEl: null,
  rafPending: false,
  busy: false,
}

const renderMd = (text) => DOMPurify.sanitize(marked.parse(text ?? '', { breaks: false }))
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._timer)
  t._timer = setTimeout(() => t.classList.remove('show'), 2600)
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

const scroll = () => { const c = $('#chat'); c.scrollTop = c.scrollHeight }

function hideWelcome() { const w = $('#welcome'); if (w) w.remove() }

function addMsg(role, html) {
  hideWelcome()
  const row = document.createElement('div')
  row.className = `msg-row ${role}`
  row.innerHTML = `<div class="bubble ${role === 'system' ? '' : 'md'}">${html}</div>`
  $('#chat').appendChild(row)
  scroll()
  return row.querySelector('.bubble')
}

function addActivity(cls, html) {
  hideWelcome()
  const el = document.createElement('div')
  el.className = `activity ${cls}`
  el.innerHTML = html
  $('#chat').appendChild(el)
  scroll()
  return el
}

function toolLabel(name, args) {
  let target = ''
  try {
    const a = JSON.parse(args || '{}')
    target = a.pattern ?? a.file_path ?? a.path ?? ''
    target = String(target).replace('/workspace/kb/', '')
  } catch { /* keep empty */ }
  if (name === 'grep') return `🔎 Searching the knowledge base${target ? ` for <code>${esc(target)}</code>` : ''} …`
  if (name === 'read') return `📖 Reading <code>${esc(target || '…')}</code>`
  if (name === 'glob') return `📂 Browsing the knowledge base …`
  return `🔧 ${esc(name)}${target ? ` <code>${esc(target)}</code>` : ''} …`
}

function startStreamBubble() {
  state.streamText = ''
  state.streamReasoning = ''
  state.streamBubble = null
  state.thinkEl = null
}

function ensureStreamBubble() {
  if (!state.streamBubble) state.streamBubble = addMsg('agent', '<span class="typing"><i></i><i></i><i></i></span>')
  return state.streamBubble
}

function scheduleRender() {
  if (state.rafPending) return
  state.rafPending = true
  requestAnimationFrame(() => {
    state.rafPending = false
    if (state.streamBubble && state.streamText) state.streamBubble.innerHTML = renderMd(state.streamText)
    if (state.thinkEl && state.streamReasoning) state.thinkEl.textContent = state.streamReasoning
    scroll()
  })
}

function onReasoning(text) {
  if (!state.thinkEl) {
    hideWelcome()
    const d = document.createElement('details')
    d.className = 'thinking'
    d.innerHTML = '<summary>thinking…</summary><div class="think-body"></div>'
    $('#chat').appendChild(d)
    state.thinkEl = d.querySelector('.think-body')
    scroll()
  }
  state.streamReasoning += text
  scheduleRender()
}

function renderQuestion(sid, rpcId, questions) {
  const card = document.createElement('div')
  card.className = 'qcard'
  card.dataset.rpcId = rpcId
  const q = questions[0] ?? {}
  const multi = q.multi_select === true
  card.innerHTML = `
    <div class="q-head">💬 The assistant would like to clarify</div>
    ${q.header ? `<div class="q-head" style="text-transform:none;color:var(--muted)">${esc(q.header)}</div>` : ''}
    <div class="q-text">${esc(q.question ?? '')}</div>
    <div class="q-opts"></div>
    <div class="q-free"><input placeholder="Or type your answer…"><button class="btn sm">Send</button></div>
    <div class="q-foot"><button class="q-cancel">skip this question</button></div>`
  const opts = card.querySelector('.q-opts')
  const picked = new Set()
  for (const opt of q.options ?? []) {
    const b = document.createElement('button')
    b.className = 'q-opt'
    b.textContent = opt.label
    b.title = opt.description ?? ''
    b.onclick = () => {
      if (multi) {
        if (picked.has(opt.label)) { picked.delete(opt.label); b.classList.remove('picked') }
        else { picked.add(opt.label); b.classList.add('picked') }
      } else {
        answer([{ id: q.id, selected: [opt.label] }])
      }
    }
    opts.appendChild(b)
  }
  if (multi) {
    const submit = document.createElement('button')
    submit.className = 'btn sm primary'
    submit.textContent = 'Submit'
    submit.style.marginLeft = '6px'
    submit.onclick = () => answer([{ id: q.id, selected: [...picked] }])
    opts.appendChild(submit)
  }
  const freeInput = card.querySelector('.q-free input')
  const sendFree = () => { const v = freeInput.value.trim(); if (v) answer([{ id: q.id, selected: [], custom: v }]) }
  card.querySelector('.q-free button').onclick = sendFree
  freeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendFree() })
  card.querySelector('.q-cancel').onclick = async () => {
    try { await api('/api/respond', { method: 'POST', body: { sid, rpcId, decline: true } }) } catch (e) { toast(e.message) }
    card.classList.add('resolved')
  }
  async function answer(answers) {
    try {
      const r = await api('/api/respond', { method: 'POST', body: { sid, rpcId, answers } })
      if (!r.accepted) toast(`answer not accepted (${r.reason ?? '?'})`)
      card.classList.add('resolved')
    } catch (e) { toast(e.message) }
  }
  $('#chat').appendChild(card)
  scroll()
}

function openStream(sid) {
  if (state.es) { state.es.close(); state.es = null }
  const es = new EventSource('/api/stream?sid=' + encodeURIComponent(sid))
  state.es = es
  es.addEventListener('status', (e) => {
    const { state: st } = JSON.parse(e.data)
    $('#conn-dot').classList.toggle('on', st === 'open')
    $('#conn-text').textContent = st === 'open' ? 'live' : st
  })
  es.addEventListener('turn_start', () => startStreamBubble())
  es.addEventListener('delta', (e) => { ensureStreamBubble(); state.streamText += JSON.parse(e.data).text; scheduleRender() })
  es.addEventListener('reasoning', (e) => onReasoning(JSON.parse(e.data).text))
  es.addEventListener('message', (e) => {
    const { text } = JSON.parse(e.data)
    if (state.streamBubble) { state.streamBubble.innerHTML = renderMd(text); state.streamBubble = null }
    else addMsg('agent', renderMd(text))
    scroll()
  })
  es.addEventListener('tool_call', (e) => { const d = JSON.parse(e.data); addActivity('', toolLabel(d.name, d.args)) })
  es.addEventListener('tool_result', (e) => { const d = JSON.parse(e.data); if (d.isError) addActivity('err', `⚠ <code>${esc((d.text || '').slice(0, 120))}</code>`) })
  es.addEventListener('approval', (e) => {
    const d = JSON.parse(e.data)
    if (String(d.outcome).startsWith('rejected')) addActivity('blocked', `🛡 blocked a <code>${esc(d.toolName)}</code> attempt — this assistant is read-only`)
    else addActivity('shield', `🛡 ${esc(String(d.outcome))} <code>${esc(d.toolName)}</code>`)
  })
  es.addEventListener('question', (e) => { const d = JSON.parse(e.data); renderQuestion(sid, d.rpcId, d.questions) })
  es.addEventListener('question_resolved', (e) => {
    const d = JSON.parse(e.data)
    const card = document.querySelector(`.qcard[data-rpc-id="${CSS.escape(d.rpcId)}"]`)
    if (card) card.classList.add('resolved')
  })
  es.addEventListener('turn_end', (e) => {
    const d = JSON.parse(e.data)
    if (state.streamBubble && !state.streamText) state.streamBubble.innerHTML = renderMd('_(no text output)_')
    state.streamBubble = null
    state.busy = false
    $('#send').disabled = false
    if (d.reason !== 'completed') addMsg('system', esc(`turn ended: ${d.reason}`))
  })
  es.addEventListener('error', (e) => {
    try { const d = JSON.parse(e.data); addMsg('system', esc(d.message ?? 'stream error')) } catch { /* transport hiccup: EventSource auto-retries */ }
  })
}

async function send(text) {
  text = (text ?? $('#input').value).trim()
  if (!text || state.busy) return
  $('#input').value = ''
  $('#input').style.height = 'auto'
  addMsg('user', esc(text))
  state.busy = true
  $('#send').disabled = true
  $('#newchat').hidden = false
  try {
    const r = await api('/api/chat', { method: 'POST', body: { sid: state.sid || undefined, text } })
    if (r.sid !== state.sid) {
      state.sid = r.sid
      localStorage.setItem('csdemo.sid', r.sid)
      openStream(r.sid)
    } else if (!state.es) openStream(r.sid)
    startStreamBubble()
    addActivity('', '<span class="typing" style="padding:0"><i></i><i></i><i></i></span> consulting the knowledge base…')
  } catch (e) {
    addMsg('system', esc(e.message))
    state.busy = false
    $('#send').disabled = false
  }
}

async function loadTranscript() {
  if (!state.sid) return
  try {
    const r = await api('/api/history?sid=' + encodeURIComponent(state.sid))
    if (r.messages.length > 0) $('#newchat').hidden = false
    for (const m of r.messages) {
      if (m.role === 'user') addMsg('user', esc(m.text))
      else if (m.role === 'assistant') addMsg('agent', renderMd(m.text))
      else addMsg('system', esc(m.text))
    }
    openStream(state.sid)
  } catch {
    localStorage.removeItem('csdemo.sid')
    state.sid = ''
  }
}

$('#send').onclick = () => send()
$('#input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })
$('#input').addEventListener('input', function () {
  this.style.height = 'auto'
  this.style.height = Math.min(this.scrollHeight, 160) + 'px'
})
for (const chip of document.querySelectorAll('#chips .chip')) chip.onclick = () => send(chip.dataset.q)
$('#newchat').onclick = () => {
  localStorage.removeItem('csdemo.sid')
  location.reload()
}

loadTranscript()
