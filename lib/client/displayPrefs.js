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
export function useSpeakerHeader() {
    return useSyncExternalStore((fn) => {
        listeners.add(fn);
        return () => {
            listeners.delete(fn);
        };
    }, getSpeakerHeader);
}
