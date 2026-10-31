/** 旧宿主没有模型列表 API 时，仍以公开内置目录和同一次官方传输完成 Tavern 请求。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { Config as DeepSeekConfig, plainOptions, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { afterEach, expect, it, vi } from 'vitest'
import { FileSettings } from './hostSettingsFactory.js'
import { messagesResponse } from './messagesApiFactory.js'
import { PRESET_ADAPTER_PROVIDER, registerPresetAdapter } from '../src/node/presetAdapter.js'
import { admitPresetModel, withPresetCatalog } from '../src/node/presetModelCatalog.js'

vi.mock('@deepseek-ai/dsh-anonymous-user-id', () => ({ getOrCreateAnonymousUserId: () => 'factory-anonymous-user' }))
vi.mock('@deepseek-ai/dsh-llm-deepseek', async importOriginal => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-llm-deepseek')>()
  return { ...actual, ModelListingCache: undefined, requestModelListing: undefined, resolveListedCatalog: undefined, refuseListedModel: undefined }
})

let ctx: Context | undefined, root: string | undefined
afterEach(async () => {
  await ctx?.fiber.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (root) await rm(root, { recursive: true, force: true })
})

it('没有列表 API 的宿主仍可注册内置模型并发送投影后的请求', async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-legacy-catalog-'))
  const file = join(root, 'settings.json'); await writeFile(file, '{}')
  ctx = new Context()
  const llm = new LlmRuntime(ctx), settings = new FileSettings(ctx, file)
  await settings.register('llm-deepseek-api-key', DeepSeekConfig, { base: {
    baseURL: 'https://factory.invalid/v1', apiKeyEnv: 'FACTORY_KEY',
    models: [{ id: 'factory', name: '工厂模型', contextWindow: 64000 }],
  } })
  ctx.provide('credentials', { resolve: async () => ({ value: 'synthetic', source: 'factory' }) } as unknown as CredentialProvider)
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(messagesResponse('旧宿主回复'))
  vi.stubGlobal('fetch', fetch)
  registerPresetAdapter(ctx, options => ({ ...options, messages: [...options.messages,
    createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '投影内容' }] })] })).ensureRegistered()
  expect((await llm.listModels(PRESET_ADAPTER_PROVIDER)).map(model => model.id)).toEqual(['factory'])
  const prepared = await llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'factory' })
  const messages = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '用户输入' }] })]
  const chunks = []; for await (const chunk of prepared.stream({ ...prepared.config, messages })) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(fetch).toHaveBeenCalledOnce()
  const wire = JSON.parse(String(fetch.mock.calls[0]![1]?.body)) as { messages: unknown }
  expect(JSON.stringify(wire.messages)).toContain('投影内容')
})

it('旧宿主不能将未知列表拒绝项当作已检查通过', () => {
  const base = resolveAdapterOptions(plainOptions(DeepSeekConfig({ baseURL: 'https://factory.invalid/v1' })), undefined)
  const connection = withPresetCatalog(base, undefined)
  expect(() => admitPresetModel(connection, 'factory')).not.toThrow()
  expect(() => admitPresetModel({ ...connection, refusals: new Map([['factory', { kind: 'unsupported' }]]) }, 'factory'))
    .toThrow('宿主无法检查模型目录拒绝项')
})

it('切换到需要模型列表的配置后，缺少列表接口时不能退回内置目录发信', async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-legacy-listing-'))
  const file = join(root, 'settings.json'); await writeFile(file, '{}')
  ctx = new Context()
  const llm = new LlmRuntime(ctx), settings = new FileSettings(ctx, file)
  const scope = await settings.register('llm-deepseek-api-key', DeepSeekConfig, { base: {
    baseURL: 'https://factory.invalid/v1', apiKeyEnv: 'FACTORY_KEY',
  } })
  ctx.provide('credentials', { resolve: async () => ({ value: 'synthetic', source: 'factory' }) } as unknown as CredentialProvider)
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(messagesResponse())
  vi.stubGlobal('fetch', fetch)
  registerPresetAdapter(ctx, options => options).ensureRegistered()
  await scope.update({ baseURL: 'https://api.deepseek.com/anthropic' })
  await expect(llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'deepseek-flash' }))
    .rejects.toMatchObject({ code: 'PRESET_ADAPTER_UNAVAILABLE' })
  expect(fetch).not.toHaveBeenCalled()
})
