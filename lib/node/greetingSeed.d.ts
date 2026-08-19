import { type SessionEvent } from '@deepseek-ai/dsh-session';
export declare function greetingMessage(text: string): import("@deepseek-ai/dsh-llm").AssistantMessage;
/** 脱离态编一轮开场白；调用方把返回值当作 agents.create 的 seed。不含 session/end-seed。 */
export declare function greetingTurnEvents(text: string): SessionEvent[];
