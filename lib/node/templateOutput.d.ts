/** 正常 stop 回复只在 turn/end 处理一次；冻结闭包可从当前剧情恢复，状态与展示快照原子落盘。 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { TavernState } from './state.js';
export declare function completeTemplateOutput(state: TavernState, session: Pick<Session, 'id' | 'snapshotEvents'>): Promise<void>;
