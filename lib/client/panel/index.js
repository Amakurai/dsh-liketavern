import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** 设置面板入口：7 页签拆分各分区，视觉对齐插件 / Agent 预设。「默认绑定」已并入「设置」页。 */
import { useState } from 'react';
import { Tabs } from '../util.js';
import { CharactersSection } from './characters.js';
import { LorebooksSection } from './lorebooks.js';
import { MemorySection } from './memory.js';
import { PersonasSection } from './personas.js';
import { PresetsSection } from './presets.js';
import { RegexSection } from './regex.js';
import { SettingsSection } from './settings.js';
const TABS = [
    { id: 'characters', label: '角色' },
    { id: 'presets', label: '预设' },
    { id: 'lorebooks', label: '世界书' },
    { id: 'personas', label: '人设' },
    { id: 'regex', label: '正则' },
    { id: 'memory', label: '记忆' },
    { id: 'sampling', label: '设置' },
];
export function TavernPanel(props) {
    const { remote } = props;
    const [tab, setTab] = useState('characters');
    return (_jsxs("div", { className: "dsh-tavern-ui dsh-tavern-panel", style: { width: '100%', maxWidth: '100%', fontSize: 14, boxSizing: 'border-box' }, children: [_jsx(Tabs, { items: [...TABS], value: tab, onChange: (id) => setTab(id) }), tab === 'characters' && _jsx(CharactersSection, { remote: remote }), tab === 'presets' && _jsx(PresetsSection, { remote: remote }), tab === 'lorebooks' && _jsx(LorebooksSection, { remote: remote }), tab === 'personas' && _jsx(PersonasSection, { remote: remote }), tab === 'regex' && _jsx(RegexSection, { remote: remote }), tab === 'memory' && _jsx(MemorySection, { remote: remote }), tab === 'sampling' && _jsx(SettingsSection, { remote: remote })] }));
}
