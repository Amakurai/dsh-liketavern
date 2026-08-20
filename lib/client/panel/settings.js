import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 设置面板分区：顶部「选卡后的默认配置」+ 采样参数 / 世界书全局 / 交互卡。
 * 排版对齐通用设置：标题 + 说明 + 右侧 36px 胶囊控件；瞬时保存反馈走 useToast，上下文错误用 Err。
 */
import { useEffect, useState } from 'react';
import { EMPTY_SESSION_DEFAULTS } from '../types.js';
import { Btn, Err, Muted, NumInput, Section, Select, SettingsRow, Skeleton, Toggle, textarea, useLoader, useToast } from '../util.js';
export function SettingsSection(props) {
    const { remote } = props;
    const { state, reload } = useLoader(() => remote.getSettings({}), []);
    const presets = useLoader(() => remote.listPresets({}), []);
    const lore = useLoader(() => remote.listLorebooks({}), []);
    const personas = useLoader(() => remote.listPersonas({}), []);
    const [draft, setDraft] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const toast = useToast();
    /** 老配置可能缺 defaults 键，落成草稿时按 EMPTY_SESSION_DEFAULTS 补齐。 */
    const toDraft = (settings) => ({
        ...structuredClone(settings),
        defaults: { ...EMPTY_SESSION_DEFAULTS, ...settings.defaults },
        worldInfo: { ...settings.worldInfo, useGroupScoring: settings.worldInfo.useGroupScoring ?? false },
    });
    useEffect(() => {
        if (state.status === 'ready')
            setDraft(toDraft(state.value.settings));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state]);
    const save = async (patch, toastText) => {
        setBusy(true);
        setError(null);
        const r = await remote.updateSettings({ patch });
        setBusy(false);
        if (!r.ok)
            setError(r.error.message);
        else {
            const saved = toDraft(r.value.settings);
            // 一页有多个独立保存区：只用服务端返回值刷新本次保存的键，保留其它区尚未保存的草稿。
            setDraft((current) => {
                if (!current)
                    return saved;
                const next = { ...current };
                for (const key of Object.keys(patch)) {
                    ;
                    next[key] = structuredClone(saved[key]);
                }
                return next;
            });
            toast.show(toastText);
        }
    };
    if (state.status === 'loading')
        return (_jsxs(Section, { title: "\u8BBE\u7F6E", children: [_jsx(Skeleton, { height: 56 }), _jsx(Skeleton, { height: 56 }), _jsx(Skeleton, { height: 56 })] }));
    if (state.status === 'error')
        return (_jsxs(Section, { title: "\u8BBE\u7F6E", children: [_jsx(Err, { message: state.message }), _jsx(Btn, { size: "md", onClick: reload, children: "\u91CD\u8BD5" })] }));
    if (!draft)
        return null;
    const presetItems = presets.state.status === 'ready' ? presets.state.value.items : [];
    const lorebooks = lore.state.status === 'ready' ? lore.state.value.items : [];
    const personaItems = personas.state.status === 'ready' ? personas.state.value.items : [];
    const embeddedLabel = '（使用所选角色的卡内嵌书 / 无）';
    const setSampling = (patch) => setDraft({ ...draft, sampling: { ...draft.sampling, ...patch } });
    const setWorldInfo = (patch) => setDraft({ ...draft, worldInfo: { ...draft.worldInfo, ...patch } });
    const setDefaults = (patch) => setDraft({ ...draft, defaults: { ...draft.defaults, ...patch } });
    return (_jsxs(_Fragment, { children: [toast.node, _jsxs(Section, { title: "\u9009\u5361\u540E\u7684\u9ED8\u8BA4\u914D\u7F6E", description: "\u5728\u65B0\u5BF9\u8BDD\u91CC\u70B9\u9009\u4EFB\u610F\u89D2\u8272\u5361\u540E\uFF0C\u4F1A\u5957\u7528\u8FD9\u91CC\u7684\u9884\u8BBE\u3001\u4E16\u754C\u4E66\u4E0E\u4EBA\u8BBE\u3002\u65B0\u5BF9\u8BDD\u4E0D\u4F1A\u81EA\u52A8\u9009\u89D2\u8272\uFF1B\u5DF2\u6253\u5F00\u7684\u4F1A\u8BDD\u8BF7\u7528\u5BF9\u8BDD\u9875\u89D2\u8272\u82AF\u7247\u4FEE\u6539\u3002", children: [_jsx(SettingsRow, { title: "\u63D0\u793A\u8BCD\u9884\u8BBE", description: "\u5F53\u524D\u4F1A\u8BDD\u8BF7\u7528\u5BF9\u8BDD\u9875\u89D2\u8272\u82AF\u7247\u5207\u6362\u3002\u8FD9\u91CC\u53EA\u5F71\u54CD\u4E4B\u540E\u70B9\u9009\u89D2\u8272\u65F6\u7684\u9ED8\u8BA4\u503C\u3002", children: _jsx(Select, { size: "md", value: draft.defaults.presetId, onChange: (presetId) => setDefaults({ presetId }), options: [
                                { value: '', label: '（内建默认预设）' },
                                ...presetItems.map((p) => ({ value: p.id, label: p.regexCount > 0 ? `${p.name}（${p.regexCount} 条正则）` : p.name })),
                            ] }) }), _jsx(SettingsRow, { title: "\u4EBA\u8BBE", description: "\u7528\u6237\u4FA7\u540D\u5B57\uFF08{{user}}\uFF09\u3002\u53EF\u7A7A\uFF1B\u82E5\u5E93\u91CC\u53EA\u6709\u4E00\u6761\u4EBA\u8BBE\uFF0C\u672A\u9009\u62E9\u65F6\u4E5F\u4F1A\u81EA\u52A8\u7528\u90A3\u6761\u3002", children: _jsx(Select, { size: "md", value: draft.defaults.personaId, onChange: (personaId) => setDefaults({ personaId }), options: [{ value: '', label: '（无人设）' }, ...personaItems.map((p) => ({ value: p.id, label: p.name }))] }) }), _jsx(SettingsRow, { title: "\u4E3B\u4E16\u754C\u4E66", description: "Character Lore\u3002\u4E0D\u9009\u5219\u4F7F\u7528\u89D2\u8272\u5361\u5185\u5D4C\u4E16\u754C\u4E66\uFF08\u82E5\u5BFC\u5165\u65F6\u4FDD\u7559\u4E86\uFF09\u3002", children: _jsx(Select, { size: "md", value: draft.defaults.characterLorebookId, onChange: (characterLorebookId) => setDefaults({ characterLorebookId }), options: [{ value: '', label: embeddedLabel }, ...lorebooks.map((n) => ({ value: n, label: n }))] }) }), _jsx(SettingsRow, { title: "\u5168\u5C40\u4E16\u754C\u4E66", description: "\u53EF\u591A\u9009\uFF0C\u6BCF\u8F6E\u68C0\u7D22\u65F6\u4E0E\u4E3B\u4E16\u754C\u4E66\u4E00\u5E76\u626B\u63CF\u3002", stacked: true, children: lorebooks.length === 0 ? (_jsx(Muted, { children: "\u5E93\u4E2D\u6682\u65E0\u72EC\u7ACB\u4E16\u754C\u4E66\u3002\u53EF\u5728\u300C\u4E16\u754C\u4E66\u300D\u9875\u5BFC\u5165\uFF0C\u6216\u4F7F\u7528\u89D2\u8272\u5361\u5185\u5D4C\u4E66\u3002" })) : (_jsx("div", { className: "dsh-tavern-checkList", children: lorebooks.map((n) => (_jsxs("label", { children: [_jsx("input", { type: "checkbox", checked: draft.defaults.lorebookIds.includes(n), onChange: (e) => setDefaults({
                                            lorebookIds: e.target.checked ? [...draft.defaults.lorebookIds, n] : draft.defaults.lorebookIds.filter((x) => x !== n),
                                        }) }), n] }, n))) })) }), _jsx("div", { style: { padding: '12px 0 4px' }, children: _jsx(Btn, { primary: true, size: "md", disabled: busy, onClick: () => void save({ defaults: draft.defaults }, '已保存选卡后的默认配置'), children: "\u4FDD\u5B58\u9ED8\u8BA4\u914D\u7F6E" }) })] }), _jsx("div", { className: "dsh-tavern-groupHead", children: "\u89D2\u8272\u5361" }), _jsxs(Section, { title: "\u89D2\u8272\u5361", description: "\u5220\u9664\u89D2\u8272\u5361\u65F6\u7684\u8FDE\u5E26\u884C\u4E3A\u3002", children: [_jsx(SettingsRow, { title: "\u8FDE\u540C\u5220\u9664\u5185\u5D4C\u4E16\u754C\u4E66", description: "\u5F00\u542F\uFF1A\u5220\u9664\u89D2\u8272\u5361\u65F6\u5176\u5185\u5D4C\u4E16\u754C\u4E66\u4E00\u5E76\u5220\u9664\u3002\u5173\u95ED\uFF1A\u5220\u5361\u524D\u628A\u5185\u5D4C\u4E66\u4FDD\u7559\u5230\u4E16\u754C\u4E66\u5E93\uFF08\u91CD\u540D\u81EA\u52A8\u52A0\u5E8F\u53F7\uFF09\u3002", children: _jsx(Toggle, { checked: draft.cascadeDeleteEmbeddedBook, onChange: (cascadeDeleteEmbeddedBook) => setDraft({ ...draft, cascadeDeleteEmbeddedBook }) }) }), _jsx("div", { style: { padding: '12px 0 4px' }, children: _jsx(Btn, { primary: true, size: "md", disabled: busy, onClick: () => void save({ cascadeDeleteEmbeddedBook: draft.cascadeDeleteEmbeddedBook }, '已保存角色卡设置'), children: "\u4FDD\u5B58\u89D2\u8272\u5361\u8BBE\u7F6E" }) })] }), _jsx("div", { className: "dsh-tavern-groupHead", children: "\u91C7\u6837\u4E0E\u884C\u4E3A" }), _jsxs(Section, { title: "\u91C7\u6837\u53C2\u6570", description: "temperature / maxTokens / stop \u4F1A\u900F\u4F20\u5230\u6A21\u578B\uFF1BtopP \u4E0E penalty \u5F53\u524D\u5E73\u53F0\u4E0D\u751F\u6548\uFF0C\u4EC5\u4F5C\u8BB0\u5F55\u3002", children: [_jsx(SettingsRow, { title: "temperature", description: "0\u20132\uFF0C\u9ED8\u8BA4 1\u3002thinking \u6A21\u5F0F\u4E0B\u4E0D\u751F\u6548\u3002", children: _jsx(NumInput, { step: "0.05", value: draft.sampling.temperature, onChange: (v) => setSampling({ temperature: v }) }) }), _jsx(SettingsRow, { title: "topP", description: "0\u20131\u3002\u5F53\u524D dsh \u6A21\u578B\u670D\u52A1\u4E0D\u900F\u4F20\u3002", children: _jsx(NumInput, { step: "0.05", value: draft.sampling.topP, onChange: (v) => setSampling({ topP: v }) }) }), _jsx(SettingsRow, { title: "maxTokens", description: "\u5355\u6B21\u751F\u6210\u6700\u5927 token\uFF1B0 = \u6CBF\u7528\u6A21\u578B\u9ED8\u8BA4\u3002", children: _jsx(NumInput, { value: draft.sampling.maxTokens, onChange: (v) => setSampling({ maxTokens: Math.max(0, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: "presencePenalty", children: _jsx(NumInput, { step: "0.1", value: draft.sampling.presencePenalty, onChange: (v) => setSampling({ presencePenalty: v }) }) }), _jsx(SettingsRow, { title: "frequencyPenalty", children: _jsx(NumInput, { step: "0.1", value: draft.sampling.frequencyPenalty, onChange: (v) => setSampling({ frequencyPenalty: v }) }) }), _jsx(SettingsRow, { title: "\u6DF1\u5EA6\u601D\u8003", description: "\u5173\u95ED\uFF1A\u5BF9\u5F53\u524D\u6A21\u578B\u5199\u5165 off\uFF08\u82E5\u516C\u5E03\u8BE5\u6863\uFF09\u3002\u5F00\u542F\uFF1A\u4FDD\u7559\u4F1A\u8BDD\u5DF2\u9009\u6863\u4F4D\uFF0C\u5426\u5219\u7528\u6A21\u578B\u9ED8\u8BA4\u3002\u90E8\u7F72\u628A thinking \u9501\u6210 disabled \u65F6\u65E0\u6CD5\u6253\u5F00\u3002thinking \u6A21\u5F0F\u4E0B\u6E29\u5EA6\u4E0D\u751F\u6548\u3002", children: _jsx(Toggle, { checked: draft.sampling.thinking === 'enabled', onChange: (on) => setSampling({ thinking: on ? 'enabled' : 'disabled' }), title: "\u542F\u7528 thinking" }) }), _jsx(SettingsRow, { title: "\u505C\u6B62\u5E8F\u5217", description: "\u6BCF\u884C\u4E00\u4E2A\u3002", stacked: true, children: _jsx("textarea", { style: { ...textarea, minHeight: 64 }, value: draft.sampling.stop.join('\n'), onChange: (e) => setSampling({ stop: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) }) }) }), _jsx("div", { style: { padding: '12px 0 4px' }, children: _jsx(Btn, { disabled: busy, onClick: () => void save({ sampling: draft.sampling }, '已保存采样参数'), primary: true, size: "md", children: "\u4FDD\u5B58\u91C7\u6837\u53C2\u6570" }) })] }), _jsx("div", { className: "dsh-tavern-groupHead", children: "\u4E16\u754C\u4E66\u5168\u5C40" }), _jsxs(Section, { title: "\u4E16\u754C\u4E66\u5168\u5C40\u8BBE\u7F6E", description: "\u626B\u63CF\u6DF1\u5EA6\u3001\u9884\u7B97\u4E0E\u5408\u5E76\u7B56\u7565\uFF0C\u5BF9\u6240\u6709\u4F1A\u8BDD\u751F\u6548\u3002", children: [_jsx(SettingsRow, { title: "\u626B\u63CF\u6DF1\u5EA6 scanDepth", children: _jsx(NumInput, { value: draft.worldInfo.scanDepth, onChange: (v) => setWorldInfo({ scanDepth: Math.max(0, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: "\u9884\u7B97\u767E\u5206\u6BD4 contextPercent", children: _jsx(NumInput, { value: draft.worldInfo.contextPercent, onChange: (v) => setWorldInfo({ contextPercent: v }) }) }), _jsx(SettingsRow, { title: "\u56FA\u5B9A token \u9884\u7B97", children: _jsx(NumInput, { value: draft.worldInfo.tokenBudget, onChange: (v) => setWorldInfo({ tokenBudget: Math.max(0, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: "\u6700\u5927\u9012\u5F52\u6B65\u6570", children: _jsx(NumInput, { value: draft.worldInfo.maxRecursionSteps, onChange: (v) => setWorldInfo({ maxRecursionSteps: Math.max(0, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: "\u5408\u5E76\u7B56\u7565", children: _jsx(Select, { size: "md", value: String(draft.worldInfo.characterStrategy), onChange: (v) => setWorldInfo({ characterStrategy: Number(v) }), options: [
                                { value: '0', label: 'Sorted Evenly' },
                                { value: '1', label: 'Character Lore First' },
                                { value: '2', label: 'Global Lore First' },
                            ] }) }), [
                        ['recursiveScan', '递归扫描', '命中条目的内容继续作为关键词扫描。'],
                        ['caseSensitive', '区分大小写', ''],
                        ['matchWholeWords', '整词匹配', '对中文不友好，建议关闭。'],
                        ['includeNames', '扫描计入消息名前缀', ''],
                        ['overflowWarning', '预算溢出告警', ''],
                        ['useGroupScoring', '组内按命中键数挑选', '开启后同组按命中关键词数选一条；关闭则按组权重随机。'],
                    ].map(([key, title, description]) => (_jsx(SettingsRow, { title: title, description: description || undefined, children: _jsx(Toggle, { checked: draft.worldInfo[key], onChange: (on) => setWorldInfo({ [key]: on }) }) }, key))), _jsx("div", { style: { padding: '12px 0 4px' }, children: _jsx(Btn, { disabled: busy, onClick: () => void save({ worldInfo: draft.worldInfo }, '已保存世界书设置'), primary: true, size: "md", children: "\u4FDD\u5B58\u4E16\u754C\u4E66\u8BBE\u7F6E" }) })] }), _jsx("div", { className: "dsh-tavern-groupHead", children: "\u4EA4\u4E92\u5361" }), _jsxs(Section, { title: "\u4EA4\u4E92\u5361", description: "\u5C01\u9762 HTML \u9ED8\u8BA4\u5141\u8BB8\u52A0\u8F7D https \u56FE\u7247\u4E0E\u5B57\u4F53\u3002\u5361\u5185\u5207\u5F00\u573A\u767D\u8D70\u5BBF\u4E3B swipe\uFF0C\u4E0D\u5F00\u653E\u4E3B\u7A97\u53E3 API\u3002", children: [_jsx(SettingsRow, { title: "\u4EA4\u4E92\u5361\u6E32\u67D3", description: "\u5173\u95ED\u540E\u5C01\u9762\u4E0E\u4EA4\u4E92\u5361\u4E00\u5F8B\u6309\u7EAF\u6587\u672C\u663E\u793A\u3002", children: _jsx(Toggle, { checked: draft.interactiveCards, onChange: (interactiveCards) => setDraft({ ...draft, interactiveCards }) }) }), _jsx(SettingsRow, { title: "\u89E6\u53D1\u65E5\u5FD7\u4FDD\u7559\u6761\u6570", children: _jsx(NumInput, { value: draft.triggerLogMax, onChange: (v) => setDraft({ ...draft, triggerLogMax: Math.max(10, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: "\u811A\u672C\u4FE1\u4EFB\u7684\u5916\u90E8\u57DF\u540D", description: "\u5C01\u9762\u811A\u672C\u9ED8\u8BA4\u4E0D\u80FD fetch/XHR\u3001\u4E5F\u4E0D\u80FD\u52A0\u8F7D\u5916\u90E8\u811A\u672C\uFF1B\u6309\u884C\u586B\u5199\u57DF\u540D\u9010\u4E2A\u653E\u884C\uFF0C\u5355\u72EC\u4E00\u884C * \u8868\u793A\u5168\u90E8\u653E\u884C\u3002\u56FE\u7247\u548C\u5B57\u4F53\u9ED8\u8BA4\u5DF2\u653E\u884C https\u3002", stacked: true, children: _jsx("textarea", { style: { ...textarea, minHeight: 64 }, value: draft.cardNetworkWhitelist.join('\n'), onChange: (e) => setDraft({ ...draft, cardNetworkWhitelist: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) }) }) }), _jsx("div", { style: { padding: '12px 0 4px' }, children: _jsx(Btn, { primary: true, size: "md", disabled: busy, onClick: () => void save({
                                interactiveCards: draft.interactiveCards,
                                triggerLogMax: draft.triggerLogMax,
                                cardNetworkWhitelist: draft.cardNetworkWhitelist,
                            }, '已保存交互卡设置'), children: "\u4FDD\u5B58\u4EA4\u4E92\u5361\u8BBE\u7F6E" }) })] }), _jsx(Err, { message: error })] }));
}
