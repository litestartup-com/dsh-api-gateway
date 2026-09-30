// KB Studio front-end — vanilla JS, no build step.
// Talks only to this demo's BFF (same origin); the facade API key never reaches the browser.
'use strict'

const $ = (s) => document.querySelector(s)
const state = {
  files: [],
  current: null,       // { path, content, synced }
  editing: false,
  sid: localStorage.getItem('kbdemo.sid') || '',
  es: null,
  streamText: '',
  streamReasoning: '',
  streamBubble: null,
  thinkEl: null,
  rafPending: false,
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

// Served behind nginx under a mount prefix (/kb/): every API call must stay under it —
// root-absolute /api/... would land in the front door's fail-closed 404. BASE is '' when
// the BFF is opened directly (dev), so both topologies work.
const BASE = location.pathname.replace(/\/+$/, '')

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ---- file tree ----

async function loadTree() {
  const data = await api('/api/tree')
  state.files = data.files
  renderTree()
}

function renderTree() {
  const filter = $('#search').value.trim().toLowerCase()
  const groups = { 'content/docs': [], 'content/notes': [], '(root)': [] }
  for (const f of state.files) {
    if (filter && !f.path.toLowerCase().includes(filter)) continue
    if (f.path.startsWith('content/docs/')) groups['content/docs'].push(f)
    else if (f.path.startsWith('content/notes/')) groups['content/notes'].push(f)
    else groups['(root)'].push(f)
  }
  const labels = { 'content/docs': ['docs', 'synced from repo'], 'content/notes': ['notes', 'yours'], '(root)': null }
  const el = $('#tree')
  el.innerHTML = ''
  for (const [g, files] of Object.entries(groups)) {
    if (files.length === 0 && g !== 'content/notes') continue
    if (labels[g]) {
      const h = document.createElement('div')
      h.className = 'group'
      h.innerHTML = `${icon('folder', 13)} ${labels[g][0]} <span class="tagline">· ${labels[g][1]}</span>`
      el.appendChild(h)
    }
    for (const f of files) {
      const row = document.createElement('div')
      row.className = 'file' + (state.current && state.current.path === f.path ? ' active' : '')
      const name = f.path.slice(f.path.startsWith(g + '/') ? g.length + 1 : (g === '(root)' ? 0 : f.path.lastIndexOf('/') + 1))
      row.innerHTML = `${/\.md$/i.test(f.path) ? icon('file-text', 15) : icon('file-code', 15)}<span class="nm" title="${esc(f.path)}">${esc(name || f.path)}</span>`
      row.onclick = () => openFile(f.path)
      el.appendChild(row)
    }
  }
}

async function openFile(path) {
  try {
    state.current = await api('/api/file?path=' + encodeURIComponent(path))
    state.editing = false
    renderViewer()
    renderTree()
  } catch (e) { toast(e.message) }
}

function renderViewer() {
  const f = state.current
  $('#editor').hidden = true
  $('#viewer').hidden = false
  if (!f) return
  $('#meta').hidden = false
  $('#meta-path').textContent = f.path
  $('#meta-synced').hidden = !f.synced
  const isMd = /\.md$/i.test(f.path)
  $('#viewer').innerHTML = `<div class="paper ${isMd ? 'md' : 'plain'}">${isMd ? renderMd(f.content) : `<pre><code>${esc(f.content)}</code></pre>`}</div>`
}

function startEdit() {
  if (!state.current) return
  state.editing = true
  $('#viewer').hidden = true
  $('#meta').hidden = true
  $('#editor').hidden = false
  $('#edit-path').textContent = state.current.path
  $('#edit-area').value = state.current.content
  $('#edit-area').focus()
}

async function saveEdit() {
  try {
    await api('/api/file', { method: 'PUT', body: { path: state.current.path, content: $('#edit-area').value } })
    state.current.content = $('#edit-area').value
    state.editing = false
    renderViewer()
    toast('Saved')
    loadTree()
  } catch (e) { toast(e.message) }
}

async function deleteCurrent() {
  if (!state.current) return
  if (!confirm(`Delete ${state.current.path}?`)) return
  try {
    await api('/api/file?path=' + encodeURIComponent(state.current.path), { method: 'DELETE' })
    state.current = null
    $('#meta').hidden = true
    $('#viewer').innerHTML = `<div class="kb-empty"><div class="empty-state"><div class="glyph">${icon('inbox', 26)}</div><h3>File deleted</h3></div></div>`
    toast('Deleted')
    loadTree()
  } catch (e) { toast(e.message) }
}

async function newNote() {
  const name = prompt('New note filename (under content/notes/):', 'my-note.md')
  if (!name) return
  const path = 'content/notes/' + name.replace(/^\/+/, '')
  try {
    await api('/api/file', { method: 'POST', body: { path, content: `---\ntitle: ${name.replace(/\.md$/, '')}\nupdated: ${new Date().toISOString().slice(0, 10)}\n---\n\n# ${name.replace(/\.md$/, '')}\n\n` } })
    await loadTree()
    openFile(path)
    startEdit()
  } catch (e) { toast(e.message) }
}

async function syncDocs() {
  $('#sync-btn').disabled = true
  try {
    const r = await api('/api/sync', { method: 'POST' })
    toast(`Synced ${r.synced.length} doc file(s) from repo`)
    await loadTree()
    if (state.current && state.current.synced) openFile(state.current.path)
  } catch (e) { toast(e.message) }
  $('#sync-btn').disabled = false
}

// ---- chat drawer ----

function setChat(open) {
  $('#layout').classList.toggle('chat-open', open)
  if (open) $('#chat-input').focus()
}

function addMsg(role, html) {
  const row = document.createElement('div')
  row.className = `msg-row ${role}`
  row.innerHTML = `<div class="bubble ${role === 'system' ? '' : 'md'}">${html}</div>`
  $('#chat-msgs').appendChild(row)
  scrollChat()
  return row.querySelector('.bubble')
}

function addActivity(cls, html) {
  const el = document.createElement('div')
  el.className = `activity ${cls}`
  el.innerHTML = html
  $('#chat-msgs').appendChild(el)
  scrollChat()
  return el
}

const scrollChat = () => { const m = $('#chat-msgs'); m.scrollTop = m.scrollHeight }

function toolLabel(name, args) {
  let target = ''
  try {
    const a = JSON.parse(args || '{}')
    target = a.file_path ?? a.path ?? a.pattern ?? (a.command ? String(a.command).slice(0, 60) : '')
  } catch { /* keep empty */ }
  const icons = { read: 'file-text', grep: 'search', glob: 'folder', write: 'pencil', edit: 'pencil', pwsh: 'activity', bash: 'activity' }
  const verbs = { read: 'Reading', grep: 'Searching', glob: 'Browsing', write: 'Writing', edit: 'Editing', pwsh: 'Running', bash: 'Running' }
  const verb = verbs[name] ?? name
  return `${icon(icons[name] ?? 'activity', 14)} <span>${esc(verb)}${target ? ` <code>${esc(String(target))}</code>` : ''}…</span>`
}

function startStreamBubble() {
  state.streamText = ''
  state.streamReasoning = ''
  state.streamBubble = null
  state.thinkEl = null
}

function ensureStreamBubble() {
  if (!state.streamBubble) {
    const row = addMsg('agent', '<span class="typing"><i></i><i></i><i></i></span>')
    state.streamBubble = row
  }
  return state.streamBubble
}

function scheduleRender() {
  if (state.rafPending) return
  state.rafPending = true
  requestAnimationFrame(() => {
    state.rafPending = false
    if (state.streamBubble && state.streamText) state.streamBubble.innerHTML = renderMd(state.streamText)
    if (state.thinkEl && state.streamReasoning) state.thinkEl.textContent = state.streamReasoning
    scrollChat()
  })
}

function onReasoning(text) {
  if (!state.thinkEl) {
    const d = document.createElement('details')
    d.className = 'thinking'
    d.innerHTML = '<summary>thinking…</summary><div class="think-body"></div>'
    $('#chat-msgs').appendChild(d)
    state.thinkEl = d.querySelector('.think-body')
    scrollChat()
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
    <div class="q-head">${icon('sparkles', 14)} The steward is asking${questions.length > 1 ? ` · ${questions.length} questions, answering the first` : ''}</div>
    ${q.header ? `<div class="q-sub">${esc(q.header)}</div>` : ''}
    <div class="q-text">${esc(q.question ?? '')}</div>
    <div class="q-opts"></div>
    <div class="q-free"><input placeholder="Or type a custom answer…"><button class="btn sm primary">Send</button></div>
    <div class="q-foot"><button class="q-cancel">cancel this question</button></div>`
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
    submit.textContent = 'Submit selection'
    submit.style.marginLeft = '6px'
    submit.onclick = () => answer([{ id: q.id, selected: [...picked] }])
    opts.appendChild(submit)
  }
  const freeInput = card.querySelector('.q-free input')
  card.querySelector('.q-free button').onclick = () => {
    const v = freeInput.value.trim()
    if (v) answer([{ id: q.id, selected: [], custom: v }])
  }
  freeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = freeInput.value.trim(); if (v) answer([{ id: q.id, selected: [], custom: v }]) } })
  card.querySelector('.q-cancel').onclick = async () => {
    try { await api('/api/respond', { method: 'POST', body: { sid, rpcId, decline: true } }) } catch (e) { toast(e.message) }
    card.classList.add('resolved')
  }
  async function answer(answers) {
    try {
      const r = await api('/api/respond', { method: 'POST', body: { sid, rpcId, answers } })
      if (!r.accepted) toast(`answer not accepted (${r.reason ?? '?'}) — someone may have replied first`)
      card.classList.add('resolved')
    } catch (e) { toast(e.message) }
  }
  $('#chat-msgs').appendChild(card)
  scrollChat()
}

function openStream(sid) {
  if (state.es) { state.es.close(); state.es = null }
  const es = new EventSource(BASE + '/api/stream?sid=' + encodeURIComponent(sid))
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
    scrollChat()
  })
  es.addEventListener('tool_call', (e) => { const d = JSON.parse(e.data); addActivity('', toolLabel(d.name, d.args)) })
  es.addEventListener('tool_result', (e) => { const d = JSON.parse(e.data); if (d.isError) addActivity('err', `${icon('alert', 14)} <span>tool error: <code>${esc((d.text || '').slice(0, 120))}</code></span>`) })
  es.addEventListener('approval', (e) => {
    const d = JSON.parse(e.data)
    addActivity('shield', `${icon('shield-check', 14)} <span>auto-approved <code>${esc(d.toolName)}</code>${d.reason ? ` — ${esc(String(d.reason).slice(0, 90))}` : ''}</span>`)
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
    if (d.reason !== 'completed') addMsg('system', esc(`turn ended: ${d.reason}`))
    // the steward may have changed files — refresh the tree and the open file
    loadTree()
    if (state.current && !state.editing) openFile(state.current.path)
  })
  es.addEventListener('error', (e) => {
    try { const d = JSON.parse(e.data); addMsg('system', esc(d.message ?? 'stream error')) } catch { /* transport hiccup: EventSource auto-retries */ }
  })
}

async function sendChat() {
  const input = $('#chat-input')
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  input.style.height = 'auto'
  addMsg('user', esc(text))
  $('#chat-send').disabled = true
  try {
    const r = await api('/api/chat', { method: 'POST', body: { sid: state.sid || undefined, text } })
    if (r.sid !== state.sid) {
      state.sid = r.sid
      localStorage.setItem('kbdemo.sid', r.sid)
      openStream(r.sid)
    } else if (!state.es) openStream(r.sid)
    startStreamBubble()
    addActivity('', '<span class="typing" style="padding:2px 0"><i></i><i></i><i></i></span> <span>working…</span>')
  } catch (e) {
    addMsg('system', esc(e.message))
  }
  $('#chat-send').disabled = false
}

async function loadTranscript() {
  if (!state.sid) return
  try {
    const r = await api('/api/history?sid=' + encodeURIComponent(state.sid))
    for (const m of r.messages) {
      if (m.role === 'user') addMsg('user', esc(m.text))
      else if (m.role === 'assistant') addMsg('agent', renderMd(m.text))
      else addMsg('system', esc(m.text))
    }
    openStream(state.sid) // reattach (BFF revalidates; replay buffer covers an in-flight turn)
  } catch {
    localStorage.removeItem('kbdemo.sid')
    state.sid = ''
  }
}

// ---- wiring ----

$('#chat-toggle').onclick = () => setChat(!$('#layout').classList.contains('chat-open'))
$('#chat-close').onclick = () => setChat(false)
$('#sync-btn').onclick = syncDocs
$('#new-note').onclick = newNote
$('#edit-btn').onclick = startEdit
$('#delete-btn').onclick = deleteCurrent
$('#save-btn').onclick = saveEdit
$('#cancel-edit').onclick = () => { state.editing = false; renderViewer() }
$('#search').oninput = renderTree
$('#chat-send').onclick = sendChat
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat() }
})
$('#chat-input').addEventListener('input', function () {
  this.style.height = 'auto'
  this.style.height = Math.min(this.scrollHeight, 160) + 'px'
})

hydrateIcons()
loadTree().catch((e) => toast(`tree load failed: ${e.message}`))
loadTranscript()
