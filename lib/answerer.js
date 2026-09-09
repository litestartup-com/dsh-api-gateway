/**
 * dsh-api-gateway — 0.1.2 in-host waterfall 应答器（respond 桥）。
 *
 * manager 的问答/审批走老契约：mux 收到 question/approval 帧 → respond 回填。
 * 0.1.2 的正缝 = 网关直接挂两个 Cordis waterfall 监听器（不带 scope 标签的
 * 监听者收到全部投递，A1-20 笔记实证），收到请求后翻译成老帧广播、挂起
 * Promise，等 manager 的 respond 到达后返回答案**认领**该请求。
 *
 * 词汇映射实测为零（0.1.2-rc.1 源码实证）：
 * - AskUserQuestionAnswerItem {id, selected, custom?} ≡ manager QuestionAnswer
 * - ApprovalOutcome 'allowed-once'|'rejected'|'cancelled'|'unavailable'
 *   ⊇ manager decideApproval 词汇（直通）
 * - 拒绝语义：manager declineQuestion = not-ok + error.code 'cancelled'；
 *   0.1.2 UI 等价 = 以 code 'ASK_CANCELLED' 拒绝 waterfall（ui-user-questions
 *   的 cancel() 行为）。错误对象按 name/message/code 复原成 UserQuestionError
 *   —— 这正是 dsh-user-questions restoreUserQuestionError 支持的跨 worker 形。
 */
import { randomBytes } from 'node:crypto';
/** manager 拒绝问题的标记：settle 对它 reject，监听器凭它把「认领并失败」与「超时让位」分开。 */
class ManagerDeclined extends Error {
    constructor() {
        super('the user cancelled ask_user_question');
        this.name = 'ManagerDeclined';
    }
}
/** 0.1.2 ApprovalOutcome 全集；manager 只发 allowed-once/rejected，其余直通备用。 */
const APPROVAL_OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable']);
/** manager 不回应的最长期限（超时让位给链上其它应答器，如浏览器 UI）。 */
export const ANSWER_TIMEOUT_MS = 10 * 60_000;
const mintId = () => `apigw-${randomBytes(16).toString('hex')}`;
export class Answerer {
    broadcast;
    log;
    pending = new Map();
    disposers = [];
    constructor(broadcast, log) {
        this.broadcast = broadcast;
        this.log = log;
    }
    /** 挂载两个 waterfall 监听器；返回卸载器（fiber 销毁时调用）。 */
    mount(ctx) {
        const onQuestions = ctx.on('user-questions/request', async (request, next) => {
            const rpcId = mintId();
            const sessionId = request.agent?.id ?? '';
            this.broadcast(JSON.stringify({
                type: 'server-request',
                rpcId,
                method: 'question/requested',
                payload: { type: 'question/requested', sessionId, questions: request.questions },
            }));
            try {
                // respond 值 = { sessionId, answer: { answers: [...] } }；认领返回值 = { answers }。
                const value = await this.awaitAnswer(rpcId, request.signal);
                const answers = (value?.answer?.answers ?? []);
                this.broadcastResolved('question/resolved', sessionId, rpcId, 'answered', null);
                return { answers };
            }
            catch (error) {
                if (error instanceof ManagerDeclined) {
                    this.broadcastResolved('question/resolved', sessionId, rpcId, 'cancelled', null);
                    // 与 ui-user-questions cancel() 一致：waterfall 抛错 = 认领并失败。
                    // 不带 ASK_CANCELLED 抛错而 next() 会让浏览器 UI 重问一遍同一问题。
                    throw { name: 'UserQuestionError', message: 'the user cancelled ask_user_question', code: 'ASK_CANCELLED' };
                }
                this.log(`[dsh-api-gw] question ${rpcId} unanswered (${String(error?.message ?? error)}), delegating`);
                return next();
            }
        });
        const onApprovals = ctx.on('approval/request', async (request, next) => {
            const approvalId = mintId();
            this.broadcast(JSON.stringify({
                type: 'server-request',
                rpcId: approvalId,
                method: 'approval/requested',
                payload: {
                    type: 'approval/requested',
                    sessionId: request.agent.id,
                    approvalId,
                    toolName: request.toolName,
                    callId: request.callId ?? null,
                    reason: request.reason ?? null,
                },
            }));
            try {
                // respond 值 = { sessionId, approvalId, outcome }；outcome 词汇直通。
                const value = await this.awaitAnswer(approvalId, request.signal);
                const outcome = value?.outcome;
                if (typeof outcome === 'string' && APPROVAL_OUTCOMES.has(outcome)) {
                    this.broadcastResolved('approval/resolved', request.agent.id, approvalId, outcome, approvalId);
                    return outcome;
                }
                return next();
            }
            catch (error) {
                this.log(`[dsh-api-gw] approval ${approvalId} unanswered (${String(error?.message ?? error)}), delegating`);
                return next();
            }
        });
        this.disposers = [onQuestions, onApprovals];
        return () => {
            for (const dispose of this.disposers)
                dispose();
            this.disposers = [];
            for (const entry of this.pending.values())
                entry.reject(new Error('gateway unloaded'));
            this.pending.clear();
        };
    }
    awaitAnswer(id, signal) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('answer timeout'));
            }, ANSWER_TIMEOUT_MS);
            const onAbort = () => {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new Error('cancelled'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            const entry = {
                resolve: (value) => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                    this.pending.delete(id);
                    resolve(value);
                },
                reject: (reason) => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                    this.pending.delete(id);
                    reject(reason);
                },
            };
            this.pending.set(id, entry);
        });
    }
    broadcastResolved(method, sessionId, id, outcome, approvalId) {
        const payload = { type: method, sessionId, outcome };
        if (method === 'question/resolved')
            payload.questionRpcId = id;
        else
            payload.approvalId = approvalId ?? id;
        this.broadcast(JSON.stringify({ type: 'server-request', rpcId: id, method, payload }));
    }
    /**
     * manager 的 respond 到达：解析 client-response 信封，回填挂起项。
     * not-ok + code 'cancelled'（manager declineQuestion）按老契约算已认领，
     * 但以 ManagerDeclined 拒绝挂起项，让监听器走 ASK_CANCELLED 路径。
     */
    settle(envelope) {
        const id = typeof envelope.rpcId === 'string' ? envelope.rpcId : '';
        const entry = this.pending.get(id);
        if (entry === undefined)
            return { found: false };
        const result = envelope.result;
        if (result?.ok === true) {
            entry.resolve(result.value);
        }
        else {
            const code = typeof result?.error?.code === 'string' ? result.error.code : '';
            const message = typeof result?.error?.message === 'string' ? result.error.message : 'manager rejected';
            entry.reject(code === 'cancelled' ? new ManagerDeclined() : new Error(message));
        }
        return { found: true };
    }
    pendingCount() {
        return this.pending.size;
    }
}
