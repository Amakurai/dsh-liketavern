/** 宿主会话事件的副作用：开启/提交剧情 WAL，持久模板恢复及每轮缓存清理。调用方负责按会话排队。 */
import type { TavernState } from './state.js';
import type { Session } from '@deepseek-ai/dsh-session';
export declare function onTurnStart(state: TavernState, sessionId: string, turn: number): Promise<void>;
export declare function onTurnEnd(state: TavernState, sessionId: string, session?: Pick<Session, 'id' | 'snapshotEvents'>): Promise<void>;
