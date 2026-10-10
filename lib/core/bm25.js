/**
 * BM25 内存检索索引。
 * 纯内存态、零依赖；分词复用 tokenize 模块，CJK bigram 与 ASCII 词天然同权。
 * 文档占用数值槽位，倒排表按槽位存平行数组；查询用定长数组累加，不逐条查字符串表。
 */
import { tokenize } from './tokenize.js';
// ---------------------------------------------------------------------------
// 公开契约
// ---------------------------------------------------------------------------
/** 关键词每出现一次折算的词频；正文出现一次计 1。 */
const KEY_WEIGHT = 2;
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
        let length = 0;
        for (const term of tokenize(doc.text)) {
            tf.set(term, (tf.get(term) ?? 0) + 1);
            length++;
        }
        if (doc.keys) {
            for (const term of tokenize(doc.keys.join(' ')))
                tf.set(term, (tf.get(term) ?? 0) + KEY_WEIGHT);
        }
        const slot = this.freeSlots.pop() ?? this.slots.length;
        const positions = new Map();
        for (const [term, weight] of tf) {
            let posting = this.postings.get(term);
            if (!posting) {
                posting = { slots: [], tfs: [] };
                this.postings.set(term, posting);
            }
            positions.set(term, posting.slots.length);
            posting.slots.push(slot);
            posting.tfs.push(weight);
        }
        const entry = { id: doc.id, slot, length, positions, ts: doc.ts, data: doc.data };
        this.docs.set(doc.id, entry);
        this.slots[slot] = entry;
        this.lengths[slot] = length;
        this.totalLength += length;
    }
    remove(id) {
        const entry = this.docs.get(id);
        if (!entry)
            return;
        this.docs.delete(id);
        this.totalLength -= entry.length;
        for (const [term, position] of entry.positions) {
            const posting = this.postings.get(term);
            const last = posting.slots.length - 1;
            // 把末位文档挪到空出的位置再弹出末位；倒排表内顺序不影响评分。
            if (position !== last) {
                const moved = posting.slots[last];
                posting.slots[position] = moved;
                posting.tfs[position] = posting.tfs[last];
                this.slots[moved].positions.set(term, position);
            }
            posting.slots.pop();
            posting.tfs.pop();
            if (last === 0)
                this.postings.delete(term);
        }
        this.slots[entry.slot] = undefined;
        this.lengths[entry.slot] = 0;
        this.freeSlots.push(entry.slot);
    }
    clear() {
        this.docs.clear();
        this.postings.clear();
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
    search(query, options) {
        const topK = options?.topK ?? 10;
        const halfLifeMs = options?.halfLifeMs ?? 0;
        const now = options?.now ?? Date.now();
        const docCount = this.docs.size;
        if (docCount === 0 || topK <= 0)
            return [];
        // 查询去重：同一 term 重复出现不重复加分
        const terms = [...new Set(tokenize(query))];
        if (terms.length === 0)
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
        try {
            for (const term of terms) {
                const posting = this.postings.get(term);
                if (!posting)
                    continue;
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
                    scores[slot] = scores[slot] + (idf * tf * (k1 + 1)) / (tf + k1 * norms[slot]);
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
     * 不做时间衰减；词频与 keys 加权不参与，只看词的有无。
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
