/** worker 的纯计算入口；不读取工作区，不接触宿主、会话或网络。 */
import { parentPort, workerData } from 'node:worker_threads'
import { assemblePrompt } from '../core/assemble.js'
import { evaluateWorldInfo } from '../core/worldbook.js'
import { applyRegexRules } from '../core/regex.js'
import { createTurnRandom } from '../core/macros.js'
import { estimateTokens } from '../core/tokenize.js'
import type { MacroContext } from '../core/types.js'

type SerializableMacros = Omit<MacroContext, 'random' | 'onUnknown'>
export interface ComputeJobs {
  assemble: {
    input: Omit<Parameters<typeof assemblePrompt>[0], 'estimateTokens' | 'macroCtx'> & { macroCtx: SerializableMacros; seed: number }
    output: ReturnType<typeof assemblePrompt>
  }
  wi: {
    input: Omit<Parameters<typeof evaluateWorldInfo>[0], 'estimateTokens' | 'random'> & { seed: number }
    output: ReturnType<typeof evaluateWorldInfo>
  }
  render: {
    input: { text: string; rules: Parameters<typeof applyRegexRules>[1]; macroCtx: SerializableMacros }
    output: ReturnType<typeof applyRegexRules>
  }
}

if (parentPort) {
  parentPort.postMessage({ ready: true })
  try {
    const { kind, input } = workerData
    let value: unknown
    if (kind === 'assemble') value = assemblePrompt({ ...input, estimateTokens, macroCtx: { ...input.macroCtx, random: createTurnRandom(input.seed) } })
    else if (kind === 'wi') value = evaluateWorldInfo({ ...input, estimateTokens, random: createTurnRandom(input.seed) })
    else if (kind === 'render') value = applyRegexRules(input.text, input.rules, { scope: 'output', timing: 'render' }, input.macroCtx)
    else throw new Error('未知提示词任务')
    if (JSON.stringify(value).length > 16 * 1024 * 1024) throw new Error('提示词计算结果超过 16 MiB 上限')
    parentPort.postMessage({ value })
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
