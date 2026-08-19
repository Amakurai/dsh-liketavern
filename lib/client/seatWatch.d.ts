/**
 * 无会话 hero 上选择「Tavern 模式」的补偿器。
 *
 * 宿主的预设 seat（dsh-client-ui-agent-preset）在没有 current 会话时只把选择暂存
 * （staged，chip 立即回显「Tavern 模式」，但不发 RPC、不建会话）；要再点一次
 * 「新对话」让会话成为 current，暂存的选择才落地。表现为：选了模式，英雄区的
 * 角色卡选择器（conversation.input.dock，session 作用域，无会话时不渲染）不出现。
 *
 * 这里监听 seat chip 的文案变化：一旦它从无变为显示「Tavern 模式」且当前仍无会话，
 * 就代为调用 workspaces.startSession()（与侧边栏「新对话」同一动作）。会话出现后
 * 宿主 seat 的 list 订阅会自动把暂存的 tavern 预设应用上去，dock 英雄区随即渲染。
 *
 * DOM 耦合点（宿主升级后若失效，最坏退回「需要再点一次新对话」的原行为）：
 * - seat chip = button[aria-haspopup="menu"] 且 title 为 seatHint 的中/英文案；
 * - 选中文案 = presets/tavern/preset.yml 的 name（宿主原样显示，不做本地化）。
 */
import type { ClientContext } from './types.js';
/** 安装监听；返回清理函数（挂进 ctx.effect）。 */
export declare function installTavernSeatWatch(ctx: ClientContext): () => void;
