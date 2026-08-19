/**
 * BM25 内存检索索引。
 * 纯内存态、零依赖；分词复用 tokenize 模块，CJK bigram 与 ASCII 词天然同权。
 */
/** 写入文档。keys 为写入时提炼的关键词（其 token 权重 ×2）；ts 供时间衰减使用。 */
export interface Bm25Doc<D = unknown> {
    id: string;
    text: string;
    keys?: string[];
    /** 毫秒时间戳；仅在 search 指定 halfLifeMs 时参与衰减。 */
    ts?: number;
    data?: D;
}
export interface Bm25SearchOptions {
    /** 返回条数上限，默认 10。 */
    topK?: number;
    /** 半衰期（毫秒）；> 0 且文档带 ts 时启用时间衰减。 */
    halfLifeMs?: number;
    /** 「现在」的毫秒时间戳，默认 Date.now()；测试注入以保证确定性。 */
    now?: number;
}
export interface Bm25Hit<D = unknown> {
    id: string;
    score: number;
    data?: D;
}
export declare class Bm25Index<D = unknown> {
    private readonly k1;
    private readonly b;
    private readonly docs;
    /** term → 文档频率（包含该 term 的文档数）。 */
    private readonly df;
    private totalLength;
    constructor(options?: {
        k1?: number;
        b?: number;
    });
    get size(): number;
    has(id: string): boolean;
    /** 同 id 重复 add = 覆盖（先撤掉旧统计再计入新文档）。 */
    add(doc: Bm25Doc<D>): void;
    remove(id: string): void;
    clear(): void;
    search(query: string, options?: Bm25SearchOptions): Array<Bm25Hit<D>>;
}
