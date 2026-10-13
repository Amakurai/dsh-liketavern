/** 正常 stop 回复只在 turn/end 处理一次；冻结闭包可从当前剧情恢复，状态与展示快照原子落盘。 */
import type { Session } from '@deepseek-ai/dsh-session';
import type { TavernState } from './state.js';
/** 计算已成功但提交未确认：保留原 prepared 与 WAL，不能按模板脚本异常放弃回复。 */
export declare class TemplateOutputCommitError extends Error {
    constructor(cause: unknown);
}
export declare function completeTemplateOutput(state: TavernState, session: Pick<Session, 'id' | 'snapshotEvents'>): Promise<void>;
