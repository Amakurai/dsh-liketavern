/**
 * BM25 内存检索索引。
 * 纯内存态、零依赖；分词复用 tokenize 模块，CJK bigram 与 ASCII 词天然同权。
 * 文档占用数值槽位，倒排表按槽位存平行数组；查询用定长数组累加，不逐条查字符串表。
 * bigram 文字的每个字另有一套倒排表：在库里或在查询里单独成词的字，检索时作为半权重的单字词，
 * 补上 bigram 表达不了的单字名与单字名词。
 */
import { isSeparatorChar, isStopBigram, isStopChar, isStopWord, isWeakBigram } from './stopwords.js';
import { analyzeText, isBigramTerm, isKana, tokenize } from './tokenize.js';
// ---------------------------------------------------------------------------
// 公开契约
// ---------------------------------------------------------------------------
/** 关键词每出现一次折算的词频；正文出现一次计 1。 */
const KEY_WEIGHT = 2;
/** 单字词相对 bigram / 整词的权重：单字是弱证据，同一个字出现在不同的词里并不代表相关。 */
const CHAR_WEIGHT = 0.5;
/**
 * 由两个功能字组成、又不是确定的功能词的 bigram 在查询里的权重：多半是跨词的碎片（来一、里有），
 * 也可能是名字（日向、五月），分不清，所以不剔除、只减半。被 key 声明过的不减。
 */
const WEAK_TERM_WEIGHT = 0.5;
/** 出现在超过这一比例文档里的字没有区分度，不作为单字词（keys 声明和纯单字查询除外）。 */
const CHAR_MAX_DF_RATIO = 0.5;
/**
 * 上面的比例只在库够大时才有意义：刚开始的剧情只有三五条记忆，主角的名字出现在大半条里很正常。
 * 出现在不超过这么多条文档里的字不按比例排除。
 */
const CHAR_DF_FLOOR = 10;
/** 一个字在某一侧至少要有这么多种不同的邻接情况，才算能产的构词成分（只作次级证据）。 */
const CHAR_MIN_ACCESSORS = 2;
/**
 * 特征倒排表的键：字出现在一段文字的开头、结尾；字在某处单独成词；字在某处左侧、右侧是词的边界；
 * 字或词被只含它自己的 key 声明为词。只用到这些特征的文档数。
 */
const edgeInitial = (char) => `^${char}`;
const edgeFinal = (char) => `${char}$`;
const edgeWord = (char) => `~${char}`;
const edgeLeft = (char) => `<${char}`;
const edgeRight = (char) => `${char}>`;
const edgeDeclared = (token) => `=${token}`;
/** 一段只含一个字或一个词的文本所声明的那个词；多于一个词时不声明任何东西。 */
function declaredToken(tokens) {
    if (tokens.terms.length === 0 && tokens.chars.length === 1)
        return tokens.chars[0];
    return tokens.terms.length === 1 ? tokens.terms[0] : undefined;
}
/** 名字里的分隔符：空白与间隔号。「艾琳·冯」「日向 夏帆」的每一段各自声明。 */
const NAME_SEPARATORS = /[\s·・•‧]+/u;
/** 分数降序；并列按 id 字典序升序，保证结果确定可复现。 */
function byScoreThenId(a, b) {
    return b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export class Bm25Index {
    k1;
    b;
    docs = new Map();
    slots = [];
    lengths = [];
    freeSlots = [];
    postings = new Map();
    /** 单字倒排表：与 postings 分开，既不计入文档长度，也不参与写入去重的相似度。 */
    charPostings = new Map();
    /** 边界特征倒排表：只用它的文档数判断一个字是否独立成词。 */
    edgePostings = new Map();
    /** 字 → 以它开头 / 结尾的不同 bigram 数，即它右侧 / 左侧出现过多少种不同的字。 */
    followers = new Map();
    leaders = new Map();
    totalLength = 0;
    /**
     * search 复用的按槽位寻址的缓冲。每次查询结束只把用过的槽位清零，
     * 稀疏查询不必为全库分配并清零一遍。search 是同步的，不会重入。
     */
    scores = new Float64Array(0);
    norms = new Float64Array(0);
    seen = new Uint8Array(0);
    constructor(options) {
        this.k1 = options?.k1 ?? 1.5;
        this.b = options?.b ?? 0.75;
    }
    get size() {
        return this.docs.size;
    }
    has(id) {
        return this.docs.has(id);
    }
    /** 同 id 重复 add = 覆盖（先撤掉旧统计再计入新文档）。 */
    add(doc) {
        this.remove(doc.id);
        const tf = new Map();
        const charTf = new Map();
        const edges = new Map();
        const count = (tokens, weight) => {
            for (const term of tokens.terms)
                tf.set(term, (tf.get(term) ?? 0) + weight);
            for (const char of tokens.chars)
                charTf.set(char, (charTf.get(char) ?? 0) + weight);
            for (const char of tokens.initials)
                edges.set(edgeInitial(char), 1);
            for (const char of tokens.finals)
                edges.set(edgeFinal(char), 1);
            for (const char of tokens.words)
                edges.set(edgeWord(char), 1);
            for (const char of tokens.lefts)
                edges.set(edgeLeft(char), 1);
            for (const char of tokens.rights)
                edges.set(edgeRight(char), 1);
        };
        const body = analyzeText(doc.text);
        count(body, 1);
        const label = (text, weight) => {
            const tokens = analyzeText(text);
            count(tokens, weight);
            // 整个 key 只有一个字或一个词：写的人把它当作一个词
            const token = declaredToken(tokens);
            if (token !== undefined)
                edges.set(edgeDeclared(token), 1);
        };
        for (const key of doc.keys ?? [])
            label(key, KEY_WEIGHT);
        for (const alias of doc.aliases ?? [])
            label(alias, 1);
        const length = body.terms.length;
        const slot = this.freeSlots.pop() ?? this.slots.length;
        const entry = {
            id: doc.id, slot, length,
            positions: this.attach(this.postings, tf, slot),
            charPositions: this.attach(this.charPostings, charTf, slot),
            edgePositions: this.attach(this.edgePostings, edges, slot),
            ts: doc.ts, data: doc.data,
        };
        this.docs.set(doc.id, entry);
        this.slots[slot] = entry;
        this.lengths[slot] = length;
        this.totalLength += length;
    }
    /** 把一篇文档的词频挂进倒排表，返回各词在倒排表里的下标。 */
    attach(postings, frequencies, slot) {
        const positions = new Map();
        for (const [term, frequency] of frequencies) {
            let posting = postings.get(term);
            if (!posting) {
                posting = { slots: [], tfs: [] };
                postings.set(term, posting);
                if (postings === this.postings)
                    this.noteBigram(term, 1);
            }
            positions.set(term, posting.slots.length);
            posting.slots.push(slot);
            posting.tfs.push(frequency);
        }
        return positions;
    }
    /** 从倒排表撤下一篇文档；field 指明被挪动的文档该更新哪一张下标表。 */
    detach(postings, positions, field) {
        for (const [term, position] of positions) {
            const posting = postings.get(term);
            const last = posting.slots.length - 1;
            // 把末位文档挪到空出的位置再弹出末位；倒排表内顺序不影响评分。
            if (position !== last) {
                const moved = this.slots[posting.slots[last]];
                posting.slots[position] = moved.slot;
                posting.tfs[position] = posting.tfs[last];
                moved[field].set(term, position);
            }
            posting.slots.pop();
            posting.tfs.pop();
            if (last === 0) {
                postings.delete(term);
                if (postings === this.postings)
                    this.noteBigram(term, -1);
            }
        }
    }
    /** 词典里新增或删掉一个 bigram 时，更新两个字各自的邻接种类数。 */
    noteBigram(term, delta) {
        if (!isBigramTerm(term))
            return;
        const bump = (counts, char) => {
            const value = (counts.get(char) ?? 0) + delta;
            if (value > 0)
                counts.set(char, value);
            else
                counts.delete(char);
        };
        bump(this.followers, term[0]);
        bump(this.leaders, term[1]);
    }
    remove(id) {
        const entry = this.docs.get(id);
        if (!entry)
            return;
        this.docs.delete(id);
        this.totalLength -= entry.length;
        this.detach(this.postings, entry.positions, 'positions');
        this.detach(this.charPostings, entry.charPositions, 'charPositions');
        this.detach(this.edgePostings, entry.edgePositions, 'edgePositions');
        this.slots[entry.slot] = undefined;
        this.lengths[entry.slot] = 0;
        this.freeSlots.push(entry.slot);
    }
    clear() {
        this.docs.clear();
        this.postings.clear();
        this.charPostings.clear();
        this.edgePostings.clear();
        this.followers.clear();
        this.leaders.clear();
        this.slots.length = 0;
        this.lengths.length = 0;
        this.freeSlots.length = 0;
        this.totalLength = 0;
    }
    /** Robertson 变体 IDF：ln(1 + (N - df + 0.5)/(df + 0.5))，保证为正。 */
    idf(df) {
        const docCount = this.docs.size;
        return Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
    }
    edgeCount(key) {
        return this.edgePostings.get(key)?.slots.length ?? 0;
    }
    /**
     * 一个字是否是能产的构词成分：左右两侧各至少见过两种不同的邻接——不同的相邻字，或者紧挨着标点、
     * 段首段尾的文档。「打」出现在「打听、打开」里，「面」出现在「后面、见面、表面」里。
     * 这只说明它常用来构词，不说明它单独是一个词，所以只作次级证据：
     * 「周末打算去爬山」不会因为一个「打」字带出「打听」「打开」所在的记忆。
     */
    productive(char) {
        return (this.leaders.get(char) ?? 0) + this.edgeCount(edgeInitial(char)) >= CHAR_MIN_ACCESSORS
            && (this.followers.get(char) ?? 0) + this.edgeCount(edgeFinal(char)) >= CHAR_MIN_ACCESSORS;
    }
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
    charEvidence(char, query) {
        const posting = this.charPostings.get(char);
        if (!posting)
            return undefined;
        if (query.declared || (query.explicit && query.isolated))
            return 'primary';
        if (isKana(char) || isStopChar(char))
            return undefined;
        if (query.isolated)
            return 'primary';
        if (posting.slots.length > Math.max(CHAR_DF_FLOOR, CHAR_MAX_DF_RATIO * this.docs.size))
            return undefined;
        const wordInStore = this.edgePostings.has(edgeWord(char));
        if (wordInStore && query.edge)
            return 'primary';
        if (query.lone && this.edgePostings.has(edgeLeft(char)) && this.edgePostings.has(edgeRight(char)))
            return 'primary';
        return wordInStore || query.word || this.productive(char) ? 'secondary' : undefined;
    }
    /**
     * 查询里的这个词按几倍权重参与评分：功能词为 0（不参与），两个功能字组成的其它 bigram 减半，其余为 1。
     * 被 key 声明过的词始终按 1 倍。
     */
    termScale(term, declared) {
        if (declared)
            return 1;
        if (isStopBigram(term) || isStopWord(term))
            return 0;
        return isWeakBigram(term) ? WEAK_TERM_WEIGHT : 1;
    }
    search(query, options) {
        const topK = options?.topK ?? 10;
        const halfLifeMs = options?.halfLifeMs ?? 0;
        const now = options?.now ?? Date.now();
        const docCount = this.docs.size;
        if (docCount === 0 || topK <= 0)
            return [];
        // 查询去重：同一 term 重复出现不重复加分；强调片段里的词在主查询的 1 倍之外再加权。
        // 功能词（没有、什么、我们、the、is……）不参与：库不大时它们显得稀有，却只会带来偶然命中。
        // 两个功能字组成的其它 bigram 可能是名字，保留但减半。
        const boost = options?.boost && Number.isFinite(options.boost.weight) && options.boost.weight > 0 ? options.boost : undefined;
        const termWeights = new Map();
        const named = new Set();
        for (const name of options?.names ?? []) {
            for (const part of name.split(NAME_SEPARATORS)) {
                const token = declaredToken(analyzeText(part));
                // 人设名叫「我」、默认名是 you 之类的不算：声明之后每句话都会命中
                if (token === undefined || isStopWord(token) || isStopBigram(token) || (token.length === 1 && isSeparatorChar(token)))
                    continue;
                named.add(token);
            }
        }
        const declared = (token) => named.has(token) || this.edgePostings.has(edgeDeclared(token));
        const explicit = options?.explicit === true;
        /** 主证据的单字与只加分的单字；一个字在主查询或强调片段任一处算主证据，就整体按主证据计。 */
        const charWeights = new Map();
        const extraWeights = new Map();
        const weigh = (tokens, weight) => {
            // 功能 bigram 里的字属于那个功能词（「现在」的现、「知道」的知），不再单独作证据
            const functional = new Set();
            for (const term of new Set(tokens.terms)) {
                const scale = this.termScale(term, declared(term));
                if (scale > 0)
                    termWeights.set(term, (termWeights.get(term) ?? 0) + weight * scale);
                else if (isBigramTerm(term))
                    functional.add(term[0]).add(term[1]);
            }
            const isolated = tokens.terms.length === 0;
            const words = new Set(tokens.words);
            const sides = new Set(tokens.sides);
            for (const char of new Set(tokens.chars)) {
                // 被单字 key 声明过的字例外：「七点」是数词接量词，但「七」是名字
                const known = declared(char);
                if (functional.has(char) && !known)
                    continue;
                const evidence = this.charEvidence(char, { declared: known, explicit, isolated, lone: tokens.lone, word: words.has(char), edge: sides.has(char) });
                if (!evidence)
                    continue;
                const added = weight * CHAR_WEIGHT;
                if (evidence === 'primary' || charWeights.has(char)) {
                    // 在另一段文本里只算次级的那部分权重，一并转为主证据
                    charWeights.set(char, (charWeights.get(char) ?? 0) + (extraWeights.get(char) ?? 0) + added);
                    extraWeights.delete(char);
                }
                else {
                    extraWeights.set(char, (extraWeights.get(char) ?? 0) + added);
                }
            }
        };
        weigh(analyzeText(query), 1);
        if (boost)
            weigh(analyzeText(boost.query), boost.weight);
        if (termWeights.size === 0 && charWeights.size === 0)
            return [];
        if (this.seen.length < this.slots.length) {
            const capacity = Math.max(this.slots.length, this.seen.length * 2);
            this.scores = new Float64Array(capacity);
            this.norms = new Float64Array(capacity);
            this.seen = new Uint8Array(capacity);
        }
        const { k1, b, lengths, scores, norms, seen } = this;
        const avgdl = this.totalLength / docCount;
        /** 首次命中顺序；只为这些槽位产出结果，不扫全库。 */
        const touched = [];
        const hits = [];
        const accumulate = (posting, weight) => {
            const { slots, tfs } = posting;
            const df = slots.length;
            const idf = this.idf(df);
            for (let i = 0; i < df; i++) {
                const slot = slots[i];
                if (seen[slot] === 0) {
                    seen[slot] = 1;
                    touched.push(slot);
                    // 全部正文为空（只有 keys）时没有长度信息，归一化因子取 1。
                    norms[slot] = avgdl > 0 ? 1 - b + (b * lengths[slot]) / avgdl : 1;
                }
                const tf = tfs[i];
                scores[slot] = scores[slot] + weight * ((idf * tf * (k1 + 1)) / (tf + k1 * norms[slot]));
            }
        };
        try {
            for (const [term, weight] of termWeights) {
                const posting = this.postings.get(term);
                if (posting)
                    accumulate(posting, weight);
            }
            for (const [char, weight] of charWeights)
                accumulate(this.charPostings.get(char), weight);
            // 次级证据放在最后：只加到此时已经命中的文档上，不新增命中
            for (const [char, weight] of extraWeights) {
                const { slots, tfs } = this.charPostings.get(char);
                const idf = this.idf(slots.length);
                for (let i = 0; i < slots.length; i++) {
                    const slot = slots[i];
                    if (seen[slot] === 0)
                        continue;
                    const tf = tfs[i];
                    scores[slot] = scores[slot] + weight * ((idf * tf * (k1 + 1)) / (tf + k1 * norms[slot]));
                }
            }
            for (const slot of touched) {
                const score = scores[slot];
                if (score <= 0)
                    continue;
                const entry = this.slots[slot];
                let finalScore = score;
                // 时间衰减：×0.5^(elapsed/halfLife)；未来时间戳按因子 1 计（不放大）
                if (halfLifeMs > 0 && entry.ts !== undefined) {
                    const elapsed = now - entry.ts;
                    if (elapsed > 0) {
                        finalScore = score * Math.pow(0.5, elapsed / halfLifeMs);
                    }
                }
                const hit = { id: entry.id, score: finalScore };
                if (entry.data !== undefined)
                    hit.data = entry.data;
                hits.push(hit);
            }
        }
        finally {
            for (const slot of touched) {
                scores[slot] = 0;
                seen[slot] = 0;
            }
        }
        hits.sort(byScoreThenId);
        return hits.slice(0, topK);
    }
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
    similarity(query, options) {
        const topK = options?.topK ?? 10;
        const docCount = this.docs.size;
        if (docCount === 0 || topK <= 0)
            return [];
        const terms = [...new Set(tokenize(query))];
        if (terms.length === 0)
            return [];
        const others = docCount - 1;
        const weight = (df) => Math.log(1 + (others - df + 0.5) / (df + 0.5));
        /** 共有词的权重和：候选文档含有这些词，文档频率各减 1。 */
        const shared = new Float64Array(this.slots.length);
        /** 同一批共有词按「候选文档不含它」计的权重和，用来从 absent 里扣掉。 */
        const sharedAsAbsent = new Float64Array(this.slots.length);
        const touched = [];
        /** 查询全部词按「候选文档不含它」计的权重和。 */
        let absent = 0;
        for (const term of terms) {
            const posting = this.postings.get(term);
            const df = posting?.slots.length ?? 0;
            // 每篇文档都有的词不存在「候选不含它」的情况，两边同记 0。
            const asAbsent = df > others ? 0 : weight(df);
            absent += asAbsent;
            if (!posting)
                continue;
            const asShared = weight(df - 1);
            for (const slot of posting.slots) {
                // 权重恒为正，0 即尚未命中
                if (shared[slot] === 0)
                    touched.push(slot);
                shared[slot] = shared[slot] + asShared;
                sharedAsAbsent[slot] = sharedAsAbsent[slot] + asAbsent;
            }
        }
        const hits = [];
        for (const slot of touched) {
            const entry = this.slots[slot];
            const overlap = shared[slot];
            const queryWeight = overlap + Math.max(0, absent - sharedAsAbsent[slot]);
            let docWeight = 0;
            for (const term of entry.positions.keys())
                docWeight += weight(this.postings.get(term).slots.length - 1);
            // 求和顺序不同会差几个末位；舍入到 1e-12，使相同正文恰好得 1。
            const score = Math.min(1, Math.round(Math.min(overlap / queryWeight, overlap / docWeight) * 1e12) / 1e12);
            if (score <= 0)
                continue;
            const hit = { id: entry.id, score };
            if (entry.data !== undefined)
                hit.data = entry.data;
            hits.push(hit);
        }
        hits.sort(byScoreThenId);
        return hits.slice(0, topK);
    }
}
