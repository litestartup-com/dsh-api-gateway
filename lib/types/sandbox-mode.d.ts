/**
 * sandbox-mode — pure plumbing for the per-session sandbox override route.
 *
 * The harness stores a session's sandbox mode as `sandbox/mode` log events
 * (dsh-sandbox-policy/session-mode) and exposes no wire RPC for it, while
 * session.create has no sandbox field. The gateway route that closes the gap
 * keeps its decision logic here so it stays directly unit-testable.
 */
/** Modes a remote caller may pin on a session. */
export declare const REMOTE_SANDBOX_MODES: readonly ["read-only", "workspace-write"];
export type RemoteSandboxMode = (typeof REMOTE_SANDBOX_MODES)[number];
/**
 * Validate an untrusted mode string from a request body.
 *
 * `danger-full-access` is deliberately absent: full access is a host-UI
 * decision and is not grantable over the wire.
 */
export declare const isRemoteSandboxMode: (value: unknown) => value is RemoteSandboxMode;
