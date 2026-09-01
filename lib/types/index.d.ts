/**
 * dsh-api-gateway — Host half (S3: authenticated loopback proxy).
 *
 * The plugin no longer drives agents. It is a thin, fail-closed reverse proxy
 * that lets an external client (the manager) reach the harness's own /api
 * surface (dsh-client-connection + dsh-host-apiproxy) from another machine:
 *
 *   POST {prefix}/proxy/<method>  ->  POST <proxyTarget>/<method>   (unary passthrough)
 *   POST {prefix}/proxy/respond   ->  POST <proxyTarget>/respond    (answers)
 *   GET  {prefix}/events.mux      ->  WS <proxyTarget>/events.mux   (downlink-only pipe)
 *
 * Every proxied path requires an API key, and every method must be on the
 * whitelist — anything else is refused before touching the upstream. The
 * proxy never parses the RPC envelope: it forwards bytes, so the wire
 * contract belongs to DSH and the manager, not to this plugin.
 *
 * Install: pnpm add dsh-api-gateway, then add one row to the host composition
 * (see README / examples/cordis.yml). Uninstall: remove the row and restart.
 *
 * Composition plane: this plugin publishes a cross-session HTTP surface, so it
 * belongs in the HOST composition — never inside an agent preset.
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
     * The key minted by POST {prefix}/key, persisted through the settings scope.
     *
     * Written by the gateway, not by hand -- apiKeys is the field to edit. It is
     * stored rather than kept in memory so that the bootstrap is one-time *ever*:
     * the key a client was given keeps working across restarts, and the
     * unauthenticated mint closes permanently instead of reopening on each boot.
     */
    provisionedKey?: string;
    /** Allow the one-time POST {prefix}/key bootstrap when no key exists at all. */
    allowKeyProvision: boolean;
    /** Admin key for {prefix}/admin/*; unset disables the admin surface. */
    adminKey?: string;
    /** CORS origin(s); default '*' (open). Set an explicit origin list for public deployments. */
    corsOrigin: string | string[];
    /** Include internal error messages in HTTP responses (helpful locally, noisy publicly). */
    exposeErrors: boolean;
    /** Upstream /api base to forward to. Defaults to the loopback DSH /api. */
    proxyTarget: string;
    /** Optional override for the proxy whitelist; defaults to DEFAULT_PROXY_WHITELIST. */
    proxyWhitelist: string[];
}
export declare const Config: z<Schemastery.ObjectS<{
    prefix: z<string, string>;
    enabled: z<boolean, boolean>;
    apiKeys: z<string[], string[]>;
    provisionedKey: z<string, string>;
    allowKeyProvision: z<boolean, boolean>;
    adminKey: z<string, string>;
    corsOrigin: z<string | string[], string | string[]>;
    exposeErrors: z<boolean, boolean>;
    proxyTarget: z<string, string>;
    proxyWhitelist: z<string[], string[]>;
}>, Schemastery.ObjectT<{
    prefix: z<string, string>;
    enabled: z<boolean, boolean>;
    apiKeys: z<string[], string[]>;
    provisionedKey: z<string, string>;
    allowKeyProvision: z<boolean, boolean>;
    adminKey: z<string, string>;
    corsOrigin: z<string | string[], string | string[]>;
    exposeErrors: z<boolean, boolean>;
    proxyTarget: z<string, string>;
    proxyWhitelist: z<string[], string[]>;
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
        corsOrigin: z<string | string[], string | string[]>;
        exposeErrors: z<boolean, boolean>;
        proxyTarget: z<string, string>;
        proxyWhitelist: z<string[], string[]>;
    }>, Schemastery.ObjectT<{
        prefix: z<string, string>;
        enabled: z<boolean, boolean>;
        apiKeys: z<string[], string[]>;
        provisionedKey: z<string, string>;
        allowKeyProvision: z<boolean, boolean>;
        adminKey: z<string, string>;
        corsOrigin: z<string | string[], string | string[]>;
        exposeErrors: z<boolean, boolean>;
        proxyTarget: z<string, string>;
        proxyWhitelist: z<string[], string[]>;
    }>>;
    apply(ctx: Context, config: Config): void;
};
export default _default;
