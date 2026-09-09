import type { Context } from '@deepseek-ai/cordis';
import { type HelperWorldbookContext, type HelperWorldbookRequest, type HelperWorldbookResult, type HelperWorldbookRebindRequest } from '../core/helperWorldbook.js';
import type { TavernState } from './state.js';
export declare function getHelperWorldbookContext(state: TavernState, sessionId: string, storyId: string): Promise<HelperWorldbookContext>;
export declare function helperWorldbookOperation(ctx: Context, state: TavernState, sessionId: string, messageId: number, request: HelperWorldbookRequest): Promise<HelperWorldbookResult>;
/** 全局/角色选择属于会话配置；聊天选择及私有副本属于剧情，存成单次 WAL 写入。 */
export declare function rebindHelperWorldbooks(ctx: Context, state: TavernState, sessionId: string, messageId: number, request: HelperWorldbookRebindRequest): Promise<HelperWorldbookContext>;
