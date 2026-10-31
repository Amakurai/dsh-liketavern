import type { CatalogRefusal, DeepSeekCatalogModel, ListingView } from '@deepseek-ai/dsh-llm-deepseek';
import type { ResolvedDeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key';
/** 一次请求解析使用的连接快照：offered 只用于目录广告，models 已含 listed 模型。 */
export interface PresetConnection extends ResolvedDeepSeekOptions {
    readonly offered: readonly DeepSeekCatalogModel[];
    readonly refusals: ReadonlyMap<string, CatalogRefusal>;
    /** 新宿主可能提供模型徽标；旧宿主没有此字段。 */
    readonly badges?: ReadonlyMap<string, unknown>;
}
/**
 * 把列表视图折叠进连接。没有视图（未跟随列表、尚未加载或加载失败）时与宿主一致：
 * 目录就是内置模型、没有拒绝项，本已可用的模型不因一次列表故障失效。
 * @param base - 宿主 `llm-deepseek-api-key` 解析出的连接。
 * @param view - 同一凭证与 endpoint 的最近一次列表视图；`undefined` 表示不跟随或尚未取得。
 * @returns 目录、请求解析用的模型表与预检拒绝项。
 */
export declare function withPresetCatalog(base: ResolvedDeepSeekOptions, view: ListingView | undefined): PresetConnection;
/** 宿主同款拒绝：需要更高客户端版本或本构建不支持的 listed 模型在网络 I/O 前失败。 */
export declare function admitPresetModel(connection: PresetConnection, model: string): void;
