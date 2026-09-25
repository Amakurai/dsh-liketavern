/** Tavern 提示词投影适配器：复用宿主 DeepSeek 配置、凭证与传输，在同一 AgentLoop 请求内投影消息。 */
import type { Context } from '@deepseek-ai/cordis'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, callConfigEquals, LlmAdapter, LlmError, resolveImageAttachmentAccess,
  type AdapterRegistrationHandle, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo,
  type PreparedAdapterCall, type ResolvedRetryPolicy, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { DeepSeekAdapter, DeepSeekFileStore, catalogModelInfo } from '@deepseek-ai/dsh-llm-deepseek'
import { Config as DeepSeekConfig, plainOptions, resolveAdapterOptions, type ResolvedDeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-settings'

export const PRESET_ADAPTER_PROVIDER = 'tavern-deepseek'
export const PRESET_ADAPTER_SOURCE_PROVIDER = 'deepseek-official'
const SETTINGS_NS = 'llm-deepseek-api-key'

export interface PresetAdapterController {
  /** 在选择 Tavern 路由前准备注册；宿主配置未就绪时明确失败，不猜测 endpoint 或凭证。 */
  ensureRegistered(): void
}

/** 投影依据本次已准备的模型能力；单参数投影回调仍可直接使用。 */
export type PresetRequestProjection = (options: GenerateOptions, model: Readonly<LlmResolvedModelInfo>) => GenerateOptions

/** 只装饰自己持有的正式适配器；不重新进入 llm/stream，不访问宿主私有注册表。 */
class PresetAdapter extends LlmAdapter {
  constructor(private readonly delegate: DeepSeekAdapter, private readonly project: PresetRequestProjection) { super() }

  override providerInfo(provider: string) { return { id: provider, name: 'DeepSeek (Tavern)' } }
  override providerRetryPolicy(): ResolvedRetryPolicy { return this.delegate.providerRetryPolicy(PRESET_ADAPTER_SOURCE_PROVIDER) }
  override imageRequestPricing(_provider: string, model: string) { return this.delegate.imageRequestPricing(PRESET_ADAPTER_SOURCE_PROVIDER, model) }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return (await this.delegate.listModels(PRESET_ADAPTER_SOURCE_PROVIDER)).map(model => ({ ...model, provider }))
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return { ...await this.delegate.resolveModel(PRESET_ADAPTER_SOURCE_PROVIDER, model, signal), provider }
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const call = await this.delegate.prepareCall(PRESET_ADAPTER_SOURCE_PROVIDER, model, signal)
    // 模型能力与连接取自同一次 prepareCall，流开始时不再读取可能更新的设置。
    const modelInfo = deepFreeze(structuredClone({ ...call.model, provider }))
    return { model: modelInfo, stream: options => {
      // 先校验取消，投影只处理当前不可变快照；已准备的连接事实一直保留到真正传输。
      options.signal?.throwIfAborted()
      const projected = this.project(options, modelInfo)
      if (!callConfigEquals(options, projected) || projected.signal !== options.signal || projected.sessionId !== options.sessionId
        || projected.purpose !== options.purpose || projected.tools !== options.tools || projected.system !== options.system) {
        throw new LlmError('Tavern request projection may only replace the message list.', 'INVALID_PRESET_PROJECTION')
      }
      return call.stream({ ...projected, provider: PRESET_ADAPTER_SOURCE_PROVIDER })
    } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield* (await this.prepareCall(options.provider, options.model, options.signal)).stream(options)
  }
}

/** 懒注册避免与宿主 namespace 安装顺序竞争；配置和密钥始终来自原有公开服务。 */
export function registerPresetAdapter(ctx: Context, project: PresetRequestProjection): PresetAdapterController {
  let lastRaw: unknown, connection: ResolvedDeepSeekOptions | undefined
  const options = (): ResolvedDeepSeekOptions => {
    const directory = ctx.get('llm')?.listConfigurableProviders().find(item => item.provider === PRESET_ADAPTER_SOURCE_PROVIDER)
    const descriptor = ctx.get('settings')?.describe().find(item => item.ns === (directory?.settingsNs ?? SETTINGS_NS))
    const raw = (directory?.settingsPath ?? []).reduce<unknown>((value, key) => value && typeof value === 'object' ? Reflect.get(value, key) : undefined, descriptor?.value)
    if (raw === undefined) throw new LlmError('Tavern DeepSeek adapter is waiting for the host llm-deepseek-api-key settings namespace.', 'PRESET_ADAPTER_UNAVAILABLE')
    if (raw !== lastRaw || connection === undefined) {
      const next = resolveAdapterOptions(plainOptions(DeepSeekConfig(raw)), launchEnvironmentOf(ctx))
      lastRaw = raw; connection = next
    }
    return connection
  }
  // 与官方适配器一样使用公开的持久上传索引；同一实例保留上传复用和并发等待状态。
  const files = new DeepSeekFileStore()
  const delegate = new DeepSeekAdapter<ResolvedDeepSeekOptions>({
    discoverModels: async provider => options().models.map(model => catalogModelInfo(provider, model)),
    options,
    resolveAuth: async snapshot => {
      const credentials = ctx.get('credentials')
      const value = credentials === undefined ? launchEnvironmentOf(ctx).get(snapshot.apiKeyEnv)?.value
        : (await credentials.resolve(snapshot.apiKeyEnv))?.value
      if (value === undefined || value.length === 0) throw new LlmError(
        `Tavern cannot resolve the host DeepSeek credential reference ${snapshot.apiKeyEnv}.`, 'MISSING_CREDENTIAL')
      return { headers: { 'x-api-key': assertUsableApiKey(value, 'dsh-tavern', snapshot.apiKeyEnv) } }
    },
    resolveUserId: () => getOrCreateAnonymousUserId(),
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    resolveFiles: () => files,
    prepareExtensions: request => ctx.get('deepseekLlmApiExtensions')?.prepare(request)
      ?? Promise.resolve({ fields: {}, accept: async () => {} }),
  })
  const adapter = new PresetAdapter(delegate, project)
  let registration: AdapterRegistrationHandle | undefined, registeredPolicy: string | undefined
  const ensureRegistered = () => {
    const policy = JSON.stringify(options().retryPolicy)
    const llm = ctx.get('llm')
    if (!llm) throw new LlmError('Tavern DeepSeek adapter is waiting for the host LLM service.', 'PRESET_ADAPTER_UNAVAILABLE')
    if (!registration) registration = llm.registerAdapter([PRESET_ADAPTER_PROVIDER], adapter)
    else if (registeredPolicy !== policy) registration.replace([PRESET_ADAPTER_PROVIDER])
    registeredPolicy = policy
  }
  ctx.on('settings/document-updated', () => {
    if (registration) ensureRegistered()
  })
  return { ensureRegistered }
}
