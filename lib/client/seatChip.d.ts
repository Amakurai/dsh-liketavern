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
    hasPopup?: 'menu' | 'dialog';
    onClick: () => void;
    chevron?: boolean;
    trailing?: ReactNode;
}): any;
