/**
 * 交互卡 iframe srcDoc 组装：CSP + SillyTavern / JS-Slash-Runner 窄桥脚本 +
 * 内存版 localStorage/sessionStorage shim（opaque origin 下原生访问会抛 SecurityError）。
 * 卡内 JS 不能碰主窗口；只通过 postMessage 请求切换开场白 swipe。
 */
import { type CardVariableLabels } from './cardVariables.js';
export declare const CARD_BRIDGE_SOURCE = "dsh-tavern-card";
export interface CardFrameOptions {
    /** 开场白变体（0 = first_mes）。供 getChatMessages / swipe_id 使用。 */
    greetings: string[];
    greetingIndex: number;
    variableLabels?: CardVariableLabels;
    variableStyles?: string;
    /**
     * 额外信任的主机：放宽 connect-src 与 script-src（img/font/style 已默认放行 https）。
     * 空数组 = 脚本不能 fetch/XHR，也不能加载外部脚本；`*` = 全部放行。
     */
    connectHosts?: string[];
}
/** SillyTavern / tavernhelper 常用入口的 stub；卡内按钮经 postMessage 请求 swipeGreeting。 */
export declare function tavernCardBridgeScript(options: Pick<CardFrameOptions, 'greetings' | 'greetingIndex' | 'variableLabels' | 'variableStyles'>): string;
/** 把 CSP 与 ST 桥接脚本注入交互卡 HTML，得到 iframe srcDoc。 */
export declare function buildCardSrcDoc(html: string, options: CardFrameOptions): string;
export interface CardBridgeMessage {
    source: string;
    action: string;
    index?: number;
    height?: number;
}
export declare function parseCardBridgeMessage(data: unknown): CardBridgeMessage | null;
