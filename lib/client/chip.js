import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 会话头部角色 chip（slot conversation.session.header.actions，session 作用域）。
 * 显示当前会话绑定的角色；点击展开绑定编辑 / 开场白 / 调试小面板。
 */
import { useEffect, useRef, useState } from 'react';
import { BINDING_CHANGED_EVENT } from './actions.js';
import { isTavernSession } from './mode.js';
import { openChildSession } from './openChild.js';
import { TavernSeatChip } from './seatChip.js';
import { parseLorebook } from '../state/lorebook.js';
import { LorebookEditor } from './panel/lorebookEditor.js';
import { EMPTY_SESSION_DEFAULTS } from './types.js';
import { Btn, ConfirmDialog, Dialog, Err, Field, Muted, Select, Skeleton, Toggle, errOf, useLoader, useToast } from './util.js';
export function defaultBinding(sessionId, cardId, defaults) {
    const d = defaults ?? EMPTY_SESSION_DEFAULTS;
    return {
        sessionId,
        cardId,
        presetId: d.presetId || null,
        personaId: d.personaId || null,
        lorebookIds: [...d.lorebookIds],
        characterLorebookId: d.characterLorebookId || null,
        interactiveCards: null,
        greetingIndex: 0,
        authorNote: '',
        injectJournal: false,
        createdAt: new Date().toISOString(),
    };
}
export async function bindingFromDefaults(remote, sessionId, cardId) {
    const r = await remote.getSettings({});
    // 读取设置失败时不能静默套用空默认值，否则一次暂时性的 RPC 故障会覆盖用户原有的绑定配置。
    if (!r.ok)
        throw new Error(r.error.message);
    return defaultBinding(sessionId, cardId, r.value.settings.defaults);
}
function PreDialog(props) {
    return (_jsx(Dialog, { open: true, title: props.title, onClose: props.onClose, width: "lg", children: _jsx("pre", { className: "dsh-tavern-modalPre", children: props.text }) }));
}
/** 千位缩写（12.3k）；null 显示 ?。 */
function fmtTokens(n) {
    if (n === null)
        return '?';
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function PromptPreviewDialog(props) {
    const { data } = props;
    const [tab, setTab] = useState('standing');
    const wi = data.worldInfoBudget;
    const assemble = data.assembleBudget;
    const body = tab === 'standing'
        ? data.standing || '（空）'
        : tab === 'turn'
            ? data.turnContext || '（空）'
            : tab === 'log'
                ? data.logLines.join('\n') || '（无触发日志）'
                : `=== system ===\n${data.system}\n\n=== messages ===\n${data.messages.map((m) => JSON.stringify(m)).join('\n\n')}`;
    return (_jsxs(Dialog, { open: true, title: "\u63D0\u793A\u8BCD\u9884\u89C8", onClose: props.onClose, width: "lg", children: [_jsxs(Muted, { children: ["\u4E16\u754C\u4E66\u9884\u7B97 ", wi.used, "/", wi.limit, wi.overflowed ? ' · 已溢出' : '', ' · ', "\u7EC4\u88C5 ", assemble.tokensAfter, "/", assemble.tokensBefore, " token", assemble.trimmedSections.length > 0 ? ` · 裁剪 ${assemble.trimmedSections.join('、')}` : ''] }), _jsx("div", { className: "dsh-tavern-filters", style: { margin: '8px 0' }, children: [
                    ['standing', 'standing'],
                    ['turn', '本轮 turn'],
                    ['full', '完整序列'],
                    ['log', '触发日志'],
                ].map(([id, label]) => (_jsx("button", { type: "button", className: "dsh-tavern-chip", "data-active": tab === id ? 'true' : 'false', onClick: () => setTab(id), children: label }, id))) }), _jsx("pre", { className: "dsh-tavern-modalPre", children: body })] }));
}
export function TavernHeaderChip(props) {
    const { remote, sessionId, sessions } = props;
    const tavern = isTavernSession(props.useSessions, sessionId);
    const bindingLoader = useLoader(() => remote.getSessionBinding({ sessionId }), [sessionId], tavern);
    const binding = bindingLoader.state.status === 'ready' ? bindingLoader.state.value.binding : null;
    const canSwipeGreeting = bindingLoader.state.status === 'ready' ? bindingLoader.state.value.canSwipeGreeting !== false : false;
    const detail = useLoader(async () => {
        const [d, a] = await Promise.all([remote.getCharacterDetail({ cardId: binding.cardId }), remote.getAvatar({ cardId: binding.cardId })]);
        if (!d.ok)
            return d;
        return { ok: true, value: { name: d.value.name, avatar: a.ok ? a.value.dataUrl : null } };
    }, [binding?.cardId], tavern && binding !== null);
    const listsLoader = useLoader(() => remote.listCharacters({}), [sessionId], tavern);
    const listed = listsLoader.state.status === 'ready' ? listsLoader.state.value.items : [];
    const listedName = binding ? listed.find((c) => c.cardId === binding.cardId)?.name : undefined;
    const [open, setOpen] = useState(false);
    const usageLoader = useLoader(() => remote.getContextUsage({ sessionId }), [sessionId, open], tavern && open);
    const usage = usageLoader.state.status === 'ready' ? usageLoader.state.value.usage : null;
    const [lists, setLists] = useState(null);
    const [draft, setDraft] = useState(null);
    const [error, setError] = useState(null);
    const toast = useToast();
    const [view, setView] = useState(null);
    const [previewData, setPreviewData] = useState(null);
    const [chatLore, setChatLore] = useState(null);
    const [confirmUnbind, setConfirmUnbind] = useState(false);
    const [unbindBusy, setUnbindBusy] = useState(false);
    /** 无绑定时选择角色会异步读取 defaults；序号保证只有最后一次选择能落到草稿。 */
    const characterRequest = useRef(0);
    // 打开面板时拉取四个候选列表。绑定晚到时再填草稿，但不要在用户编辑中途用 reload 覆盖。
    useEffect(() => {
        if (!open)
            return;
        let alive = true;
        setError(null);
        void (async () => {
            const [chars, presets, personas, lorebooks] = await Promise.all([
                remote.listCharacters({}),
                remote.listPresets({}),
                remote.listPersonas({}),
                remote.listLorebooks({}),
            ]);
            if (!alive)
                return;
            if (!chars.ok)
                return setError(chars.error.message);
            if (!presets.ok)
                return setError(presets.error.message);
            if (!personas.ok)
                return setError(personas.error.message);
            if (!lorebooks.ok)
                return setError(lorebooks.error.message);
            setLists({
                characters: chars.value.items,
                presets: presets.value.items,
                personas: personas.value.items,
                lorebooks: lorebooks.value.items,
            });
        })();
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    useEffect(() => {
        if (!open) {
            characterRequest.current += 1;
            setDraft(null);
            return;
        }
        if (draft !== null)
            return;
        if (binding)
            setDraft({ ...binding, lorebookIds: [...binding.lorebookIds] });
    }, [open, binding, draft, sessionId]);
    if (!tavern)
        return null;
    const name = detail.state.status === 'ready' ? detail.state.value.name : null;
    const avatar = detail.state.status === 'ready' ? detail.state.value.avatar : null;
    const selectedChar = lists && draft ? lists.characters.find((c) => c.cardId === draft.cardId) : undefined;
    const embeddedBookLabel = selectedChar?.hasCharacterBook
        ? `${selectedChar.characterBookName || selectedChar.name}（卡内嵌${typeof selectedChar.characterBookEntryCount === 'number' ? ` ${selectedChar.characterBookEntryCount} 条` : ''}）`
        : '（卡内嵌书 / 无）';
    const saveBinding = async () => {
        if (!draft)
            return;
        const r = await remote.setSessionBinding({ binding: draft });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            toast.show('绑定已保存（对之后的消息生效）');
            bindingLoader.reload();
            // 通知操作条等按绑定显隐的组件刷新
            window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }));
        }
    };
    const insertGreeting = async () => {
        const r = await remote.ensureGreeting({ sessionId });
        if (!r.ok)
            setError(r.error.message);
        else
            toast.show(r.value.created ? '已插入开场白' : '会话已有内容，未插入');
    };
    const swipeBy = async (delta) => {
        if (!binding)
            return;
        const variants = await remote.getCharacterDetail({ cardId: binding.cardId });
        if (!variants.ok) {
            setError(variants.error.message);
            return;
        }
        const total = 1 + variants.value.alternateGreetings.length;
        if (total < 2) {
            toast.show('该角色没有额外开场白');
            return;
        }
        const next = ((binding.greetingIndex + delta) % total + total) % total;
        const r = await remote.swipeGreeting({ sessionId, index: next });
        if (!r.ok)
            setError(r.error.message);
        else
            await openChildSession(sessions, r.value.childSessionId, r.value.title);
    };
    const unbind = async () => {
        setUnbindBusy(true);
        try {
            const r = await remote.clearSessionBinding({ sessionId });
            const err = errOf(r);
            if (err) {
                // 收起确认层后，错误会显示在仍打开的主 Dialog 中。
                setConfirmUnbind(false);
                setError(err);
            }
            else {
                setConfirmUnbind(false);
                setOpen(false);
                bindingLoader.reload();
                window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }));
            }
        }
        finally {
            setUnbindBusy(false);
        }
    };
    const showTriggerLog = async () => {
        const r = await remote.getTriggerLog({ sessionId });
        if (!r.ok)
            return setError(r.error.message);
        const log = r.value.log;
        setView({
            title: '触发日志',
            text: log ? `时间：${log.at}\n\n${log.lines.join('\n')}` : '暂无日志（该会话还没有跑过一次 Tavern 组装）',
        });
    };
    const preview = async () => {
        const r = await remote.previewPrompt({ sessionId });
        if (!r.ok)
            return setError(r.error.message);
        setPreviewData(r.value);
    };
    const openChatLore = async () => {
        const cardId = draft?.cardId;
        if (!cardId)
            return;
        const r = await remote.getChatLorebook({ cardId });
        if (!r.ok) {
            setError(r.error.message);
            return;
        }
        try {
            setChatLore({
                cardId,
                entries: parseLorebook(r.value.json, { source: 'chat', sourceRef: 'chat-lorebook' }),
            });
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    };
    return (_jsxs("span", { className: "dsh-tavern-ui", style: { display: 'inline-flex' }, children: [_jsx(TavernSeatChip, { label: binding ? (name ?? listedName ?? '角色') : '选择角色卡', title: "\u9009\u62E9\u89D2\u8272\u5361", avatarUrl: avatar, open: open, hasPopup: "dialog", onClick: () => setOpen(!open) }), _jsx(Dialog, { open: open, title: "Tavern \u7ED1\u5B9A", onClose: () => setOpen(false), width: "md", children: _jsxs("div", { className: "dsh-tavern-ui", children: [_jsx(Err, { message: error }), !lists && (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 8 }, children: [_jsx(Skeleton, { height: 18 }), _jsx(Skeleton, { height: 18 })] })), lists && (_jsxs(_Fragment, { children: [_jsx(Field, { label: "\u89D2\u8272", children: _jsx(Select, { width: "100%", value: draft?.cardId ?? '', onChange: (cardId) => {
                                            if (!cardId)
                                                return;
                                            const request = ++characterRequest.current;
                                            if (draft) {
                                                const picked = lists.characters.find((c) => c.cardId === cardId);
                                                setDraft({ ...draft, cardId, cardName: picked?.name ?? draft.cardName });
                                            }
                                            else {
                                                void bindingFromDefaults(remote, sessionId, cardId).then((next) => {
                                                    if (characterRequest.current !== request)
                                                        return;
                                                    const picked = lists.characters.find((c) => c.cardId === cardId);
                                                    setDraft({ ...next, cardName: picked?.name });
                                                }).catch((cause) => {
                                                    if (characterRequest.current === request) {
                                                        setError(cause instanceof Error ? cause.message : String(cause));
                                                    }
                                                });
                                            }
                                        }, options: [
                                            { value: '', label: '（选择角色）' },
                                            ...lists.characters.map((c) => ({ value: c.cardId, label: c.name })),
                                        ] }) }), draft && (_jsxs(_Fragment, { children: [_jsx(Field, { label: "\u9884\u8BBE", children: _jsx(Select, { width: "100%", value: draft.presetId ?? '', onChange: (v) => setDraft({ ...draft, presetId: v || null }), options: [{ value: '', label: '（内建默认）' }, ...lists.presets.map((p) => ({ value: p.id, label: p.regexCount > 0 ? `${p.name}（${p.regexCount} 条正则）` : p.name }))] }) }), _jsx(Field, { label: "\u4EBA\u8BBE", children: _jsx(Select, { width: "100%", value: draft.personaId ?? '', onChange: (v) => setDraft({ ...draft, personaId: v || null }), options: [{ value: '', label: '（无）' }, ...lists.personas.map((p) => ({ value: p.id, label: p.name }))] }) }), _jsx(Field, { label: "\u4E3B\u4E16\u754C\u4E66", children: _jsx(Select, { width: "100%", value: draft.characterLorebookId ?? '', onChange: (v) => setDraft({ ...draft, characterLorebookId: v || null }), options: [
                                                    { value: '', label: embeddedBookLabel },
                                                    ...lists.lorebooks.map((n) => ({ value: n, label: n })),
                                                ] }) }), _jsx("div", { style: { fontSize: 12, margin: '6px 0 2px', opacity: 0.8 }, children: "\u5168\u5C40\u4E16\u754C\u4E66\uFF08\u591A\u9009\uFF09" }), _jsxs("div", { className: "dsh-tavern-checkList dsh-tavern-scroll", style: { maxHeight: 100, overflow: 'auto', marginBottom: 8 }, children: [lists.lorebooks.map((n) => (_jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: draft.lorebookIds.includes(n), onChange: (e) => setDraft({
                                                                ...draft,
                                                                lorebookIds: e.target.checked ? [...draft.lorebookIds, n] : draft.lorebookIds.filter((x) => x !== n),
                                                            }) }), n] }, n))), lists.lorebooks.length === 0 && _jsx(Muted, { children: "\u5E93\u4E2D\u6682\u65E0\u4E16\u754C\u4E66" })] }), _jsxs("div", { className: "dsh-tavern-field", style: { marginBottom: 8 }, children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u4F5C\u8005\u6CE8\u91CA\uFF08\u672C\u4F1A\u8BDD\uFF0C\u8FDB\u672C\u8F6E turn\uFF09" }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 64 }, value: draft.authorNote ?? '', onChange: (e) => setDraft({ ...draft, authorNote: e.target.value }) })] }), _jsx("div", { className: "dsh-tavern-inlineChecks", style: { marginBottom: 8 }, children: _jsxs("label", { children: [_jsx(Toggle, { checked: draft.injectJournal === true, onChange: (injectJournal) => setDraft({ ...draft, injectJournal }) }), "\u6CE8\u5165\u89D2\u8272\u7B14\u8BB0 journal.md"] }) }), _jsxs("div", { style: { display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }, children: [_jsx(Btn, { primary: true, onClick: () => void saveBinding(), children: "\u4FDD\u5B58\u7ED1\u5B9A" }), _jsx(Btn, { onClick: () => void openChatLore(), children: "\u7F16\u8F91\u672C\u4F1A\u8BDD\u4E16\u754C\u4E66" }), binding ? (_jsx(Btn, { danger: true, onClick: () => {
                                                        setConfirmUnbind(true);
                                                    }, children: "\u89E3\u9664\u7ED1\u5B9A" })) : null] })] })), _jsxs("div", { style: { borderTop: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))', paddingTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }, children: [_jsx(Btn, { disabled: !binding, onClick: () => void insertGreeting(), children: "\u63D2\u5165\u5F00\u573A\u767D" }), _jsx(Btn, { disabled: !binding || !canSwipeGreeting, onClick: () => void swipeBy(-1), children: "\u4E0A\u4E00\u6761\u5F00\u573A\u767D" }), _jsx(Btn, { disabled: !binding || !canSwipeGreeting, onClick: () => void swipeBy(1), children: "\u4E0B\u4E00\u6761\u5F00\u573A\u767D" }), _jsx(Btn, { onClick: () => void showTriggerLog(), children: "\u89E6\u53D1\u65E5\u5FD7" }), _jsx(Btn, { onClick: () => void preview(), children: "\u9884\u89C8\u63D0\u793A\u8BCD" })] }), usage && (_jsxs(Muted, { children: ["\u4E0A\u4E0B\u6587\uFF1A", usage.contextWindow !== null && usage.pressureTokens !== null
                                            ? `${fmtTokens(usage.pressureTokens)} / ${fmtTokens(usage.contextWindow)}（${usage.percent ?? '?'}%）`
                                            : `约 ${fmtTokens(usage.surfaceTokens)} token`, usage.messageTokens !== null
                                            ? ` · 系统 ${fmtTokens(usage.systemTokens)} · 工具 ${fmtTokens(usage.toolsTokens)} · 消息 ${fmtTokens(usage.messageTokens)}`
                                            : ''] }))] }))] }) }), toast.node, view && _jsx(PreDialog, { title: view.title, text: view.text, onClose: () => setView(null) }), previewData && _jsx(PromptPreviewDialog, { data: previewData, onClose: () => setPreviewData(null) }), chatLore && (_jsx(Dialog, { open: true, width: "lg", title: "\u672C\u4F1A\u8BDD\u4E16\u754C\u4E66", onClose: () => setChatLore(null), children: _jsx(LorebookEditor, { target: { kind: 'chat', cardId: chatLore.cardId, name: '本会话世界书' }, entries: chatLore.entries, onClose: () => setChatLore(null), onSaved: () => {
                        toast.show('已保存本会话世界书');
                        setChatLore(null);
                    }, save: (json) => remote.saveChatLorebook({ cardId: chatLore.cardId, json }) }) })), _jsx(ConfirmDialog, { open: confirmUnbind, title: "\u89E3\u9664\u89D2\u8272\u7ED1\u5B9A\uFF1F", description: "\u89E3\u9664\u540E\u672C\u4F1A\u8BDD\u4E0D\u518D\u4F7F\u7528\u89D2\u8272\u5361\uFF0C\u540E\u7EED\u56DE\u590D\u6309\u666E\u901A Tavern \u52A9\u624B\u3002\u5BF9\u8BDD\u8BB0\u5F55\u4E0D\u4F1A\u5220\u9664\u3002", confirmLabel: "\u89E3\u9664\u7ED1\u5B9A", danger: true, busy: unbindBusy, onCancel: () => {
                    setConfirmUnbind(false);
                }, onConfirm: () => void unbind() })] }));
}
