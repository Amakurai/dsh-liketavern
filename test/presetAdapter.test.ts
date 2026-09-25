import { messagesResponse } from './messagesApiFactory.js'
/** DeepSeek 投影适配器回归：真实设置文件、LLM runtime 与官方传输配合工厂网络验证路由、冻结、取消和消息保真。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { DeepSeekLlmApiExtensionRegistry } from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { createAssistantMessage, createMessage, createSystemMessage, createToolResultMessage, createUserMessage,
  LlmRuntime, ReasoningEffortId, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Config as DeepSeekConfig } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'
import { FileSettings } from './hostSettingsFactory.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER, registerPresetAdapter } from '../src/node/presetAdapter.js'

vi.mock('@deepseek-ai/dsh-anonymous-user-id', () => ({ getOrCreateAnonymousUserId: () => 'factory-anonymous-user' }))

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions' {
  interface DeepSeekLlmApiExtensionMap { tavern_factory: { ready: boolean } }
}

/** 设置写入真实临时文件，保留宿主的默认/base/用户覆盖解析与变更通知。 */

type Wire = { url: string; headers: Headers; body: { model: string; max_tokens?: number; stop?: string[];
  messages: { role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }[];
  tools?: unknown[]; tavern_factory?: { ready: boolean } } }
let ctx: Context, llm: LlmRuntime, settings: FileSettings, scope: { update(patch: object): Promise<void> }, root: string
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
let credential: ReturnType<typeof vi.fn<(ref: string) => Promise<{ value: string; source: string } | undefined>>>
const wires: Wire[] = []
const request = (config: Awaited<ReturnType<LlmRuntime['prepareCall']>>['config'], signal?: AbortSignal): GenerateOptions => ({
  ...config, signal, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '工厂输入' }] })],
})
async function collect(stream: AsyncIterable<StreamChunk>) { const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
/** 只返回手写 SSE；测试中的任何 fetch 都不访问网络。 */
function response(): Response { return messagesResponse() }

beforeEach(async () => {
  wires.length = 0
  root = await mkdtemp(join(tmpdir(), 'tavern-preset-adapter-'))
  const file = join(root, 'settings.json')
  await writeFile(file, '{}')
  ctx = new Context()
  llm = new LlmRuntime(ctx)
  settings = new FileSettings(ctx, file)
  scope = await settings.register('llm-deepseek-api-key', DeepSeekConfig, { base: {
    baseURL: 'https://factory.invalid/v1', apiKeyEnv: 'FACTORY_KEY', maxTokens: 1234,
    models: [{ id: 'factory', name: '工厂模型', contextWindow: 64000, inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history' }],
    retryPolicy: { mode: 'normal', maxRetries: 2 },
  } })
  credential = vi.fn(async (ref: string) => ({ value: `${ref}-value`, source: 'factory' }))
  ctx.provide('credentials', { resolve: credential } as unknown as CredentialProvider)
  fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    wires.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Wire['body'] })
    return response()
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

it('复用宿主最终设置和凭证，投影角色后单次经过 middleware，并保留原消息和工具', async () => {
  const tail = [createSystemMessage('深度规则', 'factory'), createMessage({ role: 'assistant', source: { kind: 'plugin', plugin: 'factory' },
    content: [{ type: 'text', text: '前缀文本' }] })]
  const controller = registerPresetAdapter(ctx, options => ({ ...options, messages: [...options.messages, ...tail] }))
  controller.ensureRegistered()
  const observed: GenerateOptions[] = []
  ctx.on('llm/stream', (options, next) => { observed.push(options); return next() })
  const prepared = await llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'factory', temperature: 0.4, stop: ['STOP'] })
  const callId = ToolCallId('factory-call')
  const original = request(prepared.config)
  original.messages.unshift(createSystemMessage('宿主工具说明', 'factory-host'))
  original.messages.push(createAssistantMessage({ source: { provider: PRESET_ADAPTER_PROVIDER, model: 'factory' },
    content: [{ type: 'tool-call', id: callId, name: 'factory_tool', arguments: '{}' }] }),
  createToolResultMessage({ callId, content: [{ type: 'text', text: '工具结果' }], isError: false }))
  original.tools = [{ name: 'factory_tool', description: '工厂工具', parameters: { type: 'object', properties: {} } }]
  const originalMessages = [...original.messages]
  Object.freeze(original.messages); Object.freeze(original)
  const chunks = await collect(prepared.stream(original))
  expect(observed).toEqual([original])
  expect(original.messages).toEqual(originalMessages)
  expect(wires).toHaveLength(1)
  expect(wires[0]!.url).toBe('https://factory.invalid/v1/messages')
  expect(wires[0]!.headers.get('x-api-key')).toBe('FACTORY_KEY-value')
  expect(wires[0]!.headers.get('user-agent')).toBeTruthy()
  expect(wires[0]!.body.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'system', 'assistant'])
  expect(wires[0]!.body.system).toBe('宿主工具说明')
  expect(wires[0]!.body.messages[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: callId, content: [{ type: 'text', text: '工具结果' }], is_error: false }])
  expect(wires[0]!.body.tools).toHaveLength(1)
  expect(wires[0]!.body.max_tokens).toBe(1234)
  expect(wires[0]!.body.stop_sequences).toEqual(['STOP'])
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(chunks.at(-2)?.type).toBe('usage')
  expect(settings.describe().map(item => item.ns)).toEqual(['llm-deepseek-api-key'])
  expect(credential).toHaveBeenCalledExactlyOnceWith('FACTORY_KEY')
})

it('模型能力和连接同代冻结，更新后才准备的新请求使用新能力、凭证及重试策略', async () => {
  const projectedModels: Readonly<LlmResolvedModelInfo>[] = []
  const controller = registerPresetAdapter(ctx, (options, model) => {
    projectedModels.push(model)
    return options
  })
  controller.ensureRegistered()
  expect(await llm.listModels(PRESET_ADAPTER_PROVIDER)).toMatchObject([{ provider: PRESET_ADAPTER_PROVIDER, id: 'factory', name: '工厂模型' }])
  const before = await llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'factory' })
  expect(before.context).toEqual({ contextWindow: 64000 })
  expect(before.inputModalities).toEqual(['text', 'image'])
  expect(before.systemPromptUpdate).toBe('in-history')
  expect(before.retryPolicy).toMatchObject({ mode: 'normal', maxRetries: 2 })
  await scope.update({ baseURL: 'https://second.invalid/v1', apiKeyEnv: 'SECOND_KEY', maxTokens: 4321,
    models: [{ id: 'factory', name: '第二代工厂模型', contextWindow: 32000, inputModalities: ['text'] }],
    retryPolicy: { mode: 'normal', maxRetries: 4 } })
  await collect(before.stream(request(before.config)))
  const after = await llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'factory' })
  await collect(after.stream(request(after.config)))
  expect(wires.map(wire => [wire.url, wire.body.max_tokens, wire.headers.get('x-api-key')])).toEqual([
    ['https://factory.invalid/v1/messages', 1234, 'FACTORY_KEY-value'],
    ['https://second.invalid/v1/messages', 4321, 'SECOND_KEY-value'],
  ])
  expect(after.retryPolicy).toMatchObject({ mode: 'normal', maxRetries: 4 })
  expect(before.retryPolicy).toMatchObject({ mode: 'normal', maxRetries: 2 })
  expect(projectedModels).toHaveLength(2)
  expect(projectedModels[0]).toMatchObject({ provider: PRESET_ADAPTER_PROVIDER, id: 'factory', name: '工厂模型',
    context: { contextWindow: 64000 }, defaultMaxTokens: 1234, inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history' })
  expect(projectedModels[1]).toMatchObject({ provider: PRESET_ADAPTER_PROVIDER, id: 'factory', name: '第二代工厂模型',
    context: { contextWindow: 32000 }, defaultMaxTokens: 4321, inputModalities: ['text'] })
  expect(projectedModels[1]!.systemPromptUpdate).toBeUndefined()
  expect(after.systemPromptUpdate).toBeUndefined()
  expect(after.context).toEqual({ contextWindow: 32000 })
  for (const model of projectedModels) {
    expect(Object.isFrozen(model)).toBe(true)
    expect(Object.isFrozen(model.context)).toBe(true)
    expect(Object.isFrozen(model.inputModalities)).toBe(true)
    expect(() => { model.context!.contextWindow = 1 }).toThrow(TypeError)
  }
})

it('宿主 namespace 未安装时不注册、不猜 endpoint，也不触碰凭证或网络', async () => {
  const pending = new Context()
  try {
    const runtime = new LlmRuntime(pending)
    const controller = registerPresetAdapter(pending, options => options)
    expect(() => controller.ensureRegistered()).toThrow(/llm-deepseek-api-key settings namespace/)
    expect(runtime.listProviders()).toEqual([])
    expect(credential).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  } finally { await pending.fiber.dispose() }
})

it('部署 reasoning 策略原样传递，不把不支持的档位发出去', async () => {
  await scope.update({ thinking: 'disabled', reasoningEffort: 'off' })
  registerPresetAdapter(ctx, options => options).ensureRegistered()
  await expect(llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'factory', reasoningEffort: ReasoningEffortId('high') }))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_REASONING_EFFORT' })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('宿主凭证服务报告缺失时不退回环境中另一个密钥', async () => {
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { FACTORY_KEY: 'wrong-ambient' } }]))
  credential.mockResolvedValue(undefined)
  registerPresetAdapter(ctx, options => options).ensureRegistered()
  const prepared = await llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'factory' })
  expect((await collect(prepared.stream(request(prepared.config)))).at(-1)).toMatchObject({
    type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})

it('API 扩展仍在官方传输内准备和确认，仅收到真正发送的投影消息', async () => {
  const extensions = new DeepSeekLlmApiExtensionRegistry(ctx)
  const accept = vi.fn(async () => {})
  const prepare = vi.fn(() => ({ value: { ready: true }, accept }))
  extensions.register('tavern_factory', { prepare })
  registerPresetAdapter(ctx, options => ({ ...options, messages: [...options.messages, createSystemMessage('扩展前规则', 'factory')] })).ensureRegistered()
  const prepared = await llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'factory' })
  await collect(prepared.stream(request(prepared.config)))
  expect(prepare).toHaveBeenCalledOnce()
  expect(accept).toHaveBeenCalledOnce()
  expect(wires[0]!.body.tavern_factory).toEqual({ ready: true })
  expect(wires[0]!.body.messages.at(-1)).toMatchObject({ role: 'system', content: [{ type: 'text', text: '扩展前规则' }] })
})

it('向同代 delegate 转交官方 provider、原图片对象和工具结构，不再次走 runtime', async () => {
  let delegated: GenerateOptions | undefined
  const spy = vi.spyOn(DeepSeekAdapter.prototype, 'prepareCall').mockImplementation(async function (provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: async function* (options) {
      delegated = options
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  })
  registerPresetAdapter(ctx, options => options).ensureRegistered()
  const abort = new AbortController()
  const prepared = await llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'factory' }, abort.signal)
  const original = request(prepared.config, abort.signal)
  original.messages.push(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: {
    attachmentId: AttachmentId('a'.repeat(64)), mediaType: 'image/png', bytes: 32, width: 1, height: 1, name: 'factory.png',
  } }] }))
  await collect(prepared.stream(original))
  expect(spy).toHaveBeenCalledExactlyOnceWith(PRESET_ADAPTER_SOURCE_PROVIDER, 'factory', abort.signal)
  expect(delegated?.provider).toBe(PRESET_ADAPTER_SOURCE_PROVIDER)
  expect(delegated?.signal).toBe(abort.signal)
  expect(delegated?.messages[1]).toBe(original.messages[1])
  expect(fetchMock).not.toHaveBeenCalled()
})

it('取消中断同一传输，返回 aborted 终态；不开始第二次请求', async () => {
  fetchMock.mockImplementation(async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  registerPresetAdapter(ctx, options => options).ensureRegistered()
  const abort = new AbortController()
  const prepared = await llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'factory' }, abort.signal)
  const result = collect(prepared.stream(request(prepared.config, abort.signal)))
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
  abort.abort(new Error('工厂取消'))
  expect((await result).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
  expect(fetchMock).toHaveBeenCalledOnce()
})

it('消息投影不能顺便修改已冻结的采样配置', async () => {
  registerPresetAdapter(ctx, options => ({ ...options, maxTokens: 1 })).ensureRegistered()
  const prepared = await llm.prepareCall({ provider: PRESET_ADAPTER_PROVIDER, model: 'factory' })
  expect((await collect(prepared.stream(request(prepared.config)))).at(-1)).toMatchObject({
    type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_PRESET_PROJECTION' } },
  })
  expect(fetchMock).not.toHaveBeenCalled()
})
