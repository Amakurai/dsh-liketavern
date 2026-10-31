import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/** 设置页的剧情变量管理：显式选择角色和剧情，备份已保存快照；恢复经原有楼层 WAL/CAS，草稿及失败留在设置。 */
import { useEffect, useRef, useState } from 'react';
import { parseHelperVariableBackup, helperVariableRestoreChanges } from '../../core/helperVariableBackup.js';
import { DraftScope, useDraftGuard } from '../drafts.js';
import { useDraftState } from '../draftPersistence.js';
import { HelperScriptEditor } from '../helperScriptEditor.js';
import { notifyHelperStory } from '../helperNotifications.js';
import { notifyHelperScripts } from '../helperScriptNotifications.js';
import { useT } from '../i18n.js';
import { openChildSession } from '../openChild.js';
import { Btn, ConfirmDialog, Err, FileBtn, Muted, SaveBar, Section, Select, SettingsRow, Skeleton, downloadJson, useLoader, useToast } from '../util.js';
export function CardDataSettings({ remote, sessions }) {
    const t = useT();
    const [cardId, setCardId] = useDraftState('card-data:card', '');
    const [storyId, setStoryId] = useDraftState('card-data:story', '');
    const chars = useLoader(() => remote.listCharacters({}), []);
    const stories = useLoader(() => remote.listStories({ cardId }), [cardId], Boolean(cardId));
    const items = stories.state.status === 'ready' ? stories.state.value.items : [];
    const story = items.find(item => item.id === storyId);
    return _jsx(Section, { title: t('speech.cardDataTitle'), description: t('settings.cards.variablesDesc'), children: _jsx(DraftScope, { children: request => _jsxs(_Fragment, { children: [_jsx(SettingsRow, { title: t('settings.cards.variableCharacter'), children: _jsx(Select, { value: cardId, title: t('settings.cards.variableCharacter'), disabled: chars.state.status !== 'ready', options: [{ value: '', label: t('settings.cards.variableChoose') }, ...(chars.state.status === 'ready' ? chars.state.value.items.map(item => ({ value: item.cardId, label: item.name })) : [])], onChange: value => request(() => { setCardId(value); setStoryId(''); }) }) }), _jsx(SettingsRow, { title: t('memory.story'), children: _jsx(Select, { value: storyId, title: t('memory.story'), disabled: !cardId || stories.state.status !== 'ready', options: [{ value: '', label: t('settings.cards.variableChoose') }, ...items.map((item, index) => ({ value: item.id, label: t('memory.storyLabel', { index: index + 1, date: new Date(item.createdAt).toLocaleString() }) }))], onChange: value => request(() => setStoryId(value)) }) }), (chars.state.status === 'loading' || stories.state.status === 'loading') && _jsx(Skeleton, { height: 40 }), _jsx(Err, { message: chars.state.status === 'error' ? chars.state.message : stories.state.status === 'error' ? stories.state.message : null }), (chars.state.status === 'error' || stories.state.status === 'error') && _jsx(Btn, { onClick: () => { chars.reload(); stories.reload(); }, children: t('action.retry') }), _jsx(SessionTransfer, { remote: remote, sessions: sessions, sessionId: story?.sessionId }), story ? _jsx(StoryVariableSettings, { remote: remote, cardId: cardId, storyId: storyId, sessionId: story.sessionId }, JSON.stringify([cardId, storyId, story.sessionId])) : _jsx(Muted, { children: t('settings.cards.variableChooseStory') })] }) }) });
}
/** 导出当前选中剧情；导入必须选择现有工作区并先确认，失败保留文件以便重试。 */
export function SessionTransfer({ remote, sessions, sessionId }) {
    const t = useT(), toast = useToast(), workspaces = useLoader(() => remote.listSessionImportWorkspaces({}), [remote]);
    const active = useRef(true), pending = useRef(false);
    useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    const [workspaceId, setWorkspaceId] = useState(''), [archive, setArchive] = useState(null);
    const [busy, setBusy] = useState(false), [error, setError] = useState(null), [confirm, setConfirm] = useState(false);
    const exportSession = async () => {
        if (!sessionId || pending.current)
            return;
        pending.current = true;
        setBusy(true);
        setError(null);
        try {
            const result = await remote.exportSessionArchive({ sessionId });
            if (!result.ok)
                throw new Error(result.error.message);
            if (active.current)
                downloadJson('tavern-session.json', result.value.archive, 0);
        }
        catch (e) {
            if (active.current)
                setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            pending.current = false;
            if (active.current)
                setBusy(false);
        }
    };
    const choose = async (file) => {
        if (pending.current)
            return;
        setError(null);
        setArchive(null);
        if (file.size > 192 * 1024 * 1024) {
            setError(t('sessionArchive.tooLarge'));
            return;
        }
        pending.current = true;
        setBusy(true);
        try {
            const text = await file.text();
            if (active.current)
                setArchive({ name: file.name, text });
        }
        catch (e) {
            if (active.current)
                setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            pending.current = false;
            if (active.current)
                setBusy(false);
        }
    };
    const restore = async () => {
        if (!archive || !workspaceId || pending.current)
            return;
        pending.current = true;
        setConfirm(false);
        setBusy(true);
        setError(null);
        try {
            const result = await remote.importSessionArchive({ workspaceId, archiveJson: archive.text });
            if (!result.ok)
                throw new Error(result.error.message);
            if (active.current) {
                setArchive(null);
                toast.show(t('sessionArchive.imported'));
            }
            if (sessions && active.current)
                try {
                    await openChildSession({ ...sessions, open: id => { if (active.current)
                            sessions.open(id); } }, result.value.sessionId);
                }
                catch {
                    if (active.current)
                        setError(t('sessionArchive.navigationFailed'));
                }
        }
        catch (e) {
            if (active.current)
                setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            pending.current = false;
            if (active.current)
                setBusy(false);
        }
    };
    const items = workspaces.state.status === 'ready' ? workspaces.state.value.items : [];
    return _jsxs(Section, { title: t('sessionArchive.title'), description: t('sessionArchive.desc'), children: [toast.node, _jsx(SettingsRow, { title: t('sessionArchive.export'), description: !sessionId ? t('sessionArchive.chooseStory') : undefined, children: _jsx(Btn, { disabled: !sessionId || busy, onClick: () => void exportSession(), children: t('sessionArchive.export') }) }), _jsx(SettingsRow, { title: t('sessionArchive.workspace'), children: _jsx(Select, { value: workspaceId, title: t('sessionArchive.workspace'), disabled: busy || workspaces.state.status !== 'ready', options: [{ value: '', label: t('sessionArchive.chooseWorkspace') }, ...items.map(item => ({ value: item.id, label: item.title }))], onChange: setWorkspaceId }) }), _jsxs(SettingsRow, { title: t('sessionArchive.chooseFile'), description: archive?.name, children: [_jsx(FileBtn, { accept: "application/json,.json", disabled: busy, onFile: file => void choose(file), children: t('sessionArchive.chooseFile') }), _jsx(Btn, { primary: true, disabled: busy || !archive || !workspaceId, onClick: () => setConfirm(true), children: t('sessionArchive.import') })] }), _jsx(Err, { message: error ?? (workspaces.state.status === 'error' ? workspaces.state.message : null) }), workspaces.state.status === 'error' && _jsx(Btn, { onClick: workspaces.reload, children: t('action.retry') }), _jsx(ConfirmDialog, { open: confirm, title: t('sessionArchive.import'), description: t('sessionArchive.confirm'), busy: busy, onCancel: () => setConfirm(false), onConfirm: () => void restore() })] });
}
export function StoryVariableSettings(props) {
    const { remote, sessionId, storyId } = props, t = useT();
    const loaded = useLoader(async () => {
        const events = await remote.getHelperEventState({ sessionId, storyId });
        if (!events.ok)
            return events;
        const message = [...events.value.messages].reverse().find(item => item.role === 'assistant');
        if (!message)
            throw new Error(t('settings.cards.variableNoMessage'));
        const result = await remote.getHelperSnapshot({ sessionId, messageId: message.seq });
        if (!result.ok)
            return result;
        if (result.value.storyId !== storyId)
            throw new Error(t('speech.helperStoryChanged'));
        return { ok: true, value: { snapshot: result.value, messageId: message.seq } };
    }, [sessionId, storyId]);
    const [library, setLibrary] = useState(null);
    const [scriptError, setScriptError] = useState(null), [scriptBusy, setScriptBusy] = useState(false);
    const scriptGuard = useDraftGuard(false, scriptBusy);
    const editScripts = async () => {
        setScriptBusy(true);
        setScriptError(null);
        try {
            const result = await remote.getHelperScriptLibrary({ target: { type: 'character', cardId: props.cardId } });
            if (!result.ok)
                throw new Error(result.error.message);
            setLibrary(result.value);
        }
        catch (error) {
            setScriptError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setScriptBusy(false);
        }
    };
    return _jsxs(_Fragment, { children: [scriptGuard.confirmation, _jsx(SettingsRow, { title: t('speech.scriptEditor'), children: _jsx(Btn, { disabled: scriptBusy, onClick: () => void editScripts(), children: t('speech.scriptEditor') }) }), _jsx(Err, { message: scriptError }), library && _jsx(HelperScriptEditor, { remote: remote, library: library, onClose: () => setLibrary(null), onSaved: () => notifyHelperScripts(sessionId, storyId) }), loaded.state.status === 'loading' && _jsx(Skeleton, { height: 100 }), loaded.state.status === 'error' && _jsxs(_Fragment, { children: [_jsx(Err, { message: loaded.state.message }), _jsx(Btn, { onClick: loaded.reload, children: t('action.retry') })] }), loaded.state.status === 'ready' && _jsx(VariableBackupEditor, { remote: remote, sessionId: sessionId, snapshot: loaded.state.value.snapshot, messageId: loaded.state.value.messageId, onRefresh: loaded.reload }, loaded.state.value.snapshot.historyRevision)] });
}
export function VariableBackupEditor(props) {
    const t = useT(), toast = useToast();
    const [snapshot, setSnapshot] = useState(props.snapshot);
    useEffect(() => { setSnapshot(props.snapshot); }, [props.snapshot]);
    const [text, setText] = useDraftState(`card-data:backup:${JSON.stringify([props.sessionId, snapshot.storyId])}`, '');
    const [error, setError] = useState(null), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
    const guard = useDraftGuard(Boolean(text.trim()), busy);
    const restore = async () => {
        setConfirm(false);
        setBusy(true);
        setError(null);
        try {
            const target = parseHelperVariableBackup(text, snapshot.currentMessageId);
            const changes = helperVariableRestoreChanges(snapshot.scopes, target);
            if (!snapshot.writable)
                throw new Error(t('settings.cards.variableReadOnly'));
            if (changes.length) {
                const result = await props.remote.commitHelperVariables({ sessionId: props.sessionId, messageId: props.messageId, storyId: snapshot.storyId, historyRevision: snapshot.historyRevision, changes });
                if (!result.ok)
                    throw new Error(result.error.message);
                if (result.value.storyId !== snapshot.storyId)
                    throw new Error(t('speech.helperStoryChanged'));
                setSnapshot(result.value);
                notifyHelperStory(props.sessionId, snapshot.storyId);
            }
            else {
                // 旧快照相等不能证明服务器仍相等；只读复核后才提示无需恢复，不清掉冲突草稿。
                const fresh = await props.remote.getHelperSnapshot({ sessionId: props.sessionId, messageId: props.messageId });
                if (!fresh.ok)
                    throw new Error(fresh.error.message);
                if (fresh.value.storyId !== snapshot.storyId || fresh.value.historyRevision !== snapshot.historyRevision)
                    throw new Error(t('speech.helperStoryChanged'));
                if (!fresh.value.writable)
                    throw new Error(t('settings.cards.variableReadOnly'));
                if (helperVariableRestoreChanges(fresh.value.scopes, target).length)
                    throw new Error(t('settings.cards.variableConflict'));
                setSnapshot(fresh.value);
            }
            setText('');
            guard.clearDraft();
            toast.show(t(changes.length ? 'speech.variableSaved' : 'settings.cards.variableUnchanged'));
        }
        catch (error) {
            setError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    return _jsxs(_Fragment, { children: [toast.node, guard.confirmation, _jsx(Muted, { children: t(snapshot.writable ? 'settings.cards.variableLoaded' : 'settings.cards.variableReadOnly') }), _jsx(SettingsRow, { title: t('speech.helperRefresh'), description: t('settings.cards.variableRefreshDesc'), children: _jsx(Btn, { disabled: busy, onClick: () => guard.request(() => { setText(''); setError(null); props.onRefresh(); }), children: t('speech.helperRefresh') }) }), _jsx(SettingsRow, { title: t('settings.cards.variableExport'), children: _jsx(Btn, { disabled: busy, onClick: () => downloadJson('tavern-variables.json', { version: 1, scopes: snapshot.scopes }, 0), children: t('settings.cards.variableExport') }) }), _jsx(SettingsRow, { stacked: true, title: t('speech.cardDataRestore'), description: t('settings.cards.variableRestoreDesc'), children: _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont", "aria-label": t('speech.cardDataText'), value: text, disabled: busy, onChange: event => setText(event.target.value) }) }), _jsx(Err, { message: error }), _jsxs(SaveBar, { children: [_jsx(Btn, { disabled: busy || !text.trim(), onClick: () => guard.request(() => { setText(''); setError(null); }), children: t('action.cancel') }), _jsx(Btn, { primary: true, disabled: busy || !snapshot.writable || !text.trim(), onClick: () => { try {
                            helperVariableRestoreChanges(snapshot.scopes, parseHelperVariableBackup(text, snapshot.currentMessageId));
                            setError(null);
                            setConfirm(true);
                        }
                        catch (error) {
                            setError(error instanceof Error ? error.message : String(error));
                        } }, children: t('speech.cardDataRestore') })] }), _jsx(ConfirmDialog, { open: confirm, title: t('speech.cardDataRestore'), description: t('settings.cards.variableRestoreConfirm'), busy: busy, onCancel: () => setConfirm(false), onConfirm: () => void restore() })] });
}
