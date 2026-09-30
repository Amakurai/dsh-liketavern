/**
 * 开启本会话原生 MVU。follow 只处理从未表态的绑定：会话启用的脚本含官方 MVU 入口即视为卡片作者要求变量更新；
 * explicit 是用户在设置中点选开启。两者都经 runHelperMvuEnable 认领宿主真正 idle 后保存，
 * 保存前在绑定锁内复核剧情与表态；显式关闭（false）不会被跟随模式改写。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { TavernState } from './state.js';
export type HelperMvuEnableMode = 'follow' | 'explicit';
export interface HelperMvuEnableResult {
    enabled: boolean;
    changed: boolean;
}
export declare function enableHelperMvu(ctx: Context, state: TavernState, request: {
    sessionId: string;
    storyId: string;
    mode: HelperMvuEnableMode;
}): Promise<HelperMvuEnableResult>;
