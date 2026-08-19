/**
 * BM25 内存检索索引。
 * 纯内存态、零依赖；分词复用 tokenize 模块，CJK bigram 与 ASCII 词天然同权。
 */
import { tokenize } from './tokenize.js';
export class Bm25Index {
    k1;
    b;
    docs = new Map();
    /** term → 文档频率（包含该 term 的文档数）。 */
    df = new Map();
    totalLength = 0;
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
        const count = (term) => {
            tf.set(term, (tf.get(term) ?? 0) + 1);
            length++;
        };
        for (const term of tokenize(doc.text))
            count(term);
        // keys 文本重复一遍计入词频，等价于关键词权重 ×2
        if (doc.keys) {
            for (const term of tokenize(doc.keys.join(' ')))
                count(term);
        }
        const entry = { length, tf, ts: doc.ts, data: doc.data };
        this.docs.set(doc.id, entry);
        this.totalLength += length;
        for (const term of tf.keys()) {
            this.df.set(term, (this.df.get(term) ?? 0) + 1);
        }
    }
    remove(id) {
        const entry = this.docs.get(id);
        if (!entry)
            return;
        this.docs.delete(id);
        this.totalLength -= entry.length;
        for (const term of entry.tf.keys()) {
            const n = this.df.get(term);
            if (n === undefined)
                continue;
            if (n <= 1)
                this.df.delete(term);
            else
                this.df.set(term, n - 1);
        }
    }
    clear() {
        this.docs.clear();
        this.df.clear();
        this.totalLength = 0;
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
        const avgdl = this.totalLength / docCount;
        const scores = new Map();
        for (const term of terms) {
            const df = this.df.get(term);
            if (df === undefined)
                continue;
            // Robertson 变体 IDF：ln(1 + (N - df + 0.5)/(df + 0.5))，保证非负
            const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
            for (const [id, entry] of this.docs) {
                const tf = entry.tf.get(term);
                if (tf === undefined)
                    continue;
                const norm = 1 - this.b + (this.b * entry.length) / avgdl;
                const score = (idf * tf * (this.k1 + 1)) / (tf + this.k1 * norm);
                scores.set(id, (scores.get(id) ?? 0) + score);
            }
        }
        const hits = [];
        for (const [id, score] of scores) {
            if (score <= 0)
                continue;
            const entry = this.docs.get(id);
            let finalScore = score;
            // 时间衰减：×0.5^(elapsed/halfLife)；未来时间戳按因子 1 计（不放大）
            if (halfLifeMs > 0 && entry.ts !== undefined) {
                const elapsed = now - entry.ts;
                if (elapsed > 0) {
                    finalScore = score * Math.pow(0.5, elapsed / halfLifeMs);
                }
            }
            const hit = { id, score: finalScore };
            if (entry.data !== undefined)
                hit.data = entry.data;
            hits.push(hit);
        }
        // 分数降序；并列按 id 字典序升序，保证结果确定可复现
        hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return hits.slice(0, topK);
    }
}
