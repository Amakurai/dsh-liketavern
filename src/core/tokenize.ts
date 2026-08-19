/**
 * 检索分词与 token 粗估。
 * 纯函数、零依赖、毫秒级；供记忆检索（BM25）与预算估算共用。
 */

// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------

/** CJK 表意文字区间：扩展 A（U+3400–U+4DBF）+ 基本区（U+4E00–U+9FFF）。 */
function isCjkCode(code: number): boolean {
  return (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
}

/**
 * 切分单元：一段连续 CJK 表意文字，或一个 ASCII 词。
 * ASCII 词以字母/数字为主体，允许内部含 `_`、`-` 连写（如 `foo_bar`、`long-term`）。
 * 其余标点、空白一律跳过；CJK 与拉丁混排时各自成段，边界处不跨语言组词。
 */
const SEGMENT_RE = /[\u3400-\u4dbf\u4e00-\u9fff]+|[a-zA-Z0-9]+(?:[_-][a-zA-Z0-9]+)*/gu

/**
 * 检索分词。
 * - CJK 段切滑窗 bigram：「我喜欢你」→ ['我喜', '喜欢', '欢你']；单字不成词（返回空）。
 * - ASCII 词整词保留并转小写。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(SEGMENT_RE)) {
    const seg = match[0]
    if (isCjkCode(seg.charCodeAt(0))) {
      for (let i = 0; i + 2 <= seg.length; i++) {
        tokens.push(seg.slice(i, i + 2))
      }
    } else {
      tokens.push(seg.toLowerCase())
    }
  }
  return tokens
}

// ---------------------------------------------------------------------------
// token 估算
// ---------------------------------------------------------------------------

/**
 * 确定性粗估 token 数：CJK 字符每个计 1，其余字符累计后 ÷4 向上取整，两部分相加。
 * 只用于预算分配，不追求与具体模型 tokenizer 对齐。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (isCjkCode(text.charCodeAt(i))) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/** 按估算 token 预算截断；超限时在末尾加省略标记。 */
export function clipToTokenBudget(text: string, budget: number): { text: string; truncated: boolean; tokens: number } {
  const limit = Math.max(0, Math.floor(budget))
  const tokens = estimateTokens(text)
  if (tokens <= limit) return { text, truncated: false, tokens }
  if (limit === 0) return { text: '', truncated: true, tokens: 0 }
  const suffix = '…（已截断）'
  if (estimateTokens(suffix) > limit) {
    const fallback = estimateTokens('…') <= limit ? '…' : ''
    return { text: fallback, truncated: true, tokens: estimateTokens(fallback) }
  }
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const candidate = mid > 0 ? `${text.slice(0, mid)}\n${suffix}` : suffix
    if (estimateTokens(candidate) <= limit) lo = mid
    else hi = mid - 1
  }
  const out = lo > 0 ? `${text.slice(0, lo)}\n${suffix}` : suffix
  return { text: out, truncated: true, tokens: estimateTokens(out) }
}
