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
    /**
     * The key minted by `POST {prefix}/key`, persisted through the settings scope.
     *
     * Written by the gateway, not by hand -- `apiKeys` is the field to edit. It is
     * stored rather than kept in memory so that the bootstrap is one-time *ever*:
     * the key a client was given keeps working across restarts, and the
     * unauthenticated mint closes permanently instead of reopening on each boot.
     */
    provisionedKey?: string;
    /** Allow the one-time `POST {prefix}/key` bootstrap when no key exists at all. */
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
    /**
     * Who answers `ask_user_question` for the sessions this gateway drives.
     *
     * - `host` (default) -- leave the deployment's own provider alone. In a
     *   profile that serves the Web GUI that is the browser, so a card appears
     *   there and the turn waits for a click nobody outside that GUI can make.
     * - `gateway` -- offer to be the provider, so the question is relayed to API
     *   clients as a `question_asked` frame and answered over HTTP. A remote
     *   client becomes the human the tool waits for; the agent, the tool and the
     *   model are untouched.
     *
     * `gateway` is an OFFER, not a seizure: the slot holds exactly one provider,
     * and a deployment whose GUI already owns it keeps it (see
     * `ensureQuestionOwnership`). To make the slot free, disable the
     * `@deepseek-ai/dsh-host-apiproxy` row -- that is the browser UI's backend,
     * not the HTTP carrier, so the gateway itself keeps serving.
     */
    questions: 'host' | 'gateway';
    /**
     * Who decides permission prompts for the sessions this gateway drives.
     *
     * - `host` (default) -- leave them to the deployment's own answerers.
     * - `gateway` -- relay each one as an `approval_pending` frame and wait for a
     *   client to decide it over HTTP.
     *
     * Needs no free slot, unlike `questions`: approval answerers COMPOSE, so this
     * can be turned on in a profile that also serves the Web GUI. Only decisions
     * for sessions this gateway drives are claimed; anything else is passed on
     * untouched, and the only grant that can be sent is the one-shot
     * `allowed-once`, so answering can never widen a session's policy.
     */
    approvals: 'host' | 'gateway';
    /** SSE heartbeat interval in ms; 0 disables. */
    sseHeartbeatMs: number;
    /** Request body read timeout in ms. */
    bodyTimeoutMs: number;
}
export declare const Config: z<Schemastery.ObjectS<{
    prefix: z<string, string>;
    enabled: z<boolean, boolean>;
    apiKeys: z<string[], string[]>;
    provisionedKey: z<string, string>;
    allowKeyProvision: z<boolean, boolean>;
    adminKey: z<string, string>;
    maxSessions: z<number, number>;
    workspaceMode: z<"auto" | "ungrouped", "auto" | "ungrouped">;
    defaultWorkspacePath: z<string, string>;
    allowDiscover: z<boolean, boolean>;
    allowAdopt: z<boolean, boolean>;
    corsOrigin: z<string | string[], string | string[]>;
    exposeErrors: z<boolean, boolean>;
    questions: z<"host" | "gateway", "host" | "gateway">;
    approvals: z<"host" | "gateway", "host" | "gateway">;
    sseHeartbeatMs: z<number, number>;
    bodyTimeoutMs: z<number, number>;
}>, Schemastery.ObjectT<{
    prefix: z<string, string>;
    enabled: z<boolean, boolean>;
    apiKeys: z<string[], string[]>;
    provisionedKey: z<string, string>;
    allowKeyProvision: z<boolean, boolean>;
    adminKey: z<string, string>;
    maxSessions: z<number, number>;
    workspaceMode: z<"auto" | "ungrouped", "auto" | "ungrouped">;
    defaultWorkspacePath: z<string, string>;
    allowDiscover: z<boolean, boolean>;
    allowAdopt: z<boolean, boolean>;
    corsOrigin: z<string | string[], string | string[]>;
    exposeErrors: z<boolean, boolean>;
    questions: z<"host" | "gateway", "host" | "gateway">;
    approvals: z<"host" | "gateway", "host" | "gateway">;
    sseHeartbeatMs: z<number, number>;
    bodyTimeoutMs: z<number, number>;
}>>;
declare const _default: {
    inject: string[];
    Config: z<Schemastery.ObjectS<{
        prefix: z<string, string>;
        enabled: z<boolean, boolean>;
        apiKeys: z<string[], string[]>;
        provisionedKey: z<string, string>;
        allowKeyProvision: z<boolean, boolean>;
        adminKey: z<string, string>;
        maxSessions: z<number, number>;
        workspaceMode: z<"auto" | "ungrouped", "auto" | "ungrouped">;
        defaultWorkspacePath: z<string, string>;
        allowDiscover: z<boolean, boolean>;
        allowAdopt: z<boolean, boolean>;
        corsOrigin: z<string | string[], string | string[]>;
        exposeErrors: z<boolean, boolean>;
        questions: z<"host" | "gateway", "host" | "gateway">;
        approvals: z<"host" | "gateway", "host" | "gateway">;
        sseHeartbeatMs: z<number, number>;
        bodyTimeoutMs: z<number, number>;
    }>, Schemastery.ObjectT<{
        prefix: z<string, string>;
        enabled: z<boolean, boolean>;
        apiKeys: z<string[], string[]>;
        provisionedKey: z<string, string>;
        allowKeyProvision: z<boolean, boolean>;
        adminKey: z<string, string>;
        maxSessions: z<number, number>;
        workspaceMode: z<"auto" | "ungrouped", "auto" | "ungrouped">;
        defaultWorkspacePath: z<string, string>;
        allowDiscover: z<boolean, boolean>;
        allowAdopt: z<boolean, boolean>;
        corsOrigin: z<string | string[], string | string[]>;
        exposeErrors: z<boolean, boolean>;
        questions: z<"host" | "gateway", "host" | "gateway">;
        approvals: z<"host" | "gateway", "host" | "gateway">;
        sseHeartbeatMs: z<number, number>;
        bodyTimeoutMs: z<number, number>;
    }>>;
    apply(ctx: Context, config: Config): void;
};
export default _default;
