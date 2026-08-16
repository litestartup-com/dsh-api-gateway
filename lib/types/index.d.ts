/**
 * dsh-api-gateway — Host half.
 *
 * An open-source DeepSeek Harness plugin that publishes a minimal REST + SSE
 * gateway over the harness HTTP carrier (`webServer`). Third-party clients can
 * create agent sessions and converse with the agents — the same agent machine
 * the Web GUI drives — without touching the GUI at all.
 *
 * Install: pnpm add dsh-api-gateway, then add one row to the host composition
 * (see README / examples/cordis.yml). Uninstall: remove the row and restart.
 *
 * Composition plane: this plugin publishes a cross-session HTTP surface, so it
 * belongs in the HOST composition — never inside an agent preset.
 *
 * Extensibility: other host plugins can subscribe to gateway events via the
 * ordinary Cordis bus — `gateway/session-created`, `gateway/message`,
 * `gateway/turn-end` (payloads documented in the README).
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export interface Config {
    /** Route prefix. Defaults to /api-gw/v1. */
    prefix: string;
    /** Master switch; also toggleable at runtime through the admin endpoint. */
    enabled: boolean;
    /** Static API keys accepted by the gateway (in addition to the provisioned key). */
    apiKeys: string[];
    /** Allow the one-time `POST {prefix}/key` bootstrap when no key exists. */
    allowKeyProvision: boolean;
    /** Admin key for `{prefix}/admin/*`; unset disables the admin surface. */
    adminKey?: string;
    /** Cap on concurrent live sessions owned by this gateway. */
    maxSessions: number;
    /** Workspace policy for sessions created without `workspace`. */
    workspaceMode: 'auto' | 'ungrouped';
    /** Fallback directory for `auto` mode when no cwd is given. */
    defaultWorkspacePath?: string;
    /** Allow GET /sessions/discover (lists every session — see security model). */
    allowDiscover: boolean;
    /** Allow POST /sessions/:id/adopt (drive/resume any session). */
    allowAdopt: boolean;
    /** CORS origin(s); default '*' (open). Set an explicit origin list for public deployments. */
    corsOrigin: string | string[];
    /** Include internal error messages in HTTP responses (helpful locally, noisy publicly). */
    exposeErrors: boolean;
    /** SSE heartbeat interval in ms; 0 disables. */
    sseHeartbeatMs: number;
    /** Request body read timeout in ms. */
    bodyTimeoutMs: number;
}
export declare const Config: z<Schemastery.ObjectS<{
    prefix: z<string, string>;
    enabled: z<boolean, boolean>;
    apiKeys: z<string[], string[]>;
    allowKeyProvision: z<boolean, boolean>;
    adminKey: z<string, string>;
    maxSessions: z<number, number>;
    workspaceMode: z<"auto" | "ungrouped", "auto" | "ungrouped">;
    defaultWorkspacePath: z<string, string>;
    allowDiscover: z<boolean, boolean>;
    allowAdopt: z<boolean, boolean>;
    corsOrigin: z<string | string[], string | string[]>;
    exposeErrors: z<boolean, boolean>;
    sseHeartbeatMs: z<number, number>;
    bodyTimeoutMs: z<number, number>;
}>, Schemastery.ObjectT<{
    prefix: z<string, string>;
    enabled: z<boolean, boolean>;
    apiKeys: z<string[], string[]>;
    allowKeyProvision: z<boolean, boolean>;
    adminKey: z<string, string>;
    maxSessions: z<number, number>;
    workspaceMode: z<"auto" | "ungrouped", "auto" | "ungrouped">;
    defaultWorkspacePath: z<string, string>;
    allowDiscover: z<boolean, boolean>;
    allowAdopt: z<boolean, boolean>;
    corsOrigin: z<string | string[], string | string[]>;
    exposeErrors: z<boolean, boolean>;
    sseHeartbeatMs: z<number, number>;
    bodyTimeoutMs: z<number, number>;
}>>;
declare const _default: {
    inject: string[];
    Config: z<Schemastery.ObjectS<{
        prefix: z<string, string>;
        enabled: z<boolean, boolean>;
        apiKeys: z<string[], string[]>;
        allowKeyProvision: z<boolean, boolean>;
        adminKey: z<string, string>;
        maxSessions: z<number, number>;
        workspaceMode: z<"auto" | "ungrouped", "auto" | "ungrouped">;
        defaultWorkspacePath: z<string, string>;
        allowDiscover: z<boolean, boolean>;
        allowAdopt: z<boolean, boolean>;
        corsOrigin: z<string | string[], string | string[]>;
        exposeErrors: z<boolean, boolean>;
        sseHeartbeatMs: z<number, number>;
        bodyTimeoutMs: z<number, number>;
    }>, Schemastery.ObjectT<{
        prefix: z<string, string>;
        enabled: z<boolean, boolean>;
        apiKeys: z<string[], string[]>;
        allowKeyProvision: z<boolean, boolean>;
        adminKey: z<string, string>;
        maxSessions: z<number, number>;
        workspaceMode: z<"auto" | "ungrouped", "auto" | "ungrouped">;
        defaultWorkspacePath: z<string, string>;
        allowDiscover: z<boolean, boolean>;
        allowAdopt: z<boolean, boolean>;
        corsOrigin: z<string | string[], string | string[]>;
        exposeErrors: z<boolean, boolean>;
        sseHeartbeatMs: z<number, number>;
        bodyTimeoutMs: z<number, number>;
    }>>;
    apply(ctx: Context, config: Config): void;
};
export default _default;
