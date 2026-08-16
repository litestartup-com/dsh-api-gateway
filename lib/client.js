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
 * Registers one card in Settings → Plugins → Configurable (`settings.plugin.item`):
 * gateway status, live session count, a runtime on/off switch (admin endpoint),
 * and API-key rotation. All communication goes through the gateway's own HTTP
 * surface with plain fetch, so the card needs no client RPC machinery.
 */
const DEFAULT_PREFIX = '/api-gw/v1';
const style = {
    card: {
        display: 'flex', flexDirection: 'column', gap: '10px',
        padding: '14px', maxWidth: '640px',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px', lineHeight: '20px',
    },
    row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
    dot: { width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0 },
    muted: { fontSize: '12px', opacity: 0.65 },
    mono: { fontFamily: 'monospace', fontSize: '12px', opacity: 0.8, wordBreak: 'break-all' },
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
};
function GatewayCard() {
    const [state, setState] = React.useState(null);
    const [adminKey, setAdminKey] = React.useState('');
    const [freshKey, setFreshKey] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState('');
    React.useEffect(() => {
        let alive = true;
        const refresh = () => {
            fetch(DEFAULT_PREFIX + '/health')
                .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
                .then((s) => { if (alive) {
                setState({ enabled: s.enabled === true, sessions: s.sessions ?? 0, apiKeySet: s.apiKeySet === true });
                setError('');
            } })
                .catch(() => { if (alive)
                setError('网关未挂载（前缀与组合行配置不一致？）'); });
        };
        refresh();
        const handle = setInterval(refresh, 3000);
        return () => { alive = false; clearInterval(handle); };
    }, []);
    const adminCall = async (path, body) => {
        setBusy(true);
        setError('');
        try {
            const r = await fetch(DEFAULT_PREFIX + path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
                body: JSON.stringify(body),
            });
            const data = await r.json();
            if (!r.ok) {
                setError(String(data.error ?? r.status));
                return;
            }
            setFreshKey(data.apiKey ?? null);
            if (data.enabled !== undefined)
                setState((prev) => prev === null ? null : { ...prev, enabled: data.enabled });
        }
        catch {
            setError('管理请求失败');
        }
        finally {
            setBusy(false);
        }
    };
    const on = state?.enabled === true;
    return React.createElement('div', { style: style.card }, React.createElement('div', { style: style.row }, React.createElement('strong', null, 'API Gateway'), React.createElement('span', { style: { ...style.dot, background: on ? '#16a34a' : 'var(--dsw-alias-state-error-primary)' } }), React.createElement('span', null, on ? '已启用' : '已停用'), React.createElement('span', { style: style.muted }, `会话数 ${state?.sessions ?? 0}`)), React.createElement('div', { style: style.mono }, '入口: ', DEFAULT_PREFIX, ' · 流式: GET /sessions/:id/stream (SSE)'), state?.apiKeySet === true
        ? React.createElement('div', { style: style.muted }, 'API 密钥已发放（POST /key 领取）')
        : React.createElement('div', { style: style.muted }, '尚未发放 API 密钥'), freshKey !== null
        ? React.createElement('div', { style: style.mono }, '新密钥: ', freshKey)
        : null, React.createElement('div', { style: style.row }, React.createElement('button', {
        type: 'button', style: style.button, disabled: busy,
        onClick: () => void adminCall('/admin/enable', { enabled: !on }),
    }, on ? '停用网关' : '启用网关'), React.createElement('button', {
        type: 'button', style: style.button, disabled: busy,
        onClick: () => void adminCall('/admin/rotate-key', {}),
    }, '轮换密钥')), React.createElement('div', { style: style.row }, React.createElement('input', {
        type: 'password', style: style.input, placeholder: 'Admin Key（组合行配置 adminKey）',
        value: adminKey, onChange: (event) => setAdminKey(event.target.value),
    }), React.createElement('span', { style: style.muted }, '停用/轮换需要管理密钥；仅 /health 在停用时仍可访问')), error !== '' ? React.createElement('div', { style: { ...style.muted, color: 'var(--dsw-alias-state-error-primary)' } }, error) : null);
}
const inject = ['slots'];
function apply(ctx) {
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name: 'settings.plugin.item', id: 'api-gateway', order: 50, label: 'API Gateway' }, () => React.createElement(GatewayCard)));
}

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
