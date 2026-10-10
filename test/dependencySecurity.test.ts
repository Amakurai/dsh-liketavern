/** 依赖补丁的行为与宿主兼容回归：验证 OAuth 凭证归属、缓存强制复核、恶意 source map 拒绝和真实 MCP HTTP 握手；所有端点与凭证均为工厂数据。 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import { AuthorizationServerMismatchError, Client, ClientCredentialsProvider, fetchToken, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import * as hostMcp from '@deepseek-ai/dsh-mcp-client'
import { expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const CachePolicy = require('http-cache-semantics') as new (
  request: { url: string; method: string; headers: Record<string, string> },
  response: { status: number; headers: Record<string, string> },
) => { satisfiesWithoutRevalidation(request: { url: string; method: string; headers: Record<string, string> }): boolean }

it('MCP OAuth 在发送凭证前拒绝不同 issuer，正确 issuer 仍能取得令牌', async () => {
  const issuer = 'https://issuer.factory.invalid'
  const provider = new ClientCredentialsProvider({ clientId: 'factory-client', clientSecret: 'factory-secret', expectedIssuer: issuer })
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ access_token: 'factory-token', token_type: 'Bearer' }), { headers: { 'content-type': 'application/json' } }))
  await expect(fetchToken(provider, 'https://other.factory.invalid', { fetchFn })).rejects.toBeInstanceOf(AuthorizationServerMismatchError)
  expect(fetchFn).not.toHaveBeenCalled()
  await expect(fetchToken(provider, issuer, { fetchFn })).resolves.toMatchObject({ access_token: 'factory-token' })
  expect(String(fetchFn.mock.calls[0]![0])).toBe(`${issuer}/token`)
  expect(new Headers(fetchFn.mock.calls[0]![1]?.headers).get('authorization')).toBe(`Basic ${Buffer.from('factory-client:factory-secret').toString('base64')}`)
})

it('max-stale 不能绕过 must-revalidate，普通可共享过期响应保留兼容行为', () => {
  const request = { url: 'https://cache.factory.invalid/example', method: 'GET', headers: { host: 'cache.factory.invalid' } }
  const staleRequest = { ...request, headers: { ...request.headers, 'cache-control': 'max-stale=999999' } }
  const response = { status: 200, headers: { 'cache-control': 'public, max-age=1, must-revalidate', age: '120' } }
  expect(new CachePolicy(request, response).satisfiesWithoutRevalidation(staleRequest)).toBe(false)
  expect(new CachePolicy(request, { ...response, headers: { ...response.headers, 'cache-control': 'public, max-age=1' } }).satisfiesWithoutRevalidation(staleRequest)).toBe(true)
})

it('超大和嵌套累计 source map 偏移在可终止 worker 内拒绝，正常映射仍可使用', async () => {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { SourceMapConsumer, SourceMapGenerator } = require(workerData);
    const flat = { version: 3, sources: ['factory.ts'], names: [], mappings: 'AAAA' };
    const indexed = (line, map = flat) => ({ version: 3, sections: [{ offset: { line, column: 0 }, map }] });
    const refused = [indexed(1e12), indexed(-1), indexed(0.5), indexed(6000000, indexed(6000000))].map(map => {
      try { new SourceMapConsumer(map); return false; } catch { return true; }
    });
    const valid = new SourceMapConsumer(flat);
    const generated = SourceMapGenerator.fromSourceMap(valid).toJSON();
    parentPort.postMessage({ refused, position: valid.originalPositionFor({ line: 1, column: 0 }), sources: generated.sources, indexedSources: new SourceMapConsumer(indexed(2)).sources });
  `, { eval: true, workerData: require.resolve('source-map-js') })
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('source map worker exceeded deadline')), 5000)
      worker.once('message', value => { clearTimeout(timer); resolve(value) })
      worker.once('error', error => { clearTimeout(timer); reject(error) })
      worker.once('exit', code => { clearTimeout(timer); reject(new Error(`source map worker exited before a result: ${code}`)) })
    })
    expect(result).toMatchObject({ refused: [true, true, true, true], position: { source: 'factory.ts', line: 1, column: 0 }, sources: ['factory.ts'], indexedSources: ['factory.ts'] })
  } finally { await worker.terminate() }
})

it('宿主使用的 MCP 导出与 HTTP 传输仍可握手、发现工具并转换调用结果', async () => {
  const methods: string[] = []
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string }
    methods.push(message.method)
    if (message.id === undefined) { response.writeHead(202).end(); return }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'factory-server', version: '1.0.0' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'factory_echo', description: '工厂工具', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: '工厂调用完成' }] }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('factory server has no port')
  const client = new Client({ name: 'factory-host', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)))
    const tools = await client.listTools()
    expect(tools.tools.map(tool => tool.name)).toEqual(['factory_echo'])
    const definition = hostMcp.createMcpToolDefinition(new Context(), { name: 'mcp__factory__factory_echo', rawName: 'factory_echo', description: '工厂工具', inputSchema: tools.tools[0]!.inputSchema, call: () => client.callTool({ name: 'factory_echo', arguments: {} }) })
    const execution = { signal: AbortSignal.timeout(5000) } as Parameters<typeof definition.execute>[1]
    expect(await definition.execute({}, execution)).toMatchObject({ content: [{ type: 'text', text: '工厂调用完成' }] })
    expect(methods).toEqual(expect.arrayContaining(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']))
  } finally {
    await client.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
