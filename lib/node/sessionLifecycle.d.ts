/** 宿主会话事件的副作用：开启/提交剧情 WAL，维护并清理每轮缓存。调用方负责按会话排队。 */
import type { TavernState } from './state.js';
export declare function onTurnStart(state: TavernState, sessionId: string, turn: number): Promise<void>;
export declare function onTurnEnd(state: TavernState, sessionId: string): Promise<void>;
