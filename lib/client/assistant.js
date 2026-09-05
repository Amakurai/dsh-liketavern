import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 接管 conversation.chat.node / assistant-step：仅 Tavern 会话用「头像 + 正文」排版，
 * 并套 output/render 正则（标记换成 HTML 封面时进 iframe）。
 *
 * 本组件只在当前会话为 Tavern 时才会被登记（见 client/index.tsx）。若仍被挂到
 * 非 Tavern 会话上（切换瞬间），立刻交回空树之外的原生 Markdown 回退，避免挡住 dsh。
 */
import { Fragment, useMemo } from 'react';
import { JsonBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { stripDisplayMeta } from '../core/displaySanitize.js';
import { cachedCharacterDetail, cachedSessionBinding } from './cache.js';
import { useMarkdownLabels, useT } from './i18n.js';
import { isTavernSession } from './mode.js';
import { openChildSession } from './openChild.js';
import { TavernInterruptedFloorActions } from './actions.js';
import { SpeechBubble } from './speech.js';
import { useLoader } from './util.js';
function ReasoningFold(props) {
    const t = useT();
    if (!props.text.trim())
        return null;
    return (_jsxs("details", { className: "dsh-tavern-reason", children: [_jsx("summary", { children: props.streaming ? t('assistant.thinking') : t('assistant.thought') }), _jsx("pre", { children: props.text })] }));
}
export function TavernAssistantNode(props) {
    const { remote, sessionId, sessions, node } = props;
    const t = useT();
    const tavern = isTavernSession(props.useSessions, sessionId);
    // 绑定/角色详情走进程内缓存（key=sessionId / cardId）：N 个 assistant 节点共享一次 RPC。
    const bindingLoader = useLoader(() => cachedSessionBinding(remote, sessionId), [sessionId], tavern);
    const binding = bindingLoader.state.status === 'ready' ? bindingLoader.state.value.binding : null;
    const detail = useLoader(() => cachedCharacterDetail(remote, binding.cardId), [binding?.cardId], tavern && binding !== null);
    const streaming = node.data.status === 'running';
    const interrupted = node.data.status === 'interrupted';
    const text = node.data.blocks.filter((b) => b.kind === 'text').map((b) => b.text ?? '').join('\n');
    const name = detail.state.status === 'ready' ? detail.state.value.name : '';
    const hasImages = node.data.blocks.some((b) => b.kind === 'image');
    const reasoningBlocks = node.data.blocks.filter((b) => b.kind === 'reasoning');
    const reasoningText = reasoningBlocks.map((b) => b.text ?? '').filter((chunk) => chunk.trim()).join('\n\n---\n\n');
    if (!tavern) {
        return _jsx(NativeAssistantFallback, { ...props, streaming: streaming, interrupted: interrupted });
    }
    // 中断楼层（已停止）的补救操作组：宿主 assistant-actions slot 只挂 finalized 消息，
    // 这里在节点内按 turn 号补挂重新生成/回退/兄弟导航（见 actions.tsx）。
    const locationTurn = node.location && (node.location.kind === 'turn' || node.location.kind === 'step') ? node.location.turn?.turn : undefined;
    const interruptedActions = interrupted && binding && typeof locationTurn === 'number' && sessions ? (_jsx(TavernInterruptedFloorActions, { remote: remote, sessionId: sessionId, sessions: sessions, turn: locationTurn })) : null;
    if (binding && text && !hasImages) {
        return (_jsxs("div", { children: [_jsx(ReasoningFold, { text: reasoningText, streaming: streaming }), _jsx(SpeechBubble, { remote: remote, sessionId: sessionId, cardId: binding.cardId, name: name || t('assistant.characterFallback'), rawText: text, messageId: node.data.finalNode?.seq, streaming: streaming || node.location?.turn?.status === 'open', interactiveCards: binding.interactiveCards, onSwipeGreeting: async (index) => {
                        if (!sessions)
                            throw new Error(t('speech.navigationUnavailable'));
                        const r = await remote.swipeGreeting({ sessionId, index });
                        if (!r.ok)
                            throw new Error(r.error.message);
                        await openChildSession(sessions, r.value.childSessionId, r.value.title);
                    } }), interrupted && _jsx("div", { className: "dsh-tavern-notice", children: t('assistant.stopped') }), interruptedActions] }));
    }
    return (_jsxs("div", { children: [_jsx(NativeAssistantFallback, { ...props, streaming: streaming, interrupted: interrupted, stripMeta: true }), interruptedActions] }));
}
function NativeAssistantFallback(props) {
    const { node, renderMessageImages, useTurnData, openFile, fileMentions, streaming, interrupted, stripMeta } = props;
    const t = useT();
    const markdownLabels = useMarkdownLabels();
    // fileMentions 是宿主 owner 函数，需按原生 AssistantNodeView 的方式用
    // turn-tail owner 解析成 mentions 再交给 MarkdownText（旧版直接透传函数本体，等于没配）。
    const turn = node.location?.kind === 'turn' || node.location?.kind === 'step' ? node.location.turn : undefined;
    const tail = useTurnData?.('turn-tail');
    const finalSeq = node.data.finalNode?.seq;
    const mentionOwner = useMemo(() => {
        if (!turn || turn.status !== 'closed' || finalSeq === undefined)
            return undefined;
        if (tail?.closing?.finalNode?.seq !== finalSeq)
            return undefined;
        return { turn, seq: finalSeq, openFile };
    }, [turn, tail, finalSeq, openFile]);
    const mentions = useMemo(() => (mentionOwner && fileMentions ? fileMentions(mentionOwner) : undefined), [fileMentions, mentionOwner]);
    const rendered = [];
    const blocks = node.data.blocks;
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!block)
            continue;
        if (block.kind === 'text') {
            const shown = stripMeta ? stripDisplayMeta(block.text ?? '') : (block.text ?? '');
            rendered.push(_jsx(MarkdownText, { text: shown, streaming: streaming, fileMentions: mentions, labels: markdownLabels }, i));
        }
        else if (block.kind === 'reasoning') {
            if (stripMeta)
                continue;
            rendered.push(_jsxs("details", { className: "dsh-tavern-reason", children: [_jsx("summary", { children: streaming ? t('assistant.thinking') : t('assistant.thought') }), _jsx("pre", { children: block.text })] }, i));
        }
        else if (block.kind === 'image') {
            const group = [block];
            while (i + 1 < blocks.length) {
                const next = blocks[i + 1];
                if (!next || next.kind !== 'image')
                    break;
                group.push(next);
                i += 1;
            }
            if (renderMessageImages) {
                rendered.push(_jsx(Fragment, { children: renderMessageImages({ images: group.map(({ attachment }) => ({ attachment })), align: 'start' }) }, i));
            }
        }
        else if (block.kind === 'tool-call') {
            continue;
        }
        else {
            rendered.push(_jsx(JsonBlock, { label: t('assistant.unknownBlock'), truncatedLabel: (total) => t('assistant.truncated', { total }), payload: block.block }, i));
        }
    }
    return (_jsxs("div", { children: [stripMeta ? _jsx(ReasoningFold, { text: node.data.blocks.filter((b) => b.kind === 'reasoning').map((b) => b.text ?? '').join('\n\n'), streaming: streaming }) : null, rendered, interrupted ? _jsx("span", { children: t('assistant.stopped') }) : null] }));
}
