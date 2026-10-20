/**
 * A3 修复验证：needsTemplates 计入 templatePreprocessing，仅靠 [Preprocessing]/@@preprocessing
 * 触发的条目也会启动沙箱并执行预处理（正文与 keys 先展开再参与 WI 匹配）；
 * 真缺沙箱时由 assembleTemplatePlan 明确失败，不再静默跳过。
 */
import { expect, it } from 'vitest'
import { defaultPreset } from '../../src/core/assemble.js'
import { emptyTemplateScopes } from '../../src/core/template.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE, type ChatMessage } from '../../src/core/types.js'
import type { ComputeJobs } from '../../src/node/computeWorker.js'
import { isolated } from '../../src/node/isolated.js'
import { assembleTemplatePlan } from '../../src/node/templatePlan.js'
import { parseLorebook } from '../../src/state/lorebook.js'

function request(lore: Record<string, unknown>[], main = 'MAIN|', history: ChatMessage[] = [{ role: 'user', content: 'Bob says hi' }]): ComputeJobs['assemble']['input'] {
  const entries = parseLorebook({ entries: lore.map((entry, index) => ({ uid: index + 1, constant: true, ...entry })) }, { source: 'character', sourceRef: 'card' })
  const preset = defaultPreset()
  preset.entries = preset.entries.filter(entry => ['main', 'worldInfoBefore', 'chatHistory'].includes(entry.identifier))
  preset.entries.find(entry => entry.identifier === 'main')!.content = main
  return { preset, card: null, personaDescription: '', history, wi: null, memories: [], worldDeltas: [], regexRules: [],
    macroCtx: { char: 'Alice', user: 'Bob' }, seed: 42, budget: { maxTokens: 100000, reserveForOutput: 0 },
    templates: { variables: emptyTemplateScopes(), char: 'Alice', user: 'Bob', card: {}, entries, presets: preset.entries, history, now: 1000, seed: 42, phase: 'generate' },
    wiEvaluation: { entries, messages: history, settings: DEFAULT_WI_SETTINGS, timerState: EMPTY_TIMER_STATE,
      contextWindowTokens: 100000, reservedTokens: 0, seed: 42 } }
}

// 两种写法都要覆盖：注释标记 [Preprocessing] 与正文装饰器 @@preprocessing，且都没有 EJS。
const commentEntry = { comment: '[Preprocessing] pre', content: 'plain {{user}} text', keys: ['{{user}}'], constant: false, enabled: true }
const decoratorEntry = { comment: 'pre2', content: '@@preprocessing\nplain {{user}} text', keys: ['{{user}}'], constant: false, enabled: true }

it('A3：仅预处理触发的条目也会执行预处理并命中', async () => {
  for (const entry of [commentEntry, decoratorEntry]) {
    const withoutEjs = await isolated('assemble', request([entry]))
    const withEjs = await isolated('assemble', request([entry], '<% setvar("unrelated",1) %>MAIN|'))
    // 修复后两种输入一致：都启动沙箱、展开 key 为 Bob 并命中历史。
    expect(withoutEjs.evaluatedWi!.activated).toHaveLength(1)
    expect(withEjs.evaluatedWi!.activated).toHaveLength(1)
    expect(withoutEjs.evaluatedWi!.activated[0]!.matchedKeys).toContain('Bob')
  }
}, 30_000)

it('A3：确实没有沙箱时预处理条目明确失败', () => {
  for (const entry of [commentEntry, decoratorEntry]) {
    const input = request([entry])
    expect(() => assembleTemplatePlan(input, null)).toThrow(/需要模板预处理/)
  }
})
