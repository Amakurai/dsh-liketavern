/**
 * 客户端消息显示偏好：模块级 store + React hook。
 *
 * 偏好落在 dsh-tavern 设置的 `speakerHeader` 键（见 node/config.ts）。入口 apply 时经
 * remote.getSettings 播种，设置页切换后即时 setSpeakerHeader，已渲染的气泡随之重绘。
 */
import { useSyncExternalStore } from 'react';
let speakerHeader = false;
const listeners = new Set();
export function getSpeakerHeader() {
    return speakerHeader;
}
/** true：角色消息显示头像与卡名；false：按宿主原生回复样式只画正文。 */
export function setSpeakerHeader(value) {
    if (value === speakerHeader)
        return;
    speakerHeader = value;
    for (const fn of listeners)
        fn();
}
function subscribeSpeakerHeader(fn) {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}
export function useSpeakerHeader() {
    return useSyncExternalStore(subscribeSpeakerHeader, getSpeakerHeader, getSpeakerHeader);
}
let displaySettingsRevision = 0;
const displayRevisionListeners = new Set();
export function getDisplaySettingsRevision() {
    return displaySettingsRevision;
}
/** 全局交互卡开关、网络白名单、展示正则或预设保存后递增，驱动已挂载气泡与后台脚本重读展示配置。 */
export function bumpDisplaySettingsRevision() {
    displaySettingsRevision += 1;
    for (const fn of [...displayRevisionListeners])
        fn();
}
function subscribeDisplaySettingsRevision(fn) {
    displayRevisionListeners.add(fn);
    return () => {
        displayRevisionListeners.delete(fn);
    };
}
export function useDisplaySettingsRevision() {
    return useSyncExternalStore(subscribeDisplaySettingsRevision, getDisplaySettingsRevision, getDisplaySettingsRevision);
}
/** 读取宿主当前主题明暗配色（优先 body[data-ds-dark-theme]，回退根节点 colorScheme）。 */
export function readHostColorScheme() {
    if (typeof document === 'undefined')
        return undefined;
    if (document.body?.hasAttribute?.('data-ds-dark-theme'))
        return 'dark';
    const scheme = document.documentElement?.style?.colorScheme;
    return scheme === 'dark' || scheme === 'light' ? scheme : undefined;
}
