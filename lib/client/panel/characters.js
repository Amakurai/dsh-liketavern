import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 设置面板分区：角色卡（列表 / 导入 / 删除 / 详情 / 交互卡）。
 * 列表行走 Avatar + 尾部详情/删除 IconBtn；导入/删除等瞬时反馈走 useToast，上下文错误用 Err。
 * 交互卡预览保留 CSP meta 注入 + sandbox iframe（无 allow-same-origin），不得放宽。
 */
import { useEffect, useState } from 'react';
import { Button, IconDownloadOutline16, IconTrashOutline16, IconUserOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { Avatar, Btn, ConfirmDialog, Dialog, Err, Field, FileBtn, IconBtn, Muted, NumInput, SearchEmpty, SearchInput, Section, Select, Skeleton, clickableProps, downloadBase64, downloadJson, errOf, fileToBase64, runAsync, useLoader, useToast } from '../util.js';
const CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'">';
/** 把 CSP meta 注入交互卡 HTML 头部（无 <head> 则直接前置）。 */
function withCsp(html) {
    const head = /<head[^>]*>/i.exec(html);
    if (head) {
        const at = head.index + head[0].length;
        return html.slice(0, at) + CSP_META + html.slice(at);
    }
    return CSP_META + html;
}
/** 按 cardId 拉头像 dataURL 的 Avatar 包装（失败时回落首字符/图标）。 */
function CardAvatar(props) {
    const { state } = useLoader(() => props.remote.getAvatar({ cardId: props.cardId }), [props.cardId]);
    const url = state.status === 'ready' ? state.value.dataUrl : null;
    return _jsx(Avatar, { url: url, name: props.name, size: props.size });
}
/** 海报卡：封面图（或首字符封面）+ 底部渐变上的名字与内嵌书信息；整卡可点进编辑，删除钮悬停浮现。 */
function CharacterCard(props) {
    const { state } = useLoader(() => props.remote.getAvatar({ cardId: props.item.cardId }), [props.item.cardId]);
    const url = state.status === 'ready' ? state.value.dataUrl : null;
    const initial = props.item.name.trim().charAt(0) || '?';
    const meta = props.item.hasCharacterBook
        ? `内嵌世界书${props.item.characterBookName ? `「${props.item.characterBookName}」` : ''}${typeof props.item.characterBookEntryCount === 'number' && props.item.characterBookEntryCount > 0
            ? ` · ${props.item.characterBookEntryCount} 条`
            : ''}`
        : '';
    return (_jsxs("article", { className: "dsh-tavern-charCard", ...clickableProps(() => props.onOpen(props.item.cardId)), children: [_jsx("div", { className: "dsh-tavern-charCardCover", children: url ? _jsx("img", { src: url, alt: "" }) : _jsx("span", { className: "dsh-tavern-charCardInitial", children: initial }) }), _jsxs("div", { className: "dsh-tavern-charCardBar", children: [_jsx("div", { className: "dsh-tavern-charCardName", children: props.item.name }), meta ? _jsx("div", { className: "dsh-tavern-charCardMeta", children: meta }) : null] }), _jsx("div", { className: "dsh-tavern-charCardActions", children: _jsx(Tooltip, { label: "\u5220\u9664\u89D2\u8272\u5361", side: "bottom", children: _jsx("button", { type: "button", "aria-label": "\u5220\u9664\u89D2\u8272\u5361", className: "dsh-tavern-coverBtn is-danger", disabled: props.busy, onClick: (e) => {
                            e.stopPropagation();
                            props.onDelete(props.item);
                        }, children: _jsx(IconTrashOutline16, {}) }) }) })] }));
}
/** 详情弹窗里的「标签 + 多行框」单元，配合 groupHead 分组使用。 */
function LabeledArea(props) {
    return (_jsxs("div", { className: "dsh-tavern-field", style: { marginBottom: 8 }, children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: props.label }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: props.minHeight ?? 64 }, value: props.value, onChange: (e) => props.onChange(e.target.value) })] }));
}
function CharacterDetailDialog(props) {
    const { remote, cardId } = props;
    const { state, reload } = useLoader(async () => {
        const r = await remote.getCharacterDetail({ cardId });
        return r;
    }, [cardId]);
    const [cardOpen, setCardOpen] = useState(false);
    const [draft, setDraft] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const toast = useToast();
    const loaded = state.status === 'ready' ? state.value : null;
    const detail = draft ?? loaded;
    useEffect(() => {
        if (loaded)
            setDraft(loaded);
    }, [loaded]);
    const set = (patch) => setDraft(detail ? { ...detail, ...patch } : detail);
    const interactiveHtml = typeof detail?.extensions?.interactiveHtml === 'string' ? detail.extensions.interactiveHtml : null;
    const save = async () => {
        if (!detail)
            return;
        if (!detail.name.trim()) {
            setError('角色名不能为空');
            return;
        }
        await runAsync(setBusy, setError, async () => {
            const r = await remote.saveCharacter({
                cardId,
                name: detail.name,
                description: detail.description,
                personality: detail.personality,
                scenario: detail.scenario,
                firstMes: detail.firstMes,
                alternateGreetings: detail.alternateGreetings.map((s) => s.trim()).filter(Boolean),
                mesExample: detail.mesExample,
                systemPrompt: detail.systemPrompt,
                postHistoryInstructions: detail.postHistoryInstructions,
                creatorNotes: detail.creatorNotes,
                creator: detail.creator,
                characterVersion: detail.characterVersion,
                tags: detail.tags,
                depthPrompt: detail.depthPrompt ?? null,
            });
            const err = errOf(r);
            if (err)
                setError(err);
            else {
                toast.show(`已保存「${detail.name}」`);
                reload();
                props.onSaved();
            }
        });
    };
    const exportCard = async (kind) => {
        const r = await remote.exportCharacter({ cardId });
        if (!r.ok) {
            setError(r.error.message);
            return;
        }
        if (kind === 'json')
            downloadJson(`${r.value.name}.json`, r.value.json);
        else
            downloadBase64(`${r.value.name}.png`, r.value.pngBase64, 'image/png');
        toast.show(kind === 'json' ? '已导出 JSON' : '已导出 PNG');
    };
    return (_jsxs(Dialog, { open: true, width: "xl", title: `编辑角色：${detail?.name ?? cardId}`, onClose: props.onClose, children: [toast.node, state.status === 'loading' && (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 8 }, children: [_jsx(Skeleton, { height: 48 }), _jsx(Skeleton, { height: 14, width: "60%" }), _jsx(Skeleton, { height: 90 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), detail && (_jsxs("div", { className: "dsh-tavern-dialogStack dsh-tavern-scroll", style: { maxHeight: '65vh', overflow: 'auto', fontSize: 13 }, children: [_jsxs("div", { style: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }, children: [_jsx(CardAvatar, { remote: remote, cardId: cardId, name: detail.name, size: 48 }), _jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [_jsx(Field, { label: "\u663E\u793A\u540D\uFF08\u4E0D\u4F1A\u6539\u5DE5\u4F5C\u533A ID\uFF09", children: _jsx("input", { className: "dsh-tavern-input", style: { width: '100%' }, value: detail.name, onChange: (e) => set({ name: e.target.value }) }) }), _jsxs(Muted, { children: [detail.spec, " \u00B7 v", detail.characterVersion || '?', " \u00B7 ", detail.creator || '未知作者', detail.hasCharacterBook ? ` · 内嵌世界书${detail.characterBookName ? `「${detail.characterBookName}」` : ''}` : ''] })] })] }), _jsxs("div", { className: "dsh-tavern-panelCard", children: [_jsx("div", { className: "dsh-tavern-groupHead", children: "\u4EBA\u8BBE\u4E0E\u573A\u666F" }), _jsx(LabeledArea, { label: "\u63CF\u8FF0", minHeight: 88, value: detail.description, onChange: (v) => set({ description: v }) }), _jsx(LabeledArea, { label: "\u6027\u683C", value: detail.personality, onChange: (v) => set({ personality: v }) }), _jsx(LabeledArea, { label: "\u573A\u666F", value: detail.scenario, onChange: (v) => set({ scenario: v }) })] }), _jsxs("div", { className: "dsh-tavern-panelCard", children: [_jsx("div", { className: "dsh-tavern-groupHead", children: "\u5F00\u573A\u767D\u4E0E\u793A\u4F8B" }), _jsx(LabeledArea, { label: "\u5F00\u573A\u767D", minHeight: 88, value: detail.firstMes, onChange: (v) => set({ firstMes: v }) }), _jsxs("div", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u5F00\u573A\u767D\u53D8\u4F53\uFF08\u6BCF\u884C\u4E00\u6761\uFF09" }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 72 }, value: detail.alternateGreetings.join('\n'), onChange: (e) => set({ alternateGreetings: e.target.value.split('\n') }) })] }), _jsx(LabeledArea, { label: "\u5BF9\u8BDD\u793A\u4F8B", value: detail.mesExample, onChange: (v) => set({ mesExample: v }) })] }), _jsxs("div", { className: "dsh-tavern-panelCard", children: [_jsx("div", { className: "dsh-tavern-groupHead", children: "\u9AD8\u7EA7\u6CE8\u5165" }), _jsx(LabeledArea, { label: "\u7CFB\u7EDF\u63D0\u793A", value: detail.systemPrompt, onChange: (v) => set({ systemPrompt: v }) }), _jsx(LabeledArea, { label: "\u5386\u53F2\u540E\u6307\u4EE4", value: detail.postHistoryInstructions, onChange: (v) => set({ postHistoryInstructions: v }) }), _jsxs("div", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "depth_prompt\uFF08\u9884\u89C8\u6309\u6DF1\u5EA6\u63D2\u4F4D\uFF0Clive \u5E76\u5165\u672C\u8F6E turn\uFF09" }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 64 }, value: detail.depthPrompt?.prompt ?? '', onChange: (e) => set({
                                            depthPrompt: e.target.value.trim()
                                                ? { prompt: e.target.value, depth: detail.depthPrompt?.depth ?? 4, role: detail.depthPrompt?.role ?? 'system' }
                                                : null,
                                        }) }), detail.depthPrompt ? (_jsxs("div", { className: "dsh-tavern-fieldRow", style: { marginTop: 6 }, children: [_jsx(Field, { label: "\u6DF1\u5EA6", children: _jsx(NumInput, { value: detail.depthPrompt.depth, onChange: (depth) => set({ depthPrompt: { ...detail.depthPrompt, depth: Math.max(0, Math.round(depth)) } }) }) }), _jsx(Field, { label: "\u89D2\u8272", children: _jsx(Select, { value: detail.depthPrompt.role, onChange: (role) => set({ depthPrompt: { ...detail.depthPrompt, role: role } }), options: [
                                                        { value: 'system', label: 'system' },
                                                        { value: 'user', label: 'user' },
                                                        { value: 'assistant', label: 'assistant' },
                                                    ] }) })] })) : null] })] }), _jsxs("div", { className: "dsh-tavern-panelCard", children: [_jsx("div", { className: "dsh-tavern-groupHead", children: "\u5143\u6570\u636E" }), _jsx(LabeledArea, { label: "\u4F5C\u8005\u5907\u6CE8", value: detail.creatorNotes, onChange: (v) => set({ creatorNotes: v }) }), _jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsx(Field, { label: "\u4F5C\u8005", children: _jsx("input", { className: "dsh-tavern-input", value: detail.creator, onChange: (e) => set({ creator: e.target.value }) }) }), _jsx(Field, { label: "\u7248\u672C", children: _jsx("input", { className: "dsh-tavern-input", value: detail.characterVersion, onChange: (e) => set({ characterVersion: e.target.value }) }) })] }), _jsx(Field, { label: "\u6807\u7B7E\uFF08\u9017\u53F7\u5206\u9694\uFF09", children: _jsx("input", { className: "dsh-tavern-input", style: { width: '100%' }, value: detail.tags.join(', '), onChange: (e) => set({ tags: e.target.value.split(/[，,]/).map((s) => s.trim()).filter(Boolean) }) }) })] }), _jsx(Err, { message: error }), _jsxs("div", { className: "dsh-tavern-footActions", style: { marginTop: 2 }, children: [_jsx(IconBtn, { label: "\u5BFC\u51FA PNG", onClick: () => void exportCard('png'), children: _jsx(IconDownloadOutline16, {}) }), interactiveHtml !== null && _jsx(Btn, { size: "md", onClick: () => setCardOpen(true), children: "\u6253\u5F00\u4EA4\u4E92\u5361" }), _jsx("span", { className: "dsh-tavern-footSpacer" }), _jsx(Btn, { size: "md", disabled: busy, onClick: () => void exportCard('json'), children: "\u5BFC\u51FA JSON" }), _jsx(Btn, { primary: true, size: "md", disabled: busy, onClick: () => void save(), children: "\u4FDD\u5B58" })] })] })), cardOpen && interactiveHtml !== null && (_jsx(Dialog, { open: true, width: "lg", title: `交互卡：${detail?.name ?? ''}`, onClose: () => setCardOpen(false), children: _jsx("iframe", { sandbox: "allow-scripts", srcDoc: withCsp(interactiveHtml), title: "\u4EA4\u4E92\u5361", style: { width: '100%', height: '60vh', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))', borderRadius: 16, background: 'var(--dsw-alias-bg-base, #111)' } }) }))] }));
}
export function CharactersSection(props) {
    const { remote } = props;
    const { state, reload } = useLoader(() => remote.listCharacters({}), []);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [detailId, setDetailId] = useState(null);
    const [pending, setPending] = useState(null);
    const [toDelete, setToDelete] = useState(null);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const [query, setQuery] = useState('');
    const toast = useToast();
    const doImport = async (name, dataBase64, importWorldBook) => {
        setBusy(true);
        setError(null);
        try {
            const r = await remote.importCharacter({ name, dataBase64, importWorldBook });
            const err = errOf(r);
            if (err)
                setError(err);
            else {
                toast.show(importWorldBook ? '已导入角色卡（含内嵌世界书）' : '已导入角色卡');
                reload();
            }
        }
        catch (err2) {
            setError(err2 instanceof Error ? err2.message : String(err2));
        }
        finally {
            setBusy(false);
            setPending(null);
        }
    };
    const onImportFile = async (file) => {
        setBusy(true);
        setError(null);
        try {
            const dataBase64 = await fileToBase64(file);
            const inspected = await remote.inspectCharacter({ name: file.name, dataBase64 });
            if (!inspected.ok) {
                setError(inspected.error.message);
                return;
            }
            if (inspected.value.hasCharacterBook) {
                setPending({ name: file.name, dataBase64, preview: inspected.value });
                return;
            }
            await doImport(file.name, dataBase64, false);
        }
        catch (err2) {
            setError(err2 instanceof Error ? err2.message : String(err2));
        }
        finally {
            setBusy(false);
        }
    };
    const onDelete = async () => {
        if (!toDelete)
            return;
        await runAsync(setBusy, setError, async () => {
            const r = await remote.deleteCharacter({ cardId: toDelete.cardId });
            const err = errOf(r);
            if (err)
                setError(err);
            else {
                toast.show(r.ok && r.value.salvagedLorebook
                    ? `已删除「${toDelete.name}」，内嵌世界书已保留到世界书库：${r.value.salvagedLorebook}`
                    : `已删除「${toDelete.name}」`);
                setToDelete(null);
                reload();
            }
        });
    };
    const items = state.status === 'ready' ? state.value.items : [];
    // 卡多到要翻页找时才出搜索框；关键词同时匹配角色名与内嵌书名。
    const q = query.trim().toLowerCase();
    const filtered = q === ''
        ? items
        : items.filter((c) => c.name.toLowerCase().includes(q) ||
            (c.characterBookName ?? '').toLowerCase().includes(q));
    return (_jsxs(Section, { title: "\u89D2\u8272\u5361", description: "\u5BFC\u5165\u6216\u65B0\u5EFA\u89D2\u8272\u5361\u3002\u70B9\u8FDB\u5361\u7247\u53EF\u7F16\u8F91\u6B63\u6587\u5E76\u5BFC\u51FA PNG/JSON\u3002\u5220\u9664\u4F1A\u6E05\u6389\u8BE5\u5361\u5DE5\u4F5C\u533A\uFF0C\u4EE5\u53CA\u4ECD\u6307\u5411\u5B83\u7684\u4F1A\u8BDD\u7ED1\u5B9A\u3002", children: [toast.node, _jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(FileBtn, { accept: ".png,.json", disabled: busy, onFile: (file) => void onImportFile(file), children: "\u5BFC\u5165 PNG / JSON" }), _jsx(Btn, { size: "md", disabled: busy, onClick: () => setCreating(true), children: "\u65B0\u5EFA\u7A7A\u767D\u5361" }), _jsx(Btn, { size: "md", onClick: reload, disabled: busy, children: "\u5237\u65B0" }), items.length >= 5 && (_jsx(SearchInput, { label: "\u641C\u7D22\u89D2\u8272\u5361", value: query, onChange: setQuery, placeholder: "\u641C\u7D22\u89D2\u8272\u540D / \u5185\u5D4C\u4E66\u540D", width: 220 }))] }), state.status === 'loading' && (_jsxs("div", { className: "dsh-tavern-charGrid", children: [_jsx(Skeleton, { height: 186, radius: 16 }), _jsx(Skeleton, { height: 186, radius: 16 }), _jsx(Skeleton, { height: 186, radius: 16 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), _jsx(Err, { message: error }), items.length === 0 && state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty", children: [_jsx("div", { className: "dsh-tavern-emptyIcon", children: _jsx(IconUserOutline16, { size: 32 }) }), _jsx("div", { className: "dsh-tavern-emptyTitle", children: "\u8FD8\u6CA1\u6709\u89D2\u8272\u5361" }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: "\u5BFC\u5165\u4E00\u5F20 SillyTavern \u89D2\u8272\u5361\uFF0C\u6216\u65B0\u5EFA\u7A7A\u767D\u5361\u3002" })] })), q !== '' && filtered.length === 0 && state.status === 'ready' && (_jsx(SearchEmpty, { what: "\u89D2\u8272\u5361", query: query.trim(), onClear: () => setQuery('') })), _jsx("div", { className: "dsh-tavern-charGrid", children: filtered.map((item) => (_jsx(CharacterCard, { remote: remote, item: item, busy: busy, onOpen: setDetailId, onDelete: setToDelete }, item.cardId))) }), detailId && (_jsx(CharacterDetailDialog, { remote: remote, cardId: detailId, onClose: () => setDetailId(null), onSaved: reload })), pending && (_jsx(Dialog, { open: true, title: "\u5BFC\u5165\u5185\u5D4C\u4E16\u754C\u4E66\uFF1F", description: `角色卡「${pending.preview.name}」内嵌世界书${pending.preview.characterBookName ? `「${pending.preview.characterBookName}」` : ''}，共 ${pending.preview.entryCount} 条。导入后会作为该卡的主世界书。`, onClose: () => setPending(null), footer: _jsxs("div", { className: "dsh-tavern-modalActions", children: [_jsx(Button, { type: "button", variant: "outline", size: "md", disabled: busy, onClick: () => void doImport(pending.name, pending.dataBase64, false), children: "\u8DF3\u8FC7" }), _jsx(Button, { type: "button", variant: "primary", size: "md", disabled: busy, onClick: () => void doImport(pending.name, pending.dataBase64, true), children: "\u5BFC\u5165\u4E16\u754C\u4E66" })] }), children: _jsx("p", { style: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }, children: "\u8DF3\u8FC7\u540E\u4ECD\u5BFC\u5165\u89D2\u8272\u5361\uFF08\u63CF\u8FF0\u3001\u5F00\u573A\u767D\u3001\u6B63\u5219\uFF09\uFF0C\u53EA\u662F\u4E0D\u542F\u7528\u8FD9\u672C\u5185\u5D4C\u4E16\u754C\u4E66\u3002" }) })), _jsx(ConfirmDialog, { open: toDelete !== null, title: "\u5220\u9664\u89D2\u8272\u5361\uFF1F", description: toDelete ? `确定删除角色「${toDelete.name}」？其工作区（记忆/世界状态）以及仍绑定该卡的会话都会解除。文件夹 ID 不会出现在对话标题里。` : '', confirmLabel: "\u5220\u9664", danger: true, busy: busy, onCancel: () => setToDelete(null), onConfirm: () => void onDelete() }), _jsx(Dialog, { open: creating, title: "\u65B0\u5EFA\u7A7A\u767D\u89D2\u8272\u5361", description: "\u5148\u5EFA\u4E00\u5F20\u53EA\u6709\u540D\u5B57\u548C\u9ED8\u8BA4\u5F00\u573A\u767D\u7684\u5361\uFF0C\u518D\u70B9\u8FDB\u53BB\u586B\u63CF\u8FF0\u3002", onClose: () => setCreating(false), footer: _jsxs("div", { className: "dsh-tavern-modalActions", children: [_jsx(Btn, { size: "md", onClick: () => setCreating(false), children: "\u53D6\u6D88" }), _jsx(Btn, { primary: true, size: "md", disabled: busy || !newName.trim(), onClick: () => {
                                void runAsync(setBusy, setError, async () => {
                                    const r = await remote.createCharacter({ name: newName.trim() });
                                    const err = errOf(r);
                                    if (err)
                                        setError(err);
                                    else {
                                        toast.show(`已创建「${r.ok ? r.value.name : newName}」`);
                                        setCreating(false);
                                        setNewName('');
                                        reload();
                                        if (r.ok)
                                            setDetailId(r.value.cardId);
                                    }
                                });
                            }, children: "\u521B\u5EFA" })] }), children: _jsx("input", { className: "dsh-tavern-input", style: { width: '100%', height: 36, borderRadius: 8, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }, value: newName, placeholder: "\u89D2\u8272\u540D", onChange: (e) => setNewName(e.target.value) }) })] }));
}
