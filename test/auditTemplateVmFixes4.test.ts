/**
 * Template 与 QuickJS VM 层第四轮审计修复回归测试（V1–V5）：
 * - V1: IIFE 闭包封装彻底隔离内部变量与 __TavernTemplateLibraries，@@if 拒绝通过 api.defines 写入副作用
 * - V2: Promise.prototype.constructor 劫持不影响 C FFI drainRenderHandle，Date.prototype.toJSON 篡改在序列化前被拒绝
 * - V3: sticky 移除记录超过 4096 条按 FIFO 淘汰而非抛错锁死长剧情
 * - V4: templateHelperMvu 独立校验 snapshots 与 current 的 1 MiB 上限并兼容 49–64 层合法嵌套深度
 * - V5: 确定性模板展示片段超限异常在 onTurnEnd 中关闭 generation 为 terminated 并提交 WAL，不阻塞后续 helper 写入
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session as HostSession, SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { projectTemplateHelperMvu } from '../src/core/templateHelperMvu.js'
import { resolveConfig } from '../src/node/config.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { TemplateSandbox } from '../src/node/templateSandbox.js'
import { loadTemplateState } from '../src/state/template.js'

const tempDirs: string[] = []
afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true })
})

function makeContext(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    variables: emptyTemplateScopes(),
    char: 'Alice',
    user: 'Bob',
    card: { name: 'Alice' },
    entries: [],
    presets: [],
    history: [{ role: 'user', content: 'hi' }],
    historyIdentities: [{ messageId: 'm0', hostMessageId: 1, swipeId: 0 }],
    now: 1000,
    seed: 7,
    phase: 'generate',
    ...overrides,
  }
}

describe('Template 与 QuickJS VM 层第四轮审计修复回归', () => {
  it('V1: 模板与 @@if 无法读取内部状态或 __TavernTemplateLibraries，且 @@if 拒绝改写 defines', async () => {
    await TemplateSandbox.prepare()
    const sandbox = await TemplateSandbox.create(makeContext())
    try {
      const probe = sandbox.render(
        '<%= [typeof conditionReadonlyDepth, typeof templateOutputLimit, typeof scopes, typeof preparing, typeof validatingSchema, typeof __TavernTemplateLibraries].join(",") %>',
      )
      expect(probe).toBe('undefined,undefined,undefined,undefined,undefined,undefined')

      expect(() => sandbox.condition('((defines.evil = 1), true)')).toThrow(/@@if 条件必须只读/)
      expect(() => sandbox.condition('((delete defines.x), true)')).toThrow(/@@if 条件必须只读/)
      // 只读条件抛错后 readonly 深度必须恢复为 0，后续正常模板仍可写入变量。
      const after = sandbox.render('<% setvar("ok", 42) %><%= getvar("ok") %>')
      expect(after).toBe('42')
    } finally {
      sandbox.dispose()
    }
  })

  it('V2: Promise.prototype.constructor 劫持不破坏宿主句柄结算，Date.prototype.toJSON 篡改被单趟序列化拦截', async () => {
    await TemplateSandbox.prepare()
    const sandbox = await TemplateSandbox.create(makeContext())
    try {
      const rendered = sandbox.render(
        '<% Promise.prototype.constructor = function() { throw new Error("hijack") }; const v = await Promise.resolve("safe"); %><%= v %>',
      )
      expect(rendered).toBe('safe')

      expect(() =>
        sandbox.render('<% Date.prototype.toJSON = () => "tampered"; setvar("d", "x"); %><%= JSON.stringify(findVariables()) %>'),
      ).toThrow(/Date\.prototype\.toJSON/)
    } finally {
      sandbox.dispose()
    }
  })

  it('V3: sticky 临时注入/正则移除记录超过 4096 条按 FIFO 淘汰，不再抛错锁死长剧情', async () => {
    await TemplateSandbox.prepare()
    const sandbox = await TemplateSandbox.create(makeContext())
    try {
      // 分批注册并到期淘汰超过 4096 个不同 sticky 注入（每批 500 ≤ 1024 活跃分组上限），FIFO 淘汰墓碑不抛错
      const out = sandbox.render(
        '<% for (let batch = 0; batch < 9; batch++) { for (let i = 0; i < 500; i++) { injectPrompt("inj-" + batch + "-" + i, "v", 100, 0); } __finishTemplateGeneration(); } %>done',
      )
      expect(out).toBe('done')
      expect(JSON.parse(sandbox.render('<%= __exportTemplateStickyState() %>')).prompts).toEqual([])
    } finally {
      sandbox.dispose()
    }
  })

  it('V4: templateHelperMvu 独立计费 snapshots/current 并允许 49–64 层嵌套对象', () => {
    let deep: Record<string, unknown> = { leaf: 'ok' }
    for (let i = 0; i < 52; i++) deep = { next: deep }
    const big = 'x'.repeat(600 * 1024)
    const stat = { payload: big, deep }
    const result = projectTemplateHelperMvu(
      { [JSON.stringify(['message', 'm0'])]: { stat_data: stat } },
      [{ messageId: 'm0', hostMessageId: 1, swipeId: 0 }],
      stat,
    )
    expect(result).toBeDefined()
    expect(Object.keys(result!.snapshots)).toEqual(['m0'])
    expect((result!.current as { payload?: string })?.payload?.length).toBe(big.length)
  })

  it('V5: 回复阶段触发确定性展示片段超限异常时，onTurnEnd 关闭 prepared generation 为 terminated 并提交 WAL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tavern-vm-audit4-'))
    tempDirs.push(root)
    const state = new TavernState(
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
    const { cardId } = await state.createCharacter('片段超限角色')
    // 卡片含 EJS 使管线为本轮落盘 prepared generation
    await state.saveCharacter(cardId, { description: '角色设定 <%= char %>' })
    const sessionId = 'vm4-part-limit'
    await state.saveBinding({
      sessionId,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadStoryBinding(sessionId))!
    const ws = await state.storyWorkspace(binding.cardId, binding.storyId!)

    const session = HostSession.create(SessionId(sessionId))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await onTurnStart(state, sessionId, 1, session)
    await runTavernPipeline({
      state,
      sessionId,
      agent: null,
      mode: 'live',
      historyOverride: [{ role: 'user', content: 'hi' }],
    })
    expect((await loadTemplateState(ws.fs)).generation?.status).toBe('prepared')

    // 构造超过 128 个模板展示片段的正常 stop 回复：确定性脚本限制应立刻关闭 prepared 并提交楼层。
    const tooManyParts = '<% for (let i = 0; i < 135; i++) { %>text\n```html\n<div>p<%= i %></div>\n```\n<% } %>'
    const replyEvents = [
      ...session.snapshotEvents(),
      {
        type: 'assistant/message',
        seq: 10,
        time: 0,
        data: {
          stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: tooManyParts }],
            source: { provider: 'factory', model: 'factory' },
          }),
        },
      },
      { type: 'turn/end', seq: 11, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]

    await expect(
      onTurnEnd(state, sessionId, { id: sessionId as Session['id'], snapshotEvents: () => replyEvents }),
    ).rejects.toThrow(/模板展示片段/)

    const floor = await ws.wal.validateFloor(`${sessionId}#t1`)
    expect(floor.committed).toBe(true)
    const saved = await loadTemplateState(ws.fs)
    expect(saved.generation?.status).toBe('terminated')
  })
})
