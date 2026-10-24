/** Tavern DeepSeek 列表跟随：真实设置文件、LLM runtime 与手写 HTTP 工厂验证目录广告、预检拒绝与回退。 */
import { messagesResponse } from './messagesApiFactory.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Config as DeepSeekConfig, plainOptions, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { FileSettings } from './hostSettingsFactory.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PRESET_ADAPTER_PROVIDER, registerPresetAdapter } from '../src/node/presetAdapter.js'
import { admitPresetModel, withPresetCatalog } from '../src/node/presetModelCatalog.js'

vi.mock('@deepseek-ai/dsh-anonymous-user-id', () => ({ getOrCreateAnonymousUserId: () => 'factory-anonymous-user' }))

type Wire = { url: string; headers: Headers; body: { model: string; max_tokens?: number } }
type ListingCall = { url: string; headers: Headers }

/** 手写 `/models` 响应：覆盖内置模型条目、列表新增模型、需升级模型与不可用能力。 */
const listingBody = {
  data: [
    { id: 'deepseek-flash', name: 'DeepSeek Flash（列表）', context_window: 640_000, max_output_tokens: 32_000,
      input_modalities: ['text', 'image'],
      api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history', tool_update: 'addition-only' } } },
    { id: 'deepseek-listed-v5', name: 'DeepSeek V5（列表）', context_window: 131_072, max_output_tokens: 8_192,
      input_modalities: ['text'], api_capabilities: { anthropic_messages: {} },
      client_requirements: { 'deepseek-harness': { min_version: '0.1.0' } } },
    { id: 'deepseek-future', api_capabilities: { anthropic_messages: {} },
      client_requirements: { 'deepseek-harness': { min_version: '9.0.0' } } },
    { id: 'deepseek-no-messages', client_requirements: { 'deepseek-harness': { min_version: '0.1.0' } } },
  ],
}

let ctx: Context, llm: LlmRuntime, settings: FileSettings, root: string
let scope: { update(patch: object): Promise<void> }
let credential: ReturnType<typeof vi.fn<(ref: string) => Promise<{ value: string; source: string } | undefined>>>
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let listingAnswer: () => Response
const listings: ListingCall[] = []
const wires: Wire[] = []

const request = (config: Awaited<ReturnType<LlmRuntime['prepareCall']>>['config'], signal?: AbortSignal): GenerateOptions => ({
  ...config, signal, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '工厂输入' }] })],
})
async function collect(stream: AsyncIterable<StreamChunk>) { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks }

beforeEach(async () => {
  listings.length = 0; wires.length = 0
  root = await mkdtemp(join(tmpdir(), 'tavern-preset-listing-'))
  const file = join(root, 'settings.json')
  await writeFile(file, '{}')
  ctx = new Context()
  llm = new LlmRuntime(ctx)
  settings = new FileSettings(ctx, file)
  // 只覆盖凭证引用：baseURL 与 models 保持宿主默认，才会跟随 `/models` 列表。
  scope = await settings.register('llm-deepseek-api-key', DeepSeekConfig, { base: { apiKeyEnv: 'LISTED_KEY' } })
  credential = vi.fn(async (ref: string) => ({ value: `${ref}-value`, source: 'factory' }))
  ctx.provide('credentials', { resolve: credential } as unknown as CredentialProvider)
  listingAnswer = () => new Response(JSON.stringify(listingBody), { status: 200, headers: { 'content-type': 'application/json' } })
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/models')) { listings.push({ url, headers: new Headers(init?.headers) }); return listingAnswer() }
    wires.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Wire['body'] })
    return messagesResponse()
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

it('目录广告跟随宿主 /models 列表，并使用同一凭证与 endpoint', async () => {
  registerPresetAdapter(ctx, options => options).ensureRegistered()
  const advertised = await llm.listModels(PRESET_ADAPTER_PROVIDER)
  expect(advertised).toMatchObject([
    { provider: PRESET_ADAPTER_PROVIDER, id: 'deepseek-flash', name: 'DeepSeek Flash（列表）' },
    { provider: PRESET_ADAPTER_PROVIDER, id: 'deepseek-listed-v5', name: 'DeepSeek V5（列表）' },
  ])
  expect(advertised).toHaveLength(2)
  expect(listings).toEqual([{ url: 'https://api.deepseek.com/models', headers: expect.any(Headers) }])
  expect(listings[0]!.headers.get('x-api-key')).toBe('LISTED_KEY-value')
})

it('listed 模型按列表声明的上下文与输出上限准备请求', async () => {
  registerPresetAdapter(ctx, options => options).ensureRegistered()
  const prepared = await llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'deepseek-listed-v5' })
  expect(prepared.context).toEqual({ contextWindow: 131_072 })
  expect(prepared.config.maxTokens).toBe(8_192)
  const chunks = await collect(prepared.stream(request(prepared.config)))
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(wires).toMatchObject([{ url: 'https://api.deepseek.com/anthropic/v1/messages',
    body: { model: 'deepseek-listed-v5', max_tokens: 8_192 } }])
})

it('需升级与不支持的 listed 模型在发出请求前失败', async () => {
  registerPresetAdapter(ctx, options => options).ensureRegistered()
  await expect(llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'deepseek-future' }))
    .rejects.toMatchObject({ code: 'CLIENT_UPGRADE_REQUIRED' })
  await expect(llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'deepseek-no-messages' }))
    .rejects.toMatchObject({ code: 'MODEL_UNSUPPORTED' })
  expect(wires).toHaveLength(0)
})

it('列表请求失败时退回内置目录，本已可用的模型继续可请求', async () => {
  listingAnswer = () => new Response('listing down', { status: 503 })
  registerPresetAdapter(ctx, options => options).ensureRegistered()
  expect(await llm.listModels(PRESET_ADAPTER_PROVIDER)).toMatchObject([
    { id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' },
  ])
  const prepared = await llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'deepseek-flash' })
  expect(prepared.context).toEqual({ contextWindow: 1_048_576 })
  await collect(prepared.stream(request(prepared.config)))
  expect(wires).toMatchObject([{ body: { model: 'deepseek-flash' } }])
})

it('自定义模型目录不再请求列表，设置变更后按新快照重新解析', async () => {
  registerPresetAdapter(ctx, options => options).ensureRegistered()
  expect(await llm.listModels(PRESET_ADAPTER_PROVIDER)).toHaveLength(2)
  await scope.update({ baseURL: 'https://factory.invalid/v1', maxTokens: 1234,
    models: [{ id: 'factory', name: '工厂模型', contextWindow: 32_000 }] })
  expect(await llm.listModels(PRESET_ADAPTER_PROVIDER)).toMatchObject([{ id: 'factory', name: '工厂模型' }])
  expect(listings).toHaveLength(1)
  const prepared = await llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'factory' })
  expect(prepared.context).toEqual({ contextWindow: 32_000 })
  await collect(prepared.stream(request(prepared.config)))
  expect(wires.at(-1)).toMatchObject({ url: 'https://factory.invalid/v1/messages', body: { model: 'factory', max_tokens: 1234 } })
})

it('未取得列表时目录就是内置模型，拒绝项为空且放行内置模型', () => {
  const base = resolveAdapterOptions(plainOptions(DeepSeekConfig({ baseURL: 'https://api.deepseek.com/anthropic',
    apiKeyEnv: 'LISTED_KEY' })), undefined)
  const connection = withPresetCatalog(base, undefined)
  expect(connection.models).toBe(base.models)
  expect(connection.offered).toBe(base.models)
  expect(connection.refusals.size).toBe(0)
  expect(() => admitPresetModel(connection, 'deepseek-flash')).not.toThrow()
  expect(() => admitPresetModel({ ...connection, refusals: new Map([['deepseek-future', { kind: 'unsupported' }]]) },
    'deepseek-future')).toThrow(/not supported/)
  expect(base.listing).toMatchObject({ url: 'https://api.deepseek.com/models' })
})
