import type { Context } from '@deepseek-ai/cordis';
import { type HelperMessageEditRequest, type HelperMessageEditResult } from '../core/helperChatEdits.js';
import type { TavernState } from './state.js';
export declare function editHelperMessages(ctx: Context, state: TavernState, sessionId: string, messageId: number, request: HelperMessageEditRequest): Promise<HelperMessageEditResult>;
