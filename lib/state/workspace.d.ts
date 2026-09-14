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
/** 收纳箱中的角色摘要；其它字段与活动角色列表保持一致。 */
export interface ArchivedCharacterSummary extends CharacterSummary {
    archivedAt: string;
}
/** 工作区根的收纳标记；不属于剧情状态，不进入 story 快照或 WAL。 */
export interface CharacterArchiveMetadata {
    version: 1;
    archivedAt: string;
}
export declare const CHARACTER_ARCHIVE_FILE = ".archive.json";
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
/** 读收纳标记；文件损坏时明确报错，不把本应隐藏的角色误当活动角色。 */
export declare function readCharacterArchiveMetadata(dataRoot: string, cardId: string): Promise<CharacterArchiveMetadata | null>;
export declare function listCharacters(dataRoot: string): Promise<CharacterSummary[]>;
/**
 * 列出收纳箱角色。标记 JSON 损坏时仍依「文件存在」收纳，并用 mtime 兜底时间：
 * 这样角色不会误回活动库，也不会从两个列表同时消失，用户仍能点击恢复清掉坏标记。
 */
export declare function listArchivedCharacters(dataRoot: string): Promise<ArchivedCharacterSummary[]>;
/** 读取角色工作区；card.json 缺失或损坏返回 null。 */
export declare function loadCharacter(dataRoot: string, cardId: string): Promise<CharacterWorkspace | null>;
/**
 * 将角色收纳：只原子写入根级标记，不搬动工作区，因此剧情、WAL 和历史绑定仍按
 * 原路径可用。重复收纳保留首次 archivedAt，避免列表顺序因重试抖动。
 */
export declare function archiveCharacter(dataRoot: string, cardId: string): Promise<CharacterArchiveMetadata>;
/** 恢复收纳角色；对已在活动库的角色幂等，不修改任何剧情文件。 */
export declare function restoreCharacter(dataRoot: string, cardId: string): Promise<void>;
/** 删除角色工作区整目录（rm -rf；本模块唯一直接使用 node:fs 的位置）。 */
export declare function deleteCharacter(dataRoot: string, cardId: string): Promise<void>;
/**
 * 重建 index.json：扫描 memory/*.md（不含 archive 子目录）、state/world-delta.jsonl 与
 * journal.md，每个文件记录 {path, summary, tokens}（tokens 由注入的估算函数计算）。
 */
export declare function rebuildIndex(fs: WorkspaceFs, estimateTokens: (text: string) => number): Promise<void>;
