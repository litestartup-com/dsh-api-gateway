/**
 * Interactive questions: the fact the design rests on, and the answer contract.
 *
 * The first test exercises cordis and dsh-user-questions directly (unlike the
 * other suites here, which are pure) because it pins someone else's runtime
 * behaviour -- the kind of assumption a pure test cannot check and a comment
 * cannot keep true. It is the reason `ensureQuestionOwnership` offers rather
 * than registers: winning that race does not just lose questions, it throws
 * inside whichever plugin registers second.
 *
 * The rest cover `validateAnswers`, which stands between an HTTP body and a tool
 * result the model will act on.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { validateAnswers, wireQuestions } from '../lib/questions.js'

test('the provider slot holds exactly one, and the second registration throws', () => {
  const ctx = new Context()
  new UserQuestionService(ctx)
  ctx.userQuestions.registerProvider({ ask: async () => ({ answers: [] }) })
  // Exactly what would happen to `dsh-host-apiproxy` if the gateway registered
  // first -- and it does not guard its own call, so the GUI would fail to load.
  assert.throws(() => ctx.userQuestions.registerProvider({ ask: async () => ({ answers: [] }) }), /already registered/)
})

test('wire mapping copies leaf fields and drops anything unusable', () => {
  const mapped = wireQuestions([
    { id: 'q1', question: 'pick', header: 'Choose', detail: 'why it matters', multiSelect: true, options: [{ label: 'a', description: 'first' }, { label: 'b' }, { nope: 1 }] },
    { id: '', question: 'no id' },
    { id: 'q3' },
    'nonsense',
  ])
  assert.equal(mapped.length, 1)
  assert.deepEqual(mapped[0], {
    id: 'q1',
    question: 'pick',
    detail: 'why it matters',
    header: 'Choose',
    options: [{ label: 'a', description: 'first' }, { label: 'b' }],
    multiSelect: true,
  })
})

const asked = wireQuestions([
  { id: 'q1', question: 'pick one', options: [{ label: 'a' }, { label: 'b' }] },
  { id: 'q2', question: 'anything else?' },
])

test('a complete, well-formed answer passes through', () => {
  const checked = validateAnswers(asked, { answers: [{ id: 'q1', selected: ['a'] }, { id: 'q2', custom: 'ship it' }] })
  assert.equal(checked.ok, true)
  assert.deepEqual(checked.answers, [{ id: 'q1', selected: ['a'] }, { id: 'q2', selected: [], custom: 'ship it' }])
})

test('a missing answer is refused rather than passed on as a partial one', () => {
  // The model asked both. Answering one and calling it done reads to the model
  // as an unanswered question, which it then re-asks.
  const checked = validateAnswers(asked, { answers: [{ id: 'q1', selected: ['a'] }] })
  assert.equal(checked.ok, false)
  assert.match(checked.error, /unanswered.*q2/)
})

test('an id nobody asked is refused, most likely a stale card', () => {
  const checked = validateAnswers(asked, { answers: [{ id: 'q9', selected: ['a'] }] })
  assert.equal(checked.ok, false)
  assert.match(checked.error, /not asked/)
})

test('a label that names no option is refused unless custom text carries the answer', () => {
  const invented = validateAnswers(asked, { answers: [{ id: 'q1', selected: ['c'] }, { id: 'q2', custom: 'x' }] })
  assert.equal(invented.ok, false)
  assert.match(invented.error, /not offered/)

  const other = validateAnswers(asked, { answers: [{ id: 'q1', selected: ['c'], custom: 'my own option' }, { id: 'q2', custom: 'x' }] })
  assert.equal(other.ok, true)
})

test('a single-select question refuses several selections', () => {
  const checked = validateAnswers(asked, { answers: [{ id: 'q1', selected: ['a', 'b'] }, { id: 'q2', custom: 'x' }] })
  assert.equal(checked.ok, false)
  assert.match(checked.error, /single-select/)
})

test('multi-select accepts several, and an empty answer is still refused', () => {
  const multi = wireQuestions([{ id: 'm', question: 'which', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] }])
  assert.equal(validateAnswers(multi, { answers: [{ id: 'm', selected: ['a', 'b'] }] }).ok, true)

  const empty = validateAnswers(multi, { answers: [{ id: 'm', selected: [] }] })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /selection or custom text/)
})

test('a malformed body is refused before anything reaches the model', () => {
  for (const body of [null, 'nope', {}, { answers: 'a' }, { answers: [1] }, { answers: [{ id: 'q1', selected: [''] }] }]) {
    assert.equal(validateAnswers(asked, body).ok, false)
  }
})

test('the same question cannot be answered twice in one body', () => {
  const checked = validateAnswers(asked, { answers: [{ id: 'q1', selected: ['a'] }, { id: 'q1', selected: ['b'] }, { id: 'q2', custom: 'x' }] })
  assert.equal(checked.ok, false)
  assert.match(checked.error, /twice/)
})
