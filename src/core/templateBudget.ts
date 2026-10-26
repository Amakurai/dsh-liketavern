/** 模板容量与执行预算：按冻结输入的实际 JSON 规模分配资源，不把正常长历史当作脚本扩张；所有预算仍有进程保护上限。 */
const MIB = 1024 * 1024

/** 隔离传输容纳历史、当前上下文和旧重放；重放持久化另受工作区文档的 64 MiB 边界约束。 */
export const TEMPLATE_INPUT_MAX_CHARS = 128 * MIB
export const TEMPLATE_OUTPUT_MAX_CHARS = 256 * MIB
export const TEMPLATE_REPLAY_MAX_CHARS = 64 * MIB
const JSON_MAX_DEPTH = 128
const JSON_MAX_VISITS = 8 * MIB

/**
 * 精确计算 JSON.stringify 的 UTF-16 长度，遇限立即失败，不构造完整 JSON 或转义副本。
 * 输入来自纯数据边界；支持 Date，拒绝 BigInt/循环和自定义 toJSON，避免主线程执行外来代码。
 */
export function measureTemplateJson(value: unknown, limitChars = TEMPLATE_INPUT_MAX_CHARS): number {
  if (!Number.isSafeInteger(limitChars) || limitChars < 0) throw new Error('提示词 JSON 计量上限无效')
  let chars = 0, visits = 0
  const active = new Set<object>()
  const add = (length: number) => {
    chars += length
    if (chars > limitChars) throw new Error(`提示词计算数据超过资源容量（${Math.ceil(limitChars / MIB)} MiB）`)
  }
  const string = (text: string) => {
    // 先计未转义长度；超大的单个字符串无需再完整扫描一遍。
    add(text.length + 2)
    for (let at = 0; at < text.length; at++) {
      const code = text.charCodeAt(at)
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) add(1)
      else if (code < 32) add(5)
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(at + 1)
        if (next >= 0xdc00 && next <= 0xdfff) at++
        else add(5)
      } else if (code >= 0xdc00 && code <= 0xdfff) add(5)
    }
  }
  const omitted = (item: unknown) => item === undefined || typeof item === 'function' || typeof item === 'symbol'
  const visit = (item: unknown, depth: number): void => {
    if (++visits > JSON_MAX_VISITS || depth > JSON_MAX_DEPTH) throw new Error('提示词计算数据结构超过资源容量')
    if (item === null) { add(4); return }
    if (typeof item === 'string') { string(item); return }
    if (typeof item === 'boolean') { add(item ? 4 : 5); return }
    if (typeof item === 'number') { add(Number.isFinite(item) ? String(item).length : 4); return }
    if (typeof item === 'bigint') throw new Error('提示词计算数据不能包含 BigInt')
    if (omitted(item)) return
    if (typeof item !== 'object') throw new Error('提示词计算数据不是 JSON')
    if (item instanceof Date) {
      const time = Date.prototype.getTime.call(item)
      if (Number.isFinite(time)) string(Date.prototype.toISOString.call(item))
      else add(4)
      return
    }
    if (typeof (item as { toJSON?: unknown }).toJSON === 'function') throw new Error('提示词计算数据不能包含自定义 toJSON')
    if (active.has(item)) throw new Error('提示词计算数据不能包含循环引用')
    active.add(item)
    add(2)
    if (Array.isArray(item)) {
      for (let at = 0; at < item.length; at++) {
        if (at) add(1)
        if (omitted(item[at])) add(4)
        else visit(item[at], depth + 1)
      }
    } else {
      let first = true
      for (const key of Object.keys(item)) {
        const child: unknown = (item as Record<string, unknown>)[key]
        if (omitted(child)) continue
        if (!first) add(1)
        first = false
        string(key); add(1); visit(child, depth + 1)
      }
    }
    active.delete(item)
  }
  visit(value, 0)
  return chars
}

export interface TemplateExecutionBudget {
  inputChars: number
  outputChars: number
  workerMemoryMb: number
  quickJsMemoryBytes: number
  computingMs: number
  sandboxMs: number
}

/**
 * template：第三方 EJS 在 QuickJS 中解释执行，lodash/zod 类工作常比浏览器 V8 慢一个数量级以上，
 * 小输入也要容下整轮预加载、条件与渲染。display：output/render 展示正则只在 V8 中运行，
 * 保留短期限，灾难回溯能尽快释放槽位，不拖住整屏气泡。
 */
export type TemplateBudgetProfile = 'template' | 'display'
const BASE_MS: Readonly<Record<TemplateBudgetProfile, { computing: number; sandbox: number }>> = {
  template: { computing: 5000, sandbox: 4000 },
  display: { computing: 1000, sandbox: 750 },
}

/** 小输入取档位基础预算；长输入的复制、解析和重放获得线性余量，脚本不能自行延长截止时间。 */
export function templateExecutionBudget(inputChars: number, timeoutOverride?: number, profile: TemplateBudgetProfile = 'template'): TemplateExecutionBudget {
  if (!Number.isSafeInteger(inputChars) || inputChars < 0 || inputChars > TEMPLATE_INPUT_MAX_CHARS) throw new Error('提示词计算输入超过资源容量')
  if (timeoutOverride !== undefined && (!Number.isFinite(timeoutOverride) || timeoutOverride <= 0)) throw new Error('提示词计算超时预算无效')
  const extraMiB = Math.max(0, (inputChars - MIB / 4) / MIB)
  const base = BASE_MS[profile]
  return {
    inputChars,
    outputChars: Math.min(TEMPLATE_OUTPUT_MAX_CHARS, Math.max(16 * MIB, inputChars * 2 + 16 * MIB)),
    workerMemoryMb: Math.min(1536, 128 + Math.ceil(extraMiB * 12)),
    quickJsMemoryBytes: Math.min(512, 32 + Math.ceil(extraMiB * 8)) * MIB,
    computingMs: timeoutOverride ?? Math.min(30_000, Math.ceil(base.computing + extraMiB * 4000)),
    sandboxMs: Math.min(15_000, Math.ceil(base.sandbox + extraMiB * 3000)),
  }
}
