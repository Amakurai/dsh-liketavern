import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { assertUsableApiKey, callConfigEquals, LlmAdapter, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { Config as DeepSeekConfig, DeepSeekAdapter, DeepSeekFileStore, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { deepFreeze } from '@deepseek-ai/dsh-util-values';
export const PRESET_ADAPTER_PROVIDER = 'tavern-deepseek';
export const PRESET_ADAPTER_SOURCE_PROVIDER = 'deepseek-official';
const SETTINGS_NS = 'llm-deepseek';
/** 只装饰自己持有的正式适配器；不重新进入 llm/stream，不访问宿主私有注册表。 */
class PresetAdapter extends LlmAdapter {
    delegate;
    project;
    constructor(delegate, project) {
        super();
        this.delegate = delegate;
        this.project = project;
    }
    providerInfo(provider) { return { id: provider, name: 'DeepSeek (Tavern)' }; }
    providerRetryPolicy() { return this.delegate.providerRetryPolicy(PRESET_ADAPTER_SOURCE_PROVIDER); }
    imageRequestPricing(_provider, model) { return this.delegate.imageRequestPricing(PRESET_ADAPTER_SOURCE_PROVIDER, model); }
    async listModels(provider) {
        return (await this.delegate.listModels(PRESET_ADAPTER_SOURCE_PROVIDER)).map(model => ({ ...model, provider }));
    }
    async resolveModel(provider, model, signal) {
        return { ...await this.delegate.resolveModel(PRESET_ADAPTER_SOURCE_PROVIDER, model, signal), provider };
    }
    async prepareCall(provider, model, signal) {
        const call = await this.delegate.prepareCall(PRESET_ADAPTER_SOURCE_PROVIDER, model, signal);
        // 模型能力与连接取自同一次 prepareCall，流开始时不再读取可能更新的设置。
        const modelInfo = deepFreeze(structuredClone({ ...call.model, provider }));
        return { model: modelInfo, stream: options => {
                // 先校验取消，投影只处理当前不可变快照；已准备的连接事实一直保留到真正传输。
                options.signal?.throwIfAborted();
                const projected = this.project(options, modelInfo);
                if (!callConfigEquals(options, projected) || projected.signal !== options.signal || projected.sessionId !== options.sessionId
                    || projected.purpose !== options.purpose || projected.tools !== options.tools || projected.system !== options.system) {
                    throw new LlmError('Tavern request projection may only replace the message list.', 'INVALID_PRESET_PROJECTION');
                }
                return call.stream({ ...projected, provider: PRESET_ADAPTER_SOURCE_PROVIDER });
            } };
    }
    async *stream(options) {
        yield* (await this.prepareCall(options.provider, options.model, options.signal)).stream(options);
    }
}
/** 懒注册避免与宿主 namespace 安装顺序竞争；配置和密钥始终来自原有公开服务。 */
export function registerPresetAdapter(ctx, project) {
    let lastRaw, connection;
    const options = () => {
        const raw = ctx.get('settings')?.get(SETTINGS_NS);
        if (raw === undefined)
            throw new LlmError('Tavern DeepSeek adapter is waiting for the host llm-deepseek settings namespace.', 'PRESET_ADAPTER_UNAVAILABLE');
        if (raw !== lastRaw || connection === undefined) {
            const next = resolveAdapterOptions(DeepSeekConfig(raw), launchEnvironmentOf(ctx));
            lastRaw = raw;
            connection = next;
        }
        return connection;
    };
    // 与官方适配器一样使用公开的持久上传索引；同一实例保留上传复用和并发等待状态。
    const files = new DeepSeekFileStore();
    const delegate = new DeepSeekAdapter({
        options,
        resolveApiKey: async (snapshot) => {
            const credentials = ctx.get('credentials');
            const value = credentials === undefined ? launchEnvironmentOf(ctx).get(snapshot.apiKeyEnv)?.value
                : (await credentials.resolve(snapshot.apiKeyEnv))?.value;
            if (value === undefined || value.length === 0)
                throw new LlmError(`Tavern cannot resolve the host DeepSeek credential reference ${snapshot.apiKeyEnv}.`, 'MISSING_CREDENTIAL');
            return assertUsableApiKey(value, 'dsh-tavern', snapshot.apiKeyEnv);
        },
        resolveUserId: () => getOrCreateAnonymousUserId(),
        resolveAttachments: () => ctx.get('attachments'),
        resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
        resolveFiles: () => files,
        prepareExtensions: request => ctx.get('deepseekLlmApiExtensions')?.prepare(request)
            ?? Promise.resolve({ fields: {}, accept: async () => { } }),
    });
    const adapter = new PresetAdapter(delegate, project);
    let registration, registeredPolicy;
    const ensureRegistered = () => {
        const policy = JSON.stringify(options().retryPolicy);
        const llm = ctx.get('llm');
        if (!llm)
            throw new LlmError('Tavern DeepSeek adapter is waiting for the host LLM service.', 'PRESET_ADAPTER_UNAVAILABLE');
        if (!registration)
            registration = llm.registerAdapter([PRESET_ADAPTER_PROVIDER], adapter);
        else if (registeredPolicy !== policy)
            registration.replace([PRESET_ADAPTER_PROVIDER]);
        registeredPolicy = policy;
    };
    ctx.on('settings/updated', ns => {
        if (ns === SETTINGS_NS && registration)
            ensureRegistered();
    });
    return { ensureRegistered };
}
