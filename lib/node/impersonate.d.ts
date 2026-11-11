/**
 * AI 代答用户（impersonate）：以 {{user}} 口吻写一句台词。
 *
 * 不走会话 turn：不开楼层、不记 WAL、不入会话日志——结果由客户端优先直接填入宿主输入框
 * （输入区不可达或正忙时退化为剪贴板与弹窗），用户确认后才真正发出；若输入框已有草稿可作为方向参考。
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
 * 可选传入 hint（如输入框内已写的半句起笔或本轮行动方向），模型会顺着该意图完成台词。
 * 返回纯文本，调用方（client）负责填入输入框或剪贴板。
 */
export declare function impersonate({ ctx, state }: ImpersonateDeps, sessionId: string, hint?: string): Promise<{
    text: string;
}>;
