import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 共享 UI 工具：对齐 dsh 原语（Button / Menu / Modal / Tooltip / Toast）+ 加载 Hook + 文件/下载助手。
 * 样式集中在 ./styles.js（模块加载即注入）；颜色一律走宿主 --dsw-* 令牌 + Tavern 蓝色 accent。
 * 原生 select 的 option 弹层用 Menu 实现（避开 Windows 系统白底白字）。
 */
import { Children, cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, IconChevronDownOutline14, IconSearchOutline16, IconUserOutline16, Menu, Modal, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { useT } from './i18n.js';
import './styles.js';
/** 设置行与字段把可见标签传给实际控件，读屏及语音操作可以按字段名定位。 */
const ControlLabel = createContext(null);
function labelNativeControls(children, labelId, descriptionId) {
    return Children.map(children, (child) => {
        if (!isValidElement(child) || typeof child.type !== 'string' || !['input', 'textarea', 'select'].includes(child.type))
            return child;
        return cloneElement(child, {
            'aria-labelledby': child.props['aria-labelledby'] ?? (child.props['aria-label'] ? undefined : labelId),
            'aria-describedby': child.props['aria-describedby'] ?? descriptionId,
        });
    });
}
export function Btn(props) {
    return (_jsx(Button, { type: "button", className: "dsh-tavern-btn", variant: props.primary ? 'primary' : 'outline', size: props.size ?? 'sm', disabled: props.disabled, title: props.title, "aria-pressed": props.pressed, onClick: (e) => {
            e.stopPropagation();
            props.onClick();
        }, style: props.danger ? { color: 'var(--dsw-alias-state-error-primary, #ec1313)' } : undefined, children: props.children }));
}
/** 为所有值加同一前缀，空值不会与用户资产名碰撞。 */
const selectOptionId = (value) => `value:${value}`;
/** 用 dsh Menu 实现的下拉（避开 Windows 原生 option 白底白字）；anchor 是通用设置的 36px 胶囊选择器。 */
export function Select(props) {
    const [open, setOpen] = useState(false);
    const label = useContext(ControlLabel);
    const selected = props.options.find((o) => o.value === props.value);
    const width = props.width ?? '100%';
    return (_jsx("div", { className: "dsh-tavern-select", style: { width }, children: _jsx(Menu, { open: open && !props.disabled, portal: true, compact: props.size !== 'md', align: "start", selectedId: selectOptionId(props.value), onClose: () => setOpen(false), onSelect: (id) => {
                const option = props.options.find((item) => selectOptionId(item.value) === id);
                if (!props.disabled && option)
                    props.onChange(option.value);
                setOpen(false);
            }, anchor: _jsxs("button", { type: "button", className: `dsh-tavern-pillSelect${props.size === 'sm' ? ' is-sm' : ''}`, "aria-haspopup": "menu", "aria-expanded": open, "aria-label": props.title, "aria-labelledby": props.title ? undefined : label?.labelId, "aria-describedby": label?.descriptionId, disabled: props.disabled, title: props.title, onClick: () => setOpen((v) => !v), children: [_jsx("span", { className: "dsh-tavern-pillSelectLabel", children: selected?.label ?? props.value }), _jsx(IconChevronDownOutline14, { className: "dsh-tavern-pillSelectChevron" })] }), items: props.options.map((o) => ({
                id: selectOptionId(o.value),
                label: o.label,
            })) }) }));
}
export function FileBtn(props) {
    return (_jsx(Button, { type: "button", variant: "outline", size: "md", disabled: props.disabled, className: "dsh-tavern-file dsh-tavern-btn", onClick: () => {
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
/** 分段控件式页签（pill track，区别于宿主通用设置的下划线页签）；size="sm" 用于弹窗内等紧凑场景。 */
export function Tabs(props) {
    const generatedId = useId();
    const id = props.id ?? generatedId;
    const nav = useRef(null);
    // 调用方普遍传内联数组字面量（每次渲染新引用）：按 id 和文案派生稳定信号（语言切换后仍需重新定位），
    // 否则每次键入重渲染都销毁重建 ResizeObserver 并触发强制布局读。
    const itemsKey = JSON.stringify(props.items.map((item) => [item.id, item.label]));
    // 缩窄窗口或恢复上次页签后，当前项不能藏到横向滚动区域外；只移动导航，不改变正文纵向滚动位置。
    useLayoutEffect(() => {
        const element = nav.current;
        if (!element)
            return;
        const reveal = () => {
            const selected = element.querySelector('[aria-selected="true"]');
            if (!selected || element.scrollWidth <= element.clientWidth)
                return;
            const bounds = element.getBoundingClientRect(), item = selected.getBoundingClientRect();
            if (item.left < bounds.left + 4)
                element.scrollLeft += item.left - bounds.left - 4;
            else if (item.right > bounds.right - 4)
                element.scrollLeft += item.right - bounds.right + 4;
        };
        reveal();
        if (typeof ResizeObserver === 'undefined')
            return;
        const observer = new ResizeObserver(reveal);
        observer.observe(element);
        return () => observer.disconnect();
    }, [props.value, itemsKey]);
    return (_jsx("div", { ref: nav, className: `dsh-tavern-navPills${props.size === 'sm' ? ' is-sub' : ''}`, role: "tablist", "aria-label": props.label, onKeyDown: (e) => {
            const direction = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!direction && e.key !== 'Home' && e.key !== 'End')
                return;
            const buttons = Array.from(e.currentTarget.querySelectorAll('[role="tab"]'));
            const current = buttons.indexOf(e.target);
            if (current < 0)
                return;
            e.preventDefault();
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (current + direction + buttons.length) % buttons.length;
            buttons[next]?.focus();
        }, children: props.items.map((item) => (_jsx("button", { type: "button", role: "tab", id: `${id}-${item.id}`, tabIndex: props.value === item.id ? 0 : -1, className: "dsh-tavern-navPill", "data-active": props.value === item.id ? 'true' : 'false', "aria-selected": props.value === item.id, "aria-controls": props.panelId, onClick: () => props.onChange(item.id), children: item.label }, item.id))) }));
}
/** 分组保存行：与上方表单一条淡分隔，主操作左齐。 */
export function SaveBar(props) {
    return _jsx("div", { className: `dsh-tavern-saveBar${props.inline ? ' is-inline' : ''}`, children: props.children });
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
    const label = useContext(ControlLabel);
    return (_jsx("button", { type: "button", role: "switch", "aria-checked": props.checked, "aria-label": props.title, "aria-labelledby": props.title ? undefined : label?.labelId, "aria-describedby": label?.descriptionId, className: `dsh-tavern-toggle${props.checked ? ' is-on' : ''}`, disabled: props.disabled, title: props.title, onClick: (e) => {
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
    const id = useId(), labelId = `${id}-label`, descriptionId = props.description ? `${id}-description` : undefined;
    return (_jsxs("div", { className: `dsh-tavern-row${props.stacked ? ' is-stacked' : ''}`, children: [_jsxs("div", { className: "dsh-tavern-rowText", children: [_jsx("div", { id: labelId, className: "dsh-tavern-rowTitle", children: props.title }), props.description ? _jsx("div", { id: descriptionId, className: "dsh-tavern-rowDesc", children: props.description }) : null] }), _jsx("div", { className: "dsh-tavern-rowControl", children: _jsx(ControlLabel.Provider, { value: { labelId, descriptionId }, children: labelNativeControls(props.children, labelId, descriptionId) }) })] }));
}
export function Field(props) {
    const labelId = useId();
    return (_jsxs("div", { className: "dsh-tavern-field", children: [_jsx("span", { id: labelId, className: "dsh-tavern-fieldLabel", children: props.label }), _jsx(ControlLabel.Provider, { value: { labelId }, children: labelNativeControls(props.children, labelId) })] }));
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
    return _jsx("div", { className: "dsh-tavern-errText", role: "alert", children: props.message });
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
    // key 用单调计数器而不是 Date.now()：同毫秒两次 show 会撞 key，React 复用实例只换文本，
    // 第二条消息沿用第一条的停留计时器提前淡出。计数器保证每次 show 都重建实例。
    const counter = useRef(0);
    const [item, setItem] = useState(null);
    const show = useCallback((text) => { counter.current += 1; setItem({ key: counter.current, text }); }, []);
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
            if (e.target !== e.currentTarget)
                return;
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
    // reload 身份稳定：调用方把它放进 effect 依赖（如绑定变更监听）时不会每次渲染都重新订阅。
    const reload = useCallback(() => setSeq((s) => s + 1), []);
    return { state, reload };
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
export function downloadJson(filename, json, space = 2) {
    const blob = new Blob([JSON.stringify(json, null, space)], { type: 'application/json' });
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
/** primitives Modal 的薄封装（统一关闭文案）；width 档：sm 380（默认）/ md 480 / lg 680 / xl 880 / full 1280（近全屏）。 */
export function Dialog(props) {
    const t = useT();
    // Modal 的 dialog 本体不限高，超高内容会把整个弹窗顶出视口。
    // 滚动区放在 content 层（Modal 注释里指定的 scrollable content region）并钉死
    // max-height，保证任何视口高度下弹窗底部都不被裁。
    // 宽度档必须落在 dialog 外壳（className）：外壳自带 width:min(380px,100%)，
    // 宽度类挂在内容层会被外壳卡住，怎么调都只有默认宽度。
    const widthClass = props.width === 'md'
        ? 'dsh-tavern-modal-md'
        : props.width === 'lg'
            ? 'dsh-tavern-modal-lg'
            : props.width === 'xl'
                ? 'dsh-tavern-modal-xl'
                : props.width === 'full'
                    ? 'dsh-tavern-modal-full'
                    : '';
    return (_jsx(Modal, { open: props.open, onClose: props.onClose, title: props.title, description: props.description, closeLabel: t('action.close'), footer: props.footer, className: widthClass || undefined, contentClassName: `dsh-tavern-modalContent${props.footer ? ' dsh-tavern-modalHasFooter' : ''}`, children: _jsx("div", { className: "dsh-tavern-ui dsh-tavern-modalBody", children: props.children }) }));
}
export function ConfirmDialog(props) {
    const t = useT();
    return (_jsx(Modal, { open: props.open, onClose: props.onCancel, title: props.title, description: props.description, closeLabel: t('action.cancel'), footer: _jsxs("div", { className: "dsh-tavern-modalActions", children: [_jsx(Button, { type: "button", variant: "outline", size: "md", disabled: props.busy, onClick: props.onCancel, children: t('action.cancel') }), _jsx(Button, { type: "button", variant: "primary", size: "md", disabled: props.busy, onClick: props.onConfirm, style: props.danger ? { background: 'var(--dsw-alias-state-error-primary, #ec1313)', borderColor: 'transparent' } : undefined, children: props.confirmLabel ?? t('action.confirm') })] }) }));
}
/** 数字输入保留未完成文本；空值不误提交为 0，失焦时显示有效值，外部重置及时同步。 */
export function NumInput(props) {
    const label = useContext(ControlLabel);
    const value = Number.isFinite(props.value) ? props.value : 0;
    const [draft, setDraft] = useState(() => ({ value, text: String(value), pending: false }));
    let text = draft.text;
    if (draft.pending) {
        // 本次键入可触发父表单限幅：保留输入文本才能逐位输入 25（第一位 2 可能被夹成 10）。
        // 记录本次回传后的业务值，之后独立发生的外部重置仍会立即覆盖文本。
        setDraft({ value, text, pending: false });
    }
    else if (!Object.is(draft.value, value)) {
        text = String(value);
        setDraft({ value, text, pending: false });
    }
    return (_jsx("input", { type: "number", "aria-labelledby": label?.labelId, "aria-describedby": label?.descriptionId, className: "dsh-tavern-input", style: { width: props.width ?? 90 }, value: text, step: props.step ?? 'any', onChange: (e) => {
            const raw = e.target.value;
            const next = raw.trim() === '' ? NaN : Number(raw);
            if (!Number.isFinite(next)) {
                setDraft({ value, text: raw, pending: true });
                return;
            }
            setDraft({ value, text: raw, pending: true });
            props.onChange(next);
        }, onBlur: () => setDraft({ value, text: String(value), pending: false }) }));
}
/** 可空数字输入（null ↔ 空串）。 */
export function NullableNumInput(props) {
    const t = useT();
    const label = useContext(ControlLabel);
    return (_jsx("input", { type: "number", "aria-labelledby": label?.labelId, "aria-describedby": label?.descriptionId, className: "dsh-tavern-input", style: { width: props.width ?? 90 }, value: props.value ?? '', placeholder: t('common.unlimited'), onChange: (e) => {
            const raw = e.target.value;
            if (raw === '')
                return props.onChange(null);
            const v = Number(raw);
            if (Number.isFinite(v))
                props.onChange(v);
        } }));
}
/** 以逗号或换行分隔的字符串列表。全角逗号与半角逗号等价，空项忽略。 */
export function splitListText(text) {
    return text.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
}
export function joinListText(items) {
    return items.join(', ');
}
/**
 * 关键词/标签这类列表输入：输入框持有原始文本，解析结果提交给业务状态。
 * 若把业务数组重新拼接成受控值，用户键入的分隔符和尾随空格会被立即吞掉，无法输入第二项。
 * 只有业务值与当前文本的解析结果不一致（切换条目、放弃修改、恢复草稿）时才采用外部值。
 */
export function ListInput(props) {
    const label = useContext(ControlLabel);
    const [text, setText] = useState(() => joinListText(props.value));
    const external = joinListText(props.value);
    const shown = joinListText(splitListText(text)) === external ? text : external;
    return (_jsx("input", { "aria-labelledby": label?.labelId, "aria-describedby": label?.descriptionId, className: props.className ?? 'dsh-tavern-input', style: props.style, value: shown, placeholder: props.placeholder, onChange: (e) => {
            setText(e.target.value);
            props.onChange(splitListText(e.target.value));
        } }));
}
