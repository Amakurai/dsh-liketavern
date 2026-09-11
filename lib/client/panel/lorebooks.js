import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 设置面板分区：世界书库与角色卡内嵌书。卡片网格展示，点开后按条目开关/编辑。
 * 卡片可键盘触发（clickableProps）；导入/保存等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useEffect, useRef, useState } from 'react';
import { PersistentEditor, useDraftState } from '../draftPersistence.js';
import { useDraftGuard } from '../drafts.js';
import { IconDownloadOutline16, IconEditOutline16, IconFolderOpenOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { parseLorebook } from '../../state/lorebook.js';
import { useT } from '../i18n.js';
import { Badge, Btn, ConfirmDialog, Dialog, Err, FileBtn, IconBtn, SearchEmpty, SearchInput, Section, Skeleton, clickableProps, downloadJson, errOf, readJsonFile, runAsync, useLoader, useToast } from '../util.js';
import { LorebookEditor } from './lorebookEditor.js';
export function LorebooksSection(props) {
    return _jsx(PersistentEditor, { remote: props.remote, scope: "lorebooks", children: _jsx(LorebooksSectionContent, { ...props }) });
}
function LorebooksSectionContent(props) {
    const { remote } = props;
    const { state, reload } = useLoader(() => remote.listLorebooks({}), []);
    const chars = useLoader(() => remote.listCharacters({}), []);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [opening, setOpening] = useState(null);
    const openRequest = useRef(0);
    useEffect(() => () => { openRequest.current += 1; }, []);
    const [opened, setOpened] = useDraftState('lorebooks:opened', null);
    const [toDelete, setToDelete] = useState(null);
    const [toDeleteEmbedded, setToDeleteEmbedded] = useState(null);
    const [creating, setCreating] = useDraftState('lorebooks:creating', false);
    const [newName, setNewName] = useDraftState('lorebooks:newName', '');
    const toast = useToast();
    const t = useT();
    const createGuard = useDraftGuard(creating && !!newName.trim(), busy);
    const closeCreate = () => createGuard.request(() => {
        setCreating(false);
        setNewName('');
    });
    const names = state.status === 'ready' ? state.value.items : [];
    const charItems = chars.state.status === 'ready' ? chars.state.value.items : [];
    const charBooks = charItems.filter((c) => c.hasCharacterBook);
    // 关键词同时过滤「角色卡内嵌」与「世界书库」两组；书多到要滚动找时才出搜索框。
    const [query, setQuery] = useState('');
    const q = query.trim().toLowerCase();
    const matchBook = (label) => q === '' || label.toLowerCase().includes(q);
    const shownCharBooks = q === '' ? charBooks : charBooks.filter((c) => matchBook(c.characterBookName || c.name) || c.name.toLowerCase().includes(q));
    const shownNames = q === '' ? names : names.filter(matchBook);
    const totalBooks = charBooks.length + names.length;
    /** 库文件与内嵌书共用请求身份；只有最后一次点选可以打开编辑器、报告错误或收起加载反馈。 */
    const openBook = async (name, load) => {
        const request = ++openRequest.current;
        setError(null);
        setOpening(name);
        try {
            const book = await load();
            if (openRequest.current === request)
                setOpened(book);
        }
        catch (err) {
            if (openRequest.current === request)
                setError(err instanceof Error ? err.message : String(err));
        }
        finally {
            if (openRequest.current === request)
                setOpening(null);
        }
    };
    const openLibrary = (name) => openBook(name, async () => {
        const r = await remote.getLorebook({ name });
        if (!r.ok)
            throw new Error(r.error.message);
        return {
            target: { kind: 'library', name },
            entries: parseLorebook(r.value.json, { source: 'global', sourceRef: name }),
        };
    });
    const openCharacter = (item) => openBook(item.characterBookName || item.name, async () => {
        const r = await remote.getCharacterLorebook({ cardId: item.cardId });
        if (!r.ok)
            throw new Error(r.error.message);
        return {
            target: { kind: 'character', cardId: item.cardId, name: r.value.name },
            entries: parseLorebook(r.value.json, { source: 'character', sourceRef: item.cardId }),
        };
    });
    const cancelOpening = () => {
        openRequest.current += 1;
        setOpening(null);
    };
    const remove = async () => {
        if (!toDelete)
            return;
        await runAsync(setBusy, setError, async () => {
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
        });
    };
    /** 删除角色卡内嵌世界书（保留角色卡本身）。 */
    const removeEmbedded = async () => {
        const target = toDeleteEmbedded;
        if (!target)
            return;
        await runAsync(setBusy, setError, async () => {
            const r = await remote.deleteEmbeddedLorebook({ cardId: target.cardId });
            const err = errOf(r);
            if (err)
                setError(err);
            else {
                toast.show(t('lorebooks.embeddedDeleted', { name: target.name }));
                setToDeleteEmbedded(null);
                chars.reload();
            }
        });
    };
    const exportBook = async (name) => {
        await runAsync(setBusy, setError, async () => {
            const r = await remote.getLorebook({ name });
            if (!r.ok)
                setError(r.error.message);
            else
                downloadJson(`${name}.json`, r.value.json);
        });
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
                toast.show(t('lorebooks.imported', { name: r.value.name, count: r.value.entryCount }));
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
            setError(t('lorebooks.nameRequired'));
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
        return (_jsxs(Section, { title: t('section.lorebooks'), description: t('lorebooks.editorDesc'), children: [toast.node, _jsx(LorebookEditor, { remote: remote, target: opened.target, entries: opened.entries, onClose: () => setOpened(null), onSaved: () => {
                        toast.show(t('lorebooks.saved', { name: opened.target.name }));
                        chars.reload();
                        reload();
                    }, save: (json) => opened.target.kind === 'library'
                        ? remote.saveLorebook({ name: opened.target.name, json })
                        : remote.saveCharacterLorebook({ cardId: opened.target.cardId, json }) })] }));
    }
    return (_jsxs(Section, { title: t('section.lorebooks'), description: t('lorebooks.listDesc'), children: [toast.node, createGuard.confirmation, _jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(FileBtn, { accept: ".json", disabled: busy || opening !== null, onFile: (file) => void onImportFile(file), children: t('lorebooks.importJson') }), _jsx(Btn, { size: "md", disabled: busy || opening !== null, onClick: () => setCreating(true), children: t('lorebooks.newEmpty') }), _jsx(Btn, { size: "md", onClick: () => {
                            reload();
                            chars.reload();
                        }, disabled: busy, children: t('action.refresh') }), totalBooks >= 5 && (_jsx(SearchInput, { label: t('lorebooks.searchLabel'), value: query, onChange: setQuery, placeholder: t('lorebooks.searchPlaceholder'), width: 220 }))] }), opening !== null && _jsxs("div", { className: "dsh-tavern-toolbar", role: "status", children: [_jsx("span", { children: t('lorebooks.opening', { name: opening }) }), _jsx(Btn, { disabled: busy, onClick: cancelOpening, children: t('action.cancel') })] }), (state.status === 'loading' || opening !== null) && (_jsxs("div", { className: "dsh-tavern-list", children: [_jsx(Skeleton, { height: 70, radius: 16 }), _jsx(Skeleton, { height: 70, radius: 16 }), _jsx(Skeleton, { height: 70, radius: 16 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), _jsx(Err, { message: error }), q !== '' && shownCharBooks.length === 0 && shownNames.length === 0 && state.status === 'ready' && chars.state.status === 'ready' && (_jsx(SearchEmpty, { what: t('section.lorebooks'), query: query.trim(), onClear: () => setQuery('') })), shownCharBooks.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: "dsh-tavern-groupHead", children: t('lorebooks.groupEmbedded') }), _jsx("div", { className: "dsh-tavern-list", children: shownCharBooks.map((item) => (_jsxs("div", { className: "dsh-tavern-tile", ...clickableProps(() => void openCharacter(item)), children: [_jsx("span", { className: "dsh-tavern-tileIcon", children: _jsx(IconFolderOpenOutline16, { size: 18 }) }), _jsxs("div", { className: "dsh-tavern-tileMain", children: [_jsxs("div", { className: "dsh-tavern-tileTitleRow", children: [_jsx("span", { className: "dsh-tavern-tileName", children: item.characterBookName || item.name }), _jsx(Badge, { children: t('lorebooks.badgeEmbedded') })] }), _jsx("span", { className: "dsh-tavern-tileSub", children: typeof item.characterBookEntryCount === 'number' && item.characterBookEntryCount > 0
                                                ? t('lorebooks.fromCharacterWithCount', { name: item.name, count: item.characterBookEntryCount })
                                                : t('lorebooks.fromCharacter', { name: item.name }) })] }), _jsxs("div", { className: "dsh-tavern-tileActions", children: [_jsx(IconBtn, { label: t('lorebooks.editEntries'), onClick: () => void openCharacter(item), children: _jsx(IconEditOutline16, {}) }), _jsx(IconBtn, { label: t('lorebooks.deleteEmbedded'), danger: true, disabled: busy || opening !== null, onClick: () => setToDeleteEmbedded(item), children: _jsx(IconTrashOutline16, {}) })] })] }, item.cardId))) })] })), _jsx("div", { className: "dsh-tavern-groupHead", children: t('lorebooks.groupLibrary') }), shownNames.length === 0 && state.status === 'ready' ? (q === '' ? (_jsxs("div", { className: "dsh-tavern-empty", children: [_jsx("div", { className: "dsh-tavern-emptyIcon", children: _jsx(IconFolderOpenOutline16, { size: 32 }) }), _jsx("div", { className: "dsh-tavern-emptyTitle", children: t('lorebooks.emptyTitle') }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: charBooks.length > 0 ? t('lorebooks.emptyDescEmbeddedAbove') : t('lorebooks.emptyDesc') })] })) : null) : (_jsx("div", { className: "dsh-tavern-list", children: shownNames.map((name) => (_jsxs("div", { className: "dsh-tavern-tile", ...clickableProps(() => void openLibrary(name)), children: [_jsx("span", { className: "dsh-tavern-tileIcon", children: _jsx(IconFolderOpenOutline16, { size: 18 }) }), _jsxs("div", { className: "dsh-tavern-tileMain", children: [_jsxs("div", { className: "dsh-tavern-tileTitleRow", children: [_jsx("span", { className: "dsh-tavern-tileName", children: name }), _jsx(Badge, { children: t('lorebooks.badgeLibrary') })] }), _jsx("span", { className: "dsh-tavern-tileSub", children: t('lorebooks.libraryFileSub') })] }), _jsxs("div", { className: "dsh-tavern-tileActions", children: [_jsx(IconBtn, { label: t('lorebooks.editEntries'), onClick: () => void openLibrary(name), children: _jsx(IconEditOutline16, {}) }), _jsx(IconBtn, { label: t('lorebooks.exportJson'), disabled: busy || opening !== null, onClick: () => void exportBook(name), children: _jsx(IconDownloadOutline16, {}) }), _jsx(IconBtn, { label: t('lorebooks.deleteBook'), danger: true, disabled: busy || opening !== null, onClick: () => setToDelete(name), children: _jsx(IconTrashOutline16, {}) })] })] }, name))) })), _jsx(ConfirmDialog, { open: toDelete !== null, title: t('lorebooks.confirmDeleteTitle'), description: toDelete ? t('lorebooks.confirmDeleteDesc', { name: toDelete }) : '', confirmLabel: t('action.delete'), danger: true, busy: busy, onCancel: () => setToDelete(null), onConfirm: () => void remove() }), _jsx(ConfirmDialog, { open: toDeleteEmbedded !== null, title: t('lorebooks.confirmDeleteEmbeddedTitle'), description: toDeleteEmbedded
                    ? t('lorebooks.confirmDeleteEmbeddedDesc', {
                        name: toDeleteEmbedded.name,
                        book: toDeleteEmbedded.characterBookName ? t('lorebooks.bookNameSuffix', { name: toDeleteEmbedded.characterBookName }) : '',
                    })
                    : '', confirmLabel: t('action.delete'), danger: true, busy: busy, onCancel: () => setToDeleteEmbedded(null), onConfirm: () => void removeEmbedded() }), _jsx(Dialog, { open: creating, title: t('lorebooks.createTitle'), description: t('lorebooks.createDesc'), onClose: closeCreate, footer: _jsxs("div", { className: "dsh-tavern-modalActions", children: [_jsx(Btn, { size: "md", disabled: busy, onClick: closeCreate, children: t('action.cancel') }), _jsx(Btn, { primary: true, size: "md", disabled: busy || !newName.trim(), onClick: () => void createEmpty(), children: t('lorebooks.create') })] }), children: _jsx("input", { className: "dsh-tavern-input", style: { width: '100%', height: 36, borderRadius: 8, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }, value: newName, disabled: busy, placeholder: t('lorebooks.namePlaceholder'), onChange: (e) => setNewName(e.target.value) }) })] }));
}
