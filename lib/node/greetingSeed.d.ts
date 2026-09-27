import { Session, type SessionEvent } from '@deepseek-ai/dsh-session';
export declare function greetingMessage(text: string): import("@deepseek-ai/dsh-llm").AssistantMessage;
/** 脱离态编一轮开场白；调用方把返回值当作 agents.create 的 seed。不含 session/end-seed。 */
export declare function greetingTurnEvents(text: string): SessionEvent[];
/** 开场白先保留空 system 首节点；宿主首次请求用真实完整提示词替换它，不伪造模型调用。 */
export declare function appendGreetingTurn(session: Session, text: string): void;
