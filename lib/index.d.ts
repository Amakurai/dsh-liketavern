/**
 * dsh-liketavern host 入口。
 * 职责：注册设置命名空间、初始化数据目录、安装 agent 预设、提供 tavern 服务、
 * 注册 typert remote 描述符、维护楼层 WAL 与每 turn 缓存（session/event 监听）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import '@deepseek-ai/dsh-typert-registry';
import { Config } from './node/config.js';
import { createPresetRequestProjector } from './node/presetRequestProjection.js';
import { TavernState } from './node/state.js';
export declare const name = "dsh-liketavern";
export { Config };
export declare const inject: string[];
export declare function apply(ctx: Context, config: ReturnType<typeof Config>): Promise<void>;
/**
 * 投影适配器发信前处理：
 * 摘要/独立代答不经投影；未挂载或非 Tavern 会话直接原样返回，防止 projector.project 抛出未找到会话错误；
 * Tavern 会话经 createPresetRequestProjector 投影并记录诊断。
 */
export declare function projectTavernAdapterRequest(ctx: Context, state: TavernState, options: GenerateOptions, model: Parameters<ReturnType<typeof createPresetRequestProjector>['project']>[1]): GenerateOptions;
