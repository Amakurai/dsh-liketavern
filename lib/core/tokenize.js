/**
 * 检索分词与 token 粗估。
 * 纯函数、零依赖、毫秒级；供记忆检索（BM25）与预算估算共用。
 */
// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------
/** CJK 表意文字区间：扩展 A（U+3400–U+4DBF）+ 基本区（U+4E00–U+9FFF）。 */
function isCjkCode(code) {
    return (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff);
}
/**
 * 需要 bigram 切分的文字：CJK 表意 + 假名（平/片假名 U+3040–U+30FF）+
 * 片假名音标扩展（U+31F0–U+31FF）+ 谚文音节（U+AC00–U+D7A3）。
 * 这些文字不靠空格分词，整段取词不可行，统一走滑窗 bigram。
 * 刻意与 isCjkCode 分开：token 估算（estimateTokens）的口径不随分词口径变。
 */
function isBigramScript(code) {
    return (isCjkCode(code) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0x31f0 && code <= 0x31ff) ||
        (code >= 0xac00 && code <= 0xd7a3));
}
/** 与 isBigramScript 一一对应的字符类；改一处必须同步改另一处。 */
const BIGRAM_CLASS = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3040-\\u30ff\\u31f0-\\u31ff\\uac00-\\ud7a3';
/**
 * 单个词字符：任意 Unicode 字母/数字，但要排除 bigram 文字。
 * `\p{L}` 也匹配表意字与假名，不排除的话「我喜欢apple派」会把「派」并进 `apple`。
 * 必须整体包在非捕获组里，否则后面的 `+` 只作用于字符类，前瞻只在词首生效一次。
 */
const WORD_CHAR = `(?:(?![${BIGRAM_CLASS}])[\\p{L}\\p{N}])`;
/**
 * 切分单元：一段连续 bigram 文字（CJK/假名/谚文），或一个 Unicode 词。
 * bigram 分支必须排在前面：`\p{L}` 覆盖表意字，词分支在前会把整段中文吞成一个词。
 * 词以字母/数字为主体，涵盖拉丁扩展、西里尔、希腊等（`café`、`Привет`），
 * 允许内部含 `_`、`-` 连写（如 `foo_bar`、`long-term`）。
 * 其余标点、空白一律跳过；不同文字混排时各自成段，边界处不跨语言组词。
 */
const SEGMENT_RE = new RegExp(`[${BIGRAM_CLASS}]+|${WORD_CHAR}+(?:[_-]${WORD_CHAR}+)*`, 'gu');
/**
 * 检索分词。
 * - bigram 文字段切滑窗 bigram：「我喜欢你」→ ['我喜', '喜欢', '欢你']；单字不成词（返回空）。
 *   假名、谚文同理：「안녕하세요」→ ['안녕', '녕하', '하세', '세요']。
 * - 其余词整词保留并转小写：`Café` → `café`，`Привет` → `привет`。
 */
export function tokenize(text) {
    const tokens = [];
    for (const match of text.matchAll(SEGMENT_RE)) {
        const seg = match[0];
        if (isBigramScript(seg.charCodeAt(0))) {
            for (let i = 0; i + 2 <= seg.length; i++) {
                tokens.push(seg.slice(i, i + 2));
            }
        }
        else {
            tokens.push(seg.toLowerCase());
        }
    }
    return tokens;
}
// ---------------------------------------------------------------------------
// token 估算
// ---------------------------------------------------------------------------
/**
 * 确定性粗估 token 数：CJK 字符每个计 1，其余字符累计后 ÷4 向上取整，两部分相加。
 * 只用于预算分配，不追求与具体模型 tokenizer 对齐；口径固定，不跟随分词的 bigram 文字范围。
 */
export function estimateTokens(text) {
    let cjk = 0;
    let other = 0;
    for (let i = 0; i < text.length; i++) {
        if (isCjkCode(text.charCodeAt(i)))
            cjk++;
        else
            other++;
    }
    return cjk + Math.ceil(other / 4);
}
/** 按估算 token 预算截断；超限时在末尾加省略标记。 */
export function clipToTokenBudget(text, budget) {
    const limit = Math.max(0, Math.floor(budget));
    const tokens = estimateTokens(text);
    if (tokens <= limit)
        return { text, truncated: false, tokens };
    if (limit === 0)
        return { text: '', truncated: true, tokens: 0 };
    const suffix = '…（已截断）';
    if (estimateTokens(suffix) > limit) {
        const fallback = estimateTokens('…') <= limit ? '…' : '';
        return { text: fallback, truncated: true, tokens: estimateTokens(fallback) };
    }
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = mid > 0 ? `${text.slice(0, mid)}\n${suffix}` : suffix;
        if (estimateTokens(candidate) <= limit)
            lo = mid;
        else
            hi = mid - 1;
    }
    const out = lo > 0 ? `${text.slice(0, lo)}\n${suffix}` : suffix;
    return { text: out, truncated: true, tokens: estimateTokens(out) };
}
