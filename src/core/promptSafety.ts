/**
 * 入模控制标记检测。
 *
 * 预设、模板与卡片可以把分词器控制标记（`<|im_start|>`、`<｜Assistant｜>`、`[INST]` 等）
 * 当作普通文字塞进提示词。对把 `<｜…｜>` 当特殊词元处理的供应商，这等于伪造轮次边界或
 * 续写前缀；对不这么处理的供应商，它只是无意义的噪声，却也让同一份预设在不同通道上
 * 行为分叉。两种结果都不能接受，因此在**冻结布局**与**请求投影**两处都拒绝。
 *
 * 只认真正的控制标记形状；HTML、Markdown 表格与数学里的 `<`、`>`、`|` 不受影响。
 */

/** 一处控制标记命中。index 是 UTF-16 字符位置，仅用于报错定位。 */
export interface ControlTokenFinding {
  token: string
  index: number
}

/**
 * 受检标记。刻意不收录 `<s>` / `</s>`：它们是合法 HTML 删除线，误伤代价高于收益。
 * 每条都用 `u` 模式单独构造，避免共享 lastIndex。
 */
const CONTROL_TOKEN_SOURCES: readonly string[] = [
  '<｜[^<>｜\\n]{0,40}｜>', // DeepSeek / ChatML 全角变体：<｜Assistant｜>、<｜end▁of_sentence｜>
  '<\\|[A-Za-z0-9_.\\-]{1,32}\\|>', // ChatML / Llama3：<|im_start|>、<|eot_id|>、<|endoftext|>
  '<<SYS>>', // Llama2 系统段
  '\\[/?INST\\]', // Llama2 轮次
  '<\\/?start_of_turn>', // Gemma
  '<end_of_turn>', // Gemma（与上一条重叠时只报一次，靠 token 去重）
]

/** 便宜的预筛：没有候选开头就不跑正则，热路径上绝大多数条目在第一轮就被排除。 */
export function mayContainControlTokens(text: string): boolean {
  return text.includes('<|') || text.includes('<｜') || text.includes('<<SYS>>')
    || text.includes('[INST]') || text.includes('[/INST]')
    || text.includes('start_of_turn') || text.includes('end_of_turn')
}

/** 找出文本里的控制标记，按出现位置排序；limit 防止恶意长文本制造无界结果。 */
export function findControlTokens(text: string, limit = 4): ControlTokenFinding[] {
  if (!mayContainControlTokens(text)) return []
  const findings: ControlTokenFinding[] = []
  const seen = new Set<string>()
  for (const source of CONTROL_TOKEN_SOURCES) {
    const pattern = new RegExp(source, 'gu')
    for (const match of text.matchAll(pattern)) {
      if (seen.has(match[0])) continue
      seen.add(match[0])
      findings.push({ token: match[0], index: match.index ?? 0 })
      if (findings.length >= limit) return findings.sort((left, right) => left.index - right.index)
    }
  }
  return findings.sort((left, right) => left.index - right.index)
}

/** 文本里是否含有控制标记；调用方只关心真假时用它，不构造数组。 */
export function hasControlToken(text: string): boolean {
  return findControlTokens(text, 1).length > 0
}

/**
 * 命中即失败。错误文案要能直接指导用户改哪一条：写明位置、标记原文与字符偏移。
 * 这里不提供"静默剥离"选项——改写用户正文后若不出现在轨迹里，比拒绝更难排查。
 */
export function assertNoControlTokens(text: string, where: string): void {
  const finding = findControlTokens(text, 1)[0]
  if (!finding) return
  throw new Error(`${where} 含模型控制标记 ${JSON.stringify(finding.token)}（字符位置 ${finding.index}）：`
    + '它能在提示词里伪造轮次边界或续写前缀。请删除该标记后重试。')
}
