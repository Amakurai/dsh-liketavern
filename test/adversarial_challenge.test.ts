/**
 * 对抗性挑战与压力测试套件：
 * 1. renameWithRetry 在 Windows 模拟/真实文件锁争用、重试上限与平台退化边界
 * 2. saveHelperState 写入验证守卫在已提交与真正故障、损坏内容下的判定
 * 3. 'dsh-tavern' 步骤通知过滤与 prompt plan 载体绑定隔离
 * 4. mergeTavernCallConfig 在 reasoningEffort 未定义时的字段清理与不可变性
 */
import { mkdtemp, rm, writeFile, readFile, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renameWithRetry } from '../src/state/rename.js'
import { saveHelperState, loadHelperState, HELPER_STATE_PATH, type HelperState } from '../src/state/helper.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { isHostInjectedUserMessage } from '../src/core/dshPrompt.js'
import { mergeTavernCallConfig } from '../src/core/callConfig.js'
import { DEFAULT_SAMPLING } from '../src/core/types.js'
import { attachPresetPlanMessage, createPresetPlanMessage, type PresetRequestPlan } from '../src/node/presetRequestProjection.js'
import type { GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'
import { projectTavernAdapterRequest } from '../src/index.js'

// -------------------------------------------------------------
// Fault injection hoisting for renameWithRetry
// -------------------------------------------------------------
const fault = vi.hoisted(() => ({
  enabled: false,
  platform: 'win32',
  attempts: 0,
  maxFailures: 0,
  error: Object.assign(new Error('EBUSY: resource locked'), { code: 'EBUSY' } as any),
  customErrors: [] as any[],
}))

vi.mock('node:process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:process')>()
  return {
    ...actual,
    get platform() {
      return fault.enabled ? fault.platform : actual.platform
    },
  }
})

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fault.enabled) {
        fault.attempts++
        if (fault.customErrors.length > 0) {
          const nextErr = fault.customErrors.shift()
          if (nextErr !== undefined) throw nextErr
        } else if (fault.attempts <= fault.maxFailures) {
          throw fault.error
        }
      }
      return actual.rename(...args)
    },
  }
})

// -------------------------------------------------------------
// 1. renameWithRetry 对抗性压力测试
// -------------------------------------------------------------
describe('Adversarial: renameWithRetry 锁争用与故障边界', () => {
  let root: string

  beforeEach(async () => {
    fault.enabled = false
    fault.platform = 'win32'
    fault.attempts = 0
    fault.maxFailures = 0
    fault.customErrors = []
    fault.error = Object.assign(new Error('EBUSY: resource locked'), { code: 'EBUSY' })
    root = await mkdtemp(join(tmpdir(), 'adv-rename-'))
  })

  afterEach(async () => {
    fault.enabled = false
    await rm(root, { recursive: true, force: true })
  })

  it('严格验证 [10, 30, 60]ms 延迟阶梯：第 1 次、第 2 次、第 3 次重试成功', async () => {
    const from = join(root, 'source.txt')
    const to = join(root, 'target.txt')
    await writeFile(from, 'src-content')
    await writeFile(to, 'old-target')

    // 启用故障注入：失败 3 次，第 4 次成功
    fault.enabled = true
    fault.platform = 'win32'
    fault.maxFailures = 3
    fault.error = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })

    const start = Date.now()
    await renameWithRetry(from, to)
    const elapsed = Date.now() - start

    expect(fault.attempts).toBe(4)
    // 10 + 30 + 60 = 100ms
    expect(elapsed).toBeGreaterThanOrEqual(80)
    expect(await readFile(to, 'utf8')).toBe('src-content')
  })

  it('超过 3 次重试（第 4 次失败）时立即抛出原始错误，不得死循环或吞错', async () => {
    const from = join(root, 'source.txt')
    const to = join(root, 'target.txt')
    await writeFile(from, 'src-content')
    await writeFile(to, 'old-target')

    fault.enabled = true
    fault.platform = 'win32'
    fault.maxFailures = 10 // 持续失败
    fault.error = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })

    const start = Date.now()
    await expect(renameWithRetry(from, to)).rejects.toThrow('EPERM: operation not permitted')
    const elapsed = Date.now() - start

    // 尝试次数应为 4 次（尝试 0, 1, 2 发生重试，第 4 次无 delay 抛出）
    expect(fault.attempts).toBe(4)
    expect(elapsed).toBeGreaterThanOrEqual(80)
  })

  it('非 win32 平台（linux/darwin）遇 EPERM/EBUSY 立即上报，不等待也不重试', async () => {
    const from = join(root, 'source.txt')
    const to = join(root, 'target.txt')
    await writeFile(from, 'src-content')
    await writeFile(to, 'old-target')

    fault.enabled = true
    fault.platform = 'linux'
    fault.maxFailures = 5
    fault.error = Object.assign(new Error('EBUSY: device or resource busy'), { code: 'EBUSY' })

    await expect(renameWithRetry(from, to)).rejects.toThrow('EBUSY: device or resource busy')
    expect(fault.attempts).toBe(1)
  })

  it('对非占用错误代码（ENOENT, EEXIST, ENOSPC, EIO, EINVAL）不进行任何重试，尝试次数必须为 1', async () => {
    const nonRetryCodes = ['ENOENT', 'EEXIST', 'ENOSPC', 'EIO', 'EINVAL', 'EISDIR']

    for (const code of nonRetryCodes) {
      const from = join(root, `source-${code}.txt`)
      const to = join(root, `target-${code}.txt`)
      await writeFile(from, 'content')

      fault.enabled = true
      fault.platform = 'win32'
      fault.attempts = 0
      fault.maxFailures = 5
      fault.error = Object.assign(new Error(`${code} error`), { code })

      await expect(renameWithRetry(from, to)).rejects.toThrow(`${code} error`)
      expect(fault.attempts).toBe(1)
    }
  })

  it('对畸形或非标准错误对象（无 code、code 为非 string、null 等）安全抛出且不重试', async () => {
    const weirdErrors = [
      new Error('no code property'),
      { code: 12345, message: 'number code' },
      { code: null, message: 'null code' },
      { code: undefined, message: 'undefined code' },
      'primitive string error',
    ]

    for (const err of weirdErrors) {
      const from = join(root, 'from.txt')
      const to = join(root, 'to.txt')
      await writeFile(from, 'content')

      fault.enabled = true
      fault.platform = 'win32'
      fault.attempts = 0
      fault.customErrors = [err]

      await expect(renameWithRetry(from, to)).rejects.toSatisfy(e => e === err || (e as any)?.message === (err as any)?.message)
      expect(fault.attempts).toBe(1)
    }
  })

  it('并发重试风暴：20 个并发 renameWithRetry 即使发生并发冲突也保持最终一致', async () => {
    fault.enabled = false
    const concurrentCount = 20
    const tasks: Promise<void>[] = []

    for (let i = 0; i < concurrentCount; i++) {
      const from = join(root, `src-${i}.txt`)
      const to = join(root, `dst-${i}.txt`)
      await writeFile(from, `payload-${i}`)
      tasks.push(renameWithRetry(from, to))
    }

    await Promise.all(tasks)

    for (let i = 0; i < concurrentCount; i++) {
      const to = join(root, `dst-${i}.txt`)
      expect(await readFile(to, 'utf8')).toBe(`payload-${i}`)
    }
  })

  it('Windows 真实文件句柄独占锁定压力测试：持锁释放后成功自愈', async () => {
    if (process.platform !== 'win32') return
    fault.enabled = false

    const from = join(root, 'real-src.txt')
    const to = join(root, 'real-target.txt')
    await writeFile(from, 'new-real-data')
    await writeFile(to, 'old-real-data')

    // 在 Windows 上以 r+ 打开目标文件会阻碍跨文件原子替换
    const handle = await open(to, 'r+')
    try {
      // 延迟 20ms 后关闭文件句柄
      setTimeout(async () => {
        await handle.close().catch(() => {})
      }, 20)

      await renameWithRetry(from, to)
      expect(await readFile(to, 'utf8')).toBe('new-real-data')
    } finally {
      await handle.close().catch(() => {})
    }
  })
})

// -------------------------------------------------------------
// 2. saveHelperState 写入验证守卫对抗性测试
// -------------------------------------------------------------
describe('Adversarial: saveHelperState 写入验证守卫', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'adv-helper-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('写操作假失败（底层已实际落盘新内容）：守卫吞掉假异常并成功完成', async () => {
    const fs = new WorkspaceFs(root, null).withFloor('sess#t1')
    const testState: HelperState = {
      scopes: { '["chat",""]': { gold: 100 } },
      extras: {},
    }
    const raw = JSON.stringify({ version: 1, scopes: testState.scopes })

    const writeSpy = vi.spyOn(fs, 'writeText').mockImplementation(async (path, content) => {
      // 模拟先写入磁盘成功，但后续后置步骤（如目录同步/通知）抛出 EPERM
      await new WorkspaceFs(root, null).writeText(path, content)
      throw new Error('EPERM: directory flush lock')
    })

    await expect(saveHelperState(fs, testState)).resolves.toBeUndefined()
    expect(await fs.readText(HELPER_STATE_PATH)).toBe(raw)
    writeSpy.mockRestore()
  })

  it('写操作真失败（磁盘未写入/仍为旧内容）：守卫严密抛出原异常', async () => {
    const fs = new WorkspaceFs(root, null).withFloor('sess#t1')
    const oldState: HelperState = {
      scopes: { '["chat",""]': { gold: 50 } },
      extras: {},
    }
    await saveHelperState(fs, oldState)
    const oldRaw = await fs.readText(HELPER_STATE_PATH)

    const newState: HelperState = {
      scopes: { '["chat",""]': { gold: 999 } },
      extras: {},
    }

    const writeSpy = vi.spyOn(fs, 'writeText').mockRejectedValueOnce(new Error('EIO: disk controller crash'))

    await expect(saveHelperState(fs, newState)).rejects.toThrow('EIO: disk controller crash')
    // 磁盘必须仍是旧数据
    expect(await fs.readText(HELPER_STATE_PATH)).toBe(oldRaw)
    writeSpy.mockRestore()
  })

  it('写操作异常且磁盘文件被截断或损坏：守卫拒绝吞错并如实报警', async () => {
    const fs = new WorkspaceFs(root, null).withFloor('sess#t1')
    const newState: HelperState = {
      scopes: { '["chat",""]': { inventory: ['sword', 'shield'] } },
      extras: {},
    }

    const writeSpy = vi.spyOn(fs, 'writeText').mockImplementation(async (path) => {
      // 模拟写入了一半的截断文件
      await new WorkspaceFs(root, null).writeText(path, '{"version":1,"scopes":{ truncated')
      throw new Error('ENOSPC: no space left on device')
    })

    await expect(saveHelperState(fs, newState)).rejects.toThrow('ENOSPC: no space left on device')
    expect(await fs.readText(HELPER_STATE_PATH)).toBe('{"version":1,"scopes":{ truncated')
    writeSpy.mockRestore()
  })

  it('磁盘内容已与目标一致时（无变更）：跳过 writeText 调用（零 I/O 优化）', async () => {
    const fs = new WorkspaceFs(root, null).withFloor('sess#t1')
    const testState: HelperState = {
      scopes: { '["chat",""]': { level: 5 } },
      extras: {},
    }
    await saveHelperState(fs, testState)

    const writeSpy = vi.spyOn(fs, 'writeText')
    await saveHelperState(fs, testState)

    expect(writeSpy).not.toHaveBeenCalled()
    writeSpy.mockRestore()
  })

  it('未绑定楼层时直接在写入前抛错拒绝，不触碰文件系统', async () => {
    const fs = new WorkspaceFs(root, null) // currentFloor 为 null
    const testState: HelperState = { scopes: {}, extras: {} }
    await expect(saveHelperState(fs, testState)).rejects.toThrow('酒馆助手剧情写入必须绑定楼层')
  })

  it('单表超限（> 1MB）触发“酒馆助手数据超过预算”；多表合计超限（> 4MB）触发“酒馆助手状态文件超限”', async () => {
    const fs = new WorkspaceFs(root, null).withFloor('sess#t1')

    // 1. 单表超限
    const hugeString1MB = 'a'.repeat(1024 * 1024 + 10)
    const singleOverState: HelperState = {
      scopes: { '["chat",""]': { payload: hugeString1MB } },
      extras: {},
    }
    await expect(saveHelperState(fs, singleOverState)).rejects.toThrow('酒馆助手数据超过预算')

    // 2. 读取超过 4MB 的状态文件时在反序列化前同步拒绝
    const hugeFilePath = join(root, HELPER_STATE_PATH)
    await new WorkspaceFs(root, null).writeText(HELPER_STATE_PATH, '{"version":1,"scopes":{}}' + ' '.repeat(4 * 1024 * 1024))
    await expect(loadHelperState(fs)).rejects.toThrow('酒馆助手状态文件超限')
  })
})

// -------------------------------------------------------------
// 3. 'dsh-tavern' 消息过滤与 Prompt Plan 绑定隔离对抗性测试
// -------------------------------------------------------------
describe('Adversarial: 宿主与插件注入消息过滤 & 计划载体绑定隔离', () => {
  it('isHostInjectedUserMessage 严密区分各种角色和来源 kind', () => {
    // 6 个受保护注入来源必须全部被判定为 true
    const validKinds = [
      'runtime-context',
      'agent-instructions',
      'model-selection',
      'compact-checkpoint',
      'tavern-prompt-plan',
      'dsh-tavern',
    ]

    for (const kind of validKinds) {
      expect(isHostInjectedUserMessage({ role: 'user', source: { kind } })).toBe(true)
      // role 为 undefined 沿用 user
      expect(isHostInjectedUserMessage({ source: { kind } })).toBe(true)
    }

    // 非 user 角色的任何注入消息必须返回 false
    for (const kind of validKinds) {
      expect(isHostInjectedUserMessage({ role: 'assistant', source: { kind } })).toBe(false)
      expect(isHostInjectedUserMessage({ role: 'system', source: { kind } })).toBe(false)
    }

    // 普通用户消息必须返回 false
    expect(isHostInjectedUserMessage({ role: 'user', source: { kind: 'user' } })).toBe(false)
    expect(isHostInjectedUserMessage({ role: 'user', source: { kind: 'custom-plugin' } })).toBe(false)
    expect(isHostInjectedUserMessage({ role: 'user', source: {} })).toBe(false)
    expect(isHostInjectedUserMessage({ role: 'user' })).toBe(false)
  })

  it('对抗验证：Agent 决策流中 step notice 绝不能被绑定为 prompt plan 载体', () => {
    const dummyPlan: PresetRequestPlan = {
      version: 1,
      sessionId: 'sess-1',
      turn: 1,
      layout: { version: 1, history: [], entries: [] },
      standingText: 'standing',
      contextText: 'turnContext',
    }

    // 场景 A: 队列中包含真实用户发言 + 'dsh-tavern' 步骤通知
    const userMsg: UserMessage = {
      role: 'user',
      content: [{ type: 'text', text: '你好角色' }],
      source: { kind: 'user' },
    } as any
    const stepNoticeMsg: UserMessage = {
      role: 'user',
      content: [{ type: 'text', text: '工具执行成功' }],
      source: { kind: 'dsh-tavern' },
    } as any

    const messages = [userMsg, stepNoticeMsg]

    // 模拟 src/agent.ts:194-201 载体选择算法
    let targetIndex = -1
    for (let index = messages.length - 1; index >= 0; index--) {
      if (!isHostInjectedUserMessage(messages[index]!)) {
        targetIndex = index
        break
      }
    }

    // targetIndex 必须命中 userMsg (index 0)，跳过 stepNoticeMsg (index 1)
    expect(targetIndex).toBe(0)

    const transformedMessages = targetIndex >= 0
      ? messages.map((m, idx) => idx === targetIndex ? attachPresetPlanMessage(m, dummyPlan) : m)
      : [createPresetPlanMessage(dummyPlan), ...messages]

    // 验证：真实用户消息携带了 tavernPromptPlan
    expect((transformedMessages[0]!.source as any).tavernPromptPlan).toBeDefined()
    expect((transformedMessages[0]!.source as any).tavernPromptPlan.sessionId).toBe('sess-1')

    // 验证：stepNoticeMsg 绝对没有 tavernPromptPlan
    expect((transformedMessages[1]!.source as any).tavernPromptPlan).toBeUndefined()
    expect(transformedMessages[1]!.source.kind).toBe('dsh-tavern')
  })

  it('对抗验证：全注入消息流中孤立 step notice 会触发独立 plan 消息前置，而不是污染 notice', () => {
    const dummyPlan: PresetRequestPlan = {
      version: 1,
      sessionId: 'sess-2',
      turn: 2,
      layout: { version: 1, history: [], entries: [] },
      standingText: 'standing',
      contextText: 'turnContext',
    }

    const stepNoticeMsg1: UserMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'Notice 1' }],
      source: { kind: 'dsh-tavern' },
    } as any
    const stepNoticeMsg2: UserMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'Notice 2' }],
      source: { kind: 'dsh-tavern' },
    } as any

    const messages = [stepNoticeMsg1, stepNoticeMsg2]

    let targetIndex = -1
    for (let index = messages.length - 1; index >= 0; index--) {
      if (!isHostInjectedUserMessage(messages[index]!)) {
        targetIndex = index
        break
      }
    }

    // 全为注入消息，targetIndex 为 -1
    expect(targetIndex).toBe(-1)

    const transformedMessages = targetIndex >= 0
      ? messages.map((m, idx) => idx === targetIndex ? attachPresetPlanMessage(m, dummyPlan) : m)
      : [createPresetPlanMessage(dummyPlan), ...messages]

    expect(transformedMessages.length).toBe(3)
    // 首条是独立的 tavern-prompt-plan 载体
    expect(transformedMessages[0]!.source.kind).toBe('tavern-prompt-plan')
    // 后续的两条 step notice 完好无损且无 tavernPromptPlan
    expect(transformedMessages[1]!.source.kind).toBe('dsh-tavern')
    expect((transformedMessages[1]!.source as any).tavernPromptPlan).toBeUndefined()
    expect(transformedMessages[2]!.source.kind).toBe('dsh-tavern')
    expect((transformedMessages[2]!.source as any).tavernPromptPlan).toBeUndefined()
  })
})

// -------------------------------------------------------------
// 4. mergeTavernCallConfig reasoningEffort 对抗性测试
// -------------------------------------------------------------
describe('Adversarial: mergeTavernCallConfig 参数清洗与不可变性', () => {
  it('当 reasoningEffort 为 undefined 时，结果对象中绝无 reasoningEffort 键，且原配置对象不受修改', () => {
    const originalConfig = {
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
      customOption: 'preserved',
    }

    // 冻结输入对象以确保不可变性不被破坏
    Object.freeze(originalConfig)

    const result = mergeTavernCallConfig(originalConfig, DEFAULT_SAMPLING, undefined)

    // 检查属性不存在性
    expect('reasoningEffort' in result).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(result, 'reasoningEffort')).toBe(false)
    expect(Object.keys(result)).not.toContain('reasoningEffort')
    expect(result.reasoningEffort).toBeUndefined()

    // 检查其余字段完整性
    expect(result.provider).toBe('deepseek-official')
    expect(result.model).toBe('deepseek-chat')
    expect((result as any).customOption).toBe('preserved')
    expect(result.temperature).toBe(DEFAULT_SAMPLING.temperature)

    // 原对象保留
    expect(originalConfig.reasoningEffort).toBe('high')
  })

  it('当 reasoningEffort 为有效档位（low/high/max/off）时如实写入', () => {
    const levels = ['off', 'low', 'high', 'max'] as const
    for (const level of levels) {
      const config = { provider: 'p', model: 'm', reasoningEffort: 'off' }
      const result = mergeTavernCallConfig(config, DEFAULT_SAMPLING, level)
      expect(result.reasoningEffort).toBe(level)
      expect('reasoningEffort' in result).toBe(true)
    }
  })

  it('连续多次合并清洗状态流：高档位 -> 未定义 -> 低档位 -> 未定义', () => {
    let cfg: any = { provider: 'test', model: 'm1' }

    // 1. 设置为 high
    cfg = mergeTavernCallConfig(cfg, DEFAULT_SAMPLING, 'high')
    expect(cfg.reasoningEffort).toBe('high')

    // 2. 清除为 undefined
    cfg = mergeTavernCallConfig(cfg, DEFAULT_SAMPLING, undefined)
    expect('reasoningEffort' in cfg).toBe(false)

    // 3. 设置为 low
    cfg = mergeTavernCallConfig(cfg, DEFAULT_SAMPLING, 'low')
    expect(cfg.reasoningEffort).toBe('low')

    // 4. 再次清除为 undefined
    cfg = mergeTavernCallConfig(cfg, DEFAULT_SAMPLING, undefined)
    expect('reasoningEffort' in cfg).toBe(false)
  })
})

// -------------------------------------------------------------
// 5. onTurnStart 幂等性与高并发竞态压力测试
// -------------------------------------------------------------
describe('Adversarial: onTurnStart 幂等性与高并发竞态压力测试', () => {
  let root: string
  let state: TavernState

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'adv-turn-start-'))
    state = new TavernState(
      {
        root,
        characters: join(root, 'characters'),
        lorebooks: join(root, 'library/lorebooks'),
        presets: join(root, 'library/presets'),
        personas: join(root, 'personas'),
        regexDir: join(root, 'regex'),
        sessions: join(root, 'sessions'),
      },
      () => resolveConfig({}),
    )
    await state.init()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('50 个并发 onTurnStart 同时触发，全部幂等成功且仅开启一次底层楼层', async () => {
    const { cardId } = await state.createCharacter('高并发测试卡')
    const session = Session.create(SessionId('concurrent-sess'))
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    session.append('turn/start', { turn: 1 })

    // 50 个 Promise 并发执行
    const concurrencyCount = 50
    const promises = Array.from({ length: concurrencyCount }, () =>
      onTurnStart(state, session.id, 1, session)
    )

    const results = await Promise.all(promises)
    expect(results).toHaveLength(concurrencyCount)
    expect(results.every((r) => r === undefined)).toBe(true)

    // 验证状态
    expect(state.openFloors.get(session.id)?.floor).toBe('concurrent-sess#t1')
    expect(state.currentTurns.get(session.id)).toBe(1)

    // 楼层能够正常写入和收口
    const binding = (await state.loadBinding(session.id))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)
    await ws.fs.withFloor('concurrent-sess#t1').writeText('content.txt', '并发安全写入')

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)

    expect(state.openFloors.has(session.id)).toBe(false)
    expect((await ws.wal.validateFloor('concurrent-sess#t1')).committed).toBe(true)
    expect(await ws.fs.readText('content.txt')).toBe('并发安全写入')
  })

  it('连续 100 次突发串行调用 onTurnStart，保持严格幂等且不发生锁饥饿或状态漂移', async () => {
    const { cardId } = await state.createCharacter('突发串行测试卡')
    const session = Session.create(SessionId('burst-sess'))
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    session.append('turn/start', { turn: 1 })

    for (let i = 0; i < 100; i++) {
      await expect(onTurnStart(state, session.id, 1, session)).resolves.toBeUndefined()
      expect(state.openFloors.get(session.id)?.floor).toBe('burst-sess#t1')
      expect(state.currentTurns.get(session.id)).toBe(1)
    }

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)
    expect(state.openFloors.has(session.id)).toBe(false)
  })

  it('竞态模拟：turn/start 事件队列与 10 个并发提示词组装程序互斥同步', async () => {
    const { cardId } = await state.createCharacter('竞态角色')
    const session = Session.create(SessionId('race-sess'))
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    session.append('turn/start', { turn: 1 })

    // 模拟 src/index.ts 的事件排队：稍有延迟地进入 enqueueSessionTask
    const eventTask = state.enqueueSessionTask(session.id, async () => {
      await new Promise((r) => setTimeout(r, 10))
      await onTurnStart(state, session.id, 1, session)
    })

    // 模拟 10 个并发的 agent.ts 提示词组装逻辑
    const simulateAgentAssemble = async () => {
      await state.waitForSessionTasks(session.id)
      const turn = state.currentTurns.get(session.id)
      if (turn !== undefined && !state.openFloors.has(session.id)) {
        await state.enqueueSessionTask(session.id, () => onTurnStart(state, session.id, turn, session))
      }
      expect(state.openFloors.has(session.id)).toBe(true)
      expect(state.openFloors.get(session.id)?.floor).toBe('race-sess#t1')
    }

    await Promise.all([
      eventTask,
      ...Array.from({ length: 10 }, () => simulateAgentAssemble()),
    ])

    expect(state.openFloors.get(session.id)?.floor).toBe('race-sess#t1')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)
    expect(state.openFloors.has(session.id)).toBe(false)
  })

  it('上一楼层未结束时，尝试开启新楼层（turn 2）立即被拒绝，并清除当前轮次状态以防止脏写', async () => {
    const { cardId } = await state.createCharacter('未完成拦截卡')
    const session = Session.create(SessionId('conflict-sess'))
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    session.append('turn/start', { turn: 1 })
    await onTurnStart(state, session.id, 1, session)

    // 在 floor 1 未提交时直接尝试 turn 2
    session.append('turn/start', { turn: 2 })
    await expect(onTurnStart(state, session.id, 2, session)).rejects.toThrow(
      '上一楼层尚未完成，请先重试结束事件恢复提交，再开启新轮次',
    )

    // 确认 currentTurns 与 currentSteps 被清除以阻止新轮继续进行
    expect(state.currentTurns.has(session.id)).toBe(false)
    expect(state.currentSteps.has(session.id)).toBe(false)
    // 但原 floor 1 依然被保留在 openFloors 中供恢复
    expect(state.openFloors.get(session.id)?.floor).toBe('conflict-sess#t1')
  })

  it('跨轮次连续递进：轮次 1 正常提交后，轮次 2 并发开层依然稳固', async () => {
    const { cardId } = await state.createCharacter('跨轮递进角色')
    const session = Session.create(SessionId('multi-turn-sess'))
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    // Turn 1
    session.append('turn/start', { turn: 1 })
    await onTurnStart(state, session.id, 1, session)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)
    expect(state.openFloors.has(session.id)).toBe(false)

    // Turn 2 并发开层
    session.append('turn/start', { turn: 2 })
    await Promise.all([
      onTurnStart(state, session.id, 2, session),
      onTurnStart(state, session.id, 2, session),
      onTurnStart(state, session.id, 2, session),
    ])
    expect(state.openFloors.get(session.id)?.floor).toBe('multi-turn-sess#t2')

    // Turn 2 正常收尾
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)
    expect(state.openFloors.has(session.id)).toBe(false)
  })
})

// -------------------------------------------------------------
// 6. 未提交楼层崩溃自愈与 WAL 防护矩阵
// -------------------------------------------------------------
describe('Adversarial: 未提交楼层崩溃自愈与 WAL 防护矩阵', () => {
  let root: string
  let state: TavernState

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'adv-crash-recovery-'))
    state = new TavernState(
      {
        root,
        characters: join(root, 'characters'),
        lorebooks: join(root, 'library/lorebooks'),
        presets: join(root, 'library/presets'),
        personas: join(root, 'personas'),
        regexDir: join(root, 'regex'),
        sessions: join(root, 'sessions'),
      },
      () => resolveConfig({}),
    )
    await state.init()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('普通卡崩溃重启：turn 1 未提交楼层在重启后通过 onTurnStart 自动自愈并复用', async () => {
    const { cardId } = await state.createCharacter('普通卡崩溃卡')
    const session = Session.create(SessionId('crash-rp-sess'))
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadBinding(session.id))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)

    session.append('turn/start', { turn: 1 })
    await onTurnStart(state, session.id, 1, session)
    await ws.fs.withFloor('crash-rp-sess#t1').writeText('part1.txt', '第一阶段数据')

    // 崩溃模拟：抹除内存中的运行时
    state.openFloors.delete(session.id)
    state.currentTurns.delete(session.id)

    // 重启调用 onTurnStart
    await expect(onTurnStart(state, session.id, 1, session)).resolves.toBeUndefined()
    expect(state.openFloors.get(session.id)?.floor).toBe('crash-rp-sess#t1')

    // 恢复后追加写入
    await ws.fs.withFloor('crash-rp-sess#t1').writeText('part2.txt', '第二阶段数据')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)

    expect((await ws.wal.validateFloor('crash-rp-sess#t1')).committed).toBe(true)
    expect(await ws.fs.readText('part1.txt')).toBe('第一阶段数据')
    expect(await ws.fs.readText('part2.txt')).toBe('第二阶段数据')
  })

  it('进程崩溃后重启：turn/end 直接到达（未先收到 turn/start），finishTurn 能够自动校验并收口未提交楼层', async () => {
    const { cardId } = await state.createCharacter('直接结束恢复角色')
    const session = Session.create(SessionId('direct-end-sess'))
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadBinding(session.id))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)

    session.append('turn/start', { turn: 1 })
    await onTurnStart(state, session.id, 1, session)
    await ws.fs.withFloor('direct-end-sess#t1').writeText('state.json', '{"alive":true}')

    // 模拟断电崩溃：彻底抹去内存中的状态
    state.openFloors.delete(session.id)
    state.currentTurns.delete(session.id)
    state.currentSteps.delete(session.id)
    expect(state.openFloors.has(session.id)).toBe(false)

    // 宿主重启后直接重放/补发 turn/end
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(onTurnEnd(state, session.id, session)).resolves.toBeUndefined()

    // 验证楼层已成功自愈并提交
    const floorMeta = await ws.wal.validateFloor('direct-end-sess#t1')
    expect(floorMeta.committed).toBe(true)
    expect(await ws.fs.readText('state.json')).toBe('{"alive":true}')
  })

  it('若楼层已在之前成功提交，重启后宿主误发重复的 turn/start，拒绝重复开始并保护 WAL', async () => {
    const { cardId } = await state.createCharacter('重复开层防御角色')
    const session = Session.create(SessionId('dup-open-sess'))
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadBinding(session.id))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)

    // 正常执行第一轮并完整提交
    session.append('turn/start', { turn: 1 })
    await onTurnStart(state, session.id, 1, session)
    await ws.fs.withFloor('dup-open-sess#t1').writeText('final.txt', '已落盘终态')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)

    expect((await ws.wal.validateFloor('dup-open-sess#t1')).committed).toBe(true)

    // 模拟重启：内存清空
    state.openFloors.delete(session.id)
    state.currentTurns.delete(session.id)

    // 宿主错误地重发 turn 1 的 turn/start
    await expect(onTurnStart(state, session.id, 1, session)).rejects.toThrow(
      '已存在，拒绝重复开始；追加写入请显式重新打开，重新生成请先回滚',
    )

    // 确保已有内容和提交状态未被损坏
    expect((await ws.wal.validateFloor('dup-open-sess#t1')).committed).toBe(true)
    expect(await ws.fs.readText('final.txt')).toBe('已落盘终态')
  })

  it('连续多次崩溃与自愈恢复循环：多轮次交错崩溃恢复不破坏剧情 WAL 完整性', async () => {
    const { cardId } = await state.createCharacter('多轮崩溃角色')
    const session = Session.create(SessionId('multi-crash-sess'))
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadBinding(session.id))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)

    // 第 1 轮：崩溃后通过 onTurnStart 恢复并提交
    session.append('turn/start', { turn: 1 })
    await onTurnStart(state, session.id, 1, session)
    await ws.fs.withFloor('multi-crash-sess#t1').writeText('round1.txt', 'r1-initial')
    // 崩溃 1
    state.openFloors.delete(session.id)
    // 恢复
    await onTurnStart(state, session.id, 1, session)
    await ws.fs.withFloor('multi-crash-sess#t1').writeText('round1.txt', 'r1-recovered')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)

    // 第 2 轮：崩溃后通过 onTurnEnd 直接恢复并提交
    session.append('turn/start', { turn: 2 })
    await onTurnStart(state, session.id, 2, session)
    await ws.fs.withFloor('multi-crash-sess#t2').writeText('round2.txt', 'r2-data')
    // 崩溃 2
    state.openFloors.delete(session.id)
    // 直接收到 turn/end 恢复
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)

    // 验证两轮 WAL 均已提交，且最终正文均完整
    expect((await ws.wal.validateFloor('multi-crash-sess#t1')).committed).toBe(true)
    expect((await ws.wal.validateFloor('multi-crash-sess#t2')).committed).toBe(true)
    expect(await ws.fs.readText('round1.txt')).toBe('r1-recovered')
    expect(await ws.fs.readText('round2.txt')).toBe('r2-data')
  })

  it('无任何开层与无未提交楼层时直接调用 onTurnEnd 安全清理每轮临时状态', async () => {
    const { cardId } = await state.createCharacter('无开层会话')
    const session = Session.create(SessionId('no-floor-sess'))
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date().toISOString(),
    })

    // 设置临时变量
    state.currentTurns.set(session.id, 1)
    state.currentSteps.set(session.id, 1)
    state.pendingInputs.set(session.id, ['test'])

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(onTurnEnd(state, session.id, session)).resolves.toBeUndefined()

    expect(state.currentTurns.has(session.id)).toBe(false)
    expect(state.currentSteps.has(session.id)).toBe(false)
    expect(state.pendingInputs.has(session.id)).toBe(false)
  })
})

// -------------------------------------------------------------
// 7. 会话销毁生命周期与内存零泄漏压力测试
// -------------------------------------------------------------
describe('Adversarial: 会话销毁生命周期与内存零泄漏压力测试', () => {
  let root: string
  let state: TavernState

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'adv-disposal-'))
    state = new TavernState(
      {
        root,
        characters: join(root, 'characters'),
        lorebooks: join(root, 'library/lorebooks'),
        presets: join(root, 'library/presets'),
        personas: join(root, 'personas'),
        regexDir: join(root, 'regex'),
        sessions: join(root, 'sessions'),
      },
      () => resolveConfig({}),
    )
    await state.init()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('大规模并发销毁：40 个会话同时注入全量内存状态，批量触发销毁后磁盘与所有 Map 完全清空', async () => {
    const ctx = new Context()
    const { cardId } = await state.createCharacter('销毁压力角色')

    // 注册销毁监听器（模拟 src/index.ts）
    const disposeSession = async (sessionId: string) => {
      await state.clearBinding(sessionId).catch(() => {})
    }
    ctx.on('session/disposed', (session: Session) => { void disposeSession(session.id) })
    ctx.on('api-session/removed' as any, (sessionId: string) => { void disposeSession(sessionId) })

    // 创建 40 个会话并填充全部 16 个状态 Map
    const sessionIds: string[] = []
    for (let i = 0; i < 40; i++) {
      const sessId = `stress-sess-${i}`
      sessionIds.push(sessId)
      await state.saveBinding({
        sessionId: sessId,
        cardId,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: null,
        greetingIndex: 0,
        createdAt: new Date().toISOString(),
      })

      state.openFloors.set(sessId, { cardId, floor: `${sessId}#t1` })
      state.currentTurns.set(sessId, 1)
      state.currentSteps.set(sessId, 1)
      state.stepNoticeMarks.set(sessId, '1:1')
      state.turnPlans.set(sessId, { turn: 1, cardId, result: {} as any })
      state.pendingTurnPlans.set(sessId, { turn: 1, cardId, floor: `${sessId}#t1`, publish: async () => ({} as any) })
      state.pendingInputs.set(sessId, ['input'])
      state.pendingTemplateInputs.set(sessId, [{ id: `m-${i}`, text: 'text' }])
      state.triggerLogs.set(sessId, { at: 'now', lines: [] })
      state.requestDiagnostics.set(sessId, { text: 'diag', truncated: false })
      state.sessionTaskTails.set(sessId, Promise.resolve())
      state.sessionCommitTails.set(sessId, Promise.resolve())
      state.helperTurnClosures.set(sessId, { seq: 1 })
      state.helperTurnClosures.set(`${sessId}#t1`, { seq: 1 })
      state.helperTurnClosures.set(`${sessId}#t2`, { seq: 2 })
      state.bindingAdoptions.set(sessId, Promise.resolve())
      state.bindingAdoptionRetries.set(sessId, async () => {})
      state.pinStanding(sessId, 'chat', `fp-${i}\0v1\0${cardId}`, `standing-${i}`)
    }

    // 建立第 41 个对照组会话，不进行销毁
    const controlId = 'control-sess'
    await state.saveBinding({
      sessionId: controlId,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date().toISOString(),
    })
    state.openFloors.set(controlId, { cardId, floor: `${controlId}#t1` })
    state.currentTurns.set(controlId, 1)
    state.pinStanding(controlId, 'chat', `fp-ctrl\0v1\0${cardId}`, 'standing-ctrl')
    state.helperTurnClosures.set(`${controlId}#t1`, { seq: 1 })

    // 前 20 个通过 session/disposed 触发，后 20 个通过 api-session/removed 触发
    for (let i = 0; i < 20; i++) {
      const sess = Session.create(SessionId(sessionIds[i]!))
      ctx.emit('session/disposed', sess)
    }
    for (let i = 20; i < 40; i++) {
      ctx.emit('api-session/removed' as any, sessionIds[i]!)
    }

    // 等待所有 40 个会话在磁盘上被清理完毕
    await vi.waitFor(async () => {
      for (const id of sessionIds) {
        expect(await state.loadBinding(id)).toBeNull()
      }
    }, { timeout: 5000 })

    // 严格断言所有 40 个会话在全部 16 个内存表中毫无残留
    for (const id of sessionIds) {
      expect(state.openFloors.has(id)).toBe(false)
      expect(state.currentTurns.has(id)).toBe(false)
      expect(state.currentSteps.has(id)).toBe(false)
      expect(state.stepNoticeMarks.has(id)).toBe(false)
      expect(state.turnPlans.has(id)).toBe(false)
      expect(state.pendingTurnPlans.has(id)).toBe(false)
      expect(state.pendingInputs.has(id)).toBe(false)
      expect(state.pendingTemplateInputs.has(id)).toBe(false)
      expect(state.triggerLogs.has(id)).toBe(false)
      expect(state.requestDiagnostics.has(id)).toBe(false)
      expect(state.sessionTaskTails.has(id)).toBe(false)
      expect(state.sessionCommitTails.has(id)).toBe(false)
      expect(state.helperTurnClosures.has(id)).toBe(false)
      expect(state.helperTurnClosures.has(`${id}#t1`)).toBe(false)
      expect(state.helperTurnClosures.has(`${id}#t2`)).toBe(false)
      expect(state.bindingAdoptions.has(id)).toBe(false)
      expect(state.bindingAdoptionRetries.has(id)).toBe(false)
      expect(state.peekStanding(id, 'chat', cardId)).toBeUndefined()
    }

    // 断言对照组会话完好无损
    expect(await state.loadBinding(controlId)).not.toBeNull()
    expect(state.openFloors.has(controlId)).toBe(true)
    expect(state.currentTurns.get(controlId)).toBe(1)
    expect(state.peekStanding(controlId, 'chat', cardId)).toBe('standing-ctrl')
    expect(state.helperTurnClosures.has(`${controlId}#t1`)).toBe(true)

    await ctx.fiber.dispose()
  })

  it('正在执行异步后台任务时并发调用 clearBinding，任务正常完成且会话被彻底清理', async () => {
    const { cardId } = await state.createCharacter('在途任务角色')
    const sessionId = 'in-flight-task-sess'
    await state.saveBinding({
      sessionId,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date().toISOString(),
    })

    let taskExecuted = false
    const task = state.enqueueSessionTask(sessionId, async () => {
      await new Promise((r) => setTimeout(r, 20))
      taskExecuted = true
      return 'done'
    })

    // 任务进行中直接调用 clearBinding
    await state.clearBinding(sessionId)

    // 任务顺利返回而不抛未捕获异常
    await expect(task).resolves.toBe('done')
    expect(taskExecuted).toBe(true)

    // 会话已被清理
    expect(await state.loadBinding(sessionId)).toBeNull()
    expect(state.sessionTaskTails.has(sessionId)).toBe(false)
  })

  it('未知会话销毁保持严格静默幂等，不抛出异常', async () => {
    const fakeSessionId = 'completely-unknown-session-12345'
    await expect(state.clearBinding(fakeSessionId)).resolves.toBeUndefined()
    expect(state.openFloors.has(fakeSessionId)).toBe(false)
  })
})

// -------------------------------------------------------------
// 8. 适配器未挂载会话守卫 (options.sessionId undefined)
// -------------------------------------------------------------
describe('Adversarial: 适配器未挂载会话守卫', () => {
  it('不同异常 options 下适配器均安全跳过，绝不调用 projector', () => {
    const ctx = new Context()
    const sessions = new Map<string, Session>()
    ctx.provide('sessions', {
      get: (id: string) => sessions.get(id),
    } as any)
    ctx.provide('agents', { get: () => undefined } as any)

    const dummyModel = { systemPromptUpdate: 'in-history' as const, defaultMaxTokens: 4096 }
    const mockState = {
      requestDiagnostics: new Map(),
      currentTurns: new Map(),
      currentSteps: new Map(),
    } as any

    // 1. purpose 存在
    const purposeOpts: GenerateOptions = { purpose: 'summary', sessionId: 's1', messages: [] } as any
    expect(projectTavernAdapterRequest(ctx, mockState, purposeOpts, dummyModel)).toBe(purposeOpts)

    // 2. 无 sessionId
    const noSessionOpts: GenerateOptions = { messages: [] } as any
    expect(projectTavernAdapterRequest(ctx, mockState, noSessionOpts, dummyModel)).toBe(noSessionOpts)

    // 3. sessionId 不在 sessions 列表中 (undefined)
    const unregOpts: GenerateOptions = { sessionId: 'unregistered-session', messages: [] } as any
    expect(projectTavernAdapterRequest(ctx, mockState, unregOpts, dummyModel)).toBe(unregOpts)
  })
})
