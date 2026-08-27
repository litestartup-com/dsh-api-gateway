/**
 * dsh-api-gateway — Client half (Web).
 *
 * Registers one card in Settings → Plugins → Configurable (`settings.plugin.item`).
 * That slot is KEYED on the settings namespace a card edits, so this plugin:
 *   - registers a live settings namespace `dsh-api-gw` on the Host (see
 *     src/index.ts), and
 *   - registers its card here under that same key, reading and writing the
 *     gateway Config through the client `settingsScope` (the typert @Remote
 *     settings surface) instead of its own ad-hoc HTTP admin calls.
 *
 * The namespace is `dsh-api-gw`, not `api-gateway`: DSH itself ships a built-in
 * `@deepseek-ai/dsh-api-gateway` plugin (the typert Remote dispatcher), and two
 * entries reading `api-gateway` in the plugin list are indistinguishable.
 *
 * The card is collapsed by default and discloses in place, matching the
 * built-in plugin cards: which card a reader has open is card-local state the
 * Host has no stake in. Staged edits outlive collapsing, so the header marks a
 * card holding unsaved edits.
 *
 * Runtime-only state (live session count, whether a provisioned API key exists)
 * still comes from the gateway's own `GET /health`; key rotation still goes
 * through `POST /admin/rotate-key` because that provisions an in-memory key
 * that is not part of the settings document.
 */
import React from 'react'

const NS = 'dsh-api-gw'
const CARD_TITLE = 'dsh-api-gw'
const CARD_DESCRIPTION = 'REST + SSE 网关：第三方客户端创建会话、流式收包、接管 GUI 会话'
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

/**
 * Card chrome, mirroring the built-in plugin cards' geometry and design tokens.
 * Injected once as a plugin-owned <style> tag: the card lives inside the host's
 * card list, so it has to read as one of them rather than as a bolted-on panel.
 */
const CSS_TAG = 'dsh-api-gw/card.css'
const c = {
  card: 'dshApiGw_card',
  cardOpen: 'dshApiGw_cardOpen',
  header: 'dshApiGw_header',
  headText: 'dshApiGw_headText',
  name: 'dshApiGw_name',
  description: 'dshApiGw_description',
  pending: 'dshApiGw_pending',
  chevron: 'dshApiGw_chevron',
  chevronOpen: 'dshApiGw_chevronOpen',
  body: 'dshApiGw_body',
  status: 'dshApiGw_status',
  dot: 'dshApiGw_dot',
  mono: 'dshApiGw_mono',
  field: 'dshApiGw_field',
  label: 'dshApiGw_label',
  hint: 'dshApiGw_hint',
  input: 'dshApiGw_input',
  toggle: 'dshApiGw_toggle',
  muted: 'dshApiGw_muted',
  error: 'dshApiGw_error',
  footer: 'dshApiGw_footer',
  discard: 'dshApiGw_discard',
  save: 'dshApiGw_save',
  ghost: 'dshApiGw_ghost',
}

const CSS = `
.${c.card}{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.${c.card}:hover{border-color:var(--dsw-alias-label-dimmed)}
.${c.cardOpen}{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.${c.header}{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.${c.header}:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.${c.headText}{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.${c.name}{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.${c.description}{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.${c.pending}{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.${c.chevron}{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.${c.chevronOpen}{transform:rotate(180deg)}
.${c.body}{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:4px 0 8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.${c.status}{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 0 4px}
.${c.dot}{width:8px;height:8px;border-radius:50%;flex:none}
.${c.mono}{font-family:monospace;font-size:12px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.${c.field}{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:5px 0}
.${c.label}{min-width:150px;color:var(--dsw-alias-label-secondary)}
.${c.hint}{flex-basis:100%;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.${c.input}{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;padding:4px 8px;width:220px}
.${c.input}:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.${c.toggle}{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}
.${c.muted}{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.${c.error}{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}
.${c.footer}{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex;flex-wrap:wrap}
.${c.discard},.${c.save},.${c.ghost}{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.${c.discard},.${c.ghost}{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.${c.discard}:hover:not(:disabled),.${c.ghost}:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.${c.ghost}{margin-right:auto}
.${c.save}{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.${c.discard}:disabled,.${c.save}:disabled,.${c.ghost}:disabled{opacity:.4;cursor:default}
.${c.discard}:focus-visible,.${c.save}:focus-visible,.${c.ghost}:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`

const ensureStyles = () => {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-api-gateway'
  tag.dataset.pluginCss = CSS_TAG
  tag.textContent = CSS
  document.head.appendChild(tag)
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

  const [open, setOpen] = React.useState(false)
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')
  const [runtime, setRuntime] = React.useState<RuntimeState | null>(null)
  const [freshKey, setFreshKey] = React.useState<string | null>(null)
  const [rotating, setRotating] = React.useState(false)

  // Only poll while the card is disclosed: a collapsed card shows no runtime
  // state, so polling for it would be a request nobody reads.
  React.useEffect(() => {
    if (!open) return
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
  }, [prefix, open])

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

  const discard = () => {
    setDrafts({})
    setError('')
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
  const statusDot = ready ? (on ? '#16a34a' : 'var(--dsw-alias-label-error)') : 'var(--dsw-alias-label-dimmed)'
  const statusText = !ready ? '加载中…' : on ? '已启用' : '已停用'
  const dirty = Object.keys(drafts).length > 0

  const chevron = React.createElement('svg', {
    className: c.chevron + (open ? ' ' + c.chevronOpen : ''),
    width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true,
  }, React.createElement('path', {
    d: 'M3.5 5.5L7 9l3.5-3.5', stroke: 'currentColor', strokeWidth: 1.4,
    strokeLinecap: 'round', strokeLinejoin: 'round',
  }))

  const header = React.createElement('button', {
    type: 'button',
    className: c.header,
    'aria-expanded': open,
    'aria-label': `${open ? '折叠' : '展开'}：${CARD_TITLE}`,
    onClick: () => setOpen(!open),
  },
    React.createElement('span', { className: c.headText },
      React.createElement('span', { className: c.name }, CARD_TITLE),
      React.createElement('span', { className: c.description }, CARD_DESCRIPTION),
    ),
    dirty ? React.createElement('span', { className: c.pending }, '未保存') : null,
    chevron,
  )

  const body = !open ? null : React.createElement('div', { className: c.body },
    React.createElement('div', { className: c.status },
      React.createElement('span', { className: c.dot, style: { background: statusDot } }),
      React.createElement('span', null, statusText),
      React.createElement('span', { className: c.muted }, `会话数 ${runtime?.sessions ?? 0}`),
      React.createElement('span', { className: c.muted }, runtime?.apiKeySet === true ? '· API 密钥已发放' : '· 尚未发放 API 密钥'),
    ),
    React.createElement('div', { className: c.mono }, `入口 ${prefix} · 流式 GET /sessions/:id/stream (SSE)`),
    !writable ? React.createElement('p', { className: c.error, role: 'status' }, '设置文档只读，无法保存更改') : null,

    ...FIELDS.filter((f) => f.kind === 'toggle').map((f) => {
      const checked = (value as any)[f.key] === true
      return React.createElement('div', { key: f.key, className: c.field },
        React.createElement('input', {
          type: 'checkbox', className: c.toggle, checked, disabled: !ready || !writable,
          onChange: (ev: React.ChangeEvent<HTMLInputElement>) => toggle(f.key, ev.target.checked),
        }),
        React.createElement('span', { className: c.label }, f.label),
        React.createElement('span', { className: c.hint }, f.hint),
      )
    }),

    ...FIELDS.filter((f) => f.kind === 'select').map((f) =>
      React.createElement('div', { key: f.key, className: c.field },
        React.createElement('span', { className: c.label }, f.label),
        React.createElement('select', {
          className: c.input, disabled: !ready || !writable,
          value: String((value as any)[f.key] ?? 'auto'),
          onChange: (ev: React.ChangeEvent<HTMLSelectElement>) => select(f.key, ev.target.value),
        }, ...(f.options ?? []).map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label))),
        React.createElement('span', { className: c.hint }, f.hint),
      ),
    ),

    ...FIELDS.filter((f) => f.kind === 'text' || f.kind === 'number').map((f) =>
      React.createElement('div', { key: f.key, className: c.field },
        React.createElement('span', { className: c.label }, f.label),
        React.createElement('input', {
          type: 'text', className: c.input,
          inputMode: f.kind === 'number' ? 'numeric' : undefined,
          placeholder: f.placeholder ?? '',
          disabled: !ready || !writable,
          value: drafts[f.key] !== undefined ? drafts[f.key] : formatValue(f),
          onChange: (ev: React.ChangeEvent<HTMLInputElement>) => setDraft(f.key, ev.target.value),
        }),
        React.createElement('span', { className: c.hint }, f.hint),
      ),
    ),

    React.createElement('div', { className: c.field },
      React.createElement('span', { className: c.label }, '管理密钥'),
      React.createElement('input', {
        type: 'password', className: c.input, placeholder: '留空不修改',
        disabled: !ready || !writable,
        value: draft('adminKey'),
        onChange: (ev: React.ChangeEvent<HTMLInputElement>) => setDraft('adminKey', ev.target.value),
      }),
      React.createElement('span', { className: c.hint }, '只写不回显；用于 /admin/* 与轮换'),
    ),

    freshKey !== null ? React.createElement('div', { className: c.mono }, '新 API 密钥: ', freshKey) : null,
    error !== '' ? React.createElement('p', { className: c.error, role: 'status' }, error) : null,

    React.createElement('div', { className: c.footer },
      React.createElement('button', {
        type: 'button', className: c.ghost, disabled: rotating,
        onClick: () => void rotate(),
      }, rotating ? '轮换中…' : '轮换 API 密钥'),
      React.createElement('button', {
        type: 'button', className: c.discard, disabled: !dirty || saving,
        onClick: discard,
      }, '放弃更改'),
      React.createElement('button', {
        type: 'button', className: c.save, disabled: saving || !dirty || !ready || !writable,
        onClick: () => void saveAll(),
      }, saving ? '保存中…' : '保存'),
    ),
  )

  return React.createElement('li', {
    className: c.card + (open ? ' ' + c.cardOpen : ''),
  }, header, body)
}

export const inject = ['slots', 'connection', 'remote', 'settingsScope']

export function apply(ctx: any) {
  ensureStyles()
  const scope = ctx.settingsScope.bind({ namespace: NS })
  const subscribe = (cb: () => void) => scope.subscribe(cb)
  const getSnapshot = () => scope.getSnapshot()
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
    { name: 'settings.plugin.item', key: NS },
    () => React.createElement(GatewayCard, { subscribe, getSnapshot, scope }),
  ))
}
