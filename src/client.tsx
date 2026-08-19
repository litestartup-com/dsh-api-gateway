/**
 * dsh-api-gateway — Client half (Web).
 *
 * Registers one card in Settings → Plugins → Configurable (`settings.plugin.item`).
 * Since DSH 0.1.0-rc.7 that slot is KEYED on the settings namespace a card
 * edits, so this plugin:
 *   - registers a live settings namespace `api-gateway` on the Host (see
 *     src/index.ts), and
 *   - registers its card here under that same key, reading and writing the
 *     gateway Config through the client `settingsScope` (the typert @Remote
 *     settings surface) instead of its own ad-hoc HTTP admin calls.
 *
 * Runtime-only state (live session count, whether a provisioned API key exists)
 * still comes from the gateway's own `GET /health`; key rotation still goes
 * through `POST /admin/rotate-key` because that provisions an in-memory key
 * that is not part of the settings document.
 */
import React from 'react'

const NS = 'api-gateway'
const DEFAULT_PREFIX = '/api-gw/v1'

interface GatewayConfig {
  prefix?: string
  enabled?: boolean
  maxSessions?: number
  workspaceMode?: 'auto' | 'ungrouped'
  defaultWorkspacePath?: string
  allowDiscover?: boolean
  allowAdopt?: boolean
  corsOrigin?: string | string[]
  exposeErrors?: boolean
  sseHeartbeatMs?: number
  bodyTimeoutMs?: number
  adminKey?: string
}

interface RuntimeState {
  enabled?: boolean
  sessions?: number
  apiKeySet?: boolean
}

const style: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex', flexDirection: 'column', gap: '10px',
    padding: '14px', maxWidth: '680px',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)',
    fontSize: '13px', lineHeight: '20px',
  },
  row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const },
  field: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const },
  label: { minWidth: '150px' },
  hint: { flexBasis: '100%', fontSize: '11px', opacity: 0.55, marginTop: '-2px' },
  dot: { width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0 },
  muted: { fontSize: '12px', opacity: 0.65 },
  mono: { fontFamily: 'monospace', fontSize: '12px', opacity: 0.8, wordBreak: 'break-all' as const },
  button: {
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', cursor: 'pointer',
    borderRadius: '6px', padding: '4px 10px',
  },
  input: {
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', borderRadius: '6px',
    padding: '4px 8px', width: '220px',
  },
  toggle: { width: '16px', height: '16px', accentColor: '#16a34a' },
}

type FieldKind = 'toggle' | 'number' | 'text' | 'select' | 'secret'

interface Field {
  key: string
  label: string
  hint: string
  kind: FieldKind
  options?: { value: string; label: string }[]
  placeholder?: string
}

const FIELDS: Field[] = [
  { key: 'enabled', label: '启用网关', hint: '总开关（关闭后仅 /health 可达）', kind: 'toggle' },
  { key: 'prefix', label: '路由前缀', hint: 'REST + SSE 的 URL 前缀（改动后立即重挂路由）', kind: 'text', placeholder: '/api-gw/v1' },
  { key: 'maxSessions', label: '并发会话上限', hint: '网关持有的最大在线会话数', kind: 'number', placeholder: '20' },
  { key: 'workspaceMode', label: '工作区模式', hint: 'auto=自动挂入工作区；ungrouped=不分组', kind: 'select', options: [{ value: 'auto', label: 'auto' }, { value: 'ungrouped', label: 'ungrouped' }] },
  { key: 'defaultWorkspacePath', label: '默认工作区路径', hint: 'auto 模式下未给 cwd 时的归属目录', kind: 'text' },
  { key: 'allowDiscover', label: '允许发现会话', hint: 'GET /sessions/discover', kind: 'toggle' },
  { key: 'allowAdopt', label: '允许接管会话', hint: 'POST /sessions/:id/adopt', kind: 'toggle' },
  { key: 'exposeErrors', label: '暴露错误详情', hint: '错误响应是否带内部信息', kind: 'toggle' },
  { key: 'corsOrigin', label: 'CORS 来源', hint: "'*' 或具体域名", kind: 'text', placeholder: '*' },
  { key: 'sseHeartbeatMs', label: 'SSE 心跳 (ms)', hint: '0 表示关闭', kind: 'number', placeholder: '30000' },
  { key: 'bodyTimeoutMs', label: '请求体超时 (ms)', hint: '读取请求体超时', kind: 'number', placeholder: '30000' },
  { key: 'adminKey', label: '管理密钥', hint: '只写不回显；留空表示不修改', kind: 'secret' },
]

const errText = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? error)

function GatewayCard(props: { subscribe: (cb: () => void) => () => void; getSnapshot: () => any; scope: any }) {
  const { subscribe, getSnapshot, scope } = props
  const snap = React.useSyncExternalStore(subscribe, getSnapshot)
  const value = (snap?.value ?? {}) as GatewayConfig
  const ready = snap?.status === 'ready'
  const writable = snap?.writable !== false
  const prefix = (value.prefix && String(value.prefix) !== '') ? String(value.prefix) : DEFAULT_PREFIX

  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [runtime, setRuntime] = React.useState<RuntimeState | null>(null)
  const [freshKey, setFreshKey] = React.useState<string | null>(null)
  const [rotating, setRotating] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    const refresh = () => {
      fetch(prefix + '/health')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((s: any) => { if (alive) setRuntime({ enabled: s.enabled === true, sessions: s.sessions ?? 0, apiKeySet: s.apiKeySet === true }) })
        .catch(() => { /* gateway not mounted yet — keep last state */ })
    }
    refresh()
    const handle = setInterval(refresh, 3000)
    return () => { alive = false; clearInterval(handle) }
  }, [prefix])

  const draft = (key: string) => drafts[key] ?? ''
  const setDraft = (key: string, text: string) => setDrafts((prev) => ({ ...prev, [key]: text }))
  const dropDraft = (key: string) => setDrafts((prev) => { const next = { ...prev }; delete next[key]; return next })

  const formatValue = (field: Field): string => {
    const v = (value as any)[field.key]
    if (v === undefined || v === null) return ''
    if (Array.isArray(v)) return v.join(', ')
    return String(v)
  }

  const toggle = (key: string, on: boolean) => {
    setError('')
    scope.set(key, on).catch((e: unknown) => setError(errText(e)))
  }

  const select = (key: string, next: string) => {
    setError('')
    scope.set(key, next).catch((e: unknown) => setError(errText(e)))
  }

  const saveScalar = async (field: Field) => {
    const key = field.key
    const text = draft(key).trim()
    try {
      if (text === '') { await scope.unset(key); dropDraft(key); return }
      if (field.kind === 'number') {
        const n = Number(text)
        if (!Number.isFinite(n)) { setError(`「${field.label}」需要数字`); return }
        await scope.set(key, n)
      } else {
        await scope.set(key, text)
      }
      dropDraft(key)
    } catch (e) {
      setError(errText(e))
    }
  }

  const saveAll = async () => {
    setSaving(true)
    setError('')
    try {
      for (const field of FIELDS) {
        if (field.kind === 'text' || field.kind === 'number') await saveScalar(field)
        else if (field.kind === 'secret') {
          const text = draft(field.key).trim()
          if (text !== '') {
            try { await scope.set(field.key, text) } catch (e) { setError(errText(e)) }
          }
          dropDraft(field.key)
        }
      }
    } finally {
      setSaving(false)
    }
  }

  const rotate = async () => {
    setRotating(true)
    setError('')
    setFreshKey(null)
    try {
      const r = await fetch(prefix + '/admin/rotate-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': draft('adminKey') },
        body: '{}',
      })
      const data = await r.json()
      if (!r.ok) { setError(String(data?.error ?? r.status)); return }
      setFreshKey(data?.apiKey ?? null)
    } catch {
      setError('轮换请求失败')
    } finally {
      setRotating(false)
    }
  }

  const on = value.enabled === true
  const statusDot = ready ? (on ? '#16a34a' : 'var(--dsw-alias-state-error-primary)') : '#a1a1aa'
  const statusText = !ready ? '加载中…' : on ? '已启用' : '已停用'

  return React.createElement('div', { style: style.card },
    React.createElement('div', { style: style.row },
      React.createElement('strong', null, 'API Gateway'),
      React.createElement('span', { style: { ...style.dot, background: statusDot } }),
      React.createElement('span', null, statusText),
      React.createElement('span', { style: style.muted }, `会话数 ${runtime?.sessions ?? 0}`),
      runtime?.apiKeySet === true
        ? React.createElement('span', { style: style.muted }, '· API 密钥已发放')
        : React.createElement('span', { style: style.muted }, '· 尚未发放 API 密钥'),
    ),
    React.createElement('div', { style: style.mono }, `入口 ${prefix} · 流式 GET /sessions/:id/stream (SSE)`),
    !writable ? React.createElement('div', { style: { ...style.muted, color: 'var(--dsw-alias-state-error-primary)' } }, '设置文档只读，无法保存更改') : null,

    ...FIELDS.filter((f) => f.kind === 'toggle').map((f) => {
      const checked = (value as any)[f.key] === true
      return React.createElement('div', { key: f.key, style: style.field },
        React.createElement('input', {
          type: 'checkbox', style: style.toggle, checked, disabled: !ready || !writable,
          onChange: (ev) => toggle(f.key, (ev.target as HTMLInputElement).checked),
        }),
        React.createElement('span', { style: style.label }, f.label),
        React.createElement('span', { style: style.hint }, f.hint),
      )
    }),

    ...FIELDS.filter((f) => f.kind === 'select').map((f) =>
      React.createElement('div', { key: f.key, style: style.field },
        React.createElement('span', { style: style.label }, f.label),
        React.createElement('select', {
          style: style.input, disabled: !ready || !writable,
          value: String((value as any)[f.key] ?? 'auto'),
          onChange: (ev) => select(f.key, (ev.target as HTMLSelectElement).value),
        }, ...(f.options ?? []).map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label))),
        React.createElement('span', { style: style.hint }, f.hint),
      ),
    ),

    ...FIELDS.filter((f) => f.kind === 'text' || f.kind === 'number').map((f) =>
      React.createElement('div', { key: f.key, style: style.field },
        React.createElement('span', { style: style.label }, f.label),
        React.createElement('input', {
          type: 'text', style: style.input,
          inputMode: f.kind === 'number' ? 'numeric' : undefined,
          placeholder: f.placeholder ?? '',
          disabled: !ready || !writable,
          value: drafts[f.key] !== undefined ? drafts[f.key] : formatValue(f),
          onChange: (ev) => setDraft(f.key, (ev.target as HTMLInputElement).value),
        }),
        React.createElement('span', { style: style.hint }, f.hint),
      ),
    ),

    React.createElement('div', { style: style.field },
      React.createElement('span', { style: style.label }, '管理密钥'),
      React.createElement('input', {
        type: 'password', style: style.input, placeholder: '留空不修改',
        disabled: !ready || !writable,
        value: draft('adminKey'),
        onChange: (ev) => setDraft('adminKey', (ev.target as HTMLInputElement).value),
      }),
      React.createElement('span', { style: style.hint }, '只写不回显；用于 /admin/* 与轮换'),
    ),

    React.createElement('div', { style: style.row },
      React.createElement('button', { type: 'button', style: style.button, disabled: saving || !ready || !writable, onClick: () => void saveAll() }, saving ? '保存中…' : '保存配置'),
      React.createElement('button', { type: 'button', style: style.button, disabled: rotating, onClick: () => void rotate() }, rotating ? '轮换中…' : '轮换 API 密钥'),
    ),
    freshKey !== null ? React.createElement('div', { style: style.mono }, '新 API 密钥: ', freshKey) : null,
    error !== '' ? React.createElement('div', { style: { ...style.muted, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
  )
}

export const inject = ['slots', 'connection', 'remote', 'settingsScope']

export function apply(ctx: any) {
  const scope = ctx.settingsScope.bind({ namespace: NS })
  const subscribe = (cb: () => void) => scope.subscribe(cb)
  const getSnapshot = () => scope.getSnapshot()
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    { name: 'settings.plugin.item', key: NS },
    () => React.createElement(GatewayCard, { subscribe, getSnapshot, scope }),
  ))
}
