/** 新宿主模型目录契约：自动刷新所需配置、目录变更通知与模型徽标跨旧基线传递。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { Config as DeepSeekConfig } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FileSettings } from './hostSettingsFactory.js'
import { PRESET_ADAPTER_PROVIDER, registerPresetAdapter } from '../src/node/presetAdapter.js'

const future = vi.hoisted(() => ({ dependencies: undefined as undefined | { settings?: () => unknown; changed?: () => void } }))
vi.mock('@deepseek-ai/dsh-anonymous-user-id', () => ({ getOrCreateAnonymousUserId: () => 'factory-anonymous-user' }))
vi.mock('@deepseek-ai/dsh-llm-deepseek', async importOriginal => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-llm-deepseek')>()
  class NewListingCache extends actual.ModelListingCache {
    constructor(dependencies: ConstructorParameters<typeof actual.ModelListingCache>[0]) {
      super(dependencies)
      future.dependencies = dependencies as unknown as typeof future.dependencies
    }
    override async view(settings: Parameters<InstanceType<typeof actual.ModelListingCache>['view']>[0], signal?: AbortSignal) {
      const view = await super.view(settings, signal)
      future.dependencies?.changed?.()
      return view
    }
  }
  return { ...actual, ModelListingCache: NewListingCache,
    resolveListedCatalog: (...args: Parameters<typeof actual.resolveListedCatalog>) => ({ ...actual.resolveListedCatalog(...args),
      badges: new Map([['deepseek-flash', { text: 'New', tone: 'info' }]]) }),
    catalogModelInfo: (provider: string, model: Parameters<typeof actual.catalogModelInfo>[1], badge?: unknown) => ({
      ...actual.catalogModelInfo(provider, model), ...(badge === undefined ? {} : { badge }),
    }),
  }
})

let ctx: Context, root: string, llm: LlmRuntime
let scope: { update(patch: object): Promise<void> }
beforeEach(async () => {
  future.dependencies = undefined
  root = await mkdtemp(join(tmpdir(), 'tavern-new-host-listing-'))
  const file = join(root, 'settings.json'); await writeFile(file, '{}')
  ctx = new Context(); llm = new LlmRuntime(ctx)
  const settings = new FileSettings(ctx, file)
  scope = await settings.register('llm-deepseek-api-key', DeepSeekConfig, { base: { apiKeyEnv: 'FACTORY_KEY' } })
  ctx.provide('credentials', { resolve: async () => ({ value: 'synthetic', source: 'factory' }) } as unknown as CredentialProvider)
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ data: [
    { id: 'deepseek-flash', name: 'Flash', context_window: 64_000, api_capabilities: { anthropic_messages: {} } },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } })))
})
afterEach(async () => {
  await ctx.fiber.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

it('新宿主可读取最新刷新配置并在目录变化时通知 Tavern 模型列表', async () => {
  const notifications: string[] = []
  Reflect.apply(ctx.on, ctx, ['llm/models-updated', (provider: string) => { notifications.push(provider) }])
  registerPresetAdapter(ctx, options => options).ensureRegistered()
  await llm.listModels(PRESET_ADAPTER_PROVIDER)
  expect(notifications).toEqual([PRESET_ADAPTER_PROVIDER])
  expect(future.dependencies?.settings?.()).toMatchObject({ url: 'https://api.deepseek.com/models' })
  await scope.update({ baseURL: 'https://factory.invalid/v1' })
  expect(future.dependencies?.settings?.()).toBeUndefined()
})

it('新宿主在 Tavern 模型目录中保留列表徽标', async () => {
  const register = vi.spyOn(llm, 'registerAdapter')
  registerPresetAdapter(ctx, options => options).ensureRegistered()
  const adapter = register.mock.calls[0]![1]
  const models = await adapter.listModels(PRESET_ADAPTER_PROVIDER)
  expect(models).toMatchObject([{ id: 'deepseek-flash', badge: { text: 'New', tone: 'info' } }])
})
