import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/** 新会话角色选择：头像、搜索与本次打开应用期间最近使用；资产管理复用原有导入及世界书确认流程。 */
import { useState } from 'react';
import { cachedAvatar } from './cache.js';
import { DraftScope } from './drafts.js';
import { useT } from './i18n.js';
import { CharactersSection } from './panel/characters.js';
import { Avatar, Badge, Btn, Dialog, Err, SearchEmpty, SearchInput, Skeleton, useLoader } from './util.js';
const recentByRemote = new WeakMap();
export function rememberCharacter(remote, cardId) {
    recentByRemote.set(remote, [cardId, ...(recentByRemote.get(remote) ?? []).filter((id) => id !== cardId)].slice(0, 12));
}
function PickerItem(props) {
    const { item } = props;
    const t = useT();
    const avatar = useLoader(() => cachedAvatar(props.remote, item.cardId), [item.cardId], item.hasAvatar);
    return _jsxs("button", { type: "button", className: "dsh-tavern-pickerItem", "aria-pressed": props.selected, disabled: props.busy, onClick: props.onPick, children: [_jsx(Avatar, { name: item.name, url: avatar.state.status === 'ready' ? avatar.state.value.dataUrl : null, size: 52 }), _jsxs("span", { className: "dsh-tavern-pickerText", children: [_jsx("strong", { children: item.name }), item.hasCharacterBook && _jsx("span", { children: item.characterBookName || t('hero.picker.embeddedBook') }), props.recent && _jsx("span", { children: t('hero.picker.recent') })] }), props.selected && _jsx(Badge, { accent: true, children: t('hero.picker.selected') })] });
}
export function CharacterPicker(props) {
    const t = useT();
    const [query, setQuery] = useState('');
    const [limit, setLimit] = useState(24);
    const [managing, setManaging] = useState(false);
    const chars = useLoader(() => props.remote.listCharacters({}), [managing]);
    const items = chars.state.status === 'ready' ? chars.state.value.items : [];
    const recent = recentByRemote.get(props.remote) ?? [];
    const q = query.trim().toLocaleLowerCase();
    const filtered = items.filter((c) => `${c.name}\n${c.characterBookName ?? ''}`.toLocaleLowerCase().includes(q))
        .sort((a, b) => {
        const rank = (id) => { const i = recent.indexOf(id); return i < 0 ? recent.length : i; };
        return rank(a.cardId) - rank(b.cardId);
    });
    return _jsx(DraftScope, { children: (request) => _jsx(Dialog, { open: true, width: "lg", title: t(managing ? 'section.characters' : 'hero.pickCharacter'), onClose: () => { if (!props.busy)
                request(props.onClose); }, children: managing ? _jsxs(_Fragment, { children: [_jsx(Btn, { onClick: () => request(() => setManaging(false)), children: t('hero.picker.back') }), _jsx(CharactersSection, { remote: props.remote })] }) : _jsxs("div", { className: "dsh-tavern-section", children: [_jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(SearchInput, { label: t('characters.searchLabel'), value: query, width: "100%", onChange: (value) => { setQuery(value); setLimit(24); } }), _jsx(Btn, { disabled: props.busy, onClick: () => setManaging(true), children: t('hero.picker.manage') })] }), _jsx(Err, { message: props.error ?? (chars.state.status === 'error' ? chars.state.message : null) }), chars.state.status === 'error' && _jsx(Btn, { onClick: chars.reload, children: t('action.retry') }), chars.state.status === 'loading' && _jsxs(_Fragment, { children: [_jsx(Skeleton, { height: 84 }), _jsx(Skeleton, { height: 84 })] }), chars.state.status === 'ready' && items.length === 0 && _jsxs("div", { className: "dsh-tavern-empty is-compact", children: [_jsx("div", { className: "dsh-tavern-emptyTitle", children: t('hero.noCharacters') }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: t('hero.picker.empty') }), _jsx(Btn, { primary: true, onClick: () => setManaging(true), children: t('hero.picker.manage') })] }), chars.state.status === 'ready' && items.length > 0 && filtered.length === 0 &&
                        _jsx(SearchEmpty, { what: t('characters.what'), query: query, onClear: () => setQuery('') }), _jsx("div", { className: "dsh-tavern-pickerList", "aria-busy": props.busy, children: filtered.slice(0, limit).map((item) => _jsx(PickerItem, { item: item, remote: props.remote, selected: props.selectedId === item.cardId, recent: recent.includes(item.cardId), busy: props.busy, onPick: () => props.onPick(item.cardId) }, item.cardId)) }), filtered.length > limit && _jsx(Btn, { onClick: () => setLimit(limit + 24), children: t('hero.picker.more') })] }) }) });
}
