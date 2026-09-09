import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/** 设置页的剧情变量管理：显式选择角色和剧情，备份已保存快照；恢复经原有楼层 WAL/CAS，草稿及失败留在设置。 */
import { useState } from 'react';
import { parseHelperVariableBackup, helperVariableRestoreChanges } from '../../core/helperVariableBackup.js';
import { DraftScope, useDraftGuard } from '../drafts.js';
import { useDraftState } from '../draftPersistence.js';
import { HelperScriptEditor } from '../helperScriptEditor.js';
import { notifyHelperStory } from '../helperNotifications.js';
import { notifyHelperScripts } from '../helperScriptNotifications.js';
import { useT } from '../i18n.js';
import { Btn, ConfirmDialog, Err, Muted, SaveBar, Section, Select, SettingsRow, Skeleton, downloadJson, useLoader, useToast } from '../util.js';
export function CardDataSettings({ remote }) {
    const t = useT();
    const [cardId, setCardId] = useDraftState('card-data:card', '');
    const [storyId, setStoryId] = useDraftState('card-data:story', '');
    const chars = useLoader(() => remote.listCharacters({}), []);
    const stories = useLoader(() => remote.listStories({ cardId }), [cardId], Boolean(cardId));
    const items = stories.state.status === 'ready' ? stories.state.value.items : [];
    const story = items.find(item => item.id === storyId);
    return _jsx(Section, { title: t('speech.cardDataTitle'), description: t('settings.cards.variablesDesc'), children: _jsx(DraftScope, { children: request => _jsxs(_Fragment, { children: [_jsx(SettingsRow, { title: t('settings.cards.variableCharacter'), children: _jsx(Select, { value: cardId, title: t('settings.cards.variableCharacter'), options: [{ value: '', label: t('settings.cards.variableChoose') }, ...(chars.state.status === 'ready' ? chars.state.value.items.map(item => ({ value: item.cardId, label: item.name })) : [])], onChange: value => request(() => { setCardId(value); setStoryId(''); }) }) }), _jsx(SettingsRow, { title: t('memory.story'), children: _jsx(Select, { value: storyId, title: t('memory.story'), disabled: !cardId || stories.state.status !== 'ready', options: [{ value: '', label: t('settings.cards.variableChoose') }, ...items.map((item, index) => ({ value: item.id, label: t('memory.storyLabel', { index: index + 1, date: new Date(item.createdAt).toLocaleString() }) }))], onChange: value => request(() => setStoryId(value)) }) }), (chars.state.status === 'loading' || stories.state.status === 'loading') && _jsx(Skeleton, { height: 40 }), _jsx(Err, { message: chars.state.status === 'error' ? chars.state.message : stories.state.status === 'error' ? stories.state.message : null }), (chars.state.status === 'error' || stories.state.status === 'error') && _jsx(Btn, { onClick: () => { chars.reload(); stories.reload(); }, children: t('action.retry') }), story ? _jsx(StoryVariableSettings, { remote: remote, cardId: cardId, storyId: storyId, sessionId: story.sessionId }, JSON.stringify([cardId, storyId, story.sessionId])) : _jsx(Muted, { children: t('settings.cards.variableChooseStory') })] }) }) });
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
    return _jsxs(_Fragment, { children: [toast.node, guard.confirmation, _jsx(Muted, { children: t(snapshot.writable ? 'settings.cards.variableLoaded' : 'settings.cards.variableReadOnly') }), _jsx(SettingsRow, { title: t('speech.helperRefresh'), description: t('settings.cards.variableRefreshDesc'), children: _jsx(Btn, { disabled: busy, onClick: () => guard.request(props.onRefresh), children: t('speech.helperRefresh') }) }), _jsx(SettingsRow, { title: t('settings.cards.variableExport'), children: _jsx(Btn, { disabled: busy, onClick: () => downloadJson('tavern-variables.json', { version: 1, scopes: snapshot.scopes }, 0), children: t('settings.cards.variableExport') }) }), _jsx(SettingsRow, { stacked: true, title: t('speech.cardDataRestore'), description: t('settings.cards.variableRestoreDesc'), children: _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont", "aria-label": t('speech.cardDataText'), value: text, disabled: busy, onChange: event => setText(event.target.value) }) }), _jsx(Err, { message: error }), _jsxs(SaveBar, { children: [_jsx(Btn, { disabled: busy || !text.trim(), onClick: () => guard.request(() => setText('')), children: t('action.cancel') }), _jsx(Btn, { primary: true, disabled: busy || !snapshot.writable || !text.trim(), onClick: () => { try {
                            helperVariableRestoreChanges(snapshot.scopes, parseHelperVariableBackup(text, snapshot.currentMessageId));
                            setError(null);
                            setConfirm(true);
                        }
                        catch (error) {
                            setError(error instanceof Error ? error.message : String(error));
                        } }, children: t('speech.cardDataRestore') })] }), _jsx(ConfirmDialog, { open: confirm, title: t('speech.cardDataRestore'), description: t('settings.cards.variableRestoreConfirm'), busy: busy, onCancel: () => setConfirm(false), onConfirm: () => void restore() })] });
}
