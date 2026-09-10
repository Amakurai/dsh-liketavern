import type { CharacterCard } from '../core/types.js';
import { WorkspaceFs } from './workspaceFs.js';
export interface CharacterWorkspace {
    cardId: string;
    /** 工作区绝对路径：<dataRoot>/<cardId>。 */
    root: string;
    card: CharacterCard;
}
export interface CharacterSummary {
    cardId: string;
    name: string;
    hasAvatar: boolean;
    createdAt?: string;
    /** 卡内嵌世界书（assets/character-book.json 或 card.characterBook）。 */
    hasCharacterBook: boolean;
    characterBookName: string | null;
    characterBookEntryCount: number;
}
export interface WorkspaceIndexFile {
    /** 相对工作区根的路径（正斜杠）。 */
    path: string;
    /** 一句话摘要：md 取首个非 frontmatter 非空行前 60 字；jsonl 取「N 条变化」；空文件为空串。 */
    summary: string;
    tokens: number;
}
export interface WorkspaceIndex {
    files: WorkspaceIndexFile[];
    updatedAt: string;
}
export declare function isValidCardId(cardId: string): boolean;
/** 非法 cardId 统一抛错，供所有会创建/删除工作区句柄的入口复用。 */
export declare function assertValidCardId(cardId: string): void;
/** 角色 ID：净化名 + '-' + sha1(name + 随机字节) 前 8 位（同名片互不覆盖）。 */
export declare function newCardId(name: string): string;
export interface ImportCardOptions {
    /** 是否落盘卡内嵌世界书；默认 true。跳过时 card.json 里 characterBook 也置空。 */
    importWorldBook?: boolean;
}
/**
 * 导入角色卡为独立工作区：建目录结构，落盘 card.json（剔除 pngBytes、保留 raw）、
 * card.png（若有字节）、assets/character-book.json（若有内嵌书且未跳过）、
 * assets/regex-scripts.json（compileCardRegexScripts 编译产物，默认不启用）、
 * journal.md（不存在则建空文件）与初始 index.json。
 */
export declare function importCard(dataRoot: string, card: CharacterCard, opts?: ImportCardOptions): Promise<CharacterWorkspace>;
/**
 * 列出全部角色（读各 card.json 的 name 与 card.png 存在性）；损坏目录容错跳过。
 * 只 readdir characters/ 本层、逐目录读 card.json 探测：卡目录约定为单层
 * characters/<cardId>/card.json，递归遍历会把每个角色的 memory/archive/、
 * state/wal/ 整棵走完（数据积累后设置面板打开随之变慢），这里不做任何递归。
 */
export declare function listCharacters(dataRoot: string): Promise<CharacterSummary[]>;
/** 读取角色工作区；card.json 缺失或损坏返回 null。 */
export declare function loadCharacter(dataRoot: string, cardId: string): Promise<CharacterWorkspace | null>;
/** 删除角色工作区整目录（rm -rf；本模块唯一直接使用 node:fs 的位置）。 */
export declare function deleteCharacter(dataRoot: string, cardId: string): Promise<void>;
/**
 * 重建 index.json：扫描 memory/*.md（不含 archive 子目录）、state/world-delta.jsonl 与
 * journal.md，每个文件记录 {path, summary, tokens}（tokens 由注入的估算函数计算）。
 */
export declare function rebuildIndex(fs: WorkspaceFs, estimateTokens: (text: string) => number): Promise<void>;
