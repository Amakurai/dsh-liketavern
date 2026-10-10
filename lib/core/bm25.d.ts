/**
 * BM25 内存检索索引。
 * 纯内存态、零依赖；分词复用 tokenize 模块，CJK bigram 与 ASCII 词天然同权。
 * 文档占用数值槽位，倒排表按槽位存平行数组；查询用定长数组累加，不逐条查字符串表。
 * bigram 文字的每个字另有一套倒排表：在库里或在查询里单独成词的字，检索时作为半权重的单字词，
 * 补上 bigram 表达不了的单字名与单字名词。
 */
/**
 * 写入文档。keys 为写入时提炼的关键词：每次出现按 2 倍词频计入，但不计入文档长度，
 * 否则关键词多的条目（如合并了来源 keys 的摘要）会被长度归一化压低。
 * 只有一个字或一个词的 key 同时把它声明为词：此后无论它多常见、是否在功能词表里，都照常参与检索。
 * ts 供时间衰减使用。
 */
export interface Bm25Doc<D = unknown> {
    id: string;
    text: string;
    keys?: string[];
    /**
     * 写入之后补上的检索别名（同义说法、类别、名字）。与 keys 一样不计入文档长度，只有一个字或一个词的别名
     * 同样把它声明为词；但别名是推测出来的，词频按正文的 1 倍计，不按关键词的 2 倍。
     */
    aliases?: readonly string[];
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
    /**
     * 需要强调的查询片段：其中的词在主查询的 1 倍之外再加 weight 倍得分（片段里的词不必出现在主查询中）。
     * 分数与主查询同一量纲，命中越强加得越多，弱命中不会因此越过主查询的强命中。weight 非正或片段为空时忽略。
     */
    boost?: {
        query: string;
        weight: number;
    };
    /**
     * 本次查询里另外当作「已声明的词」的名字（角色名、用户人设名）：效果与写成单字 / 单词 key 相同，
     * 只对这一次查询有效。名字正好是功能字或由功能字组成时（七、月、日向）靠它检索。多于一个词的名字不声明。
     */
    names?: readonly string[];
    /**
     * 查询是使用者明确给出的检索词（记忆检索工具），不是从对话里拼出来的。这时只搜一个或几个孤立的字，
     * 就按字面匹配，功能字和假名也不例外；自动入模不设，免得一句「好。」带出所有含「好」的记忆。
     */
    explicit?: boolean;
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
    /** 单字倒排表：与 postings 分开，既不计入文档长度，也不参与写入去重的相似度。 */
    private readonly charPostings;
    /** 边界特征倒排表：只用它的文档数判断一个字是否独立成词。 */
    private readonly edgePostings;
    /** 字 → 以它开头 / 结尾的不同 bigram 数，即它右侧 / 左侧出现过多少种不同的字。 */
    private readonly followers;
    private readonly leaders;
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
    /** 把一篇文档的词频挂进倒排表，返回各词在倒排表里的下标。 */
    private attach;
    /** 从倒排表撤下一篇文档；field 指明被挪动的文档该更新哪一张下标表。 */
    private detach;
    /** 词典里新增或删掉一个 bigram 时，更新两个字各自的邻接种类数。 */
    private noteBigram;
    remove(id: string): void;
    clear(): void;
    /** Robertson 变体 IDF：ln(1 + (N - df + 0.5)/(df + 0.5))，保证为正。 */
    private idf;
    private edgeCount;
    /**
     * 一个字是否是能产的构词成分：左右两侧各至少见过两种不同的邻接——不同的相邻字，或者紧挨着标点、
     * 段首段尾的文档。「打」出现在「打听、打开」里，「面」出现在「后面、见面、表面」里。
     * 这只说明它常用来构词，不说明它单独是一个词，所以只作次级证据：
     * 「周末打算去爬山」不会因为一个「打」字带出「打听」「打开」所在的记忆。
     */
    private productive;
    /**
     * 查询里的这个字能否作为单字词，以及算哪一档证据。
     * - 被单字 key 或别名声明过的字、本次查询给出的名字始终是主证据（名字正好是功能字、或者极其常见时靠这个）。
     * - 明确给出的检索词只由孤立的单字组成时，一律按字面匹配。
     * - 假名与功能字不用：它们不携带话题信息。
     * - 整个查询只由孤立的单字组成（如直接搜「樱」）时，用户要的就是这个字，其余条件不再检查。
     * - 出现在超过半数文档里的字不用（库里不到二十条时不按这个比例排除）。
     * - 主证据：库里某处把它单独当词用过（「叫樱，」「凛的」），并且它在这段查询里至少一侧是边界。
     *   两边都要：库里的「礁门自开」不该让「几点开始」命中，问句里的「怎么走」也不该命中「走私」。
     * - 主证据的另一种情况：这段查询只有被虚词隔开的单个字（「豆在哪」「药呢」），除了这个字没有别的可查；
     *   这时库里的证据可以放宽——它在一处开头、在另一处收尾即可（「豆抓伤过」「流浪猫豆是」），不必被同时夹住。
     * - 其余情况，只要它在库里或查询里单独成词过、或者是能产的构词成分，就作次级证据，只给已有命中加分：
     *   「樱的药还够吗」里的「药」能把同时提到樱和取药的那条顶上去，却不会单独带出「火药」。
     */
    private charEvidence;
    /**
     * 查询里的这个词按几倍权重参与评分：功能词为 0（不参与），两个功能字组成的其它 bigram 减半，其余为 1。
     * 被 key 声明过的词始终按 1 倍。
     */
    private termScale;
    search(query: string, options?: Bm25SearchOptions): Array<Bm25Hit<D>>;
    /**
     * 写入去重用的相似度，取值 (0, 1]：IDF 加权的双向覆盖率。
     * 共有权重 = 查询与文档共有的不同词的权重和；分别除以查询全部词、文档全部词的权重和，取较小值。
     * 与 BM25 原始分不同，它不随库规模和正文长度漂移：正文相同得 1，只共享人名地名的不同事实远低于 1。
     *
     * 词的权重是「其余文档」里的 IDF：与某个候选文档比较时，先把它自己从文档数和文档频率里扣掉。
     * 不扣的话，库很小时候选文档的每个词都显得全库常见，权重被压低，同一对文本在小库与大库得分不同。
     * 未入库的查询词文档频率为 0，权重最大，所以新事实里的新词会明显拉低相似度。
     * 不做时间衰减；词频、keys 加权、单字词与功能词表都不参与，只看 bigram 与整词的有无。
     */
    similarity(query: string, options?: {
        topK?: number;
    }): Array<Bm25Hit<D>>;
}
