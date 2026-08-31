/**
 * dsh-api-gateway — UI strings for the settings card.
 *
 * The host half is English-only on purpose (error codes, hints and logs are a
 * machine-readable contract), but the settings card is the one surface a human
 * reads inside the GUI, and DSH exposes no locale service a plugin could ask.
 * So the card carries its own dictionary and picks a language from the document
 * and the browser, defaulting to English because that is what the README, the
 * API and the CLI examples speak.
 *
 * `Record<Locale, Dict>` is the enforcement mechanism: adding a string to one
 * language and forgetting the other is a compile error, not a runtime blank.
 *
 * Client-only module. It is inlined into lib/client.js by scripts/wrap-client.mjs
 * (the browser factory has no module resolver), so it must stay import-free.
 */

export type Locale = 'en' | 'zh'

/** Config keys the card renders a row for. */
export type FieldKey =
  | 'enabled'
  | 'prefix'
  | 'maxSessions'
  | 'workspaceMode'
  | 'defaultWorkspacePath'
  | 'allowDiscover'
  | 'allowAdopt'
  | 'exposeErrors'
  | 'questionMode'
  | 'corsOrigin'
  | 'sseHeartbeatMs'
  | 'bodyTimeoutMs'
  | 'adminKey'

export interface FieldText {
  label: string
  hint: string
}

export interface Dict {
  cardDescription: string
  expand: string
  collapse: string
  unsaved: string
  loading: string
  statusEnabled: string
  statusDisabled: string
  sessionCount: (count: number) => string
  keyProvisioned: string
  keyMissing: string
  entry: (prefix: string) => string
  readOnly: string
  adminKeyPlaceholder: string
  freshKey: string
  rotate: string
  rotating: string
  rotateFailed: string
  discard: string
  save: string
  saving: string
  numberRequired: (label: string) => string
  fields: Record<FieldKey, FieldText>
}

export const STRINGS: Record<Locale, Dict> = {
  en: {
    cardDescription: 'REST + SSE gateway: third-party clients create sessions, stream events, adopt GUI sessions',
    expand: 'Expand',
    collapse: 'Collapse',
    unsaved: 'unsaved',
    loading: 'Loading…',
    statusEnabled: 'Enabled',
    statusDisabled: 'Disabled',
    sessionCount: (count) => `${count} session${count === 1 ? '' : 's'}`,
    keyProvisioned: '· API key provisioned',
    keyMissing: '· no API key yet',
    entry: (prefix) => `at ${prefix} · stream GET /sessions/:id/stream (SSE)`,
    readOnly: 'The settings document is read-only; changes cannot be saved',
    adminKeyPlaceholder: 'leave empty to keep',
    freshKey: 'New API key: ',
    rotate: 'Rotate API key',
    rotating: 'Rotating…',
    rotateFailed: 'Rotation request failed',
    discard: 'Discard',
    save: 'Save',
    saving: 'Saving…',
    numberRequired: (label) => `“${label}” expects a number`,
    fields: {
      enabled: { label: 'Enable gateway', hint: 'Master switch (only /health stays reachable when off)' },
      prefix: { label: 'Route prefix', hint: 'URL prefix for REST + SSE (routes remount immediately)' },
      maxSessions: { label: 'Max live sessions', hint: 'Cap on sessions this gateway holds' },
      workspaceMode: { label: 'Workspace mode', hint: 'auto = join a workspace; ungrouped = stay outside' },
      defaultWorkspacePath: { label: 'Default workspace path', hint: 'Directory used in auto mode when no cwd is given' },
      allowDiscover: { label: 'Allow session discovery', hint: 'GET /sessions/discover' },
      allowAdopt: { label: 'Allow session adoption', hint: 'POST /sessions/:id/adopt' },
      exposeErrors: { label: 'Expose error details', hint: 'Whether responses carry internal messages' },
      questionMode: { label: 'Interactive questions', hint: 'conversation: ask in the reply; host: leave the card to the GUI' },
      corsOrigin: { label: 'CORS origin', hint: "'*' or an explicit origin" },
      sseHeartbeatMs: { label: 'SSE heartbeat (ms)', hint: '0 disables' },
      bodyTimeoutMs: { label: 'Body timeout (ms)', hint: 'Request body read timeout' },
      adminKey: { label: 'Admin key', hint: 'Write-only; used by /admin/* and key rotation' },
    },
  },
  zh: {
    cardDescription: 'REST + SSE 网关：第三方客户端创建会话、流式收包、接管 GUI 会话',
    expand: '展开',
    collapse: '折叠',
    unsaved: '未保存',
    loading: '加载中…',
    statusEnabled: '已启用',
    statusDisabled: '已停用',
    sessionCount: (count) => `会话数 ${count}`,
    keyProvisioned: '· API 密钥已发放',
    keyMissing: '· 尚未发放 API 密钥',
    entry: (prefix) => `入口 ${prefix} · 流式 GET /sessions/:id/stream (SSE)`,
    readOnly: '设置文档只读，无法保存更改',
    adminKeyPlaceholder: '留空不修改',
    freshKey: '新 API 密钥: ',
    rotate: '轮换 API 密钥',
    rotating: '轮换中…',
    rotateFailed: '轮换请求失败',
    discard: '放弃更改',
    save: '保存',
    saving: '保存中…',
    numberRequired: (label) => `「${label}」需要数字`,
    fields: {
      enabled: { label: '启用网关', hint: '总开关（关闭后仅 /health 可达）' },
      prefix: { label: '路由前缀', hint: 'REST + SSE 的 URL 前缀（改动后立即重挂路由）' },
      maxSessions: { label: '并发会话上限', hint: '网关持有的最大在线会话数' },
      workspaceMode: { label: '工作区模式', hint: 'auto=自动挂入工作区；ungrouped=不分组' },
      defaultWorkspacePath: { label: '默认工作区路径', hint: 'auto 模式下未给 cwd 时的归属目录' },
      allowDiscover: { label: '允许发现会话', hint: 'GET /sessions/discover' },
      allowAdopt: { label: '允许接管会话', hint: 'POST /sessions/:id/adopt' },
      exposeErrors: { label: '暴露错误详情', hint: '错误响应是否带内部信息' },
      questionMode: { label: '互动提问', hint: 'conversation：写进回复里问；host：卡片交给 GUI' },
      corsOrigin: { label: 'CORS 来源', hint: "'*' 或具体域名" },
      sseHeartbeatMs: { label: 'SSE 心跳 (ms)', hint: '0 表示关闭' },
      bodyTimeoutMs: { label: '请求体超时 (ms)', hint: '读取请求体超时' },
      adminKey: { label: '管理密钥', hint: '只写不回显；用于 /admin/* 与轮换' },
    },
  },
}

/**
 * First candidate that names a supported language wins; anything else (including
 * an empty list) falls back to English. Matching is prefix-based so `zh`,
 * `zh-CN`, `zh-Hant` and `ZH_TW` all land on Chinese.
 */
export const resolveLocale = (candidates: readonly (string | null | undefined)[]): Locale => {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const tag = candidate.trim().toLowerCase().replace(/_/g, '-')
    if (tag === 'zh' || tag.startsWith('zh-')) return 'zh'
    if (tag === 'en' || tag.startsWith('en-')) return 'en'
  }
  return 'en'
}

/** Dictionary for the first understood candidate language. */
export const dictFor = (candidates: readonly (string | null | undefined)[]): Dict => STRINGS[resolveLocale(candidates)]

/**
 * Language preference of the surrounding page: what the app declares on <html>
 * first, then what the browser asks for. Guarded for non-browser contexts so the
 * module stays importable from tests.
 */
export const documentLanguages = (): (string | null | undefined)[] => {
  const out: (string | null | undefined)[] = []
  if (typeof document !== 'undefined') out.push(document.documentElement?.lang)
  if (typeof navigator !== 'undefined') {
    const nav = navigator as Navigator & { languages?: readonly string[] }
    if (Array.isArray(nav.languages)) out.push(...nav.languages)
    out.push(nav.language)
  }
  return out
}
