/**
 * The load-bearing assumption behind conversational downgrade.
 *
 * `ctx.userQuestions` holds ONE provider in a single instance field and throws
 * DUPLICATE_PROVIDER on a second registration, so the gateway cannot simply
 * register its own: the deployment's GUI already owns that slot. The whole
 * design rests on `ctx.isolate()` giving the gateway a private scope for the
 * service name, and these tests pin that claim against the real packages
 * rather than against their documentation.
 *
 * They exercise cordis and dsh-user-questions directly (unlike the other suites
 * here, which are pure) because an assumption about someone else's runtime is
 * exactly the kind that a pure test cannot check and a comment cannot keep true.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'

const questions = [{ id: 'q1', question: 'which one?' }]

/** A provider that answers, standing in for the deployment's GUI. */
const answering = (label) => ({ ask: async () => ({ answers: [{ id: 'q1', selected: [label] }] }) })

test('the single provider slot rejects a second registration in one scope', () => {
  const ctx = new Context()
  new UserQuestionService(ctx)
  ctx.userQuestions.registerProvider(answering('gui'))
  // The reason the gateway must isolate rather than register: this is what
  // registering alongside a GUI would do.
  assert.throws(() => ctx.userQuestions.registerProvider(answering('gateway')), /already registered/)
})

test('an isolated scope carries its own provider, leaving the host slot intact', async () => {
  const host = new Context()
  new UserQuestionService(host)
  host.userQuestions.registerProvider(answering('gui'))

  const scoped = host.isolate('userQuestions')
  new UserQuestionService(scoped)
  scoped.userQuestions.registerProvider(answering('gateway'))

  // Both directions matter: ours answers ours, and the GUI's is untouched --
  // a gateway that silently stole the GUI's questions would be worse than one
  // that never handled them.
  const fromScope = await scoped.userQuestions.ask({ questions })
  const fromHost = await host.userQuestions.ask({ questions })
  assert.deepEqual(fromScope.answers[0].selected, ['gateway'])
  assert.deepEqual(fromHost.answers[0].selected, ['gui'])
})

test('a downgrading provider surfaces its instruction as the ask failure', async () => {
  const host = new Context()
  new UserQuestionService(host)

  const scoped = host.isolate('userQuestions')
  new UserQuestionService(scoped)
  scoped.userQuestions.registerProvider({
    ask: async () => { throw new Error('state the question in your reply') },
  })

  // The message is the entire mechanism: it reaches the model as a tool error,
  // so it has to arrive intact rather than be swallowed into a generic failure.
  await assert.rejects(
    () => scoped.userQuestions.ask({ questions }),
    /state the question in your reply/,
  )
})

test('an isolated scope with no provider fails closed instead of reaching the host', async () => {
  const host = new Context()
  new UserQuestionService(host)
  host.userQuestions.registerProvider(answering('gui'))

  const scoped = host.isolate('userQuestions')
  new UserQuestionService(scoped)

  // If isolation leaked, this would quietly resolve to 'gui' -- and a gateway
  // session's question would be waiting on a browser nobody is watching.
  await assert.rejects(() => scoped.userQuestions.ask({ questions }), /no user-questions provider/)
})
