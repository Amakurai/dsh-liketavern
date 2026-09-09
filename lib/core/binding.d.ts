/**
 * 会话绑定的纯函数：角色卡删除后，用名字或「库里只剩一张卡」把陈旧 cardId 接回新工作区。
 * 文件夹 ID（净化名 + hash）不能当展示名，回收失败则视为未绑定。
 * SessionBinding 数据形状也归这里（纯数据，core 层）；持久化在 node/bindings，remote 契约引用本文件。
 */
import type { WorldInfoGlobalSettings } from './types.js';
/** 子会话继承的祖先 WAL 边界：仅 throughTurn（含）属于当前分支历史。 */
export interface WalLineageEntry {
    sessionId: string;
    throughTurn: number;
}
/** 会话绑定：Tavern 会话 ↔ 角色卡/预设/人设/世界书选择（存 sessions/<sessionId>.json）。 */
export interface SessionBinding {
    sessionId: string;
    cardId: string;
    /** 独立剧情状态；旧绑定缺省，首次读取时从旧角色状态复制迁移。由 host 管理。 */
    storyId?: string;
    /** 绑定时的角色显示名；删除后按此找回新工作区。旧文件可缺。 */
    cardName?: string;
    /** 预设 identifier；null = 内建默认预设。 */
    presetId: string | null;
    personaId: string | null;
    /** 全局世界书（library 内文件名）。 */
    lorebookIds: string[];
    /** 主世界书（Character Lore）；null = 使用卡内嵌书（若有）。 */
    characterLorebookId: string | null;
    /** 主书为空时是否使用内嵌书，旧绑定缺省为 true。 */
    useEmbeddedLorebook?: boolean;
    /** 当前会话的附加角色世界书。 */
    characterLorebookIds?: string[];
    /** 当前会话世界书引擎覆盖；未指定字段跟随项目设置。 */
    worldInfo?: Partial<WorldInfoGlobalSettings>;
    /** 会话级交互卡开关；null 跟随全局设置。 */
    interactiveCards: boolean | null;
    /** 显式启用本会话原生 MVU 初始化与自动变量更新；旧绑定默认关闭。 */
    helperMvu?: boolean;
    /** 开场白 swipe 下标（0 = first_mes，1.. = alternate_greetings）。 */
    greetingIndex: number;
    /** 会话作者注释，每轮进 turnContext。 */
    authorNote?: string;
    /** 是否把角色工作区 journal.md 注入本轮 turn。 */
    injectJournal?: boolean;
    /** fork 祖先及各自被继承的最大 turn；旧绑定可缺，视为无祖先。 */
    walLineage?: WalLineageEntry[];
    createdAt: string;
}
export interface BindingCardRef {
    cardId: string;
    name: string;
}
/** 绑定里可选的展示名，旧文件没有该字段。 */
export interface StaleBindingRef {
    cardId: string;
    cardName?: string;
}
/**
 * 若 binding.cardId 仍在角色列表中则原样返回；否则按 cardName 或唯一剩余角色改写 cardId。
 * 无法回收时返回 null（调用方应丢掉绑定文件，避免 UI 把文件夹 ID 当成角色名）。
 */
export declare function resolveStaleBinding<T extends StaleBindingRef>(binding: T, characters: BindingCardRef[]): T | null;
