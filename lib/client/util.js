import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 共享 UI 工具：对齐 dsh 原语（Button / Menu / Modal / Tooltip / Toast）+ 加载 Hook + 文件/下载助手。
 * 样式集中在 ./styles.js（模块加载即注入）；颜色一律走宿主 --dsw-* 令牌 + Tavern 青碧 accent。
 * 原生 select 的 option 弹层用 Menu 实现（避开 Windows 系统白底白字）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, IconChevronDownOutline14, IconSearchOutline16, IconUserOutline16, Menu, Modal, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { useT } from './i18n.js';
import './styles.js';
export function Btn(props) {
    return (_jsx(Button, { type: "button", variant: props.primary ? 'primary' : 'outline', size: props.size ?? 'sm', disabled: props.disabled, title: props.title, onClick: (e) => {
            e.stopPropagation();
            props.onClick();
        }, style: props.danger ? { color: 'var(--dsw-alias-state-error-primary, #ec1313)' } : undefined, children: props.children }));
}
const EMPTY_SELECT_ID = '__empty__';
/** 用 dsh Menu 实现的下拉（避开 Windows 原生 option 白底白字）；anchor 是通用设置的 36px 胶囊选择器。 */
export function Select(props) {
    const [open, setOpen] = useState(false);
    const selected = props.options.find((o) => o.value === props.value);
    const width = props.width ?? '100%';
    return (_jsx("div", { className: "dsh-tavern-select", style: { width }, children: _jsx(Menu, { open: open, portal: true, compact: props.size !== 'md', align: "start", selectedId: props.value === '' ? EMPTY_SELECT_ID : props.value, onClose: () => setOpen(false), onSelect: (id) => {
                props.onChange(id === EMPTY_SELECT_ID ? '' : id);
                setOpen(false);
            }, anchor: _jsxs("button", { type: "button", className: `dsh-tavern-pillSelect${props.size === 'sm' ? ' is-sm' : ''}`, "aria-haspopup": "menu", "aria-expanded": open, disabled: props.disabled, title: props.title, onClick: () => setOpen((v) => !v), children: [_jsx("span", { className: "dsh-tavern-pillSelectLabel", children: selected?.label ?? props.value }), _jsx(IconChevronDownOutline14, { className: "dsh-tavern-pillSelectChevron" })] }), items: props.options.map((o) => ({
                id: o.value === '' ? EMPTY_SELECT_ID : o.value,
                label: o.label,
            })) }) }));
}
export function FileBtn(props) {
    return (_jsx(Button, { type: "button", variant: "outline", size: "md", disabled: props.disabled, className: "dsh-tavern-file", onClick: () => {
            const el = document.createElement('input');
            el.type = 'file';
            el.accept = props.accept;
            el.onchange = () => {
                const file = el.files?.[0];
                if (file)
                    props.onFile(file);
            };
            el.click();
        }, children: props.children }));
}
export function Section(props) {
    return (_jsxs("section", { className: "dsh-tavern-section", children: [props.title || props.description ? (_jsxs("header", { className: "dsh-tavern-pageHead", children: [props.title ? _jsx("h3", { className: "dsh-tavern-pageTitle", children: props.title }) : null, props.description ? _jsx("p", { className: "dsh-tavern-pageIntro", children: props.description }) : null] })) : null, props.children] }));
}
/** 分段控件式页签（pill track，区别于宿主通用设置的下划线页签）；size="sm" 用于页内第二级导航。 */
export function Tabs(props) {
    return (_jsx("div", { className: `dsh-tavern-navPills${props.size === 'sm' ? ' is-sub' : ''}`, role: "tablist", children: props.items.map((item) => (_jsx("button", { type: "button", role: "tab", className: "dsh-tavern-navPill", "data-active": props.value === item.id ? 'true' : 'false', "aria-selected": props.value === item.id, onClick: () => props.onChange(item.id), children: item.label }, item.id))) }));
}
/** 分组保存行：与上方表单一条淡分隔，主操作左齐。 */
export function SaveBar(props) {
    return _jsx("div", { className: "dsh-tavern-saveBar", children: props.children });
}
export function Badge(props) {
    const cls = props.accent ? ' is-accent' : props.danger ? ' is-danger' : '';
    return _jsx("span", { className: `dsh-tavern-badge${cls}`, children: props.children });
}
/**
 * 预设/卡内嵌 regex_scripts 的展示行：开关 + 名称 + 作用域徽标 + 查找式。
 * 作用域语义与 core/regex.ts 的 compileRegexScripts 一致；onToggle 传入时显示启用开关。
 */
export function RegexScriptRow(props) {
    const { script } = props;
    const t = useT();
    const badges = [];
    if (script.markdownOnly && script.promptOnly)
        badges.push(t('util.regexScope.displayAndPrompt'));
    else if (script.markdownOnly)
        badges.push(t('util.regexScope.displayOnly'));
    else if (script.promptOnly)
        badges.push(t('util.regexScope.promptOnly'));
    else {
        for (const p of script.placement ?? [2]) {
            if (p === 1)
                badges.push(t('util.regexScope.userInput'));
            else if (p === 2)
                badges.push(t('util.regexScope.aiOutput'));
            else if (p === 5)
                badges.push(t('util.regexScope.worldInfo'));
        }
    }
    const find = script.findRegex ?? '';
    const enabled = script.disabled !== true;
    return (_jsxs("div", { className: "dsh-tavern-memo", children: [_jsxs("div", { className: "dsh-tavern-memoHead", children: [props.onToggle ? (_jsx(Toggle, { checked: enabled, disabled: props.disabled, onChange: (on) => props.onToggle(!on), title: enabled ? t('util.regex.disable') : t('util.regex.enable') })) : null, _jsx("span", { className: "dsh-tavern-memoMeta", style: { color: 'var(--dsw-alias-label-primary, inherit)', fontWeight: 500 }, children: script.scriptName?.trim() || t('util.regex.unnamed', { index: props.index + 1 }) }), badges.map((label) => (_jsx(Badge, { children: label }, label)))] }), _jsx("div", { className: "dsh-tavern-codeFont", title: find, style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: find || t('util.regex.noFind') })] }));
}
/** 条目启用开关（对齐 SillyTavern 的 on/off，视觉走 dsh 胶囊）。 */
export function Toggle(props) {
    return (_jsx("button", { type: "button", role: "switch", "aria-checked": props.checked, className: `dsh-tavern-toggle${props.checked ? ' is-on' : ''}`, disabled: props.disabled, title: props.title, onClick: (e) => {
            e.stopPropagation();
            props.onChange(!props.checked);
        } }));
}
export function IconBtn(props) {
    return (_jsx(Tooltip, { label: props.label, side: "bottom", children: _jsx("button", { type: "button", "aria-label": props.label, className: `dsh-tavern-iconBtn${props.danger ? ' is-danger' : ''}`, disabled: props.disabled, onClick: (e) => {
                e.stopPropagation();
                props.onClick();
            }, children: props.children }) }));
}
/** 对齐通用设置：标题 + 说明 + 右侧控件。stacked = 宽控件（checkbox 列表等）换成纵向满宽。inline 已废弃（现在默认就是行式）。 */
export function SettingsRow(props) {
    return (_jsxs("div", { className: `dsh-tavern-row${props.stacked ? ' is-stacked' : ''}`, children: [_jsxs("div", { className: "dsh-tavern-rowText", children: [_jsx("div", { className: "dsh-tavern-rowTitle", children: props.title }), props.description ? _jsx("div", { className: "dsh-tavern-rowDesc", children: props.description }) : null] }), _jsx("div", { className: "dsh-tavern-rowControl", children: props.children })] }));
}
export function Field(props) {
    return (_jsxs("div", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: props.label }), props.children] }));
}
/** 列表搜索框（36px 胶囊 + 前导图标），配合面板里的关键字过滤。 */
export function SearchInput(props) {
    const t = useT();
    return (_jsxs("div", { className: "dsh-tavern-search", role: "search", style: { width: props.width ?? 220 }, children: [_jsx("span", { className: "dsh-tavern-searchIcon", children: _jsx(IconSearchOutline16, {}) }), _jsx("input", { type: "text", "aria-label": props.label, placeholder: props.placeholder ?? t('common.searchPlaceholder'), value: props.value, onChange: (e) => props.onChange(e.target.value) })] }));
}
/** 列表搜索的空结果态：与各面板空态同一套样式，附「清空搜索」动作。 */
export function SearchEmpty(props) {
    const t = useT();
    return (_jsxs("div", { className: "dsh-tavern-empty", children: [_jsx("div", { className: "dsh-tavern-emptyTitle", children: t('common.noMatch', { what: props.what }) }), _jsxs("div", { className: "dsh-tavern-emptyDesc", children: [t('common.noMatchDesc', { query: props.query }), _jsx("button", { type: "button", className: "dsh-tavern-linkBtn", onClick: props.onClear, children: t('action.clearSearch') })] })] }));
}
/** 多选 chip 组（替代复选框列表）：点击把选项切进/切出 selected，选中带对勾前缀。 */
export function CheckChips(props) {
    return (_jsx("div", { className: "dsh-tavern-filters", role: "group", "aria-label": props.ariaLabel, children: props.options.map((o) => {
            const on = props.selected.includes(o.value);
            return (_jsx("button", { type: "button", className: "dsh-tavern-chip is-check", "data-active": on ? 'true' : 'false', "aria-pressed": on, onClick: () => props.onChange(on ? props.selected.filter((v) => v !== o.value) : [...props.selected, o.value]), children: o.label }, o.value));
        }) }));
}
export function Err(props) {
    if (!props.message)
        return null;
    return _jsx("div", { className: "dsh-tavern-errText", children: props.message });
}
export function Muted(props) {
    return _jsx("span", { className: "dsh-tavern-muted", children: props.children });
}
/** 头像：有图出图，无图出首字符（小尺寸回退为用户图标），不再是灰块。尺寸经 --tavern-avatar-s 传入。 */
export function Avatar(props) {
    const size = props.size ?? 40;
    const style = { '--tavern-avatar-s': `${size}px` };
    const cls = `dsh-tavern-avatar${props.className ? ` ${props.className}` : ''}`;
    if (props.url) {
        return (_jsx("span", { className: cls, style: style, children: _jsx("img", { src: props.url, alt: "" }) }));
    }
    const initial = (props.name ?? '').trim().charAt(0);
    if (initial && size >= 24) {
        return (_jsx("span", { className: cls, style: style, children: initial }));
    }
    return (_jsx("span", { className: cls, style: style, children: _jsx(IconUserOutline16, { size: Math.max(12, Math.round(size * 0.6)) }) }));
}
/** shimmer 骨架条/块，替换「加载中…」。 */
export function Skeleton(props) {
    return (_jsx("div", { className: "dsh-tavern-skeleton", style: { width: props.width ?? '100%', height: props.height ?? 14, borderRadius: props.radius, ...props.style } }));
}
/** 顶部横幅通知（宿主 Toast：滑入→停留→淡出后 onDone）。瞬时操作反馈用它，上下文错误仍用 Err。 */
export function useToast() {
    const [item, setItem] = useState(null);
    const show = useCallback((text) => setItem({ key: Date.now(), text }), []);
    const node = item ? _jsx(Toast, { text: item.text, onDone: () => setItem(null) }, item.key) : null;
    return { show, node };
}
/** 让卡片等元素可键盘触发（Enter/Space），配合 .is-clickable。 */
export function clickableProps(onClick) {
    return {
        role: 'button',
        tabIndex: 0,
        onClick,
        onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
            }
        },
    };
}
/** 拉取一个 remote 读取；reload() 触发重拉；enabled=false 时挂起（idle）。 */
export function useLoader(load, deps = [], enabled = true, timeoutMs = 20_000) {
    const t = useT();
    const [state, setState] = useState(enabled ? { status: 'loading' } : { status: 'idle' });
    const [seq, setSeq] = useState(0);
    useEffect(() => {
        if (!enabled) {
            setState({ status: 'idle' });
            return;
        }
        let alive = true;
        setState({ status: 'loading' });
        // remote 挂起（通道中断/服务无响应）时不能永远停在骨架屏：超时转错误态，面板上有「刷新」可重试；
        // alive 不提前置 false，迟到的好结果仍会覆盖错误态、自动恢复。
        const timer = setTimeout(() => {
            if (alive)
                setState({ status: 'error', message: t('util.loadTimeout') });
        }, timeoutMs);
        const settle = () => clearTimeout(timer);
        load()
            .then((r) => {
            settle();
            if (alive)
                setState(r.ok ? { status: 'ready', value: r.value } : { status: 'error', message: r.error.message });
        })
            .catch((e) => {
            settle();
            if (alive)
                setState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
        });
        return () => {
            alive = false;
            clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, seq, enabled]);
    return { state, reload: () => setSeq((s) => s + 1) };
}
/** 信封 → 错误消息（ok 时返回 null）。 */
export function errOf(r) {
    return r.ok ? null : r.error.message;
}
/**
 * 面板写操作的统一外壳：置 busy → 清旧错 → 跑 fn，成功失败都在 finally 解锁。
 * typert 在传输失败和入参 zod 严格校验不过时是 reject，不是错误信封，
 * 而按钮上的 `onClick={() => void save()}` 会把这个 reject 吞掉；
 * 传输层 reject 也必须解锁按钮，否则 busy 永远为 true、保存按钮再也点不动，草稿全丢。
 * onError 传入时，reject 的消息改走 onError（如 toast 瞬时提示），不再写 setError；
 * fn 内自行 setError 的错误信封不受影响（上下文错误仍走 Err）。
 */
export async function runAsync(setBusy, setError, fn, onError) {
    setBusy(true);
    setError(null);
    try {
        await fn();
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (onError)
            onError(message);
        else
            setError(message);
    }
    finally {
        setBusy(false);
    }
}
export function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const url = String(reader.result);
            resolve(url.slice(url.indexOf(',') + 1));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}
export async function readJsonFile(file) {
    return JSON.parse(await file.text());
}
export function downloadJson(filename, json) {
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadBase64(filename, base64, mime) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
/** primitives Modal 的薄封装（统一关闭文案）；width 档：sm 380（默认）/ md 480 / lg 680 / xl 880。 */
export function Dialog(props) {
    const t = useT();
    // Modal 的 dialog 本体不限高，超高内容会把整个弹窗顶出视口。
    // 滚动区放在 content 层（Modal 注释里指定的 scrollable content region）并钉死
    // max-height，保证任何视口高度下弹窗底部都不被裁。
    const widthClass = props.width === 'md'
        ? 'dsh-tavern-modal-md'
        : props.width === 'lg'
            ? 'dsh-tavern-modal-lg'
            : props.width === 'xl'
                ? 'dsh-tavern-modal-xl'
                : '';
    return (_jsx(Modal, { open: props.open, onClose: props.onClose, title: props.title, description: props.description, closeLabel: t('action.close'), footer: props.footer, contentClassName: `dsh-tavern-modalContent${widthClass ? ` ${widthClass}` : ''}${props.footer ? ' dsh-tavern-modalHasFooter' : ''}`, children: _jsx("div", { className: "dsh-tavern-ui dsh-tavern-modalBody", children: props.children }) }));
}
export function ConfirmDialog(props) {
    const t = useT();
    return (_jsx(Modal, { open: props.open, onClose: props.onCancel, title: props.title, description: props.description, closeLabel: t('action.cancel'), footer: _jsxs("div", { className: "dsh-tavern-modalActions", children: [_jsx(Button, { type: "button", variant: "outline", size: "md", disabled: props.busy, onClick: props.onCancel, children: t('action.cancel') }), _jsx(Button, { type: "button", variant: "primary", size: "md", disabled: props.busy, onClick: props.onConfirm, style: props.danger ? { background: 'var(--dsw-alias-state-error-primary, #ec1313)', borderColor: 'transparent' } : undefined, children: props.confirmLabel ?? t('action.confirm') })] }) }));
}
/** 数字输入（number）。 */
export function NumInput(props) {
    return (_jsx("input", { type: "number", className: "dsh-tavern-input", style: { width: props.width ?? 90 }, value: Number.isFinite(props.value) ? props.value : 0, step: props.step ?? 'any', onChange: (e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v))
                props.onChange(v);
        } }));
}
/** 可空数字输入（null ↔ 空串）。 */
export function NullableNumInput(props) {
    const t = useT();
    return (_jsx("input", { type: "number", className: "dsh-tavern-input", style: { width: props.width ?? 90 }, value: props.value ?? '', placeholder: t('common.unlimited'), onChange: (e) => {
            const raw = e.target.value;
            if (raw === '')
                return props.onChange(null);
            const v = Number(raw);
            if (Number.isFinite(v))
                props.onChange(v);
        } }));
}
