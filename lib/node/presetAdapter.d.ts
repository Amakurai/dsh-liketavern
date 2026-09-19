/** Tavern 提示词投影适配器：复用宿主 DeepSeek 配置、凭证与传输，在同一 AgentLoop 请求内投影消息。 */
import type { Context } from '@deepseek-ai/cordis';
import { type GenerateOptions, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
export declare const PRESET_ADAPTER_PROVIDER = "tavern-deepseek";
export declare const PRESET_ADAPTER_SOURCE_PROVIDER = "deepseek-official";
export interface PresetAdapterController {
    /** 在选择 Tavern 路由前准备注册；宿主配置未就绪时明确失败，不猜测 endpoint 或凭证。 */
    ensureRegistered(): void;
}
/** 投影依据本次已准备的模型能力；单参数投影回调仍可直接使用。 */
export type PresetRequestProjection = (options: GenerateOptions, model: Readonly<LlmResolvedModelInfo>) => GenerateOptions;
/** 懒注册避免与宿主 namespace 安装顺序竞争；配置和密钥始终来自原有公开服务。 */
export declare function registerPresetAdapter(ctx: Context, project: PresetRequestProjection): PresetAdapterController;
