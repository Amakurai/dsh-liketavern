/** 宿主回复收口：只认可该消息自身嵌入流中唯一、位于末尾的正常 stop，不借用失败重试的结束帧。 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
export declare function hasNormalAssistantStop(event: SessionEvent<'assistant/message'>): boolean;
