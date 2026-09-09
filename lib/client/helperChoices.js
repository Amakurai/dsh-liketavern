import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** 脚本只能提交有界文本选项；可信按钮经宿主公开草稿接口填入，第三方代码不接触主页面。 */
import { useState, useSyncExternalStore } from 'react';
import { Btn, Err } from './util.js';
import { useT } from './i18n.js';
let entries = [];
const listeners = new Set();
const subscribe = (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => entries;
const notify = () => { for (const listener of listeners)
    listener(); };
let inputFor;
export function installChoiceInput(resolve) { inputFor = resolve; return () => { if (inputFor === resolve)
    inputFor = undefined; }; }
export function parseScriptChoices(value) {
    if (!Array.isArray(value) || value.length > 32)
        throw new Error('选项需为至多 32 项的数组');
    return value.map(item => { if (!item || typeof item !== 'object' || typeof item.label !== 'string' || !item.label.trim() || item.label.length > 128 || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 1024 || Object.keys(item).some(key => !['label', 'text'].includes(key)))
        throw new Error('选项文本无效或超出预算'); return { label: item.label, text: item.text }; });
}
export function publishScriptChoices(owner, sessionId, context, messageId, choices) {
    if (!Number.isSafeInteger(messageId) || !context.messages.some(message => message.message_id === messageId && message.role === 'assistant' && !message.is_hidden))
        throw new Error('选项目标消息无效');
    const parsed = parseScriptChoices(choices);
    entries = [...entries.filter(entry => entry.owner !== owner), { owner, sessionId, storyId: context.storyId, historyRevision: context.historyRevision, messageId, choices: parsed }];
    notify();
}
export function clearScriptChoices(owner) { if (!entries.some(entry => entry.owner === owner))
    return; entries = entries.filter(entry => entry.owner !== owner); notify(); }
export function choiceDraft(draft, text, previous) { return previous && draft.endsWith(previous) ? draft.slice(0, -previous.length) + text : draft + (draft && !draft.endsWith('\n') ? '\n' : '') + text; }
export function ScriptChoices({ sessionId, context }) {
    const t = useT(), all = useSyncExternalStore(subscribe, snapshot, snapshot), [error, setError] = useState(null), [previous, setPrevious] = useState('');
    const choices = all.filter(entry => entry.sessionId === sessionId && entry.storyId === context.storyId && entry.historyRevision === context.historyRevision && entry.messageId === context.currentMessageId).flatMap(entry => entry.choices);
    if (!choices.length)
        return null;
    return _jsxs("div", { className: "dsh-tavern-messageChoices", "aria-label": t('speech.scriptChoices'), children: [_jsx("div", { children: choices.map((choice, index) => _jsx(Btn, { title: choice.text, onClick: () => { try {
                        const input = inputFor?.(sessionId);
                        if (!input)
                            throw new Error(t('speech.choiceUnavailable'));
                        const state = input.state.getSnapshot();
                        if (state.phase !== 'plain' || state.occurrences.length)
                            throw new Error(t('speech.choiceBusy'));
                        input.setDraft(choiceDraft(state.draft, choice.text, previous));
                        setPrevious(choice.text);
                        setError(null);
                    }
                    catch (value) {
                        setError(value instanceof Error ? value.message : String(value));
                    } }, children: choice.label }, index)) }), _jsx(Err, { message: error })] });
}
