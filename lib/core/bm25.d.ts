/**
 * BM25 内存检索索引。
 * 纯内存态、零依赖；分词复用 tokenize 模块，CJK bigram 与 ASCII 词天然同权。
 * 文档占用数值槽位，倒排表按槽位存平行数组；查询用定长数组累加，不逐条查字符串表。
 */
/**
 * 写入文档。keys 为写入时提炼的关键词：每次出现按 2 倍词频计入，但不计入文档长度，
 * 否则关键词多的条目（如合并了来源 keys 的摘要）会被长度归一化压低。ts 供时间衰减使用。
 */
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
    private readonly slots;
    private readonly lengths;
    private readonly freeSlots;
    private readonly postings;
    private totalLength;
    /**
     * search 复用的按槽位寻址的缓冲。每次查询结束只把用过的槽位清零，
     * 稀疏查询不必为全库分配并清零一遍。search 是同步的，不会重入。
     */
    private scores;
    private norms;
    private seen;
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
    /** Robertson 变体 IDF：ln(1 + (N - df + 0.5)/(df + 0.5))，保证为正。 */
    private idf;
    search(query: string, options?: Bm25SearchOptions): Array<Bm25Hit<D>>;
    /**
     * 写入去重用的相似度，取值 (0, 1]：IDF 加权的双向覆盖率。
     * 共有权重 = 查询与文档共有的不同词的权重和；分别除以查询全部词、文档全部词的权重和，取较小值。
     * 与 BM25 原始分不同，它不随库规模和正文长度漂移：正文相同得 1，只共享人名地名的不同事实远低于 1。
     *
     * 词的权重是「其余文档」里的 IDF：与某个候选文档比较时，先把它自己从文档数和文档频率里扣掉。
     * 不扣的话，库很小时候选文档的每个词都显得全库常见，权重被压低，同一对文本在小库与大库得分不同。
     * 未入库的查询词文档频率为 0，权重最大，所以新事实里的新词会明显拉低相似度。
     * 不做时间衰减；词频与 keys 加权不参与，只看词的有无。
     */
    similarity(query: string, options?: {
        topK?: number;
    }): Array<Bm25Hit<D>>;
}
