import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 设置面板分区：全局正则脚本（列表 + enabled 开关 + 编辑，整表保存）。
 * find/replace 等代码向输入用 code 字体类；保存反馈走 useToast，上下文错误用 Err。
 */
import { useEffect, useState } from 'react';
import { IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { t as tOnce, useT } from '../i18n.js';
import { Badge, Btn, CheckChips, Err, Field, IconBtn, Muted, NullableNumInput, RegexScriptRow, SaveBar, Section, Select, Skeleton, Toggle, errOf, runAsync, useLoader, useToast } from '../util.js';
const SCOPES = [
    { value: 'input', labelKey: 'regex.scope.input' },
    { value: 'output', labelKey: 'regex.scope.output' },
    { value: 'prompt', labelKey: 'regex.scope.prompt' },
];
const TIMINGS = [
    { value: 'assemble', labelKey: 'regex.timing.assemble' },
    { value: 'send', labelKey: 'regex.timing.send' },
    { value: 'render', labelKey: 'regex.timing.render' },
];
const SOURCE_LABEL_KEY = { user: 'regex.source.user', card: 'regex.source.card', preset: 'regex.source.preset' };
function newRule() {
    return {
        id: `rule-${Date.now().toString(36)}`,
        name: tOnce('regex.newRuleName'),
        find: '',
        replace: '',
        enabled: true,
        scopes: ['prompt'],
        timing: ['send'],
        minDepth: null,
        maxDepth: null,
        substituteRegex: 0,
        source: 'user',
    };
}
function RuleEditor(props) {
    const t = useT();
    const { rule } = props;
    const set = (patch) => props.onChange({ ...rule, ...patch });
    return (_jsxs("div", { className: "dsh-tavern-entry", style: { marginBottom: 8 }, children: [_jsxs("div", { style: { display: 'flex', gap: 10, alignItems: 'center', padding: '12px 16px 8px' }, children: [_jsx(Toggle, { checked: rule.enabled, onChange: (enabled) => set({ enabled }), title: rule.enabled ? t('regex.toggleDisable') : t('regex.toggleEnable') }), _jsx("input", { className: "dsh-tavern-input", style: { flex: 1 }, value: rule.name, onChange: (e) => set({ name: e.target.value }) }), _jsx(Badge, { children: t(SOURCE_LABEL_KEY[rule.source]) }), _jsx(IconBtn, { label: t('regex.deleteRule'), danger: true, onClick: props.onDelete, children: _jsx(IconTrashOutline16, {}) })] }), _jsxs("div", { style: { padding: '2px 16px 14px' }, children: [_jsx(Field, { label: t('regex.find'), children: _jsx("input", { className: "dsh-tavern-input dsh-tavern-codeFont", style: { flex: 1 }, value: rule.find, onChange: (e) => set({ find: e.target.value }) }) }), _jsx("div", { className: "dsh-tavern-fieldLabel", style: { margin: '4px 0' }, children: t('regex.replace') }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont", style: { minHeight: 40 }, value: rule.replace, onChange: (e) => set({ replace: e.target.value }) }), _jsxs("div", { className: "dsh-tavern-fieldRow", style: { margin: '8px 0 4px' }, children: [_jsxs("div", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('regex.scope') }), _jsx(CheckChips, { ariaLabel: t('regex.scope'), options: SCOPES.map((o) => ({ value: o.value, label: t(o.labelKey) })), selected: rule.scopes, onChange: (scopes) => set({ scopes: scopes }) })] }), _jsxs("div", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('regex.timing') }), _jsx(CheckChips, { ariaLabel: t('regex.timing'), options: TIMINGS.map((o) => ({ value: o.value, label: t(o.labelKey) })), selected: rule.timing, onChange: (timing) => set({ timing: timing }) })] })] }), _jsxs("div", { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, alignItems: 'center' }, children: [_jsxs("label", { children: [t('regex.minDepth'), " ", _jsx(NullableNumInput, { value: rule.minDepth, width: 64, onChange: (v) => set({ minDepth: v }) })] }), _jsxs("label", { children: [t('regex.maxDepth'), " ", _jsx(NullableNumInput, { value: rule.maxDepth, width: 64, onChange: (v) => set({ maxDepth: v }) })] }), _jsxs("label", { children: [t('regex.macroExpand'), ' ', _jsx(Select, { value: String(rule.substituteRegex), onChange: (v) => set({ substituteRegex: Number(v) }), options: [
                                            { value: '0', label: t('regex.substitute.none') },
                                            { value: '1', label: t('regex.substitute.raw') },
                                            { value: '2', label: t('regex.substitute.escaped') },
                                        ] })] })] })] })] }));
}
export function RegexSection(props) {
    const t = useT();
    const { remote } = props;
    const { state, reload } = useLoader(() => remote.listRegexRules({}), []);
    const [rules, setRules] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const toast = useToast();
    useEffect(() => {
        if (state.status === 'ready' && rules === null)
            setRules(structuredClone(state.value.rules));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state]);
    // 预设附带的正则：列出所有带 regexScripts 的预设，开关直接改写预设文件（不动上方 rules.json 草稿）。
    const presetRegex = useLoader(async () => {
        const list = await remote.listPresets({});
        if (!list.ok)
            return list;
        const items = [];
        for (const p of list.value.items) {
            if (p.regexCount <= 0)
                continue;
            const r = await remote.getPreset({ id: p.id });
            if (r.ok && (r.value.preset.regexScripts?.length ?? 0) > 0)
                items.push(r.value.preset);
        }
        return { ok: true, value: { items } };
    }, []);
    const [presetDrafts, setPresetDrafts] = useState(null);
    useEffect(() => {
        if (presetRegex.state.status === 'ready' && presetDrafts === null)
            setPresetDrafts(structuredClone(presetRegex.state.value.items));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [presetRegex.state]);
    const togglePresetScript = async (pi, si, disabled) => {
        const drafts = presetDrafts ?? [];
        const preset = drafts[pi];
        const script = preset?.regexScripts?.[si];
        if (!preset || !script)
            return;
        const nextPreset = {
            ...preset,
            regexScripts: preset.regexScripts.map((s, i) => (i === si ? { ...s, disabled } : s)),
        };
        setPresetDrafts(drafts.map((p, i) => (i === pi ? nextPreset : p)));
        // 乐观开关失败（错误信封或传输 reject）都回滚草稿；reject 经 runAsync 落 setError，
        // 不留未处理 rejection；busy 期间 RegexScriptRow 开关禁用，防连续切换互相覆盖。
        await runAsync(setBusy, setError, async () => {
            const r = await remote.savePreset({ preset: nextPreset }).catch((e) => {
                setPresetDrafts(drafts);
                throw e;
            });
            const err = errOf(r);
            if (err) {
                setError(err);
                setPresetDrafts(drafts);
            }
            else {
                const name = script.scriptName?.trim() || t('util.regex.unnamed', { index: si + 1 });
                toast.show(disabled ? t('regex.toggledOff', { name }) : t('regex.toggledOn', { name }));
            }
        });
    };
    const save = (next) => runAsync(setBusy, setError, async () => {
        const r = await remote.saveRegexRules({ rules: next });
        const err = errOf(r);
        if (err)
            setError(err);
        else
            toast.show(t('regex.saved', { count: next.length }));
    });
    const current = rules ?? [];
    return (_jsxs(Section, { title: t('section.regex'), children: [toast.node, _jsx(Muted, { children: t('regex.desc') }), state.status === 'loading' && (_jsxs(_Fragment, { children: [_jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), _jsx(Err, { message: error }), rules !== null && (_jsxs(_Fragment, { children: [current.map((rule, i) => (_jsx(RuleEditor, { rule: rule, onChange: (r) => {
                            const next = current.slice();
                            next[i] = r;
                            setRules(next);
                        }, onDelete: () => setRules(current.filter((_, j) => j !== i)) }, rule.id))), current.length === 0 && (_jsxs("div", { className: "dsh-tavern-empty is-compact", children: [_jsx("div", { className: "dsh-tavern-emptyTitle", children: t('regex.emptyTitle') }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: t('regex.emptyDesc') })] })), _jsxs(SaveBar, { children: [_jsx(Btn, { onClick: () => setRules([...current, newRule()]), children: t('regex.new') }), _jsx(Btn, { disabled: busy, onClick: () => void save(current), primary: true, children: t('regex.saveAll') }), _jsx(Btn, { onClick: () => {
                                    setRules(null);
                                    reload();
                                }, children: t('regex.discard') })] })] })), _jsx("div", { className: "dsh-tavern-groupHead", children: t('regex.presetHead') }), presetRegex.state.status === 'loading' && (_jsxs(_Fragment, { children: [_jsx(Skeleton, { height: 56 }), _jsx(Skeleton, { height: 56 })] })), presetRegex.state.status === 'error' && _jsx(Err, { message: presetRegex.state.message }), presetDrafts !== null && presetDrafts.length === 0 && (_jsx(Muted, { children: t('regex.noPresetRegex') })), (presetDrafts ?? []).map((preset, pi) => (_jsxs("div", { children: [_jsx("div", { className: "dsh-tavern-fieldLabel", style: { margin: '12px 0 6px' }, children: t('regex.presetCount', { name: preset.name?.trim() || preset.identifier, count: preset.regexScripts.length }) }), _jsx("div", { className: "dsh-tavern-list", children: preset.regexScripts.map((s, si) => (_jsx(RegexScriptRow, { script: s, index: si, disabled: busy, onToggle: (disabled) => void togglePresetScript(pi, si, disabled) }, s.id ?? si))) })] }, preset.identifier)))] }));
}
