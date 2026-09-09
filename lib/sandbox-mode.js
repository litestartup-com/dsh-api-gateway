/**
 * sandbox-mode — pure plumbing for the per-session sandbox override route.
 *
 * The harness stores a session's sandbox mode as `sandbox/mode` log events
 * (dsh-sandbox-policy/session-mode) and exposes no wire RPC for it, while
 * session.create has no sandbox field. The gateway route that closes the gap
 * keeps its decision logic here so it stays directly unit-testable.
 */
/** Modes a remote caller may pin on a session by default. */
export const REMOTE_SANDBOX_MODES = ['read-only', 'workspace-write'];
/**
 * Validate an untrusted mode string from a request body.
 *
 * `danger-full-access` is refused unless `allowFullAccess` is true: the
 * operator opts in via the `allowFullAccess` config field (风险告知：开启即
 * 允许远端客户端把会话钉在全量沙箱——网关只在启动/命中时告警，不做
 * docker-only 等环境限制，按 2026-09-09 拍板执行).
 */
export const isRemoteSandboxMode = (value, allowFullAccess = false) => {
    if (typeof value !== 'string')
        return false;
    if (REMOTE_SANDBOX_MODES.includes(value))
        return true;
    return allowFullAccess && value === 'danger-full-access';
};
