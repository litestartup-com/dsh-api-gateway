/**
 * dsh-api-gateway — interactive question wire mapping and answer validation (pure).
 *
 * The gateway can act as the deployment's `userQuestions` provider, which makes
 * an HTTP client the human that `ask_user_question` waits for. Everything in
 * here is the part of that which needs no Cordis and no live objects, so it is
 * directly unit-testable (see test/questions.test.mjs).
 *
 * Nothing here decides policy: whether the gateway may own the provider slot at
 * all is decided in index.ts, where the deployment is visible.
 */
/** One option offered for a question, as it goes on the wire. */
export interface WireOption {
    label: string;
    description?: string;
}
/**
 * One question, as it goes on the wire.
 *
 * A leaf-field copy of the harness `AskUserQuestionItem` rather than the object
 * itself: the gateway never serializes live harness objects, and a shape it
 * copied field by field cannot start carrying something new (a handle, a
 * back-reference) because an upstream type grew.
 */
export interface WireQuestion {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: WireOption[];
    multiSelect?: boolean;
    /** Presentation hint only; a client that does not know the kind renders the option list. */
    intent?: {
        kind: string;
        approve: string;
    };
}
/** One answer, in the shape `UserQuestionProvider.ask` must return. */
export interface WireAnswer {
    id: string;
    selected: string[];
    custom?: string;
}
/** Copy the questions the harness asked into their wire form, dropping anything unrecognised. */
export declare const wireQuestions: (items: readonly unknown[]) => WireQuestion[];
export type AnswerCheck = {
    ok: true;
    answers: WireAnswer[];
} | {
    ok: false;
    error: string;
};
/**
 * Check a client's answer body against the questions actually asked.
 *
 * Strict on purpose, and stricter than the browser provider needs to be. The
 * result of this does not go back to a UI that can be corrected -- it goes into
 * a tool result the model will act on, so a partial or invented answer is worse
 * than a 400. Specifically:
 *
 * - every asked question must be answered, because the model asked all of them
 *   and a missing id reads as an unanswered question it may then re-ask;
 * - an unknown id is refused rather than ignored, since it means the client is
 *   answering a question this request never asked -- most likely a stale card;
 * - a label that names no option is refused UNLESS `custom` carries free text,
 *   which is how "other" answers arrive.
 *
 * A question with no options at all is free-text only, so `selected` may be
 * empty there and `custom` carries the answer.
 */
export declare const validateAnswers: (questions: readonly WireQuestion[], body: unknown) => AnswerCheck;
