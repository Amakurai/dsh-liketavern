import { ReasoningEffortId, createAssistantMessage, createUserMessage, } from '@deepseek-ai/dsh-llm';
import { resolveTavernReasoningEffort } from '../core/callConfig.js';
import { FloorError, forkAgentOptions } from './floors.js';
import { runTavernPipeline } from './pipeline.js';
import { isTavernRuntimeSession } from './tavernSession.js';
/** 收集一条一次性流的正文；error/aborted 终止帧转成 FloorError。 */
async function collectText(stream) {
    let text = '';
    for await (const chunk of stream) {
        if (chunk.type === 'text-delta') {
            text += chunk.text;
        }
        else if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
                throw new FloorError('impersonate-failed', `代答生成失败：${chunk.reason.failure.message}`);
            }
        }
    }
    return text.trim();
}
/**
 * 生成一句用户台词。要求会话在线且活 agent 在位（历史经 agent.session 派生）。
 * 返回纯文本，调用方（client）负责填入输入框或剪贴板。
 */
export async function impersonate({ ctx, state }, sessionId) {
    const session = ctx.sessions.get(sessionId);
    if (!session)
        throw new FloorError('session-not-live', `会话 ${sessionId} 不在线（仅支持当前打开的会话）`);
    if (!isTavernRuntimeSession(ctx, session))
        throw new FloorError('not-tavern', '当前会话不是 Tavern 模式');
    const binding = await state.loadBinding(sessionId);
    if (!binding)
        throw new FloorError('no-binding', '当前会话未绑定 Tavern 角色卡');
    const agent = ctx.agents.get(session.id);
    if (!agent)
        throw new FloorError('session-not-live', `会话 ${sessionId} 的 agent 不在线（仅支持当前打开的会话）`);
    const llm = ctx.get('llm');
    if (!llm)
        throw new FloorError('no-llm', '当前运行时没有 LLM 服务，无法代答');
    const route = forkAgentOptions(agent, session);
    if (!route.provider || !route.model) {
        throw new FloorError('no-route', '会话还没有可用的模型路由（先发一条消息或检查模型配置）');
    }
    const provider = route.provider;
    const model = route.model;
    // mode preview：impersonate 不是真实 turn，WI 定时器与触发日志按预览语义处理（不落 WAL）。
    // generationType='impersonate'：injection_trigger 按代答场景过滤预设条目（对齐 ST）。
    const pipeline = await runTavernPipeline({ state, sessionId, agent, llm, mode: 'preview', generationType: 'impersonate' });
    if (!pipeline)
        throw new FloorError('no-card', '角色卡不存在或绑定已失效');
    const sampling = state.config.sampling;
    // 深度思考的三级挑选与 live 请求共用 resolveTavernReasoningEffort（core/callConfig）：
    // 关键是 deepseek-official 在元数据解析失败时也要能关掉 thinking——代答曾漏掉这层兜底。
    let reasoning;
    try {
        reasoning = (await state.resolveModelInfoCached(llm, provider, model)).reasoning;
    }
    catch {
        // 模型元数据解析失败不阻断代答；按「无公布档」回退
    }
    // 「当前档」取会话最近一次 request header 里的档位：与 agent/request 看到的 config.reasoningEffort
    // 同源（forkAgentOptions 的路由也读这里），enabled 档才不会和 live 行为分叉。
    const currentEffort = session.requestHeader()?.config.reasoningEffort;
    const reasoningEffort = resolveTavernReasoningEffort(sampling.thinking, reasoning, currentEffort, provider);
    const messages = pipeline.history.map((m) => m.role === 'assistant'
        ? createAssistantMessage({ content: [{ type: 'text', text: m.content }], source: { provider, model } })
        : createUserMessage({ content: [{ type: 'text', text: m.content }], source: { kind: 'user' } }));
    messages.push(createUserMessage({
        content: [
            {
                type: 'text',
                text: [
                    `[系统指令：现在以用户「${pipeline.userName}」的身份，写 ta 在这个角色扮演中的下一句台词。`,
                    '只输出台词正文：不要以角色身份说话，不要旁白解释，不要加引号或名字前缀。]',
                ].join(''),
            },
        ],
        source: { kind: 'user' },
    }));
    const options = {
        provider,
        model,
        messages,
        system: pipeline.system,
        temperature: sampling.temperature,
        ...(sampling.maxTokens !== null ? { maxTokens: sampling.maxTokens } : {}),
        ...(sampling.stop.length > 0 ? { stop: [...sampling.stop] } : {}),
        ...(reasoningEffort !== undefined ? { reasoningEffort: ReasoningEffortId(reasoningEffort) } : {}),
    };
    const text = await collectText(llm.stream(options));
    if (!text)
        throw new FloorError('empty-result', '模型没有产出台词，请重试');
    return { text };
}
