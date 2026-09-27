/**
 * 开场白 seed：编成一轮完整 turn（start/step/message/end），seq 从 0 连续。
 * swipe 必须把这段放进 agents.create 的 seed；子会话发布后再 append 会和
 * 刚启动的 agent loop 抢号，客户端打开历史会出现 Failed to fetch。
 */
import { createAssistantMessage, createSystemMessage } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import { TAVERN_GREETING_SOURCE } from '../core/greetingLog.js';
const SEED_SESSION_ID = 'session-tavern-greeting-seed';
export function greetingMessage(text) {
    return createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { ...TAVERN_GREETING_SOURCE },
    });
}
/** 脱离态编一轮开场白；调用方把返回值当作 agents.create 的 seed。不含 session/end-seed。 */
export function greetingTurnEvents(text) {
    const detached = Session.create(SEED_SESSION_ID);
    appendGreetingTurn(detached, text);
    return [...detached.snapshotEvents()];
}
/** 开场白先保留空 system 首节点；宿主首次请求用真实完整提示词替换它，不伪造模型调用。 */
export function appendGreetingTurn(session, text) {
    if (session.surface.nodes.length > 0)
        throw new Error('开场白只能写入尚无消息的会话');
    session.append('turn/start', { turn: 1 });
    session.append('step/start', { turn: 1, step: 1 });
    session.append('system/message', { turn: 1, step: 1, message: createSystemMessage('') }, { surfaceOp: 'append' });
    session.append('assistant/message', { turn: 1, step: 1, message: greetingMessage(text), stream: [] }, { surfaceOp: 'append' });
    session.append('step/end', { turn: 1, step: 1 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
}
