import type { CSSProperties, ReactNode } from 'react';
import type { CardRegexScript } from '../core/types.js';
import type { Envelope } from './types.js';
import './styles.js';
/** 旧内联按钮样式（少量组合用）；新按钮请走 Btn。 */
export declare const btn: CSSProperties;
/** 旧内联输入框样式；新代码优先用 className="dsh-tavern-input"。 */
export declare const input: CSSProperties;
/** 代码向多行框（正则 find/replace 等），用宿主 code 字体。 */
export declare const textarea: CSSProperties;
/** 给人看的正文框（世界书条目内容等），不用等宽字体。 */
export declare const textareaPlain: CSSProperties;
export declare function Btn(props: {
    onClick: () => void;
    disabled?: boolean;
    danger?: boolean;
    primary?: boolean;
    title?: string;
    size?: 'sm' | 'md';
    children?: ReactNode;
}): any;
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
}): any;
export declare function FileBtn(props: {
    accept: string;
    disabled?: boolean;
    onFile: (file: File) => void;
    children?: ReactNode;
}): any;
export declare function Section(props: {
    title?: string;
    description?: string;
    children?: ReactNode;
}): any;
export interface TabItem {
    id: string;
    label: string;
}
/** 对齐插件设置页的下划线页签。 */
export declare function Tabs(props: {
    items: TabItem[];
    value: string;
    onChange: (id: string) => void;
}): any;
export declare function Badge(props: {
    accent?: boolean;
    children?: ReactNode;
}): any;
/**
 * 预设/卡内嵌 regex_scripts 的展示行：开关 + 名称 + 作用域徽标 + 查找式。
 * 作用域语义与 core/regex.ts 的 compileRegexScripts 一致；onToggle 传入时显示启用开关。
 */
export declare function RegexScriptRow(props: {
    script: CardRegexScript;
    index: number;
    onToggle?: (disabled: boolean) => void;
}): any;
/** 条目启用开关（对齐 SillyTavern 的 on/off，视觉走 dsh 胶囊）。 */
export declare function Toggle(props: {
    checked: boolean;
    onChange: (value: boolean) => void;
    disabled?: boolean;
    title?: string;
}): any;
export declare function IconBtn(props: {
    label: string;
    danger?: boolean;
    disabled?: boolean;
    onClick: () => void;
    children?: ReactNode;
}): any;
/** 对齐通用设置：标题 + 说明 + 右侧控件。stacked = 宽控件（checkbox 列表等）换成纵向满宽。inline 已废弃（现在默认就是行式）。 */
export declare function SettingsRow(props: {
    title: string;
    description?: string;
    stacked?: boolean;
    inline?: boolean;
    children?: ReactNode;
}): any;
export declare function Field(props: {
    label: string;
    children?: ReactNode;
}): any;
export declare function Err(props: {
    message: string | null;
}): any;
export declare function Muted(props: {
    children?: ReactNode;
}): any;
/** 头像：有图出图，无图出首字符（小尺寸回退为用户图标），不再是灰块。尺寸经 --tavern-avatar-s 传入。 */
export declare function Avatar(props: {
    url?: string | null;
    name?: string;
    size?: number;
    className?: string;
}): any;
/** shimmer 骨架条/块，替换「加载中…」。 */
export declare function Skeleton(props: {
    width?: number | string;
    height?: number;
    radius?: number;
    style?: CSSProperties;
}): any;
/** 顶部横幅通知（宿主 Toast：滑入→停留→淡出后 onDone）。瞬时操作反馈用它，上下文错误仍用 Err。 */
export declare function useToast(): {
    show: (text: string) => void;
    node: any;
};
/** 让卡片等元素可键盘触发（Enter/Space），配合 .is-clickable。 */
export declare function clickableProps(onClick: () => void): {
    role: string;
    tabIndex: number;
    onClick: () => void;
    onKeyDown: (e: {
        key: string;
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
export declare function useLoader<T>(load: () => Promise<Envelope<T>>, deps?: readonly unknown[], enabled?: boolean): {
    state: LoadState<T>;
    reload: () => void;
};
/** 信封 → 错误消息（ok 时返回 null）。 */
export declare function errOf(r: Envelope<unknown>): string | null;
export declare function fileToBase64(file: File): Promise<string>;
export declare function readJsonFile(file: File): Promise<unknown>;
export declare function downloadJson(filename: string, json: unknown): void;
/** primitives Modal 的薄封装（统一中文关闭文案）；width 档：sm 380（默认）/ md 480 / lg 680。 */
export declare function Dialog(props: {
    open: boolean;
    title: string;
    description?: string;
    onClose: () => void;
    footer?: ReactNode;
    width?: 'sm' | 'md' | 'lg';
    children?: ReactNode;
}): any;
export declare function ConfirmDialog(props: {
    open: boolean;
    title: string;
    description: string;
    confirmLabel?: string;
    danger?: boolean;
    busy?: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}): any;
/** 数字输入（number）。 */
export declare function NumInput(props: {
    value: number;
    onChange: (v: number) => void;
    step?: string;
    width?: number;
}): any;
/** 可空数字输入（null ↔ 空串）。 */
export declare function NullableNumInput(props: {
    value: number | null;
    onChange: (v: number | null) => void;
    width?: number;
}): any;
export {};
