import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 设置面板分区：全局正则脚本（列表 + enabled 开关 + 编辑，整表保存）。
 * find/replace 等代码向输入用 code 字体类；保存反馈走 useToast，上下文错误用 Err。
 */
import { useEffect, useState } from 'react';
import { Btn, Err, Field, Muted, NullableNumInput, RegexScriptRow, Section, Select, Skeleton, Toggle, errOf, runAsync, useLoader, useToast } from '../util.js';
const SCOPES = [
    { value: 'input', label: '用户输入' },
    { value: 'output', label: 'AI 输出' },
    { value: 'prompt', label: '发送给模型' },
];
const TIMINGS = [
    { value: 'assemble', label: '组装前' },
    { value: 'send', label: '发送前' },
    { value: 'render', label: '渲染前' },
];
function newRule() {
    return {
        id: `rule-${Date.now().toString(36)}`,
        name: '新规则',
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
function toggle(list, v) {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}
function RuleEditor(props) {
    const { rule } = props;
    const set = (patch) => props.onChange({ ...rule, ...patch });
    return (_jsxs("div", { className: "dsh-tavern-entry", style: { marginBottom: 8 }, children: [_jsxs("div", { style: { display: 'flex', gap: 8, alignItems: 'center', padding: '10px 12px 6px' }, children: [_jsx(Toggle, { checked: rule.enabled, onChange: (enabled) => set({ enabled }), title: rule.enabled ? '关闭此规则' : '启用此规则' }), _jsx("input", { className: "dsh-tavern-input", style: { flex: 1 }, value: rule.name, onChange: (e) => set({ name: e.target.value }) }), _jsx(Muted, { children: rule.source === 'user' ? '用户' : rule.source === 'card' ? '角色卡' : '预设' }), _jsx(Btn, { danger: true, onClick: props.onDelete, children: "\u5220\u9664" })] }), _jsxs("div", { style: { padding: '0 12px 12px' }, children: [_jsx(Field, { label: "\u67E5\u627E (find)", children: _jsx("input", { className: "dsh-tavern-input dsh-tavern-codeFont", style: { flex: 1 }, value: rule.find, onChange: (e) => set({ find: e.target.value }) }) }), _jsx("div", { className: "dsh-tavern-fieldLabel", style: { margin: '4px 0' }, children: "\u66FF\u6362 (replace)" }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont", style: { minHeight: 40 }, value: rule.replace, onChange: (e) => set({ replace: e.target.value }) }), _jsxs("div", { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, margin: '6px 0' }, children: [_jsxs("span", { children: ["\u4F5C\u7528\u57DF\uFF1A", SCOPES.map((s) => (_jsxs("label", { style: { marginLeft: 8 }, children: [_jsx("input", { type: "checkbox", checked: rule.scopes.includes(s.value), onChange: () => set({ scopes: toggle(rule.scopes, s.value) }) }), " ", s.label] }, s.value)))] }), _jsxs("span", { children: ["\u65F6\u673A\uFF1A", TIMINGS.map((t) => (_jsxs("label", { style: { marginLeft: 8 }, children: [_jsx("input", { type: "checkbox", checked: rule.timing.includes(t.value), onChange: () => set({ timing: toggle(rule.timing, t.value) }) }), " ", t.label] }, t.value)))] })] }), _jsxs("div", { style: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, alignItems: 'center' }, children: [_jsxs("label", { children: ["\u6700\u5C0F\u6DF1\u5EA6 ", _jsx(NullableNumInput, { value: rule.minDepth, width: 64, onChange: (v) => set({ minDepth: v }) })] }), _jsxs("label", { children: ["\u6700\u5927\u6DF1\u5EA6 ", _jsx(NullableNumInput, { value: rule.maxDepth, width: 64, onChange: (v) => set({ maxDepth: v }) })] }), _jsxs("label", { children: ["\u5B8F\u5C55\u5F00", ' ', _jsx(Select, { value: String(rule.substituteRegex), onChange: (v) => set({ substituteRegex: Number(v) }), options: [
                                            { value: '0', label: '不展开' },
                                            { value: '1', label: '原样代入' },
                                            { value: '2', label: '转义代入' },
                                        ] })] })] })] })] }));
}
export function RegexSection(props) {
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
        const r = await remote.savePreset({ preset: nextPreset });
        const err = errOf(r);
        if (err) {
            setError(err);
            setPresetDrafts(drafts);
        }
        else {
            const name = script.scriptName?.trim() || `预设正则 ${si + 1}`;
            toast.show(disabled ? `已关闭「${name}」` : `已启用「${name}」`);
        }
    };
    const save = (next) => runAsync(setBusy, setError, async () => {
        const r = await remote.saveRegexRules({ rules: next });
        const err = errOf(r);
        if (err)
            setError(err);
        else
            toast.show(`已保存 ${next.length} 条规则`);
    });
    const current = rules ?? [];
    return (_jsxs(Section, { title: "\u6B63\u5219\u811A\u672C", children: [toast.node, _jsx(Muted, { children: "\u5BF9\u8BDD\u5C55\u793A\u4F1A\u81EA\u52A8\u6536\u8D77 UpdateVariable\u3001JSONPatch \u7B49\u673A\u8BFB\u6807\u7B7E\uFF0C\u4E0D\u4F9D\u8D56\u9884\u8BBE\u662F\u5426\u5E26\u4E86\u6B63\u5219\u3002\u4E0A\u65B9\u662F\u4F60\u989D\u5916\u8981\u6539\u5199\u5C55\u793A\u6216\u5165\u6A21\u7684\u89C4\u5219\uFF1B\u4E0B\u65B9\u5217\u51FA\u9884\u8BBE\u968F\u5E26\u7684\u6B63\u5219\uFF0C\u53EF\u76F4\u63A5\u5F00\u5173\u3002" }), state.status === 'loading' && (_jsxs(_Fragment, { children: [_jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), _jsx(Err, { message: error }), rules !== null && (_jsxs(_Fragment, { children: [current.map((rule, i) => (_jsx(RuleEditor, { rule: rule, onChange: (r) => {
                            const next = current.slice();
                            next[i] = r;
                            setRules(next);
                        }, onDelete: () => setRules(current.filter((_, j) => j !== i)) }, rule.id))), current.length === 0 && _jsx(Muted, { children: "\u6682\u65E0\u89C4\u5219\u3002" }), _jsxs("div", { style: { display: 'flex', gap: 8, marginTop: 8 }, children: [_jsx(Btn, { onClick: () => setRules([...current, newRule()]), children: "\u65B0\u5EFA\u89C4\u5219" }), _jsx(Btn, { disabled: busy, onClick: () => void save(current), primary: true, children: "\u4FDD\u5B58\u5168\u90E8" }), _jsx(Btn, { onClick: () => {
                                    setRules(null);
                                    reload();
                                }, children: "\u653E\u5F03\u66F4\u6539\u5E76\u5237\u65B0" })] })] })), _jsx("div", { className: "dsh-tavern-groupHead", children: "\u9884\u8BBE\u9644\u5E26" }), presetRegex.state.status === 'loading' && (_jsxs(_Fragment, { children: [_jsx(Skeleton, { height: 56 }), _jsx(Skeleton, { height: 56 })] })), presetRegex.state.status === 'error' && _jsx(Err, { message: presetRegex.state.message }), presetDrafts !== null && presetDrafts.length === 0 && (_jsx(Muted, { children: "\u6CA1\u6709\u9884\u8BBE\u643A\u5E26\u6B63\u5219\u3002\u9884\u8BBE JSON \u91CC extensions.regex_scripts \u4F1A\u968F\u5BFC\u5165\u5E26\u8FDB\u6765\uFF0C\u53EF\u5728\u300C\u9884\u8BBE\u300D\u9875\u67E5\u770B\u3002" })), (presetDrafts ?? []).map((preset, pi) => (_jsxs("div", { children: [_jsxs("div", { className: "dsh-tavern-fieldLabel", style: { margin: '12px 0 6px' }, children: [preset.name?.trim() || preset.identifier, "\uFF08", preset.regexScripts.length, " \u6761\uFF09"] }), _jsx("div", { className: "dsh-tavern-list", children: preset.regexScripts.map((s, si) => (_jsx(RegexScriptRow, { script: s, index: si, onToggle: (disabled) => void togglePresetScript(pi, si, disabled) }, s.id ?? si))) })] }, preset.identifier)))] }));
}
