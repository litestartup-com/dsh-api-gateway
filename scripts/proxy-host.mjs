// S3 验收宿主：独立的 cordis 进程，起真实 dsh-host-webserver + 新网关插件。
// 插件把 /api-gw/v1/* 透传到本机 DSH 的 /api（127.0.0.1:3080）。
//
// 用法：node scripts/proxy-host.mjs [port]
// 环境：SMOKE_KEY 覆盖 apiKeys[0]（默认 smoke-key）。
import { Context } from '@deepseek-ai/cordis'
import webserver from '@deepseek-ai/dsh-host-webserver'
import gateway from '../lib/index.js'

const port = Number(process.argv[2] ?? process.env.PROXY_PORT ?? 3999)
const key = process.env.SMOKE_KEY ?? 'smoke-key'

const root = new Context()
await root.plugin(webserver, { host: '127.0.0.1', port })
await root.plugin(gateway, {
  prefix: '/api-gw/v1',
  apiKeys: [key],
  proxyTarget: 'http://127.0.0.1:3080/api',
})
console.log('[proxy-host] ready on http://127.0.0.1:' + port + ' (key=' + key + ')')
await new Promise(() => {})
