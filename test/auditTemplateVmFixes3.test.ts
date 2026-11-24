/**
 * Template 与 QuickJS VM 层第三轮审计缺陷修复回归测试（V1–V7）：
 * - V1: 宿主通信协议防劫持（__tavernCallInput/__tavernOutputLimit 实参直传、JSON.stringify/原型 toJSON 隔离、
 *       移除 __scopes、冻结 __resetTemplateFaker、basic 正则控制调用不经 EJS with(locals)）
 * - V2: evaluate/evaluateHandle 正确识别超时中断，避免 turn/end 误将超时当作确定性脚本异常吞掉提交
 * - V3: BigInt/Symbol 错误安全格式化且 >1 MiB 变量/确定性脚本限制在 turn/end 不触发 TemplateOutputCommitError 锁死楼层
 * - V4: @@if 按纯 JS 表达式求值（兼容 %> 与 // 注释），并在条件期间拦截一切非变量注册表副作用
 * - V5: transformRegex 与 resolveOutlets 走实参句柄并触发 growResources，大回复不再因 32 MiB 初始堆 OOM
 * - V6: templateWorldInfo keywordMatch 捕获非法正则关键词，单条坏词条不击穿世界书筛选与主动激活
 * - V7: TemplateWorkerCache.take 安全吞掉 dispose() 异常，不中断冷回退或掩盖原始校验失败
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session as HostSession, SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { WIPosition, type ChatMessage, type WorldInfoEntry } from '../src/core/types.js'
import { isolated } from '../src/node/isolated.js'
import { resolveConfig } from '../src/node/config.js'
import { saveBinding } from '../src/node/bindings.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { createTemplateGeneration } from '../src/node/templateGeneration.js'
import { TemplateOutputCommitError } from '../src/node/templateOutput.js'
import { TemplateSandbox } from '../src/node/templateSandbox.js'
import { TemplateWorkerCache, templateWorkerCacheKey } from '../src/node/templateWorkerCache.js'
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

function makeEntry(overrides: Partial<WorldInfoEntry> & { key: string; uid: string; comment: string; content: string }): WorldInfoEntry {
  return {
    source: 'global',
    sourceRef: 'book',
    keys: [],
    secondaryKeys: [],
    selective: false,
    selectiveLogic: 0,
    constant: false,
    enabled: true,
    order: 100,
    position: WIPosition.BeforeChar,
    depth: 0,
    role: null,
    outletName: '',
    probability: 100,
    useProbability: false,
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
    ...overrides,
  }
}

async function setupTurnFixture(cardDescription: string) {
  const root = await mkdtemp(join(tmpdir(), 'tavern-vm-audit3-'))
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
  const { cardId } = await state.createCharacter('审计角色')
  await state.saveCharacter(cardId, { description: cardDescription })
  const sid = SessionId('sess-vm3')
  await saveBinding(state.paths, {
    sessionId: sid,
    cardId,
    presetId: null,
    personaId: null,
    lorebookIds: [],
    characterLorebookId: null,
    interactiveCards: null,
    greetingIndex: 0,
    createdAt: new Date(0).toISOString(),
  })
  const binding = (await state.loadBinding(sid))!
  const ws = await state.storyWorkspace(cardId, binding.storyId)
  const live = HostSession.create(sid)
  live.append('agent-preset/selected', { agentPreset: 'tavern' })
  live.append('turn/start', { turn: 1 })
  live.append('step/start', { turn: 1, step: 1 })
  live.append('user/message', createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  await onTurnStart(state, sid, 1, live)
  await runTavernPipeline({ state, sessionId: sid, agent: null, mode: 'live', historyOverride: [{ role: 'user', content: '你好' }] })
  return { state, sid, ws }
}

function completedReplySession(sid: Session['id'], replyText: string, turn = 1): Pick<Session, 'id' | 'snapshotEvents'> {
  const events = [
    { type: 'turn/start', seq: 0, time: 0, data: { turn } },
    {
      type: 'assistant/message',
      seq: 5,
      time: 0,
      data: {
        stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
        turn,
        step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: replyText }], source: { provider: 'factory', model: 'factory' } }),
      },
    },
    { type: 'turn/end', seq: 6, time: 0, data: { turn, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]
  return { id: sid, snapshotEvents: () => events }
}

describe('Template & VM 层第三轮审计修复回归 (V1–V7)', () => {
  it('V1a: 重定义 globalThis.__tavernCallInput / __tavernOutputLimit 无法劫持 render、resume 或输出上限', async () => {
    await TemplateSandbox.prepare()
    const sandbox = await TemplateSandbox.create(makeContext(), true)
    try {
      sandbox.render(
        `<%
          Object.defineProperty(globalThis, '__tavernCallInput', {
            configurable: false,
            get() { return JSON.stringify({ text: 'HIJACKED', data: {}, variables: { global: {}, local: {}, message: {} }, history: [], historyIdentities: [] }); },
            set() {},
          });
          Object.defineProperty(globalThis, '__tavernOutputLimit', {
            configurable: false,
            writable: false,
            value: Infinity,
          });
        %>`,
      )
      expect(sandbox.render('REAL_BODY')).toBe('REAL_BODY')
      expect(() =>
        sandbox.resume(
          makeContext({
            phase: 'render',
            variables: { global: { mismatched: 1 }, local: {}, message: {} },
          }),
        ),
      ).toThrow(/不一致/)
      expect(() => sandbox.render(`<%- 'A'.repeat(1024 * 1024 + 8192) %>`, { pad: 'x'.repeat(2048) })).toThrow(/上限/)
    } finally {
      sandbox.dispose()
    }
  })

  it('V1b: 覆写 JSON.stringify 或原型 toJSON 无法绕过 schema/MVU 校验或伪造正则重放 applied=false', async () => {
    await TemplateSandbox.prepare()
    const sandbox = await TemplateSandbox.create(
      makeContext({
        helperMvu: { version: 1, current: { hp: 10 }, snapshots: { m0: { hp: 10 } } },
      }),
      true,
    )
    try {
      sandbox.render(
        `<%
          setVariableSchema(z.object({ x: z.number().optional() }));
          setvar('x', 42);
          activateRegex(/foo/g, () => { setvar('ran', 1); return 'BAR'; }, { generate: true, user: true });
          JSON.stringify = () => '{"applied":false,"parts":[{"key":"k","text":"FAKE","start":0}],"global":{"x":"STRING","stat_data":{"hp":999}},"local":{},"message":{}}';
        %>`,
      )
      const transformed = sandbox.transformRegexSources([{ key: 'k', text: 'foo', start: 0 }], 'generate', { role: 'user', worldinfo: false, depth: 0 }, 'ns')
      expect(transformed[0]?.text).toBe('BAR')
      const exported = sandbox.variables()
      expect(exported.message).toEqual({ x: 42, ran: 1 })
      expect(exported.global).toEqual({})
      const replay = sandbox.replay()
      expect(replay.operations.some((op) => op.kind === 'regexSources')).toBe(true)
      const rebuilt = await TemplateSandbox.rebuild(replay)
      try {
        expect(rebuilt.variables()).toEqual(exported)
      } finally {
        rebuilt.dispose()
      }
    } finally {
      sandbox.dispose()
    }

    const protoSandbox = await TemplateSandbox.create(makeContext())
    try {
      protoSandbox.render(`<% Object.prototype.toJSON = () => ({ global: { pwn: 1 }, local: {}, message: {} }); %>`)
      expect(protoSandbox.setMessageContext(null)).toEqual({ role: 'assistant', worldinfo: false, depth: 0 })
      expect(() => protoSandbox.variables()).toThrow(/toJSON/)
    } finally {
      // 异常提取不再经 QTS_Dump 调用 JS_JSONStringify，原型 toJSON 递归不会泄漏 C 句柄或触发 dispose 断言。
      protoSandbox.dispose()
    }
  })

  it('V1c: 移除 globalThis.__scopes 防止 preload/MVU 绕过，并冻结 __resetTemplateFaker', async () => {
    await TemplateSandbox.prepare()
    const preloadEntry = makeEntry({
      key: 'e1',
      uid: '1',
      comment: '[PRELOAD]',
      content: `<% setvar('scopeType', typeof globalThis.__scopes); %>`,
      templatePreload: true,
    })
    const sandbox = await TemplateSandbox.create(
      makeContext({
        entries: [preloadEntry],
        helperMvu: { version: 1, current: { hp: 10 }, snapshots: { m0: { hp: 10 } } },
      }),
    )
    try {
      expect(sandbox.render(`<%- typeof globalThis.__scopes %>|<%- getvar('scopeType') %>`)).toBe('undefined|undefined')
      const descriptor = sandbox.render(
        `<%
          const before = Object.getOwnPropertyDescriptor(globalThis, '__resetTemplateFaker');
          try { globalThis.__resetTemplateFaker = () => { throw Error('hijacked'); }; } catch {}
          const first = faker.simpleFaker.number.int({ min: 1, max: 1000000 });
          const firstLocale = faker.fakerEN.number.int({ min: 1, max: 1000000 });
          __resetTemplateFaker();
          const second = faker.simpleFaker.number.int({ min: 1, max: 1000000 });
          const secondLocale = faker.fakerEN.number.int({ min: 1, max: 1000000 });
          print(JSON.stringify({ writable: before.writable, configurable: before.configurable, sameSeed: first === second && firstLocale === secondLocale }));
        %>`,
      )
      expect(JSON.parse(descriptor)).toEqual({ writable: false, configurable: false, sameSeed: true })
    } finally {
      sandbox.dispose()
    }
  })

  it('V1d: define("__clearTemplateBasicRegex") 无法在 createTemplateGeneration 中遮蔽宿主 basic 正则清理', async () => {
    await TemplateSandbox.prepare()
    const sandbox = await TemplateSandbox.create(makeContext({ history: [{ role: 'user', content: 'foo' }] }), true)
    try {
      const hook = makeEntry({
        key: 'hook:before',
        uid: '1',
        comment: '[GENERATE:BEFORE]',
        content: `<%
          activateRegex(/foo/g, 'BASIC', { basic: true, user: true });
          define('__prepareTemplateBasicRegex', () => { setvar('shadowedPrepare', 1); });
          define('__clearTemplateBasicRegex', () => { setvar('shadowedClear', 1); });
        %>`,
      })
      const gen = createTemplateGeneration(sandbox, [hook], { char: 'Alice', user: 'Bob' }, new Map())
      const seq: Array<{ message: ChatMessage; worldinfo: boolean; depth: number; tokens: number }> = [
        { message: { role: 'user', content: 'foo' }, worldinfo: false, depth: 0, tokens: 1 },
      ]
      gen.processTemplateSequence!(seq)
      expect(seq[0]!.message.content).toBe('BASIC')
      // basic 阶段已被真实关闭，后续 generate 阶段不再套用 basic 规则，且未触发 define 注入。
      expect(sandbox.transformRegex('foo', 'generate', { role: 'user', worldinfo: false, depth: 0 })).toBe('foo')
      expect(sandbox.variables().message).toEqual({})
      const replay = sandbox.replay()
      const rebuilt = await TemplateSandbox.rebuild(replay)
      try {
        expect(rebuilt.transformRegex('foo', 'generate', { role: 'user', worldinfo: false, depth: 0 })).toBe('foo')
      } finally {
        rebuilt.dispose()
      }
    } finally {
      sandbox.dispose()
    }
  })

  it('V2: evaluate/evaluateHandle/conditionState 遇到 QuickJS 超时中断统一转抛计算超时，onTurnEnd 保留楼层重试', async () => {
    await TemplateSandbox.prepare()
    const sandbox = await TemplateSandbox.create(makeContext())
    try {
      sandbox.render(`<% activateRegex(/a/g, () => { while (true) {} }, { message: true, assistant: true }); %>`)
      ;(sandbox as unknown as { deadline: number }).deadline = Date.now() + 20
      expect(() => sandbox.transformRegex('a', 'message', { role: 'assistant', worldinfo: false, depth: 0 })).toThrow(/^EJS 模板计算超时$/)
    } finally {
      sandbox.dispose()
    }

    const sandbox2 = await TemplateSandbox.create(makeContext())
    try {
      sandbox2.render(`<% Object.defineProperty(variables, 'spin', { enumerable: true, get() { while (true) {} } }); %>`)
      ;(sandbox2 as unknown as { deadline: number }).deadline = Date.now() + 20
      expect(() => sandbox2.condition('true')).toThrow(/^EJS 模板计算超时$/)
    } finally {
      sandbox2.dispose()
    }

    // 端到端验证：回复阶段 message 正则触发 QuickJS 中断超时，经 TemplateOutputCommitError 保留原楼层与未提交 WAL。
    const fx = await setupTurnFixture(`<% activateRegex(/SPIN/g, () => { while (true) {} }, { message: true, assistant: true }); %>角色设定`)
    await expect(onTurnEnd(fx.state, fx.sid, completedReplySession(fx.sid, 'SPIN'))).rejects.toSatisfy(
      (error: unknown) => error instanceof TemplateOutputCommitError && /EJS 模板计算超时/.test(String(error)),
    )
    expect(fx.state.openFloors.has(fx.sid)).toBe(true)
    expect((await fx.ws.wal.validateFloor(`${fx.sid}#t1`)).committed).toBe(false)
  }, 30000)

  it('V3a: 同步 evaluate、条件状态与异步微任务抛 BigInt/Symbol 安全格式化，不再抛 BigInt 序列化 TypeError', async () => {
    await TemplateSandbox.prepare()
    const sandbox = await TemplateSandbox.create(makeContext())
    try {
      sandbox.render(`<% activateRegex(/a/g, () => { throw 1n; }, { message: true, assistant: true }); %>`)
      expect(() => sandbox.transformRegex('a', 'message', { role: 'assistant', worldinfo: false, depth: 0 })).toThrow(/^EJS 模板失败：1n$/)

      sandbox.render(`<% activateRegex(/b/g, () => { throw Symbol('sym'); }, { message: true, assistant: true }); %>`)
      expect(() => sandbox.transformRegex('b', 'message', { role: 'assistant', worldinfo: false, depth: 0 })).toThrow(/^EJS 模板失败：Symbol\(sym\)$/)

      sandbox.render(`<% Object.defineProperty(variables, 'boom', { enumerable: true, get() { throw 42n; } }); %>`)
      expect(() => sandbox.condition('true')).toThrow(/^@@if 条件状态读取失败：42n$/)
    } finally {
      sandbox.dispose()
    }
  })

  it('V3b: 回复阶段抛 BigInt 或写入超过 1 MiB 变量属于确定性脚本异常，onTurnEnd 不应锁死楼层', async () => {
    // 场景 1：message 正则回调抛 BigInt
    const f1 = await setupTurnFixture(`<% activateRegex(/TRIGGER/g, () => { throw 1n; }, { message: true, assistant: true }); %>角色设定`)
    await expect(onTurnEnd(f1.state, f1.sid, completedReplySession(f1.sid, 'TRIGGER'))).rejects.toSatisfy(
      (error: unknown) => !(error instanceof TemplateOutputCommitError) && /EJS 模板失败：1n/.test(String(error)),
    )
    expect(f1.state.openFloors.has(f1.sid)).toBe(false)
    expect((await f1.ws.wal.validateFloor(`${f1.sid}#t1`)).committed).toBe(true)
    await expect(onTurnStart(f1.state, f1.sid, 2)).resolves.toBeUndefined()

    // 场景 2：回复模板写入 > 1 MiB 变量
    const f2 = await setupTurnFixture(`<% incvar('runs') %>角色设定`)
    await expect(
      onTurnEnd(f2.state, f2.sid, completedReplySession(f2.sid, `<% setvar('huge', 'x'.repeat(1100000)) %>完成`)),
    ).rejects.toSatisfy(
      (error: unknown) => !(error instanceof TemplateOutputCommitError) && /模板变量超过 1 MiB 上限/.test(String(error)),
    )
    expect(f2.state.openFloors.has(f2.sid)).toBe(false)
    expect((await f2.ws.wal.validateFloor(`${f2.sid}#t1`)).committed).toBe(true)
    expect((await loadTemplateState(f2.ws.fs)).variables.message.runs).toBe(1)
    await expect(onTurnStart(f2.state, f2.sid, 2)).resolves.toBeUndefined()
  }, 30000)

  it('V4: @@if 纯 JS 表达式兼容 %> 字面量与 // 注释，并拦截一切非变量注册表副作用', async () => {
    await TemplateSandbox.prepare()
    const entry = makeEntry({
      key: 'book:target',
      uid: 'target',
      comment: 'target',
      content: 'TARGET',
      templateCondition: `getvar('tag') === '%>' // allow comment`,
    })
    const sandbox = await TemplateSandbox.create(makeContext({ entries: [entry] }), true)
    try {
      sandbox.render(`<% setvar('tag', '%' + '>'); %>`)
      expect(sandbox.condition(`getvar('tag') === '%>' // trailing comment`)).toBe(true)
      expect(sandbox.condition(`getvar('tag') === 'other' // comment`)).toBe(false)
      // activewi 内部的 templateCondition 同样支持 %> 与 // 注释
      expect(sandbox.render(`<%- (await activewi('book', 'target'))?.uid || 'none' %>`)).toBe('target')

      // 拦截所有注册表/定义/schema/激活/变量副作用（含未 await 的异步激活与链式微任务）
      for (const expr of [
        `(injectPrompt('p', 'x'), true)`,
        `(activateRegex(/x/g, 'y', { message: true }), true)`,
        `(activewi('book', 'target'), true)`,
        `(activateWorldInfoByKeywords(['target']), true)`,
        `(define('evil', 1), true)`,
        `(setVariableSchema(z.object({})), true)`,
        `(setvar('mutated', 1), true)`,
      ]) {
        expect(() => sandbox.condition(expr)).toThrow(/@@if 条件必须只读/)
      }
      // 链式微任务在条件微任务排空期间仍受只读守卫阻断，不能写入注入注册表。
      expect(sandbox.condition(`(Promise.resolve().then(() => Promise.resolve().then(() => injectPrompt('p', 'microtask'))), true)`)).toBe(true)
      expect(sandbox.hasMessageRegex()).toBe(false)
      expect(sandbox.resolveOutlets('{{outletPromptsInjected:p}}')).toBe('')
      expect(sandbox.variables().message).toEqual({ tag: '%>' })
      // 只读守卫退出后正常模板渲染仍可写入变量。
      sandbox.render(`<% setvar('afterCondition', 1); %>`)
      expect(sandbox.variables().message).toEqual({ tag: '%>', afterCondition: 1 })

      // 含 %> 的 @@if 条件重放冷恢复一致
      const replay = sandbox.replay()
      const rebuilt = await TemplateSandbox.rebuild(replay)
      try {
        expect(rebuilt.variables()).toEqual(sandbox.variables())
      } finally {
        rebuilt.dispose()
      }
    } finally {
      sandbox.dispose()
    }
  })

  it('V5: transformRegex 与 resolveOutlets 走实参传值并动态扩容，26 MiB 文本不再因 32 MiB 初始堆 OOM', async () => {
    await TemplateSandbox.prepare()
    const big = 'A'.repeat(26 * 1024 * 1024) + 'NEEDLE'
    const sandbox = await TemplateSandbox.create(makeContext())
    try {
      sandbox.render(`<% activateRegex(/NEEDLE/g, 'FOUND', { message: true, assistant: true }); %>`)
      const replaced = sandbox.transformRegex(big, 'message', { role: 'assistant', worldinfo: false, depth: 0 })
      expect(replaced.length).toBe(26 * 1024 * 1024 + 5)
      expect(replaced.endsWith('FOUND')).toBe(true)

      const resolved = sandbox.resolveOutlets(big)
      expect(resolved.length).toBe(big.length)
      expect(resolved.endsWith('NEEDLE')).toBe(true)
    } finally {
      sandbox.dispose()
    }
  }, 30000)

  it('V6: templateWorldInfo keywordMatch 遇到非法正则关键词时跳过而非击穿筛选与主动激活', async () => {
    const entries = [
      makeEntry({ key: 'b:bad1', uid: 'bad1', comment: 'bad1', content: 'BAD1', keys: ['/[unclosed/'] }),
      makeEntry({ key: 'b:bad2', uid: 'bad2', comment: 'bad2', content: 'BAD2', keys: ['/dup/ii'] }),
      makeEntry({ key: 'b:good', uid: 'good', comment: 'good', content: 'GOOD', keys: ['hero'] }),
    ]
    const out = await isolated('template', {
      context: makeContext({ entries }),
      texts: [
        `<%
          const selected = selectActivatedEntries(await getWorldInfoData('book'), ['hello hero']);
          const activated = await activateWorldInfoByKeywords(['hello hero']);
          print(JSON.stringify({ selected: selected.map(e => e.uid), activated: activated.map(e => e.uid) }));
        %>`,
      ],
    })
    expect(JSON.parse(out.texts[0]!)).toEqual({ selected: ['good'], activated: ['good'] })
  })

  it('V7: TemplateWorkerCache.take 在 dispose() 抛错时安全吞错，不阻断冷回退且不掩盖校验错误', () => {
    const cache = new TemplateWorkerCache()
    const context = makeContext({ sessionId: 's1', cardId: 'c1' })
    const replay = {
      version: 2 as const,
      formatterVersion: 2 as const,
      context,
      operations: [],
      variables: emptyTemplateScopes(),
      messageVariablesHash: '0'.repeat(64),
    }
    const key = templateWorkerCacheKey(replay, context)!

    // 场景 1：key 不匹配时 dispose 抛错，仍应安全返回 undefined 交由冷恢复处理
    const throwingMissSandbox = {
      dispose() { throw new Error('dispose-boom-on-miss') },
    } as unknown as TemplateSandbox
    cache.keep(throwingMissSandbox, replay, context)
    expect(cache.take('different-key', replay, 1024)).toBeUndefined()

    // 场景 2：verifyReplayState 抛错且清理 dispose 也抛错，必须保留原始校验失败原因
    const throwingVerifySandbox = {
      restartBudget() {},
      verifyReplayState() { throw new Error('original-verify-error') },
      dispose() { throw new Error('dispose-boom-on-error') },
    } as unknown as TemplateSandbox
    cache.keep(throwingVerifySandbox, replay, context)
    expect(() => cache.take(key, replay, 1024)).toThrow('original-verify-error')
  })
})
