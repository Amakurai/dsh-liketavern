import { type TavernPaths } from './paths.js';
/** 子会话继承的祖先 WAL 边界：仅 throughTurn（含）属于当前分支历史。 */
export interface WalLineageEntry {
    sessionId: string;
    throughTurn: number;
}
export interface SessionBinding {
    sessionId: string;
    cardId: string;
    /** 绑定时的角色显示名；删除后按此找回新工作区。旧文件可缺。 */
    cardName?: string;
    /** 预设 identifier；null = 内建默认预设。 */
    presetId: string | null;
    personaId: string | null;
    /** 全局世界书（library 内文件名）。 */
    lorebookIds: string[];
    /** 主世界书（Character Lore）；null = 使用卡内嵌书（若有）。 */
    characterLorebookId: string | null;
    /** 会话级交互卡开关；null 跟随全局设置。 */
    interactiveCards: boolean | null;
    /** 开场白 swipe 下标（0 = first_mes，1.. = alternate_greetings）。 */
    greetingIndex: number;
    /** fork 祖先及各自被继承的最大 turn；旧绑定可缺，视为无祖先。 */
    walLineage?: WalLineageEntry[];
    createdAt: string;
}
export declare function loadBinding(paths: TavernPaths, sessionId: string): Promise<SessionBinding | null>;
export declare function saveBinding(paths: TavernPaths, binding: SessionBinding): Promise<void>;
export declare function deleteBinding(paths: TavernPaths, sessionId: string): Promise<void>;
/** 删除角色卡时清掉仍指向该 cardId 的会话绑定，避免封面页继续显示文件夹 ID。 */
export declare function clearBindingsForCard(paths: TavernPaths, cardId: string): Promise<void>;
