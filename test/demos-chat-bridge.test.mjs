// Regression test for the demo chat bridge's tool/result text extraction.
//
// The wire shape (frozen contract, manager translate.ts tool/result) carries
// data.message.content[0].content as an ARRAY of {type,text} blocks. The bridge
// used String(block.content) — rendering "[object Object]" in both demo UIs —
// instead of extracting the block texts. Found during the pi-api-facade D0
// conformance survey (finding G1); the bug predates that and affects the
// gateway's own demos identically.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatBridge, blocksText } from '../examples/demos/lib/chat-bridge.mjs'

const toolResultFrame = (sid) => ({
  type: 'server-request',
  rpcId: '',
  method: 'session/event',
  payload: {
    type: 'session/event',
    sessionId: sid,
    event: {
      type: 'tool/result',
      seq: 3,
      data: {
        message: { content: [{ content: [{ type: 'text', text: 'file-a\nfile-b' }], isError: false }] },
      },
    },
  },
})

const makeBridge = () => {
  const state = { handlers: null }
  const client = {
    async history() { throw new Error('unknown session') },
    async createSession() { return { sessionId: 's1' } },
    async pinSandboxMode() { return {} },
    async prompt() { return { accepted: true } },
    connectMux(handlers) { state.handlers = handlers },
    closeMux() {},
  }
  const bridge = new ChatBridge({ client, cwd: '/workspace/x', sandboxMode: 'read-only' })
  return { bridge, state }
}

test('blocksText extracts text blocks and passes plain strings through', () => {
  assert.equal(blocksText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(blocksText('raw'), 'raw')
  assert.equal(blocksText(null), '')
})

test('tool_result SSE frames carry the extracted text, never [object Object]', async () => {
  const { bridge, state } = makeBridge()
  const sid = await bridge.ensure('')
  const seen = []
  bridge.attach(sid, { send: (event, data) => seen.push({ event, data }), close() {} })
  bridge.start()
  assert.ok(state.handlers, 'mux handlers registered')
  state.handlers.onFrame(toolResultFrame(sid))
  const tr = seen.find((s) => s.event === 'tool_result')
  assert.ok(tr, `tool_result emitted; got ${JSON.stringify(seen.map((s) => s.event))}`)
  assert.equal(tr.data.text, 'file-a\nfile-b')
  assert.equal(tr.data.isError, false)
  assert.ok(!JSON.stringify(tr.data).includes('[object Object]'))
})
