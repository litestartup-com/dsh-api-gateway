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
export type Locale = 'en' | 'zh';
/** Config keys the card renders a row for. */
export type FieldKey = 'enabled' | 'prefix' | 'maxSessions' | 'workspaceMode' | 'defaultWorkspacePath' | 'allowDiscover' | 'allowAdopt' | 'exposeErrors' | 'questions' | 'approvals' | 'corsOrigin' | 'sseHeartbeatMs' | 'bodyTimeoutMs' | 'adminKey';
export interface FieldText {
    label: string;
    hint: string;
}
export interface Dict {
    cardDescription: string;
    expand: string;
    collapse: string;
    unsaved: string;
    loading: string;
    statusEnabled: string;
    statusDisabled: string;
    sessionCount: (count: number) => string;
    keyProvisioned: string;
    keyMissing: string;
    entry: (prefix: string) => string;
    readOnly: string;
    adminKeyPlaceholder: string;
    freshKey: string;
    rotate: string;
    rotating: string;
    rotateFailed: string;
    discard: string;
    save: string;
    saving: string;
    numberRequired: (label: string) => string;
    fields: Record<FieldKey, FieldText>;
}
export declare const STRINGS: Record<Locale, Dict>;
/**
 * First candidate that names a supported language wins; anything else (including
 * an empty list) falls back to English. Matching is prefix-based so `zh`,
 * `zh-CN`, `zh-Hant` and `ZH_TW` all land on Chinese.
 */
export declare const resolveLocale: (candidates: readonly (string | null | undefined)[]) => Locale;
/** Dictionary for the first understood candidate language. */
export declare const dictFor: (candidates: readonly (string | null | undefined)[]) => Dict;
/**
 * Language preference of the surrounding page: what the app declares on <html>
 * first, then what the browser asks for. Guarded for non-browser contexts so the
 * module stays importable from tests.
 */
export declare const documentLanguages: () => (string | null | undefined)[];
