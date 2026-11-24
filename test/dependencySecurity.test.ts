/** 依赖补丁的行为与宿主兼容回归：验证 OAuth 凭证归属、缓存强制复核、恶意 source map 拒绝和真实 MCP HTTP 握手；所有端点与凭证均为工厂数据。 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import { AuthorizationServerMismatchError, Client, ClientCredentialsProvider, fetchToken, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import * as hostMcp from '@deepseek-ai/dsh-mcp-client'
import { expect, it, vi } from 'vitest'
import { inspectAuditReports, TEMPORARY_UNPATCHED_DEV_ADVISORIES } from '../scripts/verify-audit.mjs'

const require = createRequire(import.meta.url)
const CachePolicy = require('http-cache-semantics') as new (
  request: { url: string; method: string; headers: Record<string, string> },
  response: { status: number; headers: Record<string, string> },
) => { satisfiesWithoutRevalidation(request: { url: string; method: string; headers: Record<string, string> }): boolean }

it('MCP OAuth 在发送凭证前拒绝不同 issuer，正确 issuer 仍能取得令牌', async () => {
  const issuer = 'https://issuer.factory.invalid'
  const provider = new ClientCredentialsProvider({ clientId: 'factory-client', clientSecret: 'example-secret', expectedIssuer: issuer })
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ access_token: 'example-token', token_type: 'Bearer' }), { headers: { 'content-type': 'application/json' } }))
  await expect(fetchToken(provider, 'https://other.factory.invalid', { fetchFn })).rejects.toBeInstanceOf(AuthorizationServerMismatchError)
  expect(fetchFn).not.toHaveBeenCalled()
  await expect(fetchToken(provider, issuer, { fetchFn })).resolves.toMatchObject({ access_token: 'example-token' })
  expect(String(fetchFn.mock.calls[0]![0])).toBe(`${issuer}/token`)
  expect(new Headers(fetchFn.mock.calls[0]![1]?.headers).get('authorization')).toBe(`Basic ${Buffer.from('factory-client:example-secret').toString('base64')}`)
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

it('锁文件安全审计守卫：默认零豁免，生产依赖零容忍，仅放行显式登记的无补丁开发链公告并在范围变化时自动失效', () => {
  expect(TEMPORARY_UNPATCHED_DEV_ADVISORIES).toEqual({})

  const cleanReport = {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { total: 0 } },
  }
  expect(inspectAuditReports(cleanReport, cleanReport)).toEqual({
    ok: true,
    errors: [],
    notices: [],
  })

  const factoryAllowlist = Object.freeze({
    'GHSA-fc5q-39xc-vjpf': Object.freeze({
      packageName: 'picomatch',
      unpatchedRange: '<=4.0.7',
    }),
  })

  const makePicomatchFullReport = (range = '<=4.0.7', fixAvailable: unknown = { name: 'vitest', version: '3.1.4', isSemVerMajor: true }) => ({
    auditReportVersion: 2,
    vulnerabilities: {
      picomatch: {
        name: 'picomatch',
        severity: 'high',
        isDirect: false,
        via: [
          {
            source: 1247710,
            name: 'picomatch',
            title: 'picomatch vulnerable to ReDoS through single-branch repeated extglobs',
            url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
            severity: 'high',
            range,
          },
        ],
        effects: ['tinyglobby', 'vitest', '@deepseek-ai/dsh-hmr'],
        fixAvailable,
      },
      tinyglobby: {
        name: 'tinyglobby',
        severity: 'high',
        via: ['picomatch'],
        effects: ['vitest'],
        fixAvailable,
      },
      vitest: {
        name: 'vitest',
        severity: 'high',
        via: ['picomatch', 'tinyglobby'],
        effects: [],
        fixAvailable,
      },
      '@deepseek-ai/dsh-hmr': {
        name: '@deepseek-ai/dsh-hmr',
        severity: 'high',
        via: ['picomatch'],
        effects: ['@deepseek-ai/dsh'],
        fixAvailable: true,
      },
      '@deepseek-ai/dsh': {
        name: '@deepseek-ai/dsh',
        severity: 'high',
        via: ['@deepseek-ai/dsh-hmr'],
        effects: [],
        fixAvailable: { isSemVerMajor: true },
      },
    },
    metadata: { vulnerabilities: { total: 5 } },
  })

  // 默认配置不含任何临时豁免，即使是历史公告也会被立即拒绝
  const defaultRejected = inspectAuditReports(cleanReport, makePicomatchFullReport())
  expect(defaultRejected.ok).toBe(false)
  expect(defaultRejected.errors.join('\n')).toContain('未豁免漏洞：picomatch (GHSA-fc5q-39xc-vjpf)')

  // 显式登记的开发链无补丁公告在生产审计为 0 时受控通过，并给出明确提示
  const allowed = inspectAuditReports(cleanReport, makePicomatchFullReport(), factoryAllowlist)
  expect(allowed.ok).toBe(true)
  expect(allowed.errors).toEqual([])
  expect(allowed.notices).toHaveLength(1)
  expect(allowed.notices[0]).toContain('GHSA-fc5q-39xc-vjpf')

  // 即使同一 GHSA 若进入生产依赖（--omit=dev）也必须立即拒绝
  const inProd = inspectAuditReports(makePicomatchFullReport(), makePicomatchFullReport(), factoryAllowlist)
  expect(inProd.ok).toBe(false)
  expect(inProd.errors.join('\n')).toContain('生产运行依赖存在已知漏洞')

  // 上游发布修复版本使受影响范围收缩或报告直接修复时，临时豁免自动失效
  const rangeUpdated = inspectAuditReports(cleanReport, makePicomatchFullReport('<4.0.8'), factoryAllowlist)
  expect(rangeUpdated.ok).toBe(false)
  expect(rangeUpdated.errors.join('\n')).toContain('受影响范围已变更')

  const fixReady = inspectAuditReports(cleanReport, makePicomatchFullReport('<=4.0.7', true), factoryAllowlist)
  expect(fixReady.ok).toBe(false)
  expect(fixReady.errors.join('\n')).toContain('已报告直接修复版本')

  // 其它未知 GHSA 或未归因的传递告警一律拒绝
  const otherReport = makePicomatchFullReport()
  ;(otherReport.vulnerabilities as Record<string, unknown>).unlisted = {
    name: 'unlisted',
    severity: 'moderate',
    via: [{ source: 999, name: 'unlisted', url: 'https://github.com/advisories/GHSA-0000-1111-2222', range: '<1.0.1' }],
  }
  const rejectedOther = inspectAuditReports(cleanReport, otherReport, factoryAllowlist)
  expect(rejectedOther.ok).toBe(false)
  expect(rejectedOther.errors.join('\n')).toContain('GHSA-0000-1111-2222')

  const orphanReport = makePicomatchFullReport()
  ;(orphanReport.vulnerabilities as Record<string, unknown>).orphan = {
    name: 'orphan',
    severity: 'high',
    via: ['missing-root'],
  }
  const rejectedOrphan = inspectAuditReports(cleanReport, orphanReport, factoryAllowlist)
  expect(rejectedOrphan.ok).toBe(false)
  expect(rejectedOrphan.errors.join('\n')).toContain('存在未归因于受控公告的依赖告警：orphan')
})
