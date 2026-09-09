import type { CSSProperties, ReactNode } from 'react';
import type { CardRegexScript } from '../core/types.js';
import type { Envelope } from './types.js';
import './styles.js';
export declare function Btn(props: {
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    primary?: boolean;
    pressed?: boolean;
    title?: string;
    size?: 'sm' | 'md';
    children?: ReactNode;
}): import("react").JSX.Element;
export interface SelectOption {
    value: string;
    label: string;
}
/** 用 dsh Menu 实现的下拉（避开 Windows 原生 option 白底白字）；anchor 是通用设置的 36px 胶囊选择器。 */
export declare function Select(props: {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    disabled?: boolean;
    title?: string;
    width?: number | string;
    size?: 'sm' | 'md';
}): import("react").JSX.Element;
export declare function FileBtn(props: {
    accept: string;
    disabled?: boolean;
    onFile: (file: File) => void;
    children?: ReactNode;
}): import("react").JSX.Element;
export declare function Section(props: {
    title?: string;
    description?: string;
    children?: ReactNode;
}): import("react").JSX.Element;
export interface TabItem {
    id: string;
    label: string;
}
/** 分段控件式页签（pill track，区别于宿主通用设置的下划线页签）；size="sm" 用于弹窗内等紧凑场景。 */
export declare function Tabs(props: {
    items: TabItem[];
    value: string;
    onChange: (id: string) => void;
    size?: 'md' | 'sm';
    id?: string;
    panelId?: string;
    label?: string;
}): import("react").JSX.Element;
/** 分组保存行：与上方表单一条淡分隔，主操作左齐。 */
export declare function SaveBar(props: {
    children?: ReactNode;
    inline?: boolean;
}): import("react").JSX.Element;
export declare function Badge(props: {
    accent?: boolean;
    danger?: boolean;
    children?: ReactNode;
}): import("react").JSX.Element;
/**
 * 预设/卡内嵌 regex_scripts 的展示行：开关 + 名称 + 作用域徽标 + 查找式。
 * 作用域语义与 core/regex.ts 的 compileRegexScripts 一致；onToggle 传入时显示启用开关。
 */
export declare function RegexScriptRow(props: {
    script: CardRegexScript;
    index: number;
    onToggle?: (disabled: boolean) => void;
    disabled?: boolean;
}): import("react").JSX.Element;
/** 条目启用开关（对齐 SillyTavern 的 on/off，视觉走 dsh 胶囊）。 */
export declare function Toggle(props: {
    checked: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
    title?: string;
}): import("react").JSX.Element;
export declare function IconBtn(props: {
    label: string;
    danger?: boolean;
    disabled?: boolean;
    onClick: () => void;
    children?: ReactNode;
}): import("react").JSX.Element;
/** 对齐通用设置：标题 + 说明 + 右侧控件。stacked = 宽控件（checkbox 列表等）换成纵向满宽。inline 已废弃（现在默认就是行式）。 */
export declare function SettingsRow(props: {
    title: string;
    description?: string;
    stacked?: boolean;
    inline?: boolean;
    children?: ReactNode;
}): import("react").JSX.Element;
export declare function Field(props: {
    label: string;
    children?: ReactNode;
}): import("react").JSX.Element;
/** 列表搜索框（36px 胶囊 + 前导图标），配合面板里的关键字过滤。 */
export declare function SearchInput(props: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    width?: number | string;
}): import("react").JSX.Element;
/** 列表搜索的空结果态：与各面板空态同一套样式，附「清空搜索」动作。 */
export declare function SearchEmpty(props: {
    what: string;
    query: string;
    onClear: () => void;
}): import("react").JSX.Element;
/** 多选 chip 组（替代复选框列表）：点击把选项切进/切出 selected，选中带对勾前缀。 */
export declare function CheckChips(props: {
    options: {
        value: string;
        label: string;
    }[];
    selected: readonly string[];
    onChange: (next: string[]) => void;
    ariaLabel?: string;
}): import("react").JSX.Element;
export declare function Err(props: {
    message: string | null;
}): import("react").JSX.Element | null;
export declare function Muted(props: {
    children?: ReactNode;
}): import("react").JSX.Element;
/** 头像：有图出图，无图出首字符（小尺寸回退为用户图标），不再是灰块。尺寸经 --tavern-avatar-s 传入。 */
export declare function Avatar(props: {
    url?: string | null;
    name?: string;
    size?: number;
    className?: string;
}): import("react").JSX.Element;
/** shimmer 骨架条/块，替换「加载中…」。 */
export declare function Skeleton(props: {
    width?: number | string;
    height?: number;
    radius?: number;
    style?: CSSProperties;
}): import("react").JSX.Element;
/** 顶部横幅通知（宿主 Toast：滑入→停留→淡出后 onDone）。瞬时操作反馈用它，上下文错误仍用 Err。 */
export declare function useToast(): {
    show: (text: string) => void;
    node: import("react").JSX.Element | null;
};
/** 让卡片等元素可键盘触发（Enter/Space），配合 .is-clickable。 */
export declare function clickableProps(onClick: () => void): {
    role: string;
    tabIndex: number;
    onClick: () => void;
    onKeyDown: (e: {
        key: string;
        target: unknown;
        currentTarget: unknown;
        preventDefault: () => void;
    }) => void;
};
type LoadState<T> = {
    status: 'idle';
} | {
    status: 'loading';
} | {
    status: 'ready';
    value: T;
} | {
    status: 'error';
    message: string;
};
/** 拉取一个 remote 读取；reload() 触发重拉；enabled=false 时挂起（idle）。 */
export declare function useLoader<T>(load: () => Promise<Envelope<T>>, deps?: readonly unknown[], enabled?: boolean, timeoutMs?: number): {
    state: LoadState<T>;
    reload: () => void;
};
/** 信封 → 错误消息（ok 时返回 null）。 */
export declare function errOf(r: Envelope<unknown>): string | null;
/**
 * 面板写操作的统一外壳：置 busy → 清旧错 → 跑 fn，成功失败都在 finally 解锁。
 * typert 在传输失败和入参 zod 严格校验不过时是 reject，不是错误信封，
 * 而按钮上的 `onClick={() => void save()}` 会把这个 reject 吞掉；
 * 传输层 reject 也必须解锁按钮，否则 busy 永远为 true、保存按钮再也点不动，草稿全丢。
 * onError 传入时，reject 的消息改走 onError（如 toast 瞬时提示），不再写 setError；
 * fn 内自行 setError 的错误信封不受影响（上下文错误仍走 Err）。
 */
export declare function runAsync(setBusy: (busy: boolean) => void, setError: (message: string | null) => void, fn: () => Promise<void>, onError?: (message: string) => void): Promise<void>;
export declare function fileToBase64(file: File): Promise<string>;
export declare function readJsonFile(file: File): Promise<unknown>;
export declare function downloadJson(filename: string, json: unknown, space?: number): void;
export declare function downloadBase64(filename: string, base64: string, mime: string): void;
/** primitives Modal 的薄封装（统一关闭文案）；width 档：sm 380（默认）/ md 480 / lg 680 / xl 880 / full 1280（近全屏）。 */
export declare function Dialog(props: {
    open: boolean;
    title: string;
    description?: string;
    onClose: () => void;
    footer?: ReactNode;
    width?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
    children?: ReactNode;
}): import("react").JSX.Element;
export declare function ConfirmDialog(props: {
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    danger?: boolean;
    busy?: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}): import("react").JSX.Element;
/** 数字输入（number）。 */
export declare function NumInput(props: {
    value: number;
    onChange: (v: number) => void;
    step?: string;
    width?: number;
}): import("react").JSX.Element;
/** 可空数字输入（null ↔ 空串）。 */
export declare function NullableNumInput(props: {
    value: number | null;
    onChange: (v: number | null) => void;
    width?: number;
}): import("react").JSX.Element;
export {};
