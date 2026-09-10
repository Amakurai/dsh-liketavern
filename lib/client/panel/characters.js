import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 设置面板分区：角色卡（列表 / 导入 / 删除 / 详情 / 交互卡）。
 * 列表行走 Avatar + 尾部详情/删除 IconBtn；导入/删除等瞬时反馈走 useToast，上下文错误用 Err。
 * 交互卡预览保留 CSP meta 注入 + sandbox iframe（无 allow-same-origin），不得放宽。
 */
import { cardVariableLabels } from '../cardVariableLabels.js';
import { useDraftGuard } from '../drafts.js';
import { buildCardSrcDoc } from '../../core/cardFrame.js';
import { CARD_VARIABLE_STYLES } from '../styles.js';
import { PersistentEditor, useDraftRestored, useDraftState } from '../draftPersistence.js';
import { useEffect, useRef, useState } from 'react';
import { Button, IconDownloadOutline16, IconTrashOutline16, IconUserOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { cachedAvatar, cachedCharacterDetail, invalidateCharacter } from '../cache.js';
import { useT } from '../i18n.js';
import { Avatar, Btn, ConfirmDialog, Dialog, Err, Field, FileBtn, IconBtn, ListInput, Muted, NumInput, SearchEmpty, SearchInput, Section, Select, Skeleton, clickableProps, downloadBase64, downloadJson, errOf, fileToBase64, runAsync, useLoader, useToast } from '../util.js';
/** 按 cardId 拉头像 dataURL 的 Avatar 包装（失败时回落首字符/图标）；头像走进程内缓存。 */
function CardAvatar(props) {
    const { state } = useLoader(() => cachedAvatar(props.remote, props.cardId), [props.cardId]);
    const url = state.status === 'ready' ? state.value.dataUrl : null;
    return _jsx(Avatar, { url: url, name: props.name, size: props.size });
}
/** 海报卡：封面图（或首字符封面）+ 底部渐变上的名字与内嵌书信息；整卡可点进编辑，删除钮悬停浮现。 */
function CharacterCard(props) {
    const t = useT();
    const { state } = useLoader(() => cachedAvatar(props.remote, props.item.cardId), [props.item.cardId]);
    const url = state.status === 'ready' ? state.value.dataUrl : null;
    const initial = props.item.name.trim().charAt(0) || '?';
    const book = props.item.characterBookName
        ? t('characters.card.embeddedBookNamed', { name: props.item.characterBookName })
        : t('characters.card.embeddedBook');
    const meta = props.item.hasCharacterBook
        ? `${book}${typeof props.item.characterBookEntryCount === 'number' && props.item.characterBookEntryCount > 0
            ? ` · ${t('characters.card.entryCount', { count: props.item.characterBookEntryCount })}`
            : ''}`
        : '';
    return (_jsxs("article", { className: "dsh-tavern-charCard", ...clickableProps(() => props.onOpen(props.item.cardId)), children: [_jsx("div", { className: "dsh-tavern-charCardCover", children: url ? _jsx("img", { src: url, alt: "" }) : _jsx("span", { className: "dsh-tavern-charCardInitial", children: initial }) }), _jsxs("div", { className: "dsh-tavern-charCardBar", children: [_jsx("div", { className: "dsh-tavern-charCardName", children: props.item.name }), meta ? _jsx("div", { className: "dsh-tavern-charCardMeta", children: meta }) : null] }), _jsx("div", { className: "dsh-tavern-charCardActions", children: _jsx(Tooltip, { label: t('characters.card.delete'), side: "bottom", children: _jsx("button", { type: "button", "aria-label": t('characters.card.delete'), className: "dsh-tavern-coverBtn is-danger", disabled: props.busy, onClick: (e) => {
                            e.stopPropagation();
                            props.onDelete(props.item);
                        }, children: _jsx(IconTrashOutline16, {}) }) }) })] }));
}
/** 详情弹窗里的「标签 + 多行框」单元，配合 groupHead 分组使用。 */
function LabeledArea(props) {
    return (_jsxs("div", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: props.label }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: props.minHeight ?? 64 }, value: props.value, onChange: (e) => props.onChange(e.target.value) })] }));
}
function CharacterDetailDialog(props) {
    const { remote, cardId } = props;
    const t = useT();
    const { state, reload } = useLoader(() => cachedCharacterDetail(remote, cardId), [cardId]);
    const [cardOpen, setCardOpen] = useState(false);
    const draftKey = `characters.detail:${cardId}`;
    const [draft, setDraft] = useDraftState(draftKey, null);
    const restored = useDraftRestored(draftKey);
    const preserveRestored = useRef(restored && draft !== null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const toast = useToast();
    const loaded = state.status === 'ready' ? state.value : null;
    const detail = draft ?? loaded;
    const dirty = draft !== null && (loaded === null ? restored : JSON.stringify(draft) !== JSON.stringify(loaded));
    const guard = useDraftGuard(dirty, busy);
    // 最近一次应用到草稿的服务端值（或保存成功那一刻的草稿）：用于识别 reload 往返窗口期内的新编辑。
    const appliedRef = useRef(null);
    const draftRef = useRef(draft);
    draftRef.current = draft;
    useEffect(() => {
        if (!loaded)
            return;
        // 首次 ready 仅提供比较基线；恢复的未保存正文必须保留。
        if (preserveRestored.current) {
            preserveRestored.current = false;
            appliedRef.current = loaded;
            return;
        }
        // 保存后 reload 落地时，草稿若已偏离基线（往返窗口期内有新键入），不整体覆盖：
        // 覆盖会静默丢掉窗口期编辑并把 dirty 复位为 false；保留草稿让「未保存」提示继续可见。
        if (draftRef.current !== null && appliedRef.current !== null && JSON.stringify(draftRef.current) !== JSON.stringify(appliedRef.current))
            return;
        appliedRef.current = loaded;
        setDraft(loaded);
    }, [loaded, setDraft]);
    const close = () => guard.request(() => {
        setDraft(null);
        props.onClose();
    });
    const set = (patch) => setDraft(detail ? { ...detail, ...patch } : detail);
    const interactiveHtml = typeof detail?.extensions?.interactiveHtml === 'string' ? detail.extensions.interactiveHtml : null;
    const save = async () => {
        if (!detail)
            return;
        if (!detail.name.trim()) {
            setError(t('characters.detail.nameRequired'));
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
                // reload 往返窗口期内的新编辑不覆盖：基线推进到刚保存的这份草稿。
                appliedRef.current = detail;
                toast.show(t('characters.detail.saved', { name: detail.name }));
                // 先失效详情/头像缓存再 reload，否则详情弹窗与聊天气泡继续吃旧值。
                invalidateCharacter(cardId);
                reload();
                props.onSaved();
            }
        });
    };
    const exportCard = async (kind) => {
        await runAsync(setBusy, setError, async () => {
            const r = await remote.exportCharacter({ cardId });
            if (!r.ok) {
                setError(r.error.message);
                return;
            }
            if (kind === 'json')
                downloadJson(`${r.value.name}.json`, r.value.json);
            else
                downloadBase64(`${r.value.name}.png`, r.value.pngBase64, 'image/png');
            toast.show(t('characters.detail.exported', { kind: kind.toUpperCase() }));
        });
    };
    return (_jsxs(Dialog, { open: true, width: "xl", title: t('characters.detail.title', { name: detail?.name ?? cardId }), onClose: close, footer: detail ? _jsxs("div", { className: "dsh-tavern-ui dsh-tavern-footActions", children: [_jsx("span", { className: "dsh-tavern-muted", role: "status", children: dirty ? t('draft.unsaved') : '' }), _jsx("span", { className: "dsh-tavern-footSpacer" }), _jsx(Btn, { size: "md", disabled: busy, onClick: close, children: t('action.close') }), _jsx(Btn, { primary: true, size: "md", disabled: busy || !dirty, onClick: () => void save(), children: t(busy ? 'draft.saving' : 'action.save') })] }) : undefined, children: [toast.node, guard.confirmation, state.status === 'loading' && (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 8 }, children: [_jsx(Skeleton, { height: 48 }), _jsx(Skeleton, { height: 14, width: "60%" }), _jsx(Skeleton, { height: 90 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), detail && (_jsxs("fieldset", { disabled: busy, className: "dsh-tavern-editorFields dsh-tavern-dialogStack", style: { fontSize: 13 }, children: [_jsxs("div", { className: "dsh-tavern-panelCard", style: { flexDirection: 'row', alignItems: 'center', gap: 14 }, children: [_jsx(CardAvatar, { remote: remote, cardId: cardId, name: detail.name, size: 52 }), _jsxs("div", { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }, children: [_jsx(Field, { label: t('characters.detail.displayName'), children: _jsx("input", { className: "dsh-tavern-input", style: { width: '100%' }, value: detail.name, onChange: (e) => set({ name: e.target.value }) }) }), _jsxs(Muted, { children: [detail.spec, " \u00B7 v", detail.characterVersion || '?', " \u00B7 ", detail.creator || t('characters.detail.unknownCreator'), detail.hasCharacterBook
                                                ? ` · ${detail.characterBookName ? t('characters.card.embeddedBookNamed', { name: detail.characterBookName }) : t('characters.card.embeddedBook')}`
                                                : ''] })] })] }), _jsxs("div", { className: "dsh-tavern-panelCard", children: [_jsx("div", { className: "dsh-tavern-groupHead", children: t('characters.detail.groupPersona') }), _jsx(LabeledArea, { label: t('characters.detail.description'), minHeight: 88, value: detail.description, onChange: (v) => set({ description: v }) }), _jsx(LabeledArea, { label: t('characters.detail.personality'), value: detail.personality, onChange: (v) => set({ personality: v }) }), _jsx(LabeledArea, { label: t('characters.detail.scenario'), value: detail.scenario, onChange: (v) => set({ scenario: v }) })] }), _jsxs("div", { className: "dsh-tavern-panelCard", children: [_jsx("div", { className: "dsh-tavern-groupHead", children: t('characters.detail.groupGreetings') }), _jsx(LabeledArea, { label: t('characters.detail.greeting'), minHeight: 88, value: detail.firstMes, onChange: (v) => set({ firstMes: v }) }), _jsxs("div", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('characters.detail.altGreetings') }), detail.alternateGreetings.map((greeting, index) => _jsxs("div", { className: "dsh-tavern-greetingEntry", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('characters.detail.greetingNumber', { index: index + 1 }) }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", value: greeting, disabled: busy, onChange: (e) => set({ alternateGreetings: detail.alternateGreetings.map((text, i) => i === index ? e.target.value : text) }) })] }), _jsx(Btn, { disabled: busy, onClick: () => set({ alternateGreetings: detail.alternateGreetings.filter((_, i) => i !== index) }), children: t('action.delete') })] }, index)), _jsx(Btn, { disabled: busy, onClick: () => set({ alternateGreetings: [...detail.alternateGreetings, ''] }), children: t('characters.detail.addGreeting') })] }), _jsx(LabeledArea, { label: t('characters.detail.mesExample'), value: detail.mesExample, onChange: (v) => set({ mesExample: v }) })] }), _jsxs("div", { className: "dsh-tavern-panelCard", children: [_jsx("div", { className: "dsh-tavern-groupHead", children: t('characters.detail.groupAdvanced') }), _jsx(LabeledArea, { label: t('characters.detail.systemPrompt'), value: detail.systemPrompt, onChange: (v) => set({ systemPrompt: v }) }), _jsx(LabeledArea, { label: t('characters.detail.postHistory'), value: detail.postHistoryInstructions, onChange: (v) => set({ postHistoryInstructions: v }) }), _jsxs("div", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('characters.detail.depthPrompt') }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 64 }, value: detail.depthPrompt?.prompt ?? '', onChange: (e) => set({
                                            depthPrompt: e.target.value.trim()
                                                ? { prompt: e.target.value, depth: detail.depthPrompt?.depth ?? 4, role: detail.depthPrompt?.role ?? 'system' }
                                                : null,
                                        }) }), detail.depthPrompt ? (_jsxs("div", { className: "dsh-tavern-fieldRow", style: { marginTop: 6 }, children: [_jsx(Field, { label: t('characters.detail.depth'), children: _jsx(NumInput, { value: detail.depthPrompt.depth, onChange: (depth) => set({ depthPrompt: { ...detail.depthPrompt, depth: Math.max(0, Math.round(depth)) } }) }) }), _jsx(Field, { label: t('characters.detail.role'), children: _jsx(Select, { value: detail.depthPrompt.role, onChange: (role) => set({ depthPrompt: { ...detail.depthPrompt, role: role } }), options: [
                                                        { value: 'system', label: 'system' },
                                                        { value: 'user', label: 'user' },
                                                        { value: 'assistant', label: 'assistant' },
                                                    ] }) })] })) : null] })] }), _jsxs("div", { className: "dsh-tavern-panelCard", children: [_jsx("div", { className: "dsh-tavern-groupHead", children: t('characters.detail.groupMetadata') }), _jsx(LabeledArea, { label: t('characters.detail.creatorNotes'), value: detail.creatorNotes, onChange: (v) => set({ creatorNotes: v }) }), _jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsx(Field, { label: t('characters.detail.creator'), children: _jsx("input", { className: "dsh-tavern-input", value: detail.creator, onChange: (e) => set({ creator: e.target.value }) }) }), _jsx(Field, { label: t('characters.detail.version'), children: _jsx("input", { className: "dsh-tavern-input", value: detail.characterVersion, onChange: (e) => set({ characterVersion: e.target.value }) }) })] }), _jsx(Field, { label: t('characters.detail.tags'), children: _jsx(ListInput, { style: { width: '100%' }, value: detail.tags, onChange: (tags) => set({ tags }) }) })] }), _jsx(Err, { message: error }), _jsxs("div", { className: "dsh-tavern-footActions", style: { marginTop: 2 }, children: [_jsx(IconBtn, { label: t('characters.detail.exportPng'), disabled: busy, onClick: () => void exportCard('png'), children: _jsx(IconDownloadOutline16, {}) }), interactiveHtml !== null && _jsx(Btn, { size: "md", onClick: () => setCardOpen(true), children: t('interactive.open') }), _jsx("span", { className: "dsh-tavern-footSpacer" }), _jsx(Btn, { size: "md", disabled: busy, onClick: () => void exportCard('json'), children: t('characters.detail.exportJson') })] })] })), cardOpen && interactiveHtml !== null && (_jsx(Dialog, { open: true, width: "lg", title: t('characters.detail.interactiveTitle', { name: detail?.name ?? '' }), onClose: () => setCardOpen(false), children: _jsx("iframe", { sandbox: "allow-scripts", srcDoc: buildCardSrcDoc(interactiveHtml, { greetings: detail ? [detail.firstMes, ...detail.alternateGreetings] : [], greetingIndex: 0,
                        helperContext: { name: detail?.name, canSwipe: false },
                        helperLabels: { diagnostics: t('speech.helperMessages'), unsupported: t('speech.helperUnsupported') },
                        variableStyles: CARD_VARIABLE_STYLES,
                        variableLabels: cardVariableLabels(t, t('speech.cardDataNote')),
                    }), title: t('characters.detail.interactiveFrame'), style: { width: '100%', height: '60vh', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))', borderRadius: 16, background: 'var(--dsw-alias-bg-base, #111)' } }) }))] }));
}
export function CharactersSection(props) {
    return _jsx(PersistentEditor, { remote: props.remote, scope: "characters", children: _jsx(CharactersSectionContent, { ...props }) });
}
function CharactersSectionContent(props) {
    const { remote } = props;
    const t = useT();
    const { state, reload } = useLoader(() => remote.listCharacters({}), []);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [detailId, setDetailId] = useDraftState('characters:detailId', null);
    const [pending, setPending] = useState(null);
    const [toDelete, setToDelete] = useState(null);
    const [creating, setCreating] = useDraftState('characters:creating', false);
    const [newName, setNewName] = useDraftState('characters:newName', '');
    const [query, setQuery] = useState('');
    const toast = useToast();
    const createGuard = useDraftGuard(creating && !!newName.trim(), busy);
    const closeCreate = () => createGuard.request(() => {
        setCreating(false);
        setNewName('');
    });
    const doImport = async (name, dataBase64, importWorldBook) => {
        setBusy(true);
        setError(null);
        try {
            const r = await remote.importCharacter({ name, dataBase64, importWorldBook });
            const err = errOf(r);
            if (err)
                setError(err);
            else {
                toast.show(t(importWorldBook ? 'characters.importedWithBook' : 'characters.imported'));
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
                    ? t('characters.deletedSalvaged', { name: toDelete.name, book: r.value.salvagedLorebook })
                    : t('characters.deleted', { name: toDelete.name }));
                invalidateCharacter(toDelete.cardId);
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
    return (_jsxs(Section, { title: t('section.characters'), description: t('characters.section.desc'), children: [toast.node, createGuard.confirmation, _jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(FileBtn, { accept: ".png,.json", disabled: busy, onFile: (file) => void onImportFile(file), children: t('characters.importFile') }), _jsx(Btn, { size: "md", disabled: busy, onClick: () => setCreating(true), children: t('characters.newCard') }), _jsx(Btn, { size: "md", onClick: reload, disabled: busy, children: t('action.refresh') }), items.length >= 5 && (_jsx(SearchInput, { label: t('characters.searchLabel'), value: query, onChange: setQuery, placeholder: t('characters.searchPlaceholder'), width: 220 }))] }), state.status === 'loading' && (_jsxs("div", { className: "dsh-tavern-charGrid", children: [_jsx(Skeleton, { height: 198, radius: 18 }), _jsx(Skeleton, { height: 198, radius: 18 }), _jsx(Skeleton, { height: 198, radius: 18 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), _jsx(Err, { message: error }), items.length === 0 && state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty", children: [_jsx("div", { className: "dsh-tavern-emptyIcon", children: _jsx(IconUserOutline16, { size: 32 }) }), _jsx("div", { className: "dsh-tavern-emptyTitle", children: t('hero.noCharacters') }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: t('characters.emptyDesc') })] })), q !== '' && filtered.length === 0 && state.status === 'ready' && (_jsx(SearchEmpty, { what: t('characters.what'), query: query.trim(), onClear: () => setQuery('') })), _jsx("div", { className: "dsh-tavern-charGrid", children: filtered.map((item) => (_jsx(CharacterCard, { remote: remote, item: item, busy: busy, onOpen: setDetailId, onDelete: setToDelete }, item.cardId))) }), detailId && (_jsx(CharacterDetailDialog, { remote: remote, cardId: detailId, onClose: () => setDetailId(null), onSaved: reload }, detailId)), pending && (_jsx(Dialog, { open: true, title: t('characters.importBook.title'), description: pending.preview.characterBookName
                    ? t('characters.importBook.descNamed', { name: pending.preview.name, book: pending.preview.characterBookName, count: pending.preview.entryCount })
                    : t('characters.importBook.desc', { name: pending.preview.name, count: pending.preview.entryCount }), onClose: () => setPending(null), footer: _jsxs("div", { className: "dsh-tavern-modalActions", children: [_jsx(Button, { type: "button", variant: "outline", size: "md", disabled: busy, onClick: () => void doImport(pending.name, pending.dataBase64, false), children: t('characters.importBook.skip') }), _jsx(Button, { type: "button", variant: "primary", size: "md", disabled: busy, onClick: () => void doImport(pending.name, pending.dataBase64, true), children: t('characters.importBook.import') })] }), children: _jsx("p", { style: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }, children: t('characters.importBook.skipNote') }) })), _jsx(ConfirmDialog, { open: toDelete !== null, title: t('characters.delete.title'), description: toDelete ? t('characters.delete.desc', { name: toDelete.name }) : '', confirmLabel: t('action.delete'), danger: true, busy: busy, onCancel: () => setToDelete(null), onConfirm: () => void onDelete() }), _jsx(Dialog, { open: creating, title: t('characters.create.title'), description: t('characters.create.desc'), onClose: closeCreate, footer: _jsxs("div", { className: "dsh-tavern-modalActions", children: [_jsx(Btn, { size: "md", disabled: busy, onClick: closeCreate, children: t('action.cancel') }), _jsx(Btn, { primary: true, size: "md", disabled: busy || !newName.trim(), onClick: () => {
                                void runAsync(setBusy, setError, async () => {
                                    const r = await remote.createCharacter({ name: newName.trim() });
                                    const err = errOf(r);
                                    if (err)
                                        setError(err);
                                    else {
                                        toast.show(t('characters.created', { name: r.ok ? r.value.name : newName }));
                                        setCreating(false);
                                        setNewName('');
                                        reload();
                                        if (r.ok)
                                            setDetailId(r.value.cardId);
                                    }
                                });
                            }, children: t('characters.create.confirm') })] }), children: _jsx("input", { className: "dsh-tavern-input", style: { width: '100%', height: 36, borderRadius: 8, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }, disabled: busy, value: newName, placeholder: t('characters.create.namePlaceholder'), onChange: (e) => setNewName(e.target.value) }) })] }));
}
