/**
 * AI 代答用户（impersonate）：以 {{user}} 口吻写一句台词。
 *
 * 不走会话 turn：不开楼层、不记 WAL、不入会话日志——结果由客户端填进输入框
 * （dsh 输入区没有插件可写 API 时退化为剪贴板），用户确认后才真正发出。
 * 这里用当前会话的 provider/model 直调一次模型（hand-built one-shot），
 * 提示词复用 runTavernPipeline 的组装（mode preview：WI 定时器不落盘、不碰 WAL）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { TavernState } from './state.js';
export interface ImpersonateDeps {
    ctx: Context;
    state: TavernState;
}
/**
 * 生成一句用户台词。要求会话在线且活 agent 在位（历史经 agent.session 派生）。
 * 返回纯文本，调用方（client）负责填入输入框或剪贴板。
 */
export declare function impersonate({ ctx, state }: ImpersonateDeps, sessionId: string): Promise<{
    text: string;
}>;
