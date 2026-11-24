/**
 * Template 与 QuickJS VM 层缺陷修复回归测试：
 * 覆盖 TemplateSandbox.condition() 单趟快照防 toJSON TOCTOU 绕过、activewi @@if 只读守卫防全局篡改、
 * merge/setvar/writeHistoricalVariable 数组覆写对象不丢键、withMsg 历史读作用域一致性、
 * 同位置多条 @INJECT 的 layout.entries 声明顺序、有序列表制表符缩进保留正文、
 * findVariables('stat_data.<key>') 缺键回退历史快照，以及确定性异步/只读异常不卡死楼层提交。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session as HostSession, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPreset } from '../src/core/assemble.js'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE, type ChatMessage } from '../src/core/types.js'
import { saveBinding } from '../src/node/bindings.js'
import { resolveConfig } from '../src/node/config.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'
import { isolated } from '../src/node/isolated.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { createMessageFormatter } from '../src/node/templateMarkdown.js'
import { TemplateSandbox } from '../src/node/templateSandbox.js'
import { parseLorebook } from '../src/state/lorebook.js'
import { loadTemplateState } from '../src/state/template.js'

const tempDirs: string[] = []
afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true })
})

function makeTemplateContext(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    variables: emptyTemplateScopes(),
    char: 'Alice',
    user: 'Bob',
    card: {},
    entries: [],
    presets: [],
    history: [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
    ],
    historyIdentities: [
      { messageId: 'm0', hostMessageId: 1, swipeId: 0 },
      { messageId: 'm1', hostMessageId: 2, swipeId: 0 },
    ],
    now: 1000,
    seed: 42,
    phase: 'generate',
    ...overrides,
  }
}

describe('Template & VM 层缺陷修复回归', () => {
  it('E1: TemplateSandbox.condition() 单趟快照彻底阻止 2-shot toJSON getter TOCTOU 绕过与全局 JSON 篡改', async () => {
    await TemplateSandbox.prepare()
    const sandbox = await TemplateSandbox.create(makeTemplateContext())
    try {
      // 在正常生成脚本里种下 2-shot toJSON getter 并定向劫持状态对象的 JSON.stringify。
      sandbox.render(`<%
        setvar('hp', 10);
        let reads = 0;
        Object.defineProperty(variables, 'toJSON', {
          enumerable: false,
          configurable: true,
          get() { return reads++ % 2 === 1 ? () => ({ hp: 10 }) : undefined; },
        });
        const origStringify = JSON.stringify;
        JSON.stringify = (v, ...rest) => v && typeof v === 'object' && 'scopes' in v ? 'CONSTANT' : origStringify(v, ...rest);
      %>`)
      expect(() => sandbox.condition("(setvar('hp', 999), true)")).toThrow(/@@if 条件/)
    } finally {
      sandbox.dispose()
    }
  })

  it('E2: activewi() 内部 @@if 守卫免疫 globalThis.JSON.stringify 与 __conditionState 篡改', async () => {
    await TemplateSandbox.prepare()
    const entries = parseLorebook(
      {
        entries: [
          {
            uid: 1,
            comment: 'guarded',
            content: '@@if (setvar("hacked", 1), true)\nSECRET_LORE',
            constant: false,
            enabled: true,
          },
        ],
      },
      { source: 'character', sourceRef: 'book' },
    )
    const sandbox = await TemplateSandbox.create(makeTemplateContext({ entries }))
    try {
      expect(() =>
        sandbox.render(`<%
          const origStringify = JSON.stringify;
          JSON.stringify = (v, ...rest) => v && typeof v === 'object' && 'scopes' in v ? 'SAME' : origStringify(v, ...rest);
          try { globalThis.__conditionState = () => 'SAME'; } catch {}
          await activewi('book', 'guarded');
        %>`),
      ).toThrow(/@@if 条件必须只读/)
    } finally {
      sandbox.dispose()
    }
  })

  it('E3: setvar({merge:true}) / writeHistoricalVariable({merge:true}) / define(combine=true) 在对象合入数组时替换为普通对象，不静默丢键', async () => {
    const result = await isolated('template', {
      context: makeTemplateContext({
        messageVariables: {
          version: 1,
          snapshots: {
            m0: { values: { histArr: [1, 2] }, initialized: true },
            m1: { values: { curArr: [1, 2] }, initialized: true },
          },
        },
      }),
      texts: [
        `<%
          define('arrDef', { x: [1, 2] });
          define('arrDef', { x: { a: 1 } }, true);
          setvar('curArr', { b: 2 }, { merge: true });
          setMessageVar('histArr', { c: 3 }, { merge: true, withMsg: { id: 0 } });
        %><%- JSON.stringify(defines.arrDef.x) %>|<%- JSON.stringify(getvar('curArr')) %>|<%- JSON.stringify(getMessageVar('histArr', { withMsg: { id: 0 } })) %>`,
      ],
    })
    expect(result.texts).toEqual(['{"a":1}|{"b":2}|{"c":3}'])
    expect(result.variables.message.curArr).toEqual({ b: 2 })
    expect(result.messageVariables?.snapshots.m0?.values.histArr).toEqual({ c: 3 })
  })

  it('E4: withMsg 在 incMessageVar / decMessageVar / delvar(index) / insvar / patchVariables 中读取目标历史消息而非当前消息', async () => {
    const result = await isolated('template', {
      context: makeTemplateContext({
        messageVariables: {
          version: 1,
          snapshots: {
            m0: { values: { count: 10, items: ['a', 'b'], meta: { v: 1 } }, initialized: true },
            m1: { values: { count: 999, items: ['x', 'y'], meta: { v: 999 } }, initialized: true },
          },
        },
      }),
      texts: [
        `<%
          incMessageVar('count', 2, { withMsg: { id: 0 } });
          decMessageVar('count', 1, { withMsg: { id: 0 } });
          delvar('items', 0, { withMsg: { id: 0 } });
          insvar('items', 'c', null, { withMsg: { id: 0 } });
          patchVariables('meta', [{ op: 'replace', path: '/v', value: 7 }], { withMsg: { id: 0 } });
        %>ok`,
      ],
    })
    expect(result.messageVariables?.snapshots.m0?.values).toEqual({
      count: 11,
      items: ['b', 'c'],
      meta: { v: 7 },
    })
    // 当前消息 m1 保持原值不被污染。
    expect(result.messageVariables?.snapshots.m1?.values).toEqual({
      count: 999,
      items: ['x', 'y'],
      meta: { v: 999 },
    })
  })

  it('E5: 同一历史消息前的多条 @INJECT 在 layout.entries 中保持声明顺序（含/不含既有 GENERATE:BEFORE 钩子）', async () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'hello' }]
    const buildReq = (lore: Record<string, unknown>[]): ComputeJobs['assemble']['input'] => {
      const entries = parseLorebook(
        { entries: lore.map((entry, i) => ({ uid: i + 1, constant: true, ...entry })) },
        { source: 'character', sourceRef: 'card' },
      )
      const preset = defaultPreset()
      preset.entries = preset.entries.filter((entry) => ['chatHistory', 'worldInfoBefore'].includes(entry.identifier))
      return {
        preset,
        card: null,
        personaDescription: '',
        history,
        wi: null,
        memories: [],
        worldDeltas: [],
        regexRules: [],
        macroCtx: { char: 'Alice', user: 'Bob' },
        seed: 42,
        budget: { maxTokens: 100000, reserveForOutput: 0 },
        templates: { variables: emptyTemplateScopes(), char: 'Alice', user: 'Bob', card: {}, entries, presets: [], history, now: 1000, seed: 42, phase: 'generate' },
        wiEvaluation: { entries, messages: history, settings: DEFAULT_WI_SETTINGS, timerState: EMPTY_TIMER_STATE, contextWindowTokens: 100000, reservedTokens: 0, seed: 42 },
      }
    }

    // 无既有 GENERATE 钩子：A、B、C 在 messages 与 layout.entries 均为 [A, B, C]。
    const plain = await isolated(
      'assemble',
      buildReq([
        { comment: '@INJECT pos=1,order=10', content: 'INS_A' },
        { comment: '@INJECT pos=1,order=20', content: 'INS_B' },
        { comment: '@INJECT pos=1,order=30', content: 'INS_C' },
      ]),
    )
    expect(plain.messages.map((m) => m.content)).toEqual(['INS_A', 'INS_B', 'INS_C', 'hello'])
    expect(plain.layout!.entries.filter((e) => e.key.startsWith('template-insert:')).map((e) => e.content)).toEqual([
      'INS_A',
      'INS_B',
      'INS_C',
    ])

    // 存在既有 [GENERATE:0:BEFORE] 钩子时，A、B、C 仍按顺序排在既有钩子之前（外侧）。
    const withHook = await isolated(
      'assemble',
      buildReq([
        { comment: '[GENERATE:0:BEFORE]', order: 5, content: 'HOOK' },
        { comment: '@INJECT pos=1,order=10', content: 'INS_A' },
        { comment: '@INJECT pos=1,order=20', content: 'INS_B' },
        { comment: '@INJECT pos=1,order=30', content: 'INS_C' },
      ]),
    )
    expect(withHook.layout!.entries.map((e) => e.content)).toEqual([
      'INS_A',
      'INS_B',
      'INS_C',
      'HOOK',
    ])
  })

  it('E6: 有序列表标记后接制表符时不裁掉或清空列表项正文，且保持多制表位缩进代码', () => {
    const format = createMessageFormatter()
    expect(format('100.\ta')).toBe('<ol start="100">\n<li>a</li>\n</ol>')
    expect(format('  1.\tfoo')).toBe('<ol>\n<li>foo</li>\n</ol>')
    expect(format('10.\tbar')).toBe('<ol start="10">\n<li>bar</li>\n</ol>')
    expect(format('100.\t\tcode')).toContain('<code>')
    expect(format('100.\t\tcode')).toContain('code')
  })

  it('E7: findVariables("stat_data.<key>") 在 current 缺少目标键时回退查找较早 MVU 快照', async () => {
    const result = await isolated('template', {
      context: makeTemplateContext({
        helperMvu: {
          version: 1,
          current: { hp: 50 },
          snapshots: {
            m0: { hp: 100, oldFlag: 'FOUND_IN_M0' },
            m1: { hp: 50 },
          },
        },
      }),
      texts: [
        '<%- findVariables("stat_data.oldFlag")?.stat_data?.oldFlag %>|<%- findVariables("stat_data.hp")?.stat_data?.hp %>',
      ],
    })
    expect(result.texts).toEqual(['FOUND_IN_M0|50'])
  })

  it('E8: 回复模板遇到确定性未完成异步任务或只读 @@if 异常时按模板脚本失败降级，不抛 TemplateOutputCommitError 卡死楼层', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tavern-e8-'))
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
    const { cardId } = await state.createCharacter('E8角色')
    await state.saveCharacter(cardId, { description: '<% setvar("seen", 1) %>desc' })
    const sessionId = 'e8-session'
    await saveBinding(state.paths, {
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
    const binding = (await state.loadBinding(sessionId))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)

    const live = HostSession.create(sessionId as Session['id'])
    live.append('agent-preset/selected', { agentPreset: 'tavern' })
    live.append('turn/start', { turn: 1 })
    live.append('step/start', { turn: 1, step: 1 })
    live.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), { surfaceOp: 'append' })

    await onTurnStart(state, sessionId, 1, live)
    const pipeline = await runTavernPipeline({
      state,
      sessionId,
      agent: null,
      mode: 'live',
      historyOverride: [{ role: 'user', content: 'hi' }],
    })
    expect(pipeline?.templateReplay).toBeDefined()

    // 确定性未完成 Promise（不允许外部 I/O）：应降级并正常提交楼层，而不是抛出 TemplateOutputCommitError 永久阻塞。
    const replyEvents = [
      ...live.snapshotEvents(),
      {
        type: 'assistant/message',
        seq: 10,
        time: 0,
        data: {
          stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
          turn: 1,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: '<% await new Promise(() => {}) %>正文' }],
            source: { provider: 'factory', model: 'factory' },
          }),
        },
      },
      { type: 'turn/end', seq: 11, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as unknown as SessionEvent[]

    let caught: unknown
    try {
      await onTurnEnd(state, sessionId, { id: sessionId as Session['id'], snapshotEvents: () => replyEvents })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).not.toBe('TemplateOutputCommitError')
    expect((caught as Error).message).toContain('EJS 异步任务未完成')
    expect(state.openFloors.has(sessionId)).toBe(false)
    const floor = await ws.wal.validateFloor(`${sessionId}#t1`)
    expect(floor.committed).toBe(true)
    // 下一轮能够自动清理已提交楼层的旧 prepared 生成记录并顺利开层，不会永久死锁。
    const nextEvents = [
      ...replyEvents,
      { type: 'turn/start', seq: 12, time: 0, data: { turn: 2 } },
    ] as unknown as SessionEvent[]
    await expect(onTurnStart(state, sessionId, 2, { id: sessionId as Session['id'], snapshotEvents: () => nextEvents })).resolves.toBeUndefined()
    const saved = await loadTemplateState(ws.fs)
    expect(saved.generation?.status).toBe('terminated')
  })
})
