import type { ReactNode } from 'react';
/** 每个编辑器独立注册，避免一个干净的子编辑器覆盖另一个编辑器的未保存状态。 */
export declare function useDraftGuard(dirty: boolean, busy?: boolean, clearChildren?: () => void): {
    request: (action: () => void) => void;
    confirmation: import("react").JSX.Element;
    clearDraft: () => void;
};
/** 一级导航汇总当前页全部编辑器；保存中不允许卸载，取消离开时保留原草稿。 */
export declare function DraftScope(props: {
    children: (request: (action: () => void) => void, dirty: boolean, busy: boolean) => ReactNode;
}): import("react").JSX.Element;
