/** Tavern DeepSeek 路由的模型目录：跟随宿主 `/models` 列表，未取得列表时退回内置目录。 */
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import * as deepSeekCatalog from '@deepseek-ai/dsh-llm-deepseek'
import type { CatalogRefusal, DeepSeekCatalogModel, ListingView } from '@deepseek-ai/dsh-llm-deepseek'
import type { ResolvedDeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'

/** 一次请求解析使用的连接快照：offered 只用于目录广告，models 已含 listed 模型。 */
export interface PresetConnection extends ResolvedDeepSeekOptions {
  readonly offered: readonly DeepSeekCatalogModel[]
  readonly refusals: ReadonlyMap<string, CatalogRefusal>
  /** 新宿主可能提供模型徽标；旧宿主没有此字段。 */
  readonly badges?: ReadonlyMap<string, unknown>
}

/**
 * 把列表视图折叠进连接。没有视图（未跟随列表、尚未加载或加载失败）时与宿主一致：
 * 目录就是内置模型、没有拒绝项，本已可用的模型不因一次列表故障失效。
 * @param base - 宿主 `llm-deepseek-api-key` 解析出的连接。
 * @param view - 同一凭证与 endpoint 的最近一次列表视图；`undefined` 表示不跟随或尚未取得。
 * @returns 目录、请求解析用的模型表与预检拒绝项。
 */
export function withPresetCatalog(base: ResolvedDeepSeekOptions, view: ListingView | undefined): PresetConnection {
  if (view === undefined) return { ...base, offered: base.models, refusals: new Map() }
  if (typeof deepSeekCatalog.resolveListedCatalog !== 'function') throw new Error('宿主不支持模型列表目录')
  const catalog = deepSeekCatalog.resolveListedCatalog({ listing: view.listing?.entries, supported: base.models, overrides: {},
    routeMaxTokens: base.maxTokens, clientVersion: APP_IDENTITY.version })
  const badges: unknown = Reflect.get(catalog, 'badges')
  if (badges !== undefined && (badges === null || typeof badges !== 'object' || typeof Reflect.get(badges, 'get') !== 'function')) {
    throw new Error('宿主模型列表徽标格式无效')
  }
  // resolution 含「列表未列出但本构建仍支持」的模型，请求解析必须用它；offered 只广告真正的列表条目。
  return { ...base, models: catalog.resolution, offered: catalog.offered, refusals: catalog.refusals,
    ...(badges === undefined ? {} : { badges: badges as ReadonlyMap<string, unknown> }) }
}

/** 宿主同款拒绝：需要更高客户端版本或本构建不支持的 listed 模型在网络 I/O 前失败。 */
export function admitPresetModel(connection: PresetConnection, model: string): void {
  const refusal = connection.refusals.get(model)
  if (typeof deepSeekCatalog.refuseListedModel === 'function') deepSeekCatalog.refuseListedModel(model, refusal)
  else if (refusal) throw new Error('宿主无法检查模型目录拒绝项')
}
