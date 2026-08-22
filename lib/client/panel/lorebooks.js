import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 设置面板分区：世界书库与角色卡内嵌书。卡片网格展示，点开后按条目开关/编辑。
 * 卡片可键盘触发（clickableProps）；导入/保存等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useState } from 'react';
import { IconDownloadOutline16, IconEditOutline16, IconFolderOpenOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { parseLorebook } from '../../state/lorebook.js';
import { Badge, Btn, ConfirmDialog, Dialog, Err, FileBtn, IconBtn, Section, Skeleton, clickableProps, downloadJson, errOf, readJsonFile, runAsync, useLoader, useToast } from '../util.js';
import { LorebookEditor } from './lorebookEditor.js';
export function LorebooksSection(props) {
    const { remote } = props;
    const { state, reload } = useLoader(() => remote.listLorebooks({}), []);
    const chars = useLoader(() => remote.listCharacters({}), []);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [opening, setOpening] = useState(false);
    const [opened, setOpened] = useState(null);
    const [toDelete, setToDelete] = useState(null);
    const [toDeleteEmbedded, setToDeleteEmbedded] = useState(null);
    const [creating, setCreating] = useState(false);
    const [newName, setNewName] = useState('');
    const toast = useToast();
    const names = state.status === 'ready' ? state.value.items : [];
    const charItems = chars.state.status === 'ready' ? chars.state.value.items : [];
    const charBooks = charItems.filter((c) => c.hasCharacterBook);
    const openLibrary = async (name) => {
        setError(null);
        setOpening(true);
        try {
            const r = await remote.getLorebook({ name });
            if (!r.ok) {
                setError(r.error.message);
                return;
            }
            setOpened({
                target: { kind: 'library', name },
                entries: parseLorebook(r.value.json, { source: 'global', sourceRef: name }),
            });
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setOpening(false);
        }
    };
    const openCharacter = async (item) => {
        setError(null);
        setOpening(true);
        try {
            const r = await remote.getCharacterLorebook({ cardId: item.cardId });
            if (!r.ok) {
                setError(r.error.message);
                return;
            }
            setOpened({
                target: { kind: 'character', cardId: item.cardId, name: r.value.name },
                entries: parseLorebook(r.value.json, { source: 'character', sourceRef: item.cardId }),
            });
        }
        catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setOpening(false);
        }
    };
    const remove = async () => {
        if (!toDelete)
            return;
        const r = await remote.deleteLorebook({ name: toDelete });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            if (opened?.target.kind === 'library' && opened.target.name === toDelete)
                setOpened(null);
            setToDelete(null);
            reload();
        }
    };
    /** 删除角色卡内嵌世界书（保留角色卡本身）。 */
    const removeEmbedded = async () => {
        const target = toDeleteEmbedded;
        if (!target)
            return;
        const r = await remote.deleteEmbeddedLorebook({ cardId: target.cardId });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            toast.show(`已删除「${target.name}」的内嵌世界书`);
            setToDeleteEmbedded(null);
            chars.reload();
        }
    };
    const exportBook = async (name) => {
        const r = await remote.getLorebook({ name });
        if (!r.ok)
            setError(r.error.message);
        else
            downloadJson(`${name}.json`, r.value.json);
    };
    const onImportFile = async (file) => {
        setBusy(true);
        setError(null);
        try {
            const json = await readJsonFile(file);
            const name = file.name.replace(/\.json$/i, '');
            const r = await remote.importLorebook({ name, json });
            if (!r.ok)
                setError(r.error.message);
            else {
                toast.show(`已导入 ${r.value.name}（${r.value.entryCount} 条）`);
                reload();
            }
        }
        catch (err2) {
            setError(err2 instanceof Error ? err2.message : String(err2));
        }
        finally {
            setBusy(false);
        }
    };
    const createEmpty = async () => {
        const name = newName.trim();
        if (!name) {
            setError('请填写世界书名称');
            return;
        }
        await runAsync(setBusy, setError, async () => {
            const r = await remote.importLorebook({ name, json: { entries: {} } });
            if (!r.ok) {
                setError(r.error.message);
                return;
            }
            setCreating(false);
            setNewName('');
            reload();
            await openLibrary(r.value.name);
        });
    };
    if (opened) {
        return (_jsxs(Section, { title: "\u4E16\u754C\u4E66", description: "\u6309\u6761\u76EE\u5F00\u5173\u4E0E\u7F16\u8F91\u3002\u5173\u6389\u7684\u6761\u76EE\u4E0D\u4F1A\u518D\u88AB\u626B\u63CF\u547D\u4E2D\u3002\u6539\u5B8C\u540E\u8BB0\u5F97\u4FDD\u5B58\u3002", children: [toast.node, _jsx(LorebookEditor, { target: opened.target, entries: opened.entries, onClose: () => setOpened(null), onSaved: () => {
                        toast.show(`已保存「${opened.target.name}」`);
                        chars.reload();
                        reload();
                    }, save: (json) => opened.target.kind === 'library'
                        ? remote.saveLorebook({ name: opened.target.name, json })
                        : remote.saveCharacterLorebook({ cardId: opened.target.cardId, json }) })] }));
    }
    return (_jsxs(Section, { title: "\u4E16\u754C\u4E66", description: "\u5E93\u6587\u4EF6\u4E0E\u89D2\u8272\u5361\u5185\u5D4C\u4E66\u3002\u70B9\u5F00\u4E00\u672C\u4E66\uFF0C\u6309\u6761\u76EE\u5F00\u5173\u3001\u6539\u5173\u952E\u8BCD\u548C\u6B63\u6587\u3002\u65B0\u4F1A\u8BDD\u542F\u7528\u54EA\u672C\uFF0C\u5728\u300C\u8BBE\u7F6E\u300D\u9875\u52FE\u9009\u3002", children: [toast.node, _jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(FileBtn, { accept: ".json", disabled: busy, onFile: (file) => void onImportFile(file), children: "\u5BFC\u5165\u4E16\u754C\u4E66 JSON" }), _jsx(Btn, { size: "md", disabled: busy, onClick: () => setCreating(true), children: "\u65B0\u5EFA\u7A7A\u4E66" }), _jsx(Btn, { size: "md", onClick: () => {
                            reload();
                            chars.reload();
                        }, disabled: busy, children: "\u5237\u65B0" })] }), (state.status === 'loading' || opening) && (_jsxs("div", { className: "dsh-tavern-cards", children: [_jsx(Skeleton, { height: 96 }), _jsx(Skeleton, { height: 96 }), _jsx(Skeleton, { height: 96 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), _jsx(Err, { message: error }), charBooks.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: "dsh-tavern-groupHead", children: "\u89D2\u8272\u5361\u5185\u5D4C" }), _jsx("div", { className: "dsh-tavern-cards", children: charBooks.map((item) => (_jsxs("article", { className: "dsh-tavern-card is-clickable", ...clickableProps(() => void openCharacter(item)), children: [_jsxs("div", { className: "dsh-tavern-cardHead", children: [_jsx("div", { className: "dsh-tavern-cardName", children: item.characterBookName || item.name }), _jsx(Badge, { children: "\u5185\u5D4C" })] }), _jsxs("p", { className: "dsh-tavern-cardDesc", children: ["\u6765\u81EA\u89D2\u8272\u300C", item.name, "\u300D\u3002\u70B9\u5F00\u540E\u6309\u6761\u76EE\u5F00\u5173\u4E0E\u7F16\u8F91\u3002"] }), _jsxs("div", { className: "dsh-tavern-cardFoot", children: [_jsx("span", { className: "dsh-tavern-cardMeta", children: typeof item.characterBookEntryCount === 'number' ? `${item.characterBookEntryCount} 条` : '条目' }), _jsx(IconBtn, { label: "\u7F16\u8F91\u6761\u76EE", onClick: () => void openCharacter(item), children: _jsx(IconEditOutline16, {}) }), _jsx(IconBtn, { label: "\u5220\u9664\u5185\u5D4C\u4E16\u754C\u4E66", danger: true, onClick: () => setToDeleteEmbedded(item), children: _jsx(IconTrashOutline16, {}) })] })] }, item.cardId))) })] })), _jsx("div", { className: "dsh-tavern-groupHead", children: "\u4E16\u754C\u4E66\u5E93" }), names.length === 0 && state.status === 'ready' ? (_jsxs("div", { className: "dsh-tavern-empty", children: [_jsx("div", { className: "dsh-tavern-emptyIcon", children: _jsx(IconFolderOpenOutline16, { size: 32 }) }), _jsx("div", { className: "dsh-tavern-emptyTitle", children: "\u6682\u65E0\u72EC\u7ACB\u4E16\u754C\u4E66" }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: charBooks.length > 0 ? '卡内嵌书见上方分组。' : '导入角色卡或 JSON，也可以新建一本空书。' })] })) : (_jsx("div", { className: "dsh-tavern-cards", children: names.map((name) => (_jsxs("article", { className: "dsh-tavern-card is-clickable", ...clickableProps(() => void openLibrary(name)), children: [_jsxs("div", { className: "dsh-tavern-cardHead", children: [_jsx("div", { className: "dsh-tavern-cardName", children: name }), _jsx(Badge, { children: "\u5E93" })] }), _jsx("p", { className: "dsh-tavern-cardDesc", children: "\u72EC\u7ACB\u4E16\u754C\u4E66\u6587\u4EF6\u3002\u70B9\u5F00\u540E\u6309\u6761\u76EE\u7BA1\u7406\u542F\u7528\u72B6\u6001\u4E0E\u5185\u5BB9\u3002" }), _jsxs("div", { className: "dsh-tavern-cardFoot", children: [_jsx("span", { className: "dsh-tavern-cardMeta", children: name }), _jsx(IconBtn, { label: "\u7F16\u8F91\u6761\u76EE", onClick: () => void openLibrary(name), children: _jsx(IconEditOutline16, {}) }), _jsx(IconBtn, { label: "\u5BFC\u51FA JSON", onClick: () => void exportBook(name), children: _jsx(IconDownloadOutline16, {}) }), _jsx(IconBtn, { label: "\u5220\u9664\u4E16\u754C\u4E66", danger: true, onClick: () => setToDelete(name), children: _jsx(IconTrashOutline16, {}) })] })] }, name))) })), _jsx(ConfirmDialog, { open: toDelete !== null, title: "\u5220\u9664\u4E16\u754C\u4E66\uFF1F", description: toDelete ? `确定删除世界书 ${toDelete}？此操作不能从设置里撤销。` : '', confirmLabel: "\u5220\u9664", danger: true, onCancel: () => setToDelete(null), onConfirm: () => void remove() }), _jsx(ConfirmDialog, { open: toDeleteEmbedded !== null, title: "\u5220\u9664\u5185\u5D4C\u4E16\u754C\u4E66\uFF1F", description: toDeleteEmbedded
                    ? `确定删除角色「${toDeleteEmbedded.name}」的内嵌世界书${toDeleteEmbedded.characterBookName ? `（${toDeleteEmbedded.characterBookName}）` : ''}？角色卡本身保留，此操作不能从设置里撤销。`
                    : '', confirmLabel: "\u5220\u9664", danger: true, onCancel: () => setToDeleteEmbedded(null), onConfirm: () => void removeEmbedded() }), _jsx(Dialog, { open: creating, title: "\u65B0\u5EFA\u4E16\u754C\u4E66", description: "\u5148\u5EFA\u4E00\u672C\u7A7A\u4E66\uFF0C\u518D\u5728\u6761\u76EE\u5217\u8868\u91CC\u6DFB\u52A0\u5173\u952E\u8BCD\u548C\u6B63\u6587\u3002", onClose: () => setCreating(false), footer: _jsxs("div", { className: "dsh-tavern-modalActions", children: [_jsx(Btn, { size: "md", onClick: () => setCreating(false), children: "\u53D6\u6D88" }), _jsx(Btn, { primary: true, size: "md", disabled: busy, onClick: () => void createEmpty(), children: "\u521B\u5EFA" })] }), children: _jsx("input", { className: "dsh-tavern-input", style: { width: '100%', height: 36, borderRadius: 8, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }, value: newName, placeholder: "\u4E16\u754C\u4E66\u540D\u79F0", onChange: (e) => setNewName(e.target.value) }) })] }));
}
