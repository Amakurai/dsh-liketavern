import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 设置面板分区：角色卡（列表 / 导入 / 删除 / 详情 / 交互卡）。
 * 列表行走 Avatar + 尾部详情/删除 IconBtn；导入/删除等瞬时反馈走 useToast，上下文错误用 Err。
 * 交互卡预览保留 CSP meta 注入 + sandbox iframe（无 allow-same-origin），不得放宽。
 */
import { useEffect, useState } from 'react';
import { Button, IconDownloadOutline16, IconSearchOutline16, IconTrashOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { Avatar, Btn, ConfirmDialog, Dialog, Err, Field, FileBtn, IconBtn, Muted, NumInput, Section, Select, Skeleton, downloadBase64, downloadJson, errOf, fileToBase64, runAsync, useLoader, useToast } from '../util.js';
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
    return (_jsxs(Dialog, { open: true, width: "lg", title: `编辑角色：${detail?.name ?? cardId}`, onClose: props.onClose, children: [toast.node, state.status === 'loading' && (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 8 }, children: [_jsx(Skeleton, { height: 48 }), _jsx(Skeleton, { height: 14, width: "60%" }), _jsx(Skeleton, { height: 90 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), detail && (_jsxs("div", { className: "dsh-tavern-scroll", style: { maxHeight: '65vh', overflow: 'auto', fontSize: 13 }, children: [_jsxs("div", { style: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }, children: [_jsx(CardAvatar, { remote: remote, cardId: cardId, name: detail.name, size: 48 }), _jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [_jsx(Field, { label: "\u663E\u793A\u540D\uFF08\u4E0D\u4F1A\u6539\u5DE5\u4F5C\u533A ID\uFF09", children: _jsx("input", { className: "dsh-tavern-input", style: { width: '100%' }, value: detail.name, onChange: (e) => set({ name: e.target.value }) }) }), _jsxs(Muted, { children: [detail.spec, " \u00B7 v", detail.characterVersion || '?', " \u00B7 ", detail.creator || '未知作者', detail.hasCharacterBook ? ` · 内嵌世界书${detail.characterBookName ? `「${detail.characterBookName}」` : ''}` : ''] })] })] }), [
                        ['description', '描述', detail.description],
                        ['personality', '性格', detail.personality],
                        ['scenario', '场景', detail.scenario],
                        ['firstMes', '开场白', detail.firstMes],
                        ['mesExample', '对话示例', detail.mesExample],
                        ['systemPrompt', '系统提示', detail.systemPrompt],
                        ['postHistoryInstructions', '历史后指令', detail.postHistoryInstructions],
                        ['creatorNotes', '作者备注', detail.creatorNotes],
                    ].map(([key, label, value]) => (_jsxs("div", { className: "dsh-tavern-field", style: { marginBottom: 8 }, children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: label }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: key === 'description' || key === 'firstMes' ? 88 : 64 }, value: value, onChange: (e) => set({ [key]: e.target.value }) })] }, key))), _jsxs("div", { className: "dsh-tavern-field", style: { marginBottom: 8 }, children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u5F00\u573A\u767D\u53D8\u4F53\uFF08\u6BCF\u884C\u4E00\u6761\uFF09" }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 72 }, value: detail.alternateGreetings.join('\n'), onChange: (e) => set({ alternateGreetings: e.target.value.split('\n') }) })] }), _jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsx(Field, { label: "\u4F5C\u8005", children: _jsx("input", { className: "dsh-tavern-input", value: detail.creator, onChange: (e) => set({ creator: e.target.value }) }) }), _jsx(Field, { label: "\u7248\u672C", children: _jsx("input", { className: "dsh-tavern-input", value: detail.characterVersion, onChange: (e) => set({ characterVersion: e.target.value }) }) })] }), _jsx(Field, { label: "\u6807\u7B7E\uFF08\u9017\u53F7\u5206\u9694\uFF09", children: _jsx("input", { className: "dsh-tavern-input", style: { width: '100%' }, value: detail.tags.join(', '), onChange: (e) => set({ tags: e.target.value.split(/[，,]/).map((s) => s.trim()).filter(Boolean) }) }) }), _jsxs("div", { className: "dsh-tavern-field", style: { marginTop: 8 }, children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "depth_prompt\uFF08\u9884\u89C8\u6309\u6DF1\u5EA6\u63D2\u4F4D\uFF0Clive \u5E76\u5165\u672C\u8F6E turn\uFF09" }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 64 }, value: detail.depthPrompt?.prompt ?? '', onChange: (e) => set({
                                    depthPrompt: e.target.value.trim()
                                        ? { prompt: e.target.value, depth: detail.depthPrompt?.depth ?? 4, role: detail.depthPrompt?.role ?? 'system' }
                                        : null,
                                }) }), detail.depthPrompt ? (_jsxs("div", { className: "dsh-tavern-fieldRow", style: { marginTop: 6 }, children: [_jsx(Field, { label: "\u6DF1\u5EA6", children: _jsx(NumInput, { value: detail.depthPrompt.depth, onChange: (depth) => set({ depthPrompt: { ...detail.depthPrompt, depth: Math.max(0, Math.round(depth)) } }) }) }), _jsx(Field, { label: "\u89D2\u8272", children: _jsx(Select, { value: detail.depthPrompt.role, onChange: (role) => set({ depthPrompt: { ...detail.depthPrompt, role: role } }), options: [
                                                { value: 'system', label: 'system' },
                                                { value: 'user', label: 'user' },
                                                { value: 'assistant', label: 'assistant' },
                                            ] }) })] })) : null] }), _jsx(Err, { message: error }), _jsxs("div", { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }, children: [_jsx(Btn, { primary: true, disabled: busy, onClick: () => void save(), children: "\u4FDD\u5B58" }), _jsx(Btn, { disabled: busy, onClick: () => void exportCard('json'), children: "\u5BFC\u51FA JSON" }), _jsx(IconBtn, { label: "\u5BFC\u51FA PNG", onClick: () => void exportCard('png'), children: _jsx(IconDownloadOutline16, {}) }), interactiveHtml !== null && _jsx(Btn, { onClick: () => setCardOpen(true), children: "\u6253\u5F00\u4EA4\u4E92\u5361" })] })] })), cardOpen && interactiveHtml !== null && (_jsx(Dialog, { open: true, width: "lg", title: `交互卡：${detail?.name ?? ''}`, onClose: () => setCardOpen(false), children: _jsx("iframe", { sandbox: "allow-scripts", srcDoc: withCsp(interactiveHtml), title: "\u4EA4\u4E92\u5361", style: { width: '100%', height: '60vh', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))', borderRadius: 16, background: 'var(--dsw-alias-bg-base, #111)' } }) }))] }));
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
    return (_jsxs(Section, { title: "\u89D2\u8272\u5361", description: "\u5BFC\u5165\u6216\u65B0\u5EFA\u89D2\u8272\u5361\u3002\u70B9\u8FDB\u5361\u7247\u53EF\u7F16\u8F91\u6B63\u6587\u5E76\u5BFC\u51FA PNG/JSON\u3002\u5220\u9664\u4F1A\u6E05\u6389\u8BE5\u5361\u5DE5\u4F5C\u533A\uFF0C\u4EE5\u53CA\u4ECD\u6307\u5411\u5B83\u7684\u4F1A\u8BDD\u7ED1\u5B9A\u3002", children: [toast.node, _jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(FileBtn, { accept: ".png,.json", disabled: busy, onFile: (file) => void onImportFile(file), children: "\u5BFC\u5165 PNG / JSON" }), _jsx(Btn, { size: "md", disabled: busy, onClick: () => setCreating(true), children: "\u65B0\u5EFA\u7A7A\u767D\u5361" }), _jsx(Btn, { size: "md", onClick: reload, disabled: busy, children: "\u5237\u65B0" })] }), state.status === 'loading' && (_jsxs("div", { className: "dsh-tavern-list", children: [_jsx(Skeleton, { height: 48 }), _jsx(Skeleton, { height: 48 }), _jsx(Skeleton, { height: 48 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), _jsx(Err, { message: error }), items.length === 0 && state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty", children: [_jsx("div", { className: "dsh-tavern-emptyIcon", children: _jsx(IconUserOutline16, { size: 32 }) }), _jsx("div", { className: "dsh-tavern-emptyTitle", children: "\u8FD8\u6CA1\u6709\u89D2\u8272\u5361" }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: "\u5BFC\u5165\u4E00\u5F20 SillyTavern \u89D2\u8272\u5361\uFF0C\u6216\u65B0\u5EFA\u7A7A\u767D\u5361\u3002" })] })), _jsx("div", { className: "dsh-tavern-list", children: items.map((item) => (_jsxs("div", { className: "dsh-tavern-listRow", children: [_jsx(CardAvatar, { remote: remote, cardId: item.cardId, name: item.name, size: 36 }), _jsxs("span", { style: { flex: 1, minWidth: 0 }, children: [_jsx("div", { className: "dsh-tavern-cardName", children: item.name }), item.hasCharacterBook ? (_jsxs(Muted, { children: ["\u5185\u5D4C\u4E16\u754C\u4E66", item.characterBookName ? `「${item.characterBookName}」` : '', typeof item.characterBookEntryCount === 'number' && item.characterBookEntryCount > 0 ? ` ${item.characterBookEntryCount} 条` : ''] })) : (_jsx(Muted, { children: "\u65E0\u5185\u5D4C\u4E16\u754C\u4E66" }))] }), _jsx(IconBtn, { label: "\u7F16\u8F91\u89D2\u8272", onClick: () => setDetailId(item.cardId), children: _jsx(IconSearchOutline16, {}) }), _jsx(IconBtn, { label: "\u5220\u9664", danger: true, disabled: busy, onClick: () => setToDelete(item), children: _jsx(IconTrashOutline16, {}) })] }, item.cardId))) }), detailId && (_jsx(CharacterDetailDialog, { remote: remote, cardId: detailId, onClose: () => setDetailId(null), onSaved: reload })), pending && (_jsx(Dialog, { open: true, title: "\u5BFC\u5165\u5185\u5D4C\u4E16\u754C\u4E66\uFF1F", description: `角色卡「${pending.preview.name}」内嵌世界书${pending.preview.characterBookName ? `「${pending.preview.characterBookName}」` : ''}，共 ${pending.preview.entryCount} 条。导入后会作为该卡的主世界书。`, onClose: () => setPending(null), footer: _jsxs("div", { className: "dsh-tavern-modalActions", children: [_jsx(Button, { type: "button", variant: "outline", size: "md", disabled: busy, onClick: () => void doImport(pending.name, pending.dataBase64, false), children: "\u8DF3\u8FC7" }), _jsx(Button, { type: "button", variant: "primary", size: "md", disabled: busy, onClick: () => void doImport(pending.name, pending.dataBase64, true), children: "\u5BFC\u5165\u4E16\u754C\u4E66" })] }), children: _jsx("p", { style: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }, children: "\u8DF3\u8FC7\u540E\u4ECD\u5BFC\u5165\u89D2\u8272\u5361\uFF08\u63CF\u8FF0\u3001\u5F00\u573A\u767D\u3001\u6B63\u5219\uFF09\uFF0C\u53EA\u662F\u4E0D\u542F\u7528\u8FD9\u672C\u5185\u5D4C\u4E16\u754C\u4E66\u3002" }) })), _jsx(ConfirmDialog, { open: toDelete !== null, title: "\u5220\u9664\u89D2\u8272\u5361\uFF1F", description: toDelete ? `确定删除角色「${toDelete.name}」？其工作区（记忆/世界状态）以及仍绑定该卡的会话都会解除。文件夹 ID 不会出现在对话标题里。` : '', confirmLabel: "\u5220\u9664", danger: true, busy: busy, onCancel: () => setToDelete(null), onConfirm: () => void onDelete() }), _jsx(Dialog, { open: creating, title: "\u65B0\u5EFA\u7A7A\u767D\u89D2\u8272\u5361", description: "\u5148\u5EFA\u4E00\u5F20\u53EA\u6709\u540D\u5B57\u548C\u9ED8\u8BA4\u5F00\u573A\u767D\u7684\u5361\uFF0C\u518D\u70B9\u8FDB\u53BB\u586B\u63CF\u8FF0\u3002", onClose: () => setCreating(false), footer: _jsxs("div", { className: "dsh-tavern-modalActions", children: [_jsx(Btn, { size: "md", onClick: () => setCreating(false), children: "\u53D6\u6D88" }), _jsx(Btn, { primary: true, size: "md", disabled: busy || !newName.trim(), onClick: () => {
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
