import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { assertUsableApiKey, callConfigEquals, LlmAdapter, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import * as deepSeekCatalog from '@deepseek-ai/dsh-llm-deepseek';
import { DeepSeekAdapter, DeepSeekFileStore, catalogModelInfo } from '@deepseek-ai/dsh-llm-deepseek';
import { Config as DeepSeekConfig, plainOptions, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key';
import { deepFreeze } from '@deepseek-ai/dsh-util-values';
import { admitPresetModel, withPresetCatalog } from './presetModelCatalog.js';
export const PRESET_ADAPTER_PROVIDER = 'tavern-deepseek';
export const PRESET_ADAPTER_SOURCE_PROVIDER = 'deepseek-official';
const SETTINGS_NS = 'llm-deepseek-api-key';
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
    imageRequestTarget(_provider, model, image) {
        return this.delegate.imageRequestTarget(PRESET_ADAPTER_SOURCE_PROVIDER, model, image);
    }
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
    /** 宿主 `llm-deepseek-api-key` 的当前设置快照；同一对象复用上一次解析结果。 */
    const settingsConnection = () => {
        const directory = ctx.get('llm')?.listConfigurableProviders().find(item => item.provider === PRESET_ADAPTER_SOURCE_PROVIDER);
        const descriptor = ctx.get('settings')?.describe().find(item => item.ns === (directory?.settingsNs ?? SETTINGS_NS));
        const raw = (directory?.settingsPath ?? []).reduce((value, key) => value && typeof value === 'object' ? Reflect.get(value, key) : undefined, descriptor?.value);
        if (raw === undefined)
            throw new LlmError('Tavern DeepSeek adapter is waiting for the host llm-deepseek-api-key settings namespace.', 'PRESET_ADAPTER_UNAVAILABLE');
        if (raw !== lastRaw || connection === undefined) {
            const next = resolveAdapterOptions(plainOptions(DeepSeekConfig(raw)), launchEnvironmentOf(ctx));
            lastRaw = raw;
            connection = next;
        }
        return connection;
    };
    /** 与官方适配器一样读公开凭证服务；缺失明确失败，不猜测别的密钥。 */
    const apiKeyValue = async (snapshot) => {
        const credentials = ctx.get('credentials');
        const value = credentials === undefined ? launchEnvironmentOf(ctx).get(snapshot.apiKeyEnv)?.value
            : (await credentials.resolve(snapshot.apiKeyEnv))?.value;
        if (value === undefined || value.length === 0)
            throw new LlmError(`Tavern cannot resolve the host DeepSeek credential reference ${snapshot.apiKeyEnv}.`, 'MISSING_CREDENTIAL');
        return assertUsableApiKey(value, 'dsh-tavern', snapshot.apiKeyEnv);
    };
    /** 目录广告与列表加载共用的凭证探测：没有密钥只是等待状态，其它凭证故障照常上抛。 */
    const presentKey = async (snapshot) => {
        try {
            return await apiKeyValue(snapshot);
        }
        catch (error) {
            if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL')
                return undefined;
            throw error;
        }
    };
    // 列表缓存与宿主同源：只请求公开 `/models`，凭证仍来自 credentials 服务；失败退回内置目录。
    const listings = typeof deepSeekCatalog.ModelListingCache === 'function' && typeof deepSeekCatalog.requestModelListing === 'function'
        ? new deepSeekCatalog.ModelListingCache({
            // 新宿主的缓存通过这两个回调读取最新设置并通知目录变化；旧版构造器会忽略额外字段。
            ...{
                settings: () => settingsConnection().listing,
                // 基线宿主的类型尚未声明这个后来新增的事件；运行时按新宿主的公开事件契约发送。
                changed: () => Reflect.apply(ctx.emit, ctx, ['llm/models-updated', PRESET_ADAPTER_PROVIDER]),
            },
            credential: async () => presentKey(settingsConnection()),
            load: (url, apiKey, signal) => deepSeekCatalog.requestModelListing(url, { 'x-api-key': apiKey }, signal),
            now: () => Date.now(),
            info: message => ctx.logger.info(`dsh-tavern: DeepSeek 模型列表：${message}`),
            warn: message => ctx.logger.warn(`dsh-tavern: DeepSeek 模型列表：${message}`),
        }) : undefined;
    const listingCache = () => {
        if (!listings)
            throw new LlmError('The host cannot provide its configured DeepSeek model listing.', 'PRESET_ADAPTER_UNAVAILABLE');
        return listings;
    };
    /** 无 I/O 的同步视图：请求解析与图片投影读它，保证已冻结的 prepareCall 不再取设置。 */
    const options = () => {
        const base = settingsConnection();
        return withPresetCatalog(base, base.listing === undefined ? undefined : listingCache().current());
    };
    /** 首次访问或过期时加载列表；取消原样上抛，其它故障与宿主一致退回内置目录。 */
    const connect = async (signal) => {
        const base = settingsConnection();
        if (base.listing === undefined)
            return withPresetCatalog(base, undefined);
        // 缺少宿主接口不是列表请求故障；不能把它吞掉后绕过列表声明的拒绝项。
        const cache = listingCache();
        let view;
        try {
            view = await cache.view(base.listing, signal);
        }
        catch (error) {
            if (signal?.aborted === true)
                throw error;
            return withPresetCatalog(base, undefined);
        }
        return withPresetCatalog(base, view);
    };
    // 与官方适配器一样使用公开的持久上传索引；同一实例保留上传复用和并发等待状态。
    const files = new DeepSeekFileStore();
    const delegate = new DeepSeekAdapter({
        // 目录广告跟随列表：宿主只在有凭证时展示模型，Tavern 分组保持同一口径。
        discoverModels: async (provider) => {
            const base = settingsConnection();
            if (base.listing === undefined) {
                return (await presentKey(base)) === undefined ? [] : base.models.map(model => catalogModelInfo(provider, model));
            }
            const view = await listingCache().view(base.listing);
            if (!view.authenticated)
                return [];
            const catalog = withPresetCatalog(base, view);
            // 新宿主支持第三个徽标参数；旧宿主的公开函数忽略额外参数。
            return catalog.offered.map(model => Reflect.apply(catalogModelInfo, undefined, [provider, model, catalog.badges?.get(model.id)]));
        },
        options,
        connect,
        // 需要升级或不支持的 listed 模型在发出请求前失败，与宿主官方路由同款错误码。
        admit: admitPresetModel,
        resolveAuth: async (snapshot) => ({ headers: { 'x-api-key': await apiKeyValue(snapshot) } }),
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
    /** 设置里「是否跟随列表」变化时丢弃旧列表；endpoint 与凭证变化由缓存作用域自行处理。 */
    let following = false;
    const followListing = () => {
        let next;
        try {
            next = settingsConnection().listing !== undefined;
        }
        catch {
            return;
        }
        if (next !== following)
            listings?.invalidate();
        following = next;
    };
    followListing();
    ctx.on('settings/document-updated', () => {
        // 设置对象可能原地更新：先丢弃解析缓存，再按新快照判断跟随状态与重试策略。
        lastRaw = undefined;
        connection = undefined;
        followListing();
        if (!registration)
            return;
        // 非法设置只应影响下一次请求，不能让设置页的重注册失败中断整次更新。
        try {
            ensureRegistered();
        }
        catch (error) {
            ctx.logger.warn(`dsh-tavern: DeepSeek 布局通道设置暂不可用：${String(error)}`);
        }
    });
    ctx.effect(() => () => listings?.dispose(), 'dsh-tavern: DeepSeek model listing');
    return { ensureRegistered };
}
