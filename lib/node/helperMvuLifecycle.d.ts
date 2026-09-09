/** MVU 宿主门控：停止前等待浏览器提交，空闲期保留输入；兜底拒绝只恢复原生队列，不伪造模型请求。 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session';
import type { TavernState } from './state.js';
type Snapshot = Pick<Session, 'id' | 'snapshotEvents'>;
/** 开启配置必须先同步认领宿主真正 idle；不能在新的空 WAL 出现后再尝试初始化旧回复。 */
export declare function runHelperMvuEnable<T>(ctx: Context, state: TavernState, sessionId: string, save: () => Promise<T>): Promise<T>;
/** 空历史没有可初始化的回复，允许首轮生成；开场白由维护等待的 session task 先写入。 */
export declare function helperMvuHasAssistant(session: Snapshot): boolean;
export declare function waitForHelperMvu(state: TavernState, agent: Agent, signal: AbortSignal, includeInitialization?: boolean): Promise<void>;
/** inbox 插入通知在 send 唤醒之前同步到达；先认领真正 idle，才在维护内部读取配置和等待。 */
export declare function reserveHelperMvuMaintenance(state: TavernState, agent: Agent, report: (error: unknown) => void): void;
/** 正常 stop 候选在宿主 turn/end 与下一条输入 claim 前排入持久任务；取消不清掉任务。 */
export declare function stopForHelperMvu(state: TavernState, agent: Agent, signal: AbortSignal): Promise<void>;
/** 只从公开 claim 删除记录取得原目标；取消删除带 outcome=canceled，不被当作待恢复输入。 */
export declare function observeHelperMvuSessionEvent(agent: Agent, event: SessionEvent): void;
export declare function observeHelperMvuClaim(agent: Agent, message: UserMessage, turn: number): void;
/** 恢复尚未进入 user/message 的原输入，不 wake；下一条真实输入可以唤醒保留队列。 */
export declare function restoreHelperMvuInputs(agent: Agent, turn: number, messages?: readonly UserMessage[]): void;
export declare function isHelperMvuBlocked(agent: Agent, turn: number): boolean;
/** 在 await next() 之前判断；abort 可能让宿主跳过 pre-step，因此被挡轮次同时安装取消恢复。 */
export declare function blockHelperMvuAssembly(state: TavernState, agent: Agent, signal?: AbortSignal): Promise<boolean>;
/** 宿主事件只保留身份和队列目标；第三方回调始终由原有 opaque iframe 执行。 */
export declare function registerHelperMvuLifecycle(ctx: Context): void;
export {};
