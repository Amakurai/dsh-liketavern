/** 续写展示的跨消息机读边界：只读真实 notice 与原文，隐藏命令尾段，不修改历史或重跑模板。 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
type Assistant = SessionEvent<'assistant/message'>;
/** undefined 表示该来源的模板没有可用提交快照，不能借显示刷新重新求值。 */
type SourceText = (event: Assistant) => string | undefined;
export declare function continuationDisplayText(events: readonly SessionEvent[], seq: number, raw: string, rendered: string, sourceText?: SourceText): string;
/** 流式正文还没有持久 seq；只读公开事件快照中的真实续写 notice 和此前消息。 */
export declare function continuationStreamText(events: readonly SessionEvent[], turnNumber: number, seq: number | undefined, rendered: string, sourceText?: SourceText): string;
export {};
