import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 设置面板分区：二级子导航拆成六组——界面 / 默认配置 / 采样与思考 / 世界书引擎 / 记忆 / 卡片与数据。
 * 每组一个 Section（页面头 + 设置行 + 自己的 SaveBar），一次只看一组，不再一页堆到底。
 * 排版对齐通用设置：标题 + 说明 + 右侧 36px 胶囊控件；瞬时保存反馈走 useToast，上下文错误用 Err。
 * 「界面」组只有语言一项：选择即写设置并 setTavernLocale 立即生效，不走 SaveBar。
 */
import { useEffect, useState } from 'react';
import { setTavernLocale, useT } from '../i18n.js';
import { EMPTY_SESSION_DEFAULTS } from '../types.js';
import { Btn, CheckChips, Err, Muted, NumInput, SaveBar, Section, Select, SettingsRow, Skeleton, Tabs, Toggle, runAsync, useLoader, useToast } from '../util.js';
const SUBS = [
    { id: 'interface', labelKey: 'settings.sub.interface' },
    { id: 'defaults', labelKey: 'settings.sub.defaults' },
    { id: 'sampling', labelKey: 'settings.sub.sampling' },
    { id: 'worldinfo', labelKey: 'settings.sub.worldinfo' },
    { id: 'memory', labelKey: 'settings.sub.memory' },
    { id: 'cards', labelKey: 'settings.sub.cards' },
];
/** 切走再切回「设置」页签后停在用户上次看的子组。 */
let lastSub;
export function SettingsSection(props) {
    const { remote } = props;
    const t = useT();
    const { state, reload } = useLoader(() => remote.getSettings({}), []);
    const dataInfo = useLoader(() => remote.getDataInfo({}), []);
    const presets = useLoader(() => remote.listPresets({}), []);
    const lore = useLoader(() => remote.listLorebooks({}), []);
    const personas = useLoader(() => remote.listPersonas({}), []);
    const [sub, setSub] = useState(lastSub ?? 'interface');
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
    const save = (patch, toastText) => runAsync(setBusy, setError, async () => {
        const r = await remote.updateSettings({ patch });
        if (!r.ok) {
            setError(r.error.message);
            return;
        }
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
    });
    /** 语言切换：先本地生效再持久化；保存失败回退界面语言并提示。 */
    const changeLocale = (locale) => {
        if (!draft || locale === draft.locale)
            return;
        const prev = draft.locale;
        setDraft({ ...draft, locale });
        setTavernLocale(locale);
        void runAsync(setBusy, setError, async () => {
            const r = await remote.updateSettings({ patch: { locale } });
            if (!r.ok) {
                setDraft((current) => (current ? { ...current, locale: prev } : current));
                setTavernLocale(prev);
                setError(`${t('settings.interface.languageFailed')}: ${r.error.message}`);
            }
        });
    };
    if (state.status === 'loading')
        return (_jsxs(Section, { title: t('settings.title'), children: [_jsx(Skeleton, { height: 56 }), _jsx(Skeleton, { height: 56 }), _jsx(Skeleton, { height: 56 })] }));
    if (state.status === 'error')
        return (_jsxs(Section, { title: t('settings.title'), children: [_jsx(Err, { message: state.message }), _jsx(Btn, { size: "md", onClick: reload, children: t('action.retry') })] }));
    if (!draft)
        return null;
    const presetItems = presets.state.status === 'ready' ? presets.state.value.items : [];
    const lorebooks = lore.state.status === 'ready' ? lore.state.value.items : [];
    const personaItems = personas.state.status === 'ready' ? personas.state.value.items : [];
    const setSampling = (patch) => setDraft({ ...draft, sampling: { ...draft.sampling, ...patch } });
    const setWorldInfo = (patch) => setDraft({ ...draft, worldInfo: { ...draft.worldInfo, ...patch } });
    const setMemory = (patch) => setDraft({ ...draft, memory: { ...draft.memory, ...patch } });
    const setDefaults = (patch) => setDraft({ ...draft, defaults: { ...draft.defaults, ...patch } });
    return (_jsxs(_Fragment, { children: [toast.node, _jsx(Tabs, { size: "sm", items: SUBS.map((s) => ({ id: s.id, label: t(s.labelKey) })), value: sub, onChange: (id) => {
                    lastSub = id;
                    setSub(id);
                } }), _jsxs("div", { className: "dsh-tavern-rise", children: [sub === 'interface' && (_jsx(Section, { title: t('settings.interface.title'), description: t('settings.interface.desc'), children: _jsx(SettingsRow, { title: t('settings.interface.language'), description: t('settings.interface.languageDesc'), children: _jsx(Select, { size: "md", value: draft.locale, onChange: (v) => changeLocale(v === 'zh' ? 'zh' : 'en'), options: [
                                    { value: 'en', label: 'English' },
                                    { value: 'zh', label: '中文' },
                                ] }) }) })), sub === 'defaults' && (_jsxs(Section, { title: t('settings.defaults.title'), description: t('settings.defaults.desc'), children: [_jsx(SettingsRow, { title: t('settings.defaults.preset'), description: t('settings.defaults.presetDesc'), children: _jsx(Select, { size: "md", value: draft.defaults.presetId, onChange: (presetId) => setDefaults({ presetId }), options: [
                                        { value: '', label: t('settings.defaults.builtinPreset') },
                                        ...presetItems.map((p) => ({
                                            value: p.id,
                                            label: p.regexCount > 0 ? t('settings.defaults.presetRegexCount', { name: p.name, count: p.regexCount }) : p.name,
                                        })),
                                    ] }) }), _jsx(SettingsRow, { title: t('settings.defaults.persona'), description: t('settings.defaults.personaDesc'), children: _jsx(Select, { size: "md", value: draft.defaults.personaId, onChange: (personaId) => setDefaults({ personaId }), options: [{ value: '', label: t('settings.defaults.noPersona') }, ...personaItems.map((p) => ({ value: p.id, label: p.name }))] }) }), _jsx(SettingsRow, { title: t('settings.defaults.mainLore'), description: t('settings.defaults.mainLoreDesc'), children: _jsx(Select, { size: "md", value: draft.defaults.characterLorebookId, onChange: (characterLorebookId) => setDefaults({ characterLorebookId }), options: [{ value: '', label: t('settings.defaults.embeddedLore') }, ...lorebooks.map((n) => ({ value: n, label: n }))] }) }), _jsx(SettingsRow, { title: t('settings.defaults.globalLore'), description: t('settings.defaults.globalLoreDesc'), stacked: true, children: lorebooks.length === 0 ? (_jsx(Muted, { children: t('settings.defaults.noLorebooks') })) : (_jsx(CheckChips, { ariaLabel: t('settings.defaults.globalLore'), options: lorebooks.map((n) => ({ value: n, label: n })), selected: draft.defaults.lorebookIds, onChange: (lorebookIds) => setDefaults({ lorebookIds }) })) }), _jsx(SaveBar, { children: _jsx(Btn, { primary: true, size: "md", disabled: busy, onClick: () => void save({ defaults: draft.defaults }, t('settings.defaults.saved')), children: t('settings.defaults.save') }) })] })), sub === 'sampling' && (_jsxs(Section, { title: t('settings.sampling.title'), description: t('settings.sampling.desc'), children: [_jsx(SettingsRow, { title: "temperature", description: t('settings.sampling.temperatureDesc'), children: _jsx(NumInput, { step: "0.05", value: draft.sampling.temperature, onChange: (v) => setSampling({ temperature: v }) }) }), _jsx(SettingsRow, { title: "topP", description: t('settings.sampling.topPDesc'), children: _jsx(NumInput, { step: "0.05", value: draft.sampling.topP, onChange: (v) => setSampling({ topP: v }) }) }), _jsx(SettingsRow, { title: "maxTokens", description: t('settings.sampling.maxTokensDesc'), children: _jsx(NumInput, { value: draft.sampling.maxTokens, onChange: (v) => setSampling({ maxTokens: Math.max(0, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: "presencePenalty", children: _jsx(NumInput, { step: "0.1", value: draft.sampling.presencePenalty, onChange: (v) => setSampling({ presencePenalty: v }) }) }), _jsx(SettingsRow, { title: "frequencyPenalty", children: _jsx(NumInput, { step: "0.1", value: draft.sampling.frequencyPenalty, onChange: (v) => setSampling({ frequencyPenalty: v }) }) }), _jsx(SettingsRow, { title: t('settings.sampling.thinking'), description: t('settings.sampling.thinkingDesc'), children: _jsx(Select, { size: "md", value: draft.sampling.thinking, onChange: (v) => setSampling({ thinking: v }), options: [
                                        { value: 'disabled', label: t('settings.sampling.thinking.disabled') },
                                        { value: 'enabled', label: t('settings.sampling.thinking.enabled') },
                                        { value: 'low', label: t('settings.sampling.thinking.low') },
                                        { value: 'high', label: t('settings.sampling.thinking.high') },
                                        { value: 'max', label: t('settings.sampling.thinking.max') },
                                    ] }) }), _jsx(SettingsRow, { title: t('settings.sampling.stop'), description: t('settings.sampling.stopDesc'), stacked: true, children: _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont", style: { minHeight: 64 }, value: draft.sampling.stop.join('\n'), onChange: (e) => setSampling({ stop: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) }) }) }), _jsx(SaveBar, { children: _jsx(Btn, { disabled: busy, onClick: () => void save({ sampling: draft.sampling }, t('settings.sampling.saved')), primary: true, size: "md", children: t('settings.sampling.save') }) })] })), sub === 'worldinfo' && (_jsxs(Section, { title: t('settings.worldinfo.title'), description: t('settings.worldinfo.desc'), children: [_jsx(SettingsRow, { title: t('settings.worldinfo.scanDepth'), children: _jsx(NumInput, { value: draft.worldInfo.scanDepth, onChange: (v) => setWorldInfo({ scanDepth: Math.max(0, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: t('settings.worldinfo.contextPercent'), description: t('settings.worldinfo.contextPercentDesc'), children: _jsx(NumInput, { value: draft.worldInfo.contextPercent, onChange: (v) => setWorldInfo({ contextPercent: v }) }) }), _jsx(SettingsRow, { title: t('settings.worldinfo.tokenBudget'), description: t('settings.worldinfo.tokenBudgetDesc'), children: _jsx(NumInput, { value: draft.worldInfo.tokenBudget, onChange: (v) => setWorldInfo({ tokenBudget: Math.max(0, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: t('settings.worldinfo.maxRecursionSteps'), description: t('settings.worldinfo.maxRecursionStepsDesc'), children: _jsx(NumInput, { value: draft.worldInfo.maxRecursionSteps, onChange: (v) => setWorldInfo({ maxRecursionSteps: Math.max(0, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: t('settings.worldinfo.strategy'), children: _jsx(Select, { size: "md", value: String(draft.worldInfo.characterStrategy), onChange: (v) => setWorldInfo({ characterStrategy: Number(v) }), options: [
                                        { value: '0', label: 'Sorted Evenly' },
                                        { value: '1', label: 'Character Lore First' },
                                        { value: '2', label: 'Global Lore First' },
                                    ] }) }), [
                                ['recursiveScan', 'settings.worldinfo.recursiveScan', 'settings.worldinfo.recursiveScanDesc'],
                                ['caseSensitive', 'settings.worldinfo.caseSensitive', ''],
                                ['matchWholeWords', 'settings.worldinfo.matchWholeWords', 'settings.worldinfo.matchWholeWordsDesc'],
                                ['includeNames', 'settings.worldinfo.includeNames', ''],
                                ['overflowWarning', 'settings.worldinfo.overflowWarning', ''],
                                ['useGroupScoring', 'settings.worldinfo.useGroupScoring', 'settings.worldinfo.useGroupScoringDesc'],
                            ].map(([key, titleKey, descKey]) => (_jsx(SettingsRow, { title: t(titleKey), description: descKey ? t(descKey) : undefined, children: _jsx(Toggle, { checked: draft.worldInfo[key], onChange: (on) => setWorldInfo({ [key]: on }) }) }, key))), _jsx(SaveBar, { children: _jsx(Btn, { disabled: busy, onClick: () => void save({ worldInfo: draft.worldInfo }, t('settings.worldinfo.saved')), primary: true, size: "md", children: t('settings.worldinfo.save') }) })] })), sub === 'memory' && (_jsxs(Section, { title: t('settings.memory.title'), description: t('settings.memory.desc'), children: [_jsx(SettingsRow, { title: t('settings.memory.maxEntries'), description: t('settings.memory.maxEntriesDesc'), children: _jsx(NumInput, { value: draft.memory.maxEntries, onChange: (v) => setMemory({ maxEntries: Math.max(1, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: t('settings.memory.maxTokens'), description: t('settings.memory.maxTokensDesc'), children: _jsx(NumInput, { value: draft.memory.maxTokens, onChange: (v) => setMemory({ maxTokens: Math.max(0, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: t('settings.memory.retrievalTopK'), description: t('settings.memory.retrievalTopKDesc'), children: _jsx(NumInput, { value: draft.memory.retrievalTopK, onChange: (v) => setMemory({ retrievalTopK: Math.max(0, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: t('settings.memory.retrievalTokenBudget'), description: t('settings.memory.retrievalTokenBudgetDesc'), children: _jsx(NumInput, { value: draft.memory.retrievalTokenBudget, onChange: (v) => setMemory({ retrievalTokenBudget: Math.max(0, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: t('settings.memory.halfLifeDays'), description: t('settings.memory.halfLifeDaysDesc'), children: _jsx(NumInput, { value: draft.memory.halfLifeDays, onChange: (v) => setMemory({ halfLifeDays: Math.max(0, v) }) }) }), _jsx(SettingsRow, { title: t('settings.memory.dedupScore'), description: t('settings.memory.dedupScoreDesc'), children: _jsx(NumInput, { value: draft.memory.dedupScore, onChange: (v) => setMemory({ dedupScore: Math.max(0, v) }) }) }), _jsx(SettingsRow, { title: t('settings.memory.compressBatch'), description: t('settings.memory.compressBatchDesc'), children: _jsx(NumInput, { value: draft.memory.compressBatch, onChange: (v) => setMemory({ compressBatch: Math.max(2, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: t('settings.memory.queryMessages'), description: t('settings.memory.queryMessagesDesc'), children: _jsx(NumInput, { value: draft.memory.queryMessages, onChange: (v) => setMemory({ queryMessages: Math.max(1, Math.round(v)) }) }) }), _jsx(SaveBar, { children: _jsx(Btn, { disabled: busy, onClick: () => void save({ memory: draft.memory }, t('settings.memory.saved')), primary: true, size: "md", children: t('settings.memory.save') }) })] })), sub === 'cards' && (_jsxs(_Fragment, { children: [_jsxs(Section, { title: t('settings.cards.title'), description: t('settings.cards.desc'), children: [_jsx(SettingsRow, { title: t('settings.cards.cascadeDelete'), description: t('settings.cards.cascadeDeleteDesc'), children: _jsx(Toggle, { checked: draft.cascadeDeleteEmbeddedBook, onChange: (cascadeDeleteEmbeddedBook) => setDraft({ ...draft, cascadeDeleteEmbeddedBook }) }) }), _jsx(SettingsRow, { title: t('settings.cards.interactiveCards'), description: t('settings.cards.interactiveCardsDesc'), children: _jsx(Toggle, { checked: draft.interactiveCards, onChange: (interactiveCards) => setDraft({ ...draft, interactiveCards }) }) }), _jsx(SettingsRow, { title: t('settings.cards.triggerLogMax'), children: _jsx(NumInput, { value: draft.triggerLogMax, onChange: (v) => setDraft({ ...draft, triggerLogMax: Math.max(10, Math.round(v)) }) }) }), _jsx(SettingsRow, { title: t('settings.cards.whitelist'), description: t('settings.cards.whitelistDesc'), stacked: true, children: _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont", style: { minHeight: 64 }, value: draft.cardNetworkWhitelist.join('\n'), onChange: (e) => setDraft({ ...draft, cardNetworkWhitelist: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) }) }) }), _jsx(SaveBar, { children: _jsx(Btn, { primary: true, size: "md", disabled: busy, onClick: () => void save({
                                                cascadeDeleteEmbeddedBook: draft.cascadeDeleteEmbeddedBook,
                                                interactiveCards: draft.interactiveCards,
                                                triggerLogMax: draft.triggerLogMax,
                                                cardNetworkWhitelist: draft.cardNetworkWhitelist,
                                            }, t('settings.cards.saved')), children: t('settings.cards.save') }) })] }), _jsx("div", { className: "dsh-tavern-groupHead", children: t('settings.cards.dataHome') }), _jsx(Muted, { children: _jsxs("span", { style: { wordBreak: 'break-all' }, children: [t('settings.cards.dataHomeDesc'), dataInfo.state.status === 'ready' ? dataInfo.state.value.dataHome : '…'] }) })] }))] }, sub), _jsx(Err, { message: error })] }));
}
