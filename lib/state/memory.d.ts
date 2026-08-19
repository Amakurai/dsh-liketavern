/**
 * 记忆存储（MemoryStore）。
 * 每条记忆一个 md 文件：memory/<id>.md（YAML frontmatter + 正文），压缩归档移入 memory/archive/。
 * frontmatter 手写解析（零依赖，不引入 yaml 库）：字段行 `key: value`，数组用 JSON 行内式
 * （`tags: ["a","b"]`）。一切文件读写经 WorkspaceFs（事务层）；检索复用核心 BM25
 * （keys 权重 ×2 已在索引侧内建），search 支持半衰期时间衰减（ts 取 updated）。
 */
import type { MemoryEntry } from '../core/types.js';
import type { WorkspaceFs } from './workspaceFs.js';
/** 正文软上限（字）：超过不拒绝，write 返回值带 overLength: true，治理提示由工具层做。 */
export declare const MEMORY_BODY_SOFT_LIMIT = 200;
/** 落盘的 frontmatter 元数据；id 由文件名推导、archived 由路径推导，均不写入文件。 */
export interface MemoryMeta {
    created: string;
    updated: string;
    sourceRange: string;
    tags: string[];
    keys: string[];
}
/** write 返回值：完整条目 + 超长软提示标记。 */
export type MemoryWriteResult = MemoryEntry & {
    overLength: boolean;
};
export interface MemoryStoreOptions {
    /** findSimilar 的默认返回条数（写入前去重提示用），默认 3。 */
    similarTopK?: number;
}
export interface MemoryUpdateOptions {
    /** merge 供模型工具追加标签；replace 供设置面板把编辑结果完整覆盖（含清空）。 */
    listMode?: 'merge' | 'replace';
}
/** 序列化为 md 文本：frontmatter 字段行 + 空行 + 正文，文件以单个换行结尾。 */
export declare function serializeMemory(meta: MemoryMeta, body: string): string;
/**
 * 解析 md 文本为 MemoryEntry。file 为相对 memory/ 目录的路径（如 `m-x.md`、`archive/m-x.md`）。
 * 缺少 frontmatter、created 缺失/非法、数组字段非 JSON 字符串数组时抛错。
 */
export declare function parseMemory(file: string, text: string): MemoryEntry;
export declare class MemoryStore {
    private readonly fs;
    private readonly similarTopK;
    constructor(fs: WorkspaceFs, options?: MemoryStoreOptions);
    private pathOf;
    /** 解析 memory/*.md（不含 archive/），坏文件容错跳过；按 created 升序（并列按 id 字典序）。 */
    list(): Promise<MemoryEntry[]>;
    /** 按 id 取单条（不含 archive/）；不存在或坏文件返回 null。 */
    get(id: string): Promise<MemoryEntry | null>;
    /** 写入新记忆；正文超过 200 字时返回值带 overLength: true（软提示，不拒绝）。 */
    write(input: {
        body: string;
        tags?: string[];
        keys?: string[];
        sourceRange?: string;
    }): Promise<MemoryWriteResult>;
    /** 更新正文与 tags/keys、刷新 updated；默认合并列表，replace 模式允许 UI 删除或清空列表项。 */
    update(id: string, patch: {
        body?: string;
        tags?: string[];
        keys?: string[];
    }, options?: MemoryUpdateOptions): Promise<MemoryEntry | null>;
    /** 事务删除（经 fs.delete）；不存在返回 false。 */
    delete(id: string): Promise<boolean>;
    /** 移入 memory/archive/（读原文件 → 写 archive 路径 → 删原路径，全经 fs）；返回移动条数。 */
    archive(ids: string[]): Promise<number>;
    /** 以当前活跃记忆构建临时 BM25 索引（记忆规模小，每次重建即可）。 */
    private buildIndex;
    /**
     * 写入前去重检索：query = text + keys，BM25（keys 加权内建），不做时间衰减。
     * 工具层据此提示 agent 改用 update 合并，而不是重复 write。
     */
    findSimilar(text: string, keys: string[], topK?: number): Promise<Array<{
        entry: MemoryEntry;
        score: number;
    }>>;
    /** 检索：BM25 + 可选半衰期时间衰减（ts 用 updated；now/halfLifeMs 可注入以便测试）。 */
    search(query: string, options?: {
        topK?: number;
        halfLifeMs?: number;
        now?: number;
    }): Promise<Array<{
        entry: MemoryEntry;
        score: number;
    }>>;
    /** 容量统计：条数与正文 token 粗估累加。 */
    stats(): Promise<{
        count: number;
        tokens: number;
    }>;
    /** 最旧的 n 条（created 升序），压缩取批次用。 */
    oldest(n: number): Promise<MemoryEntry[]>;
}
