/**
 * 记忆存储（MemoryStore）。
 * 每条记忆一个 md 文件：memory/<id>.md（YAML frontmatter + 正文），压缩归档移入 memory/archive/。
 * frontmatter 手写解析（零依赖，不引入 yaml 库）：字段行 `key: value`，数组用 JSON 行内式
 * （`tags: ["a","b"]`）。一切文件读写经 WorkspaceFs（事务层）；检索复用核心 BM25
 * （keys 权重 ×2 已在索引侧内建），search 支持半衰期时间衰减（ts 取 updated）。
 * 检索别名是派生数据，单独存在 memory/aliases.json，按正文指纹对应到记忆，只进检索索引、不进去重索引。
 */
import { type Bm25SearchOptions } from '../core/bm25.js';
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
 * 记忆 id 是否可作为 memory/ 下的单个文件名：不含路径分隔符、盘符、NUL，且不是 . 或 ..。
 * 只挡越出目录与 WAL 记不下来的形状；本类生成的 `m-<base36>-<hex>` 与手放的普通文件名都通过。
 */
export declare function isMemoryId(id: unknown): id is string;
/** 来源格式共用入口：旧逗号列表继续可读，特殊文件名用独立 JSON 标记避免逗号与换行歧义。 */
export declare function isMemorySummary(sourceRange: string): boolean;
export declare function memorySourceIds(sourceRange: string): string[];
/**
 * 解析 md 文本为 MemoryEntry。file 为相对 memory/ 目录的路径（如 `m-x.md`、`archive/m-x.md`）。
 * 缺少 frontmatter、created 缺失/非法、数组字段非 JSON 字符串数组时抛错。
 */
export declare function parseMemory(file: string, text: string): MemoryEntry;
export declare class MemoryStore {
    private readonly fs;
    private readonly similarTopK;
    /**
     * 活跃记忆的解析结果，按目录指纹（文件名 + mtime + size）失效。
     *
     * 为什么以磁盘指纹为主、不只用进程内修订号（对比 TavernState 的 presetCache / loreCache）：
     * 记忆文件除了本类还会被 WAL 回滚直接写回磁盘（楼层回退撤销本轮 memory_write），修订号捕获不到那条路径，
     * 会让检索一直用回滚前的索引。指纹是每个文件一次 lstat（不读数据），比全文读 + 分词便宜一个量级。
     * 本类自己的写入另外记进同一剧情共享的写入登记（WriteLedger），补上指纹在同一时间刻度内分不出的情况。
     *
     * 缓存的收益点：一次 memory_write 要连着跑 findSimilar → stats → write，
     * 一个 turn 里 search 也可能被工具重复调用；没有缓存的话每次都全量重读 + 重建索引。
     */
    private cache;
    /** 只含活跃记忆的索引（写入去重用）与含可达归档来源的索引（检索用）；只在工作区锁内读写。 */
    private activeIndex;
    private sourceIndex;
    /**
     * 活跃记忆逐个文件的解析结果（坏文件记为 null）。目录指纹变化时只重读指纹变了的文件：
     * 写一条记忆只多出一个文件，不必把其余上百条再读一遍。判断口径与目录指纹相同（文件名 + mtime + size）。
     */
    private readonly activeCache;
    /**
     * 已解析的归档来源，按路径存、按磁盘指纹校验，活跃集变化时不随 cache 一起丢弃。
     *
     * 归档原文写入后基本不再变化，而每次 memory_write 都会让活跃集指纹变化；没有这层的话，
     * 下一次检索要把全部可达来源重新逐个读盘（几百条来源即数百毫秒，随剧情长度线性增长）。
     * 信任程度与来源索引的缓存命中相同：每次对齐索引时仍批量核对指纹，指纹不符或文件缺失就重读或报错；
     * 显式 invalidate 会一并清空。
     */
    private readonly sourceCache;
    /** 别名文件的解析结果，按磁盘指纹与写入登记校验；文件不存在时记为空表。 */
    private aliasCache;
    /** 条目正文的指纹；条目对象在正文不变时一直是同一个，不必每次重算。 */
    private readonly hashes;
    private readonly ledger;
    private epoch;
    constructor(fs: WorkspaceFs, options?: MemoryStoreOptions);
    /**
     * id 必须是单个文件名段。模型可以把任意字符串当 id 传进 update/delete：
     * `archive/x` 会绕过「去重只查活跃条目」改写归档来源，`./x` 能读到文件却会在 WAL 里留下
     * 日后无法读回的路径，让整个剧情的回退/分支失效。此处不区分归档与否统一拒绝。
     */
    private pathOf;
    /**
     * 作废这个剧情下全部实例的缓存。平时不需要调用：本类的写入、面板编辑、WAL 回滚都经 WorkspaceFs，
     * 由文件层的写入登记通知各实例重读。只有完全绕过 WorkspaceFs 的改写（别的进程、外部编辑器、测试直接写盘）
     * 才可能既不改文件大小、又落在同一个 mtime 刻度内，那时需要调用方手动调一次。
     */
    invalidate(): void;
    /** 取共享的写入登记；有实例显式作废过就先丢掉本实例的全部缓存。 */
    private sync;
    /** 正文指纹：别名按它对应到记忆，正文一改即作废。 */
    private hashOf;
    /**
     * 读别名文件；调用方必须持有工作区锁。文件缺失或损坏都当作没有别名——它是派生数据，之后会重新生成。
     * known 是调用方刚取到的磁盘指纹（与别的文件一起批量取的），传了就不再单独 stat。
     */
    private loadAliases;
    /** 这条记忆当前有效的别名：指纹与正文对得上、且不为空。 */
    private aliasesOf;
    /**
     * 还没有别名、或者别名已随正文改动作废的活跃记忆，最新的在前，最多 limit 条。
     * 生成过但模型没给出别名的条目记为空列表，不再重复请求。
     */
    aliasCandidates(limit: number): Promise<MemoryEntry[]>;
    /**
     * 保存一批别名，返回实际保存的条数。等待模型期间被改写、删除或归并的记忆对不上现在的正文，直接跳过。
     * 别名是派生数据，只能经无楼层的文件面写入：记进楼层 WAL 的话，回退楼层会把别的记忆的别名一起改回去。
     * 顺带清掉既不在活跃库、也不在归档里的记录。
     */
    saveAliases(items: ReadonlyArray<{
        entry: MemoryEntry;
        aliases: readonly string[];
    }>): Promise<number>;
    /** 解析 memory/*.md（不含 archive/），坏文件容错跳过；按 created 升序（并列按 id 字典序）。 */
    list(): Promise<MemoryEntry[]>;
    private listNow;
    /** 按 id 取单条（不含 archive/）；不存在或坏文件返回 null。 */
    get(id: string): Promise<MemoryEntry | null>;
    private getNow;
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
    private updateNow;
    /** 事务删除（经 fs.delete）；不存在返回 false。 */
    delete(id: string): Promise<boolean>;
    /** 移入 memory/archive/（读原文件 → 写 archive 路径 → 删原路径，全经 fs）；返回移动条数。 */
    archive(ids: string[]): Promise<number>;
    private archiveNow;
    /** 归并使用乐观校验：等待 LLM 时来源被编辑、删除或回滚，就放弃旧摘要。 */
    mergeBatch(batch: readonly MemoryEntry[], body: string, kind: 'compress' | 'merge'): Promise<number>;
    /**
     * 取与当前磁盘状态对齐的 BM25 索引；调用方必须持有工作区锁，并在返回后同步用完。
     * 活跃集与归档指纹都没变就直接复用；否则重新展开来源，再把索引增量对齐到新的条目集合。
     */
    private buildIndex;
    /**
     * 按给定顺序加载一批归档来源：磁盘指纹与缓存一致就复用已解析条目，否则读盘解析并写回缓存。
     * 先整批取指纹再读；来源是否存在仍以读取结果为准。缺失、解析失败和读取故障都不进缓存。
     * 取指纹阶段的故障先于读取阶段报告；同一阶段多个来源出错时报告顺序最靠前的那个。
     */
    private loadSources;
    /**
     * 写入前去重检索：query = text + keys，按 IDF 加权的双向覆盖率打分（0–1），不做时间衰减。
     * 分数不随库规模和正文长度漂移，可直接与固定阈值比较；工具层据此提示 agent 改用 update 合并，
     * 而不是重复 write。
     */
    findSimilar(text: string, keys: string[], topK?: number): Promise<Array<{
        entry: MemoryEntry;
        score: number;
    }>>;
    /**
     * 检索：BM25 + 时间衰减。仅自动入模额外请求摘要来源并给最新输入加权（boost），
     * 工具不传这两项，结果形状不变。
     */
    search(query: string, options?: Bm25SearchOptions & {
        includeSummarySources?: boolean;
    }): Promise<Array<{
        entry: MemoryEntry;
        score: number;
        summarySourceIds?: readonly string[];
    }>>;
    /** 容量统计：条数与正文 token 粗估累加。 */
    stats(): Promise<{
        count: number;
        tokens: number;
    }>;
    /** 最旧的 n 条（created 升序），压缩取批次用。 */
    oldest(n: number): Promise<MemoryEntry[]>;
}
