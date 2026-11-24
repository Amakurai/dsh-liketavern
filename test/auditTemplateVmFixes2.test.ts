/**
 * Template 与 QuickJS VM 层第二轮缺陷修复回归测试（T1–T11）：
 * - T1: QuickJS checkpoint VM 异步 job 在触发 WASM memory.grow() 后仍可正常取回 resolved 值
 * - T2: RENDER_WRAPPER 安全格式化无 toString / 抛错异常，且 @@if 条件状态错误按确定性脚本失败处理
 * - T3: TemplateOutputCommitError 重试保留 turnPlans / pendingTurnPlans 不在提交成功前清空
 * - T4: 同轮同一正则回调的相同文本+来源位置重复匹配按出现序号独立执行而不串用缓存
 * - T5: renderHook 剥离内部合成前缀 activewi 等标记后再入生成正则表达式
 * - T6: keywordMatch 过滤纯空白触发词，避免匹配任意文本
 * - T7: setvar/writeHistoricalVariable { merge: true, results: 'old' } 保留未变异的 old 快照
 * - T8: bare getwi(book, title) 不将 globalThis/api 上的成员混入子模板 locals
 * - T9: delvar/patchVariables/insvar 正确透传 inscope/outscope，insvar 三参及 options.index 不二次索引写
 * - T10: path('[0].a') 前导方括号解析与 set() 空键保护（?? 代替 ||）
 * - T11: _with: false 过滤非法标识符与保留字且仅在模板引用 faker 时才触发惰性装载
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/node/config.js'
import { isolated } from '../src/node/isolated.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { createTemplateGeneration } from '../src/node/templateGeneration.js'
import { TemplateSandbox } from '../src/node/templateSandbox.js'
import { saveBinding } from '../src/node/bindings.js'
import { newStoryId, snapshotStory } from '../src/state/story.js'
import { importCard } from '../src/state/workspace.js'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { WIPosition, type ChatMessage, type WorldInfoEntry } from '../src/core/types.js'
import { defaultPreset } from '../src/core/assemble.js'

const tempDirs: string[] = []
afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop()!, { recursive: true, force: true })
})

function ctx(overrides: Partial<TemplateContext> = {}): TemplateContext {
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

describe('Template & VM 层第二轮缺陷修复回归 (T1–T11)', () => {
  it('T1: 异步微任务内分配大字符串触发 WASM memory.grow() 后，检查点 VM 仍完整执行并导出', async () => {
    await TemplateSandbox.prepare()
    const sandbox = await TemplateSandbox.create(ctx())
    try {
      const rendered = sandbox.render(
        `<%- await (async () => { await Promise.resolve(); const big = 'x'.repeat(2 * 1024 * 1024); return big.length; })() %>`,
      )
      expect(rendered).toBe(String(2 * 1024 * 1024))
      expect(() => sandbox.replay()).not.toThrow()
    } finally {
      sandbox.dispose()
    }
  })

  it('T2: RENDER_WRAPPER 安全格式化无原型或抛错 toString 的异常，且 @@if 条件状态异常判为确定性脚本失败', async () => {
    await expect(
      isolated('template', {
        context: ctx(),
        texts: ['<% const e = Object.create(null); e.message = "null-proto-err"; throw e; %>'],
      }),
    ).rejects.toThrow(/null-proto-err/)

    await expect(
      isolated('template', {
        context: ctx(),
        texts: ['<% throw { toString() { throw new Error("boom"); }, message: "fallback-msg" }; %>'],
      }),
    ).rejects.toThrow(/fallback-msg/)

    await TemplateSandbox.prepare()
    const sandbox = await TemplateSandbox.create(ctx())
    try {
      expect(() => sandbox.condition('Object.assign(variables, { bad: { toJSON() { throw 1 } } })')).toThrow(/@@if 条件/)
    } finally {
      sandbox.dispose()
    }
  })

  it('T3: onTurnEnd 遇到 TemplateOutputCommitError 时保留 turnPlans，供同一结束事件重试', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tavern-t3-'))
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
    const { cardId } = await importCard(join(root, 'characters'), {
      spec: 'chara_card_v2',
      name: 'T3',
      description: 'd',
      personality: 'p',
      scenario: 's',
      firstMes: 'hi',
      mesExample: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      creatorNotes: '',
      alternateGreetings: [],
      tags: [],
      creator: 't',
      characterVersion: '1',
      regexScripts: [],
      extensions: {},
    })
    const sid = SessionId('sess-t3')
    const storyId = newStoryId()
    await snapshotStory({ cardRoot: join(root, 'characters', cardId), sourceRoot: join(root, 'characters', cardId), id: storyId, sessionId: sid })
    await saveBinding(state.paths, {
      sessionId: sid,
      cardId,
      storyId,
      presetId: null,
      personaId: null,
      characterLorebookId: null,
      lorebookIds: [],
      interactiveCards: null,
      greetingIndex: 0,
      worldInfo: {},
      authorNote: '',
      injectJournal: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await onTurnStart(state, sid, 1)
    const dummyPlan = {
      turn: 1,
      cardId,
      storyId,
      result: {
        messages: [],
        system: '',
        standing: '',
        standingKey: 'k',
        turnContext: '',
        sampling: {},
        activatedWi: [],
        logLines: [],
        stats: { wiCount: 0, wiDropped: 0, memoryCount: 0, tokensAfter: 0 },
      },
    }
    state.turnPlans.set(sid, dummyPlan)

    // 制造当前 openFloor 被提前提交的假象，使 commitFloor/validateFloor 或 saveTemplateState 阶段失败前，validateFloor 失败；
    // 验证未成功收口时 turnPlans 不在 validateFloor 前被 clearTurn() 清空。
    const ws = await state.storyWorkspace(cardId, storyId)
    await ws.wal.commitFloor(`${sid}#t1`)
    await expect(ws.wal.validateFloor(`${sid}#t1`)).resolves.toMatchObject({ committed: true })
    // 删掉 records 破坏日志使 validateFloor 在 clearTurn 之前抛错：
    await rm(join(ws.fs.root, 'state/wal', `${sid}_t1`, 'meta.json'))
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } as SessionEvent,
      { type: 'user/message', seq: 1, time: 2, data: { turn: 1, message: createUserMessage('hi') } } as SessionEvent,
      { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, message: createAssistantMessage('ok'), stopReason: 'stop' } } as SessionEvent,
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent,
    ]
    await expect(onTurnEnd(state, sid, { id: sid, snapshotEvents: () => events })).rejects.toThrow()
    expect(state.turnPlans.get(sid)).toBe(dummyPlan)
  })

  it('T4: 同轮同来源零宽正则多次命中时不复用首次匹配缓存', async () => {
    const parts = [{ key: 's1', text: 'abc', start: 0 }]
    const out = await isolated('template', {
      context: ctx(),
      texts: [
        `<% activateRegex(/(?=.)/g, () => String(incvar('hits')), { uuid: 'r4', generate: true, worldinfo: true }); %><%- __applyTemporaryRegexSources(${JSON.stringify(parts)}, 'generate', { role: 'user', worldinfo: false, depth: 0 }, 'ns').map(p => p.text).join('') %>`,
      ],
    })
    expect(out.texts[0]).toBe('1a2b3c')
    expect(out.variables.message.hits).toBe(3)
  })

  it('T5: renderHook 送入 generate 正则前剥离内部合成前缀 <% /* activewi|... */ %>', async () => {
    await TemplateSandbox.prepare()
    const sandbox = await TemplateSandbox.create(
      ctx({
        history: [{ role: 'user', content: 'anchor' }],
      }),
    )
    try {
      sandbox.render(`<% activateRegex(new RegExp('^<' + '% /\\\\* activewi \\\\*/ %' + '>'), 'LEAKED', { generate: true, worldinfo: true }); %>`)
      const hookEntry: WorldInfoEntry = {
        key: 'e1',
        uid: '1',
        source: 'global',
        sourceRef: 'book',
        keys: ['anchor'],
        secondaryKeys: [],
        selective: false,
        selectiveLogic: 0,
        comment: '[GENERATE:AFTER:REGEX:anchor]',
        content: '<% /* activewi */ %>CleanHook',
        constant: false,
        enabled: true,
        order: 100,
        position: WIPosition.BeforeChar,
        depth: 0,
        role: null,
        outletName: '',
        probability: 100,
        useProbability: true,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        scanDepth: null,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        ignoreBudget: false,
        group: '',
        groupWeight: 100,
        groupOverride: false,
        automationId: '',
      }
      const gen = createTemplateGeneration(sandbox, [hookEntry], { char: 'Alice', user: 'Bob' }, new Map())
      const seq: Array<{ message: ChatMessage; worldinfo: boolean; depth: number; tokens: number }> = [
        { message: { role: 'user', content: 'anchor' }, worldinfo: false, depth: 0, tokens: 1 },
      ]
      gen.processTemplateSequence!(seq)
      expect(seq[0]!.message.content).toBe('anchorCleanHook')
      expect(seq[0]!.message.content).not.toContain('LEAKED')
    } finally {
      sandbox.dispose()
    }
  })

  it('T6: selectActivatedEntries 中的 keywordMatch 过滤纯空白关键词', async () => {
    const out = await isolated('template', {
      context: ctx({
        entries: [
          {
            key: 'b:blank',
            uid: 'blank',
            source: 'global',
            sourceRef: 'b',
            keys: ['   ', '\t'],
            secondaryKeys: [],
            selective: false,
            selectiveLogic: 0,
            comment: 'blank',
            content: 'BODY',
            constant: false,
            enabled: true,
            order: 10,
            position: WIPosition.BeforeChar,
            depth: 0,
            role: null,
            outletName: '',
            probability: 100,
            useProbability: true,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            scanDepth: null,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: 0,
            sticky: null,
            cooldown: null,
            delay: null,
            ignoreBudget: false,
            group: '',
            groupWeight: 100,
            groupOverride: false,
            automationId: '',
          },
        ],
      }),
      texts: [`<%- JSON.stringify(selectActivatedEntries(await getWorldInfoData('b'), ['any prompt'])) %>`],
    })
    expect(JSON.parse(out.texts[0]!)).toEqual([])
  })

  it("T7: setvar(..., { merge: true, results: 'old' }) 返回未受就地 merge 污染的旧快照", async () => {
    const out = await isolated('template', {
      context: ctx(),
      texts: [
        `<% setvar('box', { nested: { a: 1 } }); const old = setvar('box', { nested: { b: 2 } }, { merge: true, results: 'old' }); -%><%- JSON.stringify(old) %>|<%- JSON.stringify(getvar('box')) %>`,
      ],
    })
    expect(out.texts[0]).toBe('{"nested":{"a":1}}|{"nested":{"a":1,"b":2}}')
  })

  it('T8: bare call getwi 不把 globalThis 或 api 成员泄漏进子模板 locals', async () => {
    const out = await isolated('template', {
      context: ctx({
        entries: [
          {
            key: 'b:t8',
            uid: 't8',
            source: 'global',
            sourceRef: 'b',
            keys: ['k'],
            secondaryKeys: [],
            selective: false,
            selectiveLogic: 0,
            comment: 't8',
            content: `<%- Object.hasOwn(locals, 'setvar') %>`,
            constant: false,
            enabled: true,
            order: 10,
            position: WIPosition.BeforeChar,
            depth: 0,
            role: null,
            outletName: '',
            probability: 100,
            useProbability: true,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            scanDepth: null,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: 0,
            sticky: null,
            cooldown: null,
            delay: null,
            ignoreBudget: false,
            group: '',
            groupWeight: 100,
            groupOverride: false,
            automationId: '',
          },
        ],
      }),
      texts: [`<%- await getwi('b', 't8') %>`],
    })
    expect(out.texts[0]).toBe('false')
  })

  it('T9: delvar/patchVariables/insvar 正确转发 inscope/outscope，且 insvar 支持三参及 options.index 不二次索引写', async () => {
    const base = ctx({ variables: { ...emptyTemplateScopes(), global: { arr: ['a', 'b', 'c'], obj: { x: 1, y: 2 } }, local: {}, message: {} } })
    const out = await isolated('template', {
      context: base,
      texts: [
        `<% delvar('obj', 'x', { inscope: 'global', outscope: 'local' }); patchVariables('arr', [{ op: 'add', path: '/-', value: 'd' }], { inscope: 'global', outscope: 'local' }); insvar('arr', 'Z', { scope: 'local', index: 1 }); -%><%- JSON.stringify(getvar('obj', { scope: 'local' })) %>|<%- JSON.stringify(getvar('arr', { scope: 'local' })) %>|<%- JSON.stringify(getvar('arr', { scope: 'global' })) %>`,
      ],
    })
    expect(out.texts[0]).toBe('{"y":2}|["a","Z","b","c","d"]|["a","b","c"]')
  })

  it('T10: path 前导方括号与数组路径空键 set() 不错建数组容器', async () => {
    const out = await isolated('template', {
      context: ctx(),
      texts: [
        `<% setvar('[items][0].name', 'ok'); setvar(['map', '', '1'], 'val'); -%><%- getvar('items.0.name') %>|<%- Array.isArray(getvar('map')) %>|<%- getvar(['map', '', '1']) %>`,
      ],
    })
    expect(out.texts[0]).toBe('ok|false|val')
  })

  it('T11: _with: false 过滤非法标识符与保留字，且未引用 faker 时不触发全语言包解析', async () => {
    const start = Date.now()
    const out = await isolated('template', {
      context: ctx(),
      texts: [
        `<%- await evalTemplate('<' + '%= x + "-" + locals["bad-key"] %' + '>', { x: 42, 'bad-key': 'ok', 'class': 'ignored' }, { _with: false }) %>|<%- Object.getOwnPropertyDescriptor(Object.getPrototypeOf(locals), 'faker')?.get !== undefined %>`,
      ],
    })
    expect(out.texts[0]).toBe('42-ok|true')
    expect(Date.now() - start).toBeLessThan(8000)
  })
})
