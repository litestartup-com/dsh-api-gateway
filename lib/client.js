window.__ModuleLoader__.load({
  id: "dsh-api-gateway",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
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
 * Runtime-only state (live session count, whether any API key is set) still comes
 * from the gateway's own `GET /health`; key rotation still goes through
 * `POST /admin/rotate-key` rather than the settings document, because minting a
 * secret is an action with one-shot output -- the new key is shown once and the
 * stored field stays redacted, so it is not an editable form row.
 */
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
const STRINGS = {
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
            corsOrigin: { label: 'CORS 来源', hint: "'*' 或具体域名" },
            sseHeartbeatMs: { label: 'SSE 心跳 (ms)', hint: '0 表示关闭' },
            bodyTimeoutMs: { label: '请求体超时 (ms)', hint: '读取请求体超时' },
            adminKey: { label: '管理密钥', hint: '只写不回显；用于 /admin/* 与轮换' },
        },
    },
};
/**
 * First candidate that names a supported language wins; anything else (including
 * an empty list) falls back to English. Matching is prefix-based so `zh`,
 * `zh-CN`, `zh-Hant` and `ZH_TW` all land on Chinese.
 */
const resolveLocale = (candidates) => {
    for (const candidate of candidates) {
        if (typeof candidate !== 'string' || candidate === '')
            continue;
        const tag = candidate.trim().toLowerCase().replace(/_/g, '-');
        if (tag === 'zh' || tag.startsWith('zh-'))
            return 'zh';
        if (tag === 'en' || tag.startsWith('en-'))
            return 'en';
    }
    return 'en';
};
/** Dictionary for the first understood candidate language. */
const dictFor = (candidates) => STRINGS[resolveLocale(candidates)];
/**
 * Language preference of the surrounding page: what the app declares on <html>
 * first, then what the browser asks for. Guarded for non-browser contexts so the
 * module stays importable from tests.
 */
const documentLanguages = () => {
    const out = [];
    if (typeof document !== 'undefined')
        out.push(document.documentElement?.lang);
    if (typeof navigator !== 'undefined') {
        const nav = navigator;
        if (Array.isArray(nav.languages))
            out.push(...nav.languages);
        out.push(nav.language);
    }
    return out;
};
const NS = 'dsh-api-gw';
const CARD_TITLE = 'dsh-api-gw';
const DEFAULT_PREFIX = '/api-gw/v1';
/**
 * Card chrome, mirroring the built-in plugin cards' geometry and design tokens.
 * Injected once as a plugin-owned <style> tag: the card lives inside the host's
 * card list, so it has to read as one of them rather than as a bolted-on panel.
 */
const CSS_TAG = 'dsh-api-gw/card.css';
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
};
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
`;
const ensureStyles = () => {
    if (typeof document === 'undefined')
        return;
    if (document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) !== null)
        return;
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-api-gateway';
    tag.dataset.pluginCss = CSS_TAG;
    tag.textContent = CSS;
    document.head.appendChild(tag);
};
// Shape only; the label and hint of each row come from the dictionary so the
// card speaks the language of the surrounding app.
const FIELDS = [
    { key: 'enabled', kind: 'toggle' },
    { key: 'prefix', kind: 'text', placeholder: '/api-gw/v1' },
    { key: 'maxSessions', kind: 'number', placeholder: '20' },
    { key: 'workspaceMode', kind: 'select', options: [{ value: 'auto', label: 'auto' }, { value: 'ungrouped', label: 'ungrouped' }] },
    { key: 'defaultWorkspacePath', kind: 'text' },
    { key: 'allowDiscover', kind: 'toggle' },
    { key: 'allowAdopt', kind: 'toggle' },
    { key: 'exposeErrors', kind: 'toggle' },
    { key: 'corsOrigin', kind: 'text', placeholder: '*' },
    { key: 'sseHeartbeatMs', kind: 'number', placeholder: '30000' },
    { key: 'bodyTimeoutMs', kind: 'number', placeholder: '30000' },
    { key: 'adminKey', kind: 'secret' },
];
const errText = (error) => String(error?.message ?? error);
function GatewayCard(props) {
    const { subscribe, getSnapshot, scope } = props;
    const snap = React.useSyncExternalStore(subscribe, getSnapshot);
    // Resolved once per mount: the page language does not change under the card.
    const d = React.useMemo(() => dictFor(documentLanguages()), []);
    const value = (snap?.value ?? {});
    const ready = snap?.status === 'ready';
    const writable = snap?.writable !== false;
    const prefix = (value.prefix && String(value.prefix) !== '') ? String(value.prefix) : DEFAULT_PREFIX;
    const [open, setOpen] = React.useState(false);
    const [drafts, setDrafts] = React.useState({});
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState('');
    const [runtime, setRuntime] = React.useState(null);
    const [freshKey, setFreshKey] = React.useState(null);
    const [rotating, setRotating] = React.useState(false);
    // Only poll while the card is disclosed: a collapsed card shows no runtime
    // state, so polling for it would be a request nobody reads.
    React.useEffect(() => {
        if (!open)
            return;
        let alive = true;
        const refresh = () => {
            fetch(prefix + '/health')
                .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
                .then((s) => { if (alive)
                setRuntime({ enabled: s.enabled === true, sessions: s.sessions ?? 0, apiKeySet: s.apiKeySet === true }); })
                .catch(() => { });
        };
        refresh();
        const handle = setInterval(refresh, 3000);
        return () => { alive = false; clearInterval(handle); };
    }, [prefix, open]);
    const draft = (key) => drafts[key] ?? '';
    const setDraft = (key, text) => setDrafts((prev) => ({ ...prev, [key]: text }));
    const dropDraft = (key) => setDrafts((prev) => { const next = { ...prev }; delete next[key]; return next; });
    const formatValue = (field) => {
        const v = value[field.key];
        if (v === undefined || v === null)
            return '';
        if (Array.isArray(v))
            return v.join(', ');
        return String(v);
    };
    const toggle = (key, on) => {
        setError('');
        scope.set(key, on).catch((e) => setError(errText(e)));
    };
    const select = (key, next) => {
        setError('');
        scope.set(key, next).catch((e) => setError(errText(e)));
    };
    const saveScalar = async (field) => {
        const key = field.key;
        const text = draft(key).trim();
        try {
            if (text === '') {
                await scope.unset(key);
                dropDraft(key);
                return;
            }
            if (field.kind === 'number') {
                const n = Number(text);
                if (!Number.isFinite(n)) {
                    setError(d.numberRequired(d.fields[field.key].label));
                    return;
                }
                await scope.set(key, n);
            }
            else {
                await scope.set(key, text);
            }
            dropDraft(key);
        }
        catch (e) {
            setError(errText(e));
        }
    };
    const saveAll = async () => {
        setSaving(true);
        setError('');
        try {
            for (const field of FIELDS) {
                if (field.kind === 'text' || field.kind === 'number')
                    await saveScalar(field);
                else if (field.kind === 'secret') {
                    const text = draft(field.key).trim();
                    if (text !== '') {
                        try {
                            await scope.set(field.key, text);
                        }
                        catch (e) {
                            setError(errText(e));
                        }
                    }
                    dropDraft(field.key);
                }
            }
        }
        finally {
            setSaving(false);
        }
    };
    const discard = () => {
        setDrafts({});
        setError('');
    };
    const rotate = async () => {
        setRotating(true);
        setError('');
        setFreshKey(null);
        try {
            const r = await fetch(prefix + '/admin/rotate-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Admin-Key': draft('adminKey') },
                body: '{}',
            });
            const data = await r.json();
            if (!r.ok) {
                setError(String(data?.error ?? r.status));
                return;
            }
            setFreshKey(data?.apiKey ?? null);
        }
        catch {
            setError(d.rotateFailed);
        }
        finally {
            setRotating(false);
        }
    };
    const on = value.enabled === true;
    const statusDot = ready ? (on ? '#16a34a' : 'var(--dsw-alias-label-error)') : 'var(--dsw-alias-label-dimmed)';
    const statusText = !ready ? d.loading : on ? d.statusEnabled : d.statusDisabled;
    const dirty = Object.keys(drafts).length > 0;
    const chevron = React.createElement('svg', {
        className: c.chevron + (open ? ' ' + c.chevronOpen : ''),
        width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': true,
    }, React.createElement('path', {
        d: 'M3.5 5.5L7 9l3.5-3.5', stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round',
    }));
    const header = React.createElement('button', {
        type: 'button',
        className: c.header,
        'aria-expanded': open,
        'aria-label': `${open ? d.collapse : d.expand}: ${CARD_TITLE}`,
        onClick: () => setOpen(!open),
    }, React.createElement('span', { className: c.headText }, React.createElement('span', { className: c.name }, CARD_TITLE), React.createElement('span', { className: c.description }, d.cardDescription)), dirty ? React.createElement('span', { className: c.pending }, d.unsaved) : null, chevron);
    const body = !open ? null : React.createElement('div', { className: c.body }, React.createElement('div', { className: c.status }, React.createElement('span', { className: c.dot, style: { background: statusDot } }), React.createElement('span', null, statusText), React.createElement('span', { className: c.muted }, d.sessionCount(runtime?.sessions ?? 0)), React.createElement('span', { className: c.muted }, runtime?.apiKeySet === true ? d.keyProvisioned : d.keyMissing)), React.createElement('div', { className: c.mono }, d.entry(prefix)), !writable ? React.createElement('p', { className: c.error, role: 'status' }, d.readOnly) : null, ...FIELDS.filter((f) => f.kind === 'toggle').map((f) => {
        const checked = value[f.key] === true;
        return React.createElement('div', { key: f.key, className: c.field }, React.createElement('input', {
            type: 'checkbox', className: c.toggle, checked, disabled: !ready || !writable,
            onChange: (ev) => toggle(f.key, ev.target.checked),
        }), React.createElement('span', { className: c.label }, d.fields[f.key].label), React.createElement('span', { className: c.hint }, d.fields[f.key].hint));
    }), ...FIELDS.filter((f) => f.kind === 'select').map((f) => React.createElement('div', { key: f.key, className: c.field }, React.createElement('span', { className: c.label }, d.fields[f.key].label), React.createElement('select', {
        className: c.input, disabled: !ready || !writable,
        value: String(value[f.key] ?? 'auto'),
        onChange: (ev) => select(f.key, ev.target.value),
    }, ...(f.options ?? []).map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label))), React.createElement('span', { className: c.hint }, d.fields[f.key].hint))), ...FIELDS.filter((f) => f.kind === 'text' || f.kind === 'number').map((f) => React.createElement('div', { key: f.key, className: c.field }, React.createElement('span', { className: c.label }, d.fields[f.key].label), React.createElement('input', {
        type: 'text', className: c.input,
        inputMode: f.kind === 'number' ? 'numeric' : undefined,
        placeholder: f.placeholder ?? '',
        disabled: !ready || !writable,
        value: drafts[f.key] !== undefined ? drafts[f.key] : formatValue(f),
        onChange: (ev) => setDraft(f.key, ev.target.value),
    }), React.createElement('span', { className: c.hint }, d.fields[f.key].hint))), React.createElement('div', { className: c.field }, React.createElement('span', { className: c.label }, d.fields.adminKey.label), React.createElement('input', {
        type: 'password', className: c.input, placeholder: d.adminKeyPlaceholder,
        disabled: !ready || !writable,
        value: draft('adminKey'),
        onChange: (ev) => setDraft('adminKey', ev.target.value),
    }), React.createElement('span', { className: c.hint }, d.fields.adminKey.hint)), freshKey !== null ? React.createElement('div', { className: c.mono }, d.freshKey, freshKey) : null, error !== '' ? React.createElement('p', { className: c.error, role: 'status' }, error) : null, React.createElement('div', { className: c.footer }, React.createElement('button', {
        type: 'button', className: c.ghost, disabled: rotating,
        onClick: () => void rotate(),
    }, rotating ? d.rotating : d.rotate), React.createElement('button', {
        type: 'button', className: c.discard, disabled: !dirty || saving,
        onClick: discard,
    }, d.discard), React.createElement('button', {
        type: 'button', className: c.save, disabled: saving || !dirty || !ready || !writable,
        onClick: () => void saveAll(),
    }, saving ? d.saving : d.save)));
    return React.createElement('li', {
        className: c.card + (open ? ' ' + c.cardOpen : ''),
    }, header, body);
}
const inject = ['slots', 'connection', 'remote', 'settingsScope'];
function apply(ctx) {
    ensureStyles();
    const scope = ctx.settingsScope.bind({ namespace: NS });
    const subscribe = (cb) => scope.subscribe(cb);
    const getSnapshot = () => scope.getSnapshot();
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name: 'settings.plugin.item', key: NS }, () => React.createElement(GatewayCard, { subscribe, getSnapshot, scope })));
}

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
