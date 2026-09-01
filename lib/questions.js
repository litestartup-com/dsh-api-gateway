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
const str = (value) => typeof value === 'string' && value !== '' ? value : undefined;
/** Copy the questions the harness asked into their wire form, dropping anything unrecognised. */
export const wireQuestions = (items) => {
    const out = [];
    for (const item of items) {
        if (item === null || typeof item !== 'object')
            continue;
        const q = item;
        const id = str(q.id);
        const question = str(q.question);
        if (id === undefined || question === undefined)
            continue;
        const wire = { id, question };
        const detail = str(q.detail);
        if (detail !== undefined)
            wire.detail = detail;
        const header = str(q.header);
        if (header !== undefined)
            wire.header = header;
        if (Array.isArray(q.options)) {
            const options = [];
            for (const raw of q.options) {
                if (raw === null || typeof raw !== 'object')
                    continue;
                const label = str(raw.label);
                if (label === undefined)
                    continue;
                const description = str(raw.description);
                options.push(description === undefined ? { label } : { label, description });
            }
            if (options.length > 0)
                wire.options = options;
        }
        if (q.multiSelect === true)
            wire.multiSelect = true;
        const intent = q.intent;
        if (intent !== null && typeof intent === 'object') {
            const kind = str(intent.kind);
            const approve = str(intent.approve);
            if (kind !== undefined && approve !== undefined)
                wire.intent = { kind, approve };
        }
        out.push(wire);
    }
    return out;
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
export const validateAnswers = (questions, body) => {
    if (body === null || typeof body !== 'object')
        return { ok: false, error: 'body must be an object' };
    const raw = body.answers;
    if (!Array.isArray(raw))
        return { ok: false, error: 'answers must be an array' };
    const asked = new Map(questions.map((q) => [q.id, q]));
    const answers = [];
    const seen = new Set();
    for (const item of raw) {
        if (item === null || typeof item !== 'object')
            return { ok: false, error: 'each answer must be an object' };
        const a = item;
        const id = str(a.id);
        if (id === undefined)
            return { ok: false, error: 'each answer needs a non-empty id' };
        const question = asked.get(id);
        if (question === undefined)
            return { ok: false, error: `answer id ${JSON.stringify(id)} was not asked` };
        if (seen.has(id))
            return { ok: false, error: `question ${JSON.stringify(id)} was answered twice` };
        seen.add(id);
        const selectedRaw = a.selected === undefined ? [] : a.selected;
        if (!Array.isArray(selectedRaw))
            return { ok: false, error: `selected for ${JSON.stringify(id)} must be an array` };
        const selected = [];
        for (const label of selectedRaw) {
            if (typeof label !== 'string' || label === '')
                return { ok: false, error: `selected for ${JSON.stringify(id)} must contain non-empty strings` };
            selected.push(label);
        }
        const custom = str(a.custom);
        if (question.multiSelect !== true && selected.length > 1) {
            return { ok: false, error: `question ${JSON.stringify(id)} is single-select but got ${String(selected.length)} selections` };
        }
        const labels = (question.options ?? []).map((o) => o.label);
        if (labels.length > 0 && custom === undefined) {
            const unknown = selected.find((label) => !labels.includes(label));
            if (unknown !== undefined)
                return { ok: false, error: `option ${JSON.stringify(unknown)} is not offered for question ${JSON.stringify(id)}` };
        }
        if (selected.length === 0 && custom === undefined) {
            return { ok: false, error: `question ${JSON.stringify(id)} needs a selection or custom text` };
        }
        answers.push(custom === undefined ? { id, selected } : { id, selected, custom });
    }
    const missing = questions.map((q) => q.id).filter((id) => !seen.has(id));
    if (missing.length > 0)
        return { ok: false, error: `unanswered question(s): ${missing.join(', ')}` };
    return { ok: true, answers };
};
