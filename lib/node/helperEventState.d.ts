/** 实时消息通知的只读屏障：固定剧情内映射宿主序号，只有已成功收口的楼层允许发送完成事件。 */
import type { Context } from '@deepseek-ai/cordis';
import type { TavernMethodRequests, TavernMethodResults } from '../remote.js';
import type { TavernState } from './state.js';
export declare function getHelperEventState(ctx: Context, state: TavernState, request: TavernMethodRequests['getHelperEventState']): Promise<TavernMethodResults['getHelperEventState']>;
