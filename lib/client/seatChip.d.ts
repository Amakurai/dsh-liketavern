/**
 * 与原生英雄区座位（workspace / 模式选择）同高的胶囊芯片。
 * 会话头部与空白页选角共用，避免一套 outline 按钮、一套 pill。
 */
import type { ReactNode } from 'react';
import './styles.js';
export declare function TavernSeatChip(props: {
    label: string;
    title?: string;
    avatarUrl?: string | null;
    open?: boolean;
    disabled?: boolean;
    /** 绑定/详情加载中：渲染骨架占位，避免标签在「选择角色卡」与角色名之间闪跳。 */
    loading?: boolean;
    hasPopup?: 'menu' | 'dialog';
    onClick: () => void;
    chevron?: boolean;
    trailing?: ReactNode;
}): any;
