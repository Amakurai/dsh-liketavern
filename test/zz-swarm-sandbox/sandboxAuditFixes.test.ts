/**
 * 沙箱、卡片桥接、MVU 命令与 WAL 楼层恢复的回归测试：
 * 验证已回滚归档与重开活动楼层并存、加载后隐式 document.write 重注入 CSP 与桥、
 * MVU Zod 只读字段键序无关性、JsonPatch 标签空白与引号边界、世界书规范 ID 并发稳定、
 * 显示重绘锁保护无空转 pending 状态，以及隔离 worker 优先淘汰无缓存实例。
 */
import { createContext, runInContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { attachHelperEvents } from '../../src/client/helperEventRouter.js'
import { defaultPreset } from '../../src/core/assemble.js'
import { tavernCardBridgeScript } from '../../src/core/cardFrame.js'
import { createHelperMvuCommandCodec } from '../../src/core/helperMvuCommands.js'
import { helperJson, type HelperSnapshot } from '../../src/core/helperRuntime.js'
import { parseHelperScriptTrees, type HelperScript, type HelperScriptContext } from '../../src/core/helperScripts.js'
import { parseHelperWorldbook } from '../../src/core/helperWorldbook.js'
import { helperWorldbookSettingsCodec } from '../../src/core/helperWorldbookSettings.js'
import { markdownCodeScanner } from '../../src/core/markdownCode.js'
import { emptyTemplateScopes, type TemplateContext } from '../../src/core/template.js'
import { emptyTemplateMessageVariables } from '../../src/core/templateMessageVariables.js'
import { DEFAULT_WI_SETTINGS } from '../../src/core/types.js'
import { resolveConfig } from '../../src/node/config.js'
import { commitHelperMvuJob, prepareHelperMvuJob } from '../../src/node/helperMvu.js'
import { commitHelperVariables, getHelperSnapshot, withHelperStoryWrite } from '../../src/node/helperRuntime.js'
import { disposeIdleComputeWorkers, isolated, isolatedWorkerStats } from '../../src/node/isolated.js'
import { TavernState } from '../../src/node/state.js'
import { TemplateSandbox } from '../../src/node/templateSandbox.js'

const tempRoots: string[] = []
const frameCleanups: Array<() => void> = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of frameCleanups.splice(0)) {
    try { cleanup() } catch {}
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

function makeCompletedTurnEvents(replyText = '门开了'): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 0,
      surfaceOp: 'append',
      data: createUserMessage({ content: [{ type: 'text', text: '推开门' }], source: { kind: 'user' } }),
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 0,
      surfaceOp: 'append',
      data: {
        stream: [{ type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } }],
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          source: { provider: 'factory', model: 'factory' },
          content: [{ type: 'text', text: replyText }],
        }),
      },
    },
    { type: 'turn/end', seq: 3, time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]
}

describe('WAL 已回滚归档与同号活动楼层并存时的写入恢复', () => {
  it('仅有已回滚归档时拒绝写入，重建同名活动楼层后允许变量、剧情写与自动 MVU 收口', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tavern-sandbox-wal-'))
    tempRoots.push(root)
    const state = new TavernState(
      {
        root,
        characters: join(root, 'characters'),
        lorebooks: join(root, 'lorebooks'),
        presets: join(root, 'presets'),
        personas: join(root, 'personas'),
        regexDir: join(root, 'regex'),
        sessions: join(root, 'sessions'),
      },
      () => resolveConfig({}),
    )
    await state.init()
    const { cardId } = await state.createCharacter('守门人')
    const sessions = new Map<string, SessionEvent[]>([
      ['s-var', makeCompletedTurnEvents('门开了')],
      ['s-mvu', makeCompletedTurnEvents('<UpdateVariable>_.set("hp", 20);</UpdateVariable>')],
    ])
    const ctx = {
      sessions: {
        get: (id: string) => (sessions.has(id) ? { id, snapshotEvents: () => sessions.get(id)! } : undefined),
      },
      get: () => undefined,
    } as unknown as Context

    await state.saveBinding({
      sessionId: 's-var',
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: true,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    await state.saveBinding({
      sessionId: 's-mvu',
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: true,
      helperMvu: true,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    const varBinding = (await state.loadBinding('s-var'))!
    const varWs = await state.storyWorkspace(cardId, varBinding.storyId)
    await varWs.wal.beginFloor('s-var#t1')
    await varWs.fs.withFloor('s-var#t1').writeText('notes/draft.txt', 'old')
    await varWs.wal.rollbackFloor('s-var#t1', varWs.fs.root)

    const snap = await getHelperSnapshot(ctx, state, 's-var', 2)
    await expect(
      commitHelperVariables(ctx, state, {
        sessionId: 's-var',
        messageId: 2,
        storyId: snap.storyId,
        historyRevision: snap.historyRevision,
        changes: [{ key: '["chat",""]', before: {}, value: { hp: 15 } }],
      }),
    ).rejects.toThrow('酒馆助手目标楼层已回滚')
    await expect(
      withHelperStoryWrite(ctx, state, 's-var', 2, snap.storyId, async (fs, begin) => {
        await begin()
        await fs.writeText('notes/custom.txt', 'blocked')
      }),
    ).rejects.toThrow('世界书目标楼层已回滚')

    // 重建同一楼层并正常提交后，旧 rolledBack 归档不能遮蔽新活动楼层
    await varWs.wal.beginFloor('s-var#t1')
    await varWs.wal.commitFloor('s-var#t1')
    const floors = await varWs.wal.listFloors()
    expect(floors.filter(item => item.floor === 's-var#t1')).toHaveLength(2)
    expect(floors.filter(item => item.floor === 's-var#t1').map(item => item.rolledBack)).toEqual([true, false])

    const updated = await commitHelperVariables(ctx, state, {
      sessionId: 's-var',
      messageId: 2,
      storyId: snap.storyId,
      historyRevision: snap.historyRevision,
      changes: [{ key: '["chat",""]', before: {}, value: { hp: 15 } }],
    })
    expect(updated.scopes['["chat",""]']).toEqual({ hp: 15 })

    await withHelperStoryWrite(ctx, state, 's-var', 2, snap.storyId, async (fs, begin) => {
      await begin()
      await fs.writeText('notes/custom.txt', 'persisted')
    })
    expect(await varWs.fs.readText('notes/custom.txt')).toBe('persisted')

    // 自动 MVU 同样在存在历史回滚归档但当前楼层已重新激活时正常准备并提交
    const mvuBinding = (await state.loadBinding('s-mvu'))!
    const mvuWs = await state.storyWorkspace(cardId, mvuBinding.storyId)
    await mvuWs.wal.beginFloor('s-mvu#t1')
    await mvuWs.fs.withFloor('s-mvu#t1').writeText('notes/mvu-draft.txt', 'old')
    await mvuWs.wal.rollbackFloor('s-mvu#t1', mvuWs.fs.root)

    await expect(
      prepareHelperMvuJob(ctx, state, { sessionId: 's-mvu', storyId: mvuBinding.storyId!, runtimeId: 'rt-1' }),
    ).rejects.toThrow('自动 MVU 目标楼层已回滚')

    await mvuWs.wal.beginFloor('s-mvu#t1')
    await mvuWs.wal.commitFloor('s-mvu#t1')

    const prepared = await prepareHelperMvuJob(ctx, state, {
      sessionId: 's-mvu',
      storyId: mvuBinding.storyId!,
      runtimeId: 'rt-1',
    })
    expect(prepared.status).toBe('pending')
    expect(prepared.job?.floor).toBe('s-mvu#t1')

    const committed = await commitHelperMvuJob(ctx, state, {
      sessionId: 's-mvu',
      storyId: mvuBinding.storyId!,
      runtimeId: 'rt-1',
      jobId: prepared.job!.id,
      token: prepared.token!,
      data: { initialized_lorebooks: {}, stat_data: { hp: 20 } },
    })
    expect(committed.status).toBe('idle')
    const mvuSnap = await getHelperSnapshot(ctx, state, 's-mvu', 2)
    expect(mvuSnap.scopes['["message",1]']).toMatchObject({ stat_data: { hp: 20 } })
  })
})

describe('交互卡 document.write 加载后隐式开流与卸载计时器清理', () => {
  it('readyState 完成后写入纯片段仍重注入可信 CSP 与桥，loading 内联片段直写且卸载取消待冲刷缓冲', async () => {
    const nativeOpen = vi.fn()
    const nativeWrite = vi.fn()
    const nativeClose = vi.fn()
    const trustedCsp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src \'none\'">'
    const trustedLib = '<script data-dsh-tavern-libraries>/* libs */</script>'
    const trustedBridge = '<script data-dsh-tavern-bridge>/* bridge */</script>'
    const windowObj = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const docObj = {
      open: nativeOpen,
      write: nativeWrite,
      close: nativeClose,
      currentScript: { outerHTML: trustedBridge },
      querySelector: (selector: string) => {
        if (selector.includes('Content-Security-Policy')) return { outerHTML: trustedCsp }
        if (selector.includes('data-dsh-tavern-libraries')) return { outerHTML: trustedLib }
        return null
      },
      readyState: 'loading',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    const context = createContext({
      crypto: webcrypto,
      window: windowObj,
      document: docObj,
      parent: { postMessage: vi.fn() },
      TextEncoder,
      clearTimeout,
      setTimeout,
      queueMicrotask,
    })
    const script = tavernCardBridgeScript({ greetings: [], greetingIndex: 0 })
      .replace(/^<script[^>]*>/, '')
      .replace(/<\/script>$/, '')
    runInContext(script, context)

    // 1) 初次解析期间的内联普通片段保持原位直写，不触发整页包装
    runInContext("document.write('<span class=\"inline\">内联</span>')", context)
    expect(nativeOpen).not.toHaveBeenCalled()
    expect(nativeWrite).toHaveBeenCalledTimes(1)
    expect(nativeWrite.mock.lastCall?.[0]).toBe('<span class="inline">内联</span>')

    // 2) <head> 开头的整页片段在 loading 期间同样进入可信头包装，但 <header> 普通标签不误判
    runInContext("document.write('<header>顶栏</header>')", context)
    expect(nativeOpen).not.toHaveBeenCalled()
    expect(nativeWrite).toHaveBeenCalledTimes(2)
    runInContext("document.write('<head><style>.c{color:red}</style></head><main>内容</main>'); document.close()", context)
    expect(nativeOpen).toHaveBeenCalledTimes(1)
    expect(nativeClose).toHaveBeenCalledTimes(1)
    const headWrapped = nativeWrite.mock.lastCall?.[0] as string
    expect(headWrapped.indexOf(trustedCsp)).toBeLessThan(headWrapped.indexOf(trustedBridge))
    expect(headWrapped.indexOf(trustedBridge)).toBeLessThan(headWrapped.indexOf('<head><style>'))

    // 3) 文档解析完成后（interactive / complete），不调 document.open 直接写 div 片段也必须补回 CSP 与桥
    docObj.readyState = 'complete'
    runInContext("document.write('<div class=\"async\">异步'); document.write('重写</div>')", context)
    expect(nativeOpen).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(nativeOpen).toHaveBeenCalledTimes(2)
    const asyncWrapped = nativeWrite.mock.lastCall?.[0] as string
    expect(asyncWrapped).toContain(trustedCsp + trustedLib + trustedBridge)
    expect(asyncWrapped).toContain('<body><div class="async">异步重写</div></body></html>')
    expect(nativeClose).toHaveBeenCalledTimes(1)

    // 未调用 close 时流保持打开，后续片段追加到同一打开流而不再次重开整页；close 后恢复拦截
    runInContext("document.write('<p>流内追加</p>')", context)
    expect(nativeOpen).toHaveBeenCalledTimes(2)
    expect(nativeWrite.mock.lastCall?.[0]).toBe('<p>流内追加</p>')
    runInContext('document.close()', context)
    expect(nativeClose).toHaveBeenCalledTimes(2)

    // 4) 卸载清理必须取消尚未触发的延迟冲刷计时器，防止销毁后污染宿主帧
    const writesBeforeCleanup = nativeWrite.mock.calls.length
    const opensBeforeCleanup = nativeOpen.mock.calls.length
    runInContext("document.open(); document.write('<html><body>不应写出</body></html>'); window.__dshTavernBridgeCleanup()", context)
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(nativeOpen).toHaveBeenCalledTimes(opensBeforeCleanup)
    expect(nativeWrite).toHaveBeenCalledTimes(writesBeforeCleanup)
  })
})

describe('MVU Zod 只读字段键序无关性与 JsonPatch 标签解析边界', () => {
  it('registerMvuSchema 在下划线只读对象键序未排序时不误丢弃合法命令，但仍拦截真实只读修改', async () => {
    const baseSnapshot: HelperSnapshot = {
      storyId: 'mvu-zod-story',
      historyRevision: 'rev-1',
      currentMessageId: 0,
      writable: true,
      scopes: {},
      messages: [{ message_id: 0, role: 'assistant', name: '角色', message: '战斗', data: {}, extra: {}, is_hidden: false }],
    }
    const listeners = new Set<(event: unknown) => void>()
    const send = (data: Record<string, unknown>) => {
      for (const listener of listeners) listener({ source: parent, data: structuredClone(data) })
    }
    const endpoint = attachHelperEvents('mvu-zod-session', baseSnapshot.storyId, message => queueMicrotask(() => send(message)))
    const parent = {
      postMessage: (message: Record<string, unknown>) => {
        if (message.action !== 'helperVariablesCommit') queueMicrotask(() => endpoint.receive(structuredClone(message)))
      },
    }
    const { build } = await import('esbuild')
    const bundled = await build({
      stdin: { contents: "import * as z from 'zod'; window.z = z", resolveDir: process.cwd() },
      bundle: true,
      format: 'iife',
      write: false,
    })
    const scope: Record<string, unknown> = {
      parent,
      console,
      TextEncoder,
      crypto: webcrypto,
      queueMicrotask,
      setTimeout,
      clearTimeout,
      document: {
        readyState: 'loading',
        body: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
        currentScript: null,
        querySelector: () => null,
      },
      addEventListener: (name: string, fn: (event: unknown) => void) => {
        if (name === 'message') listeners.add(fn)
      },
      removeEventListener: (_name: string, fn: (event: unknown) => void) => listeners.delete(fn),
    }
    scope.window = scope
    const context = createContext(scope)
    const run = (code: string) => runInContext(code, context)
    run(bundled.outputFiles[0]!.text)
    run(
      tavernCardBridgeScript({ greetings: [], greetingIndex: 0, helperSnapshot: baseSnapshot })
        .replace(/^<script[^>]*>/, '')
        .replace(/<\/script>$/, ''),
    )
    frameCleanups.push(() => {
      run('window.__dshTavernBridgeCleanup()')
      endpoint.dispose()
    })

    run('__dshTavernMvuZod.registerMvuSchema(z.z.object({ hp: z.z.number(), _meta: z.z.object({ a: z.z.number(), z: z.z.number() }) }))')
    // 传入逆序键 { z: 2, a: 1 } 的只读对象：修改 hp 必须生效，直接修改 _meta.a 必须被静默跳过
    const parsed = await run(
      `Mvu.parseMessage("_.add('hp', 5); _.set('_meta.a', 99); _.add('hp', 3);", { stat_data: { hp: 10, _meta: { z: 2, a: 1 } } })`,
    )
    expect(parsed).toEqual({
      stat_data: { hp: 18, _meta: { a: 1, z: 2 } },
      schema: '没有用别管这个',
    })
  })

  it('JsonPatch 兼容开闭标签空白，双引号内闭合字面量安全跳过且单引号坏 JSON 报格式错误', () => {
    const codec = createHelperMvuCommandCodec(helperJson, markdownCodeScanner)

    const standalone = codec.apply(
      { hp: 10, note: '' },
      codec.parse('<JsonPatch >[{"op":"delta","path":"/hp","value":4},{"op":"replace","path":"/note","value":"it\'s </JsonPatch > ok"}]</JsonPatch >'),
    )
    expect(standalone.stat_data).toEqual({ hp: 14, note: "it's </JsonPatch > ok" })

    const fenced = codec.apply(
      { hp: 10 },
      codec.parse('```xml\n<json_patch\n>\n[{"op":"delta","path":"/hp","value":6}]\n</json_patch >\n```'),
    )
    expect(fenced.stat_data).toEqual({ hp: 16 })

    expect(() => codec.parse("<JsonPatch>[{'op':'replace','path':'/hp','value':1}]</JsonPatch>")).toThrow('MVU JSON Patch 必须是有界有效 JSON')
    expect(() => codec.parse("<JsonPatch>broken ' single quote</JsonPatch>")).toThrow('MVU JSON Patch 必须是有界有效 JSON')
    expect(() => codec.parse('<JsonPatch >[{"op":"delta","path":"/hp","value":1}]')).toThrow('MVU JSON Patch 标签未闭合')
  })
})

describe('卡面世界书规范 ID 并发稳定、显示锁与无差异状态保持', () => {
  it('按展示别名更新和删除世界书时向宿主提交已解析规范 ID，并发清缓存后仍完整清理绑定目录', async () => {
    const entries = parseHelperWorldbook([{ uid: 1, name: '设定', content: '初版' }])
    const requests: Record<string, unknown>[] = []
    const listeners = new Set<(event: unknown) => void>()
    const parent = {
      postMessage: (value: Record<string, unknown>) => {
        if (String(value.action).startsWith('helperWorldbook')) requests.push(structuredClone(value))
      },
    }
    const scope: Record<string, unknown> = {
      parent,
      TextEncoder,
      crypto: webcrypto,
      queueMicrotask,
      setTimeout,
      clearTimeout,
      document: {
        readyState: 'loading',
        body: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
        currentScript: null,
        querySelector: () => null,
      },
      addEventListener: (name: string, fn: (event: unknown) => void) => {
        if (name === 'message') listeners.add(fn)
      },
      removeEventListener: (name: string, fn: (event: unknown) => void) => {
        if (name === 'message') listeners.delete(fn)
      },
    }
    scope.window = scope
    const vm = createContext(scope)
    const run = (code: string) => runInContext(code, vm)
    const baseContext = {
      settings: helperWorldbookSettingsCodec.fromNative(DEFAULT_WI_SETTINGS, ['lore-file-1']),
      storyId: 'story-wb',
      bindingRevision: 'b0',
      names: ['lore-file-1', 'keep-book'],
      global: ['lore-file-1'],
      characterName: '角色',
      character: { primary: 'lore-file-1', additional: ['lore-file-1', 'keep-book'] },
      chat: null,
    }
    run(
      tavernCardBridgeScript({ greetings: [], greetingIndex: 0, worldbooks: baseContext })
        .replace(/^<script[^>]*>/, '')
        .replace(/<\/script>$/, ''),
    )
    frameCleanups.push(() => run('window.__dshTavernBridgeCleanup()'))

    const replyOp = (index: number, result: unknown) => {
      const req = requests[index]!
      for (const fn of listeners) {
        fn({
          source: parent,
          data: {
            source: 'dsh-tavern-card',
            action: 'helperWorldbookResult',
            requestId: req.requestId,
            runtimeId: req.runtimeId,
            ok: true,
            result,
          },
        })
      }
    }
    const replyBind = (index: number, context: unknown) => {
      const req = requests[index]!
      for (const fn of listeners) {
        fn({
          source: parent,
          data: {
            source: 'dsh-tavern-card',
            action: 'helperWorldbookBindResult',
            requestId: req.requestId,
            runtimeId: req.runtimeId,
            ok: true,
            context,
          },
        })
      }
    }

    // 通过展示名“魔法设定集”发起更新：get 解析出规范 ID lore-file-1 后，replace 直接以 lore-file-1 提交
    const updated = run('updateWorldbookWith("魔法设定集", rows => { rows[0].content = "二版"; return rows })')
    expect(requests[0]).toMatchObject({ name: '魔法设定集', operation: 'get' })
    replyOp(0, { snapshot: { name: 'lore-file-1', revision: 'r0', entries } })
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toMatchObject({ name: 'lore-file-1', operation: 'replace', revision: 'r0' })
    const nextEntries = parseHelperWorldbook(requests[1]!.entries)
    replyOp(1, { snapshot: { name: 'lore-file-1', revision: 'r1', entries: nextEntries } })
    expect((await updated)[0].content).toBe('二版')

    // 通过展示名删除世界书，并在 delete 在途时触发绑定变更清空 cache
    const deleting = run('deleteWorldbook("魔法设定集")')
    expect(requests[2]).toMatchObject({ name: '魔法设定集', operation: 'get' })
    replyOp(2, { snapshot: { name: 'lore-file-1', revision: 'r1', entries: nextEntries } })
    await vi.waitFor(() => expect(requests).toHaveLength(4))
    expect(requests[3]).toMatchObject({ name: 'lore-file-1', operation: 'delete', revision: 'r1' })

    const rebinding = run('rebindChatWorldbook("current", null)')
    await vi.waitFor(() => expect(requests).toHaveLength(5))
    replyBind(4, { ...baseContext, bindingRevision: 'b1' })
    await rebinding

    replyOp(3, { deleted: true })
    expect(await deleting).toBe(true)
    expect(run('getWorldbookNames()')).toEqual(['keep-book'])
    expect(run('getGlobalWorldbookNames()')).toEqual([])
    expect(run('getCharWorldbookNames("current")')).toEqual({ primary: null, additional: ['keep-book'] })
  })

  it('空初值与同步回撤不虚标 pending，在途提交期间回撤仍补发，显示重绘锁拦截脚本库刷新与重试', async () => {
    const baseSnapshot: HelperSnapshot = {
      storyId: 'story-persist',
      historyRevision: 'h0',
      currentMessageId: 0,
      writable: true,
      scopes: { '["chat",""]': { n: 0 } },
      messages: [{ message_id: 0, role: 'assistant', name: '灯塔', message: '正文', is_hidden: false, data: {}, extra: {} }],
    }
    const scriptTrees = parseHelperScriptTrees([{ id: 'empty-init', name: '空初值脚本', enabled: true, data: {}, content: '1' }])
    const scriptContext: HelperScriptContext = {
      storyId: 'story-persist',
      bindingRevision: 'sb0',
      libraries: [{ type: 'global', revision: 'g0', trees: scriptTrees }],
    }
    const messages: Record<string, unknown>[] = []
    const listeners = new Set<(event: unknown) => void>()
    const parent = { postMessage: vi.fn((msg: Record<string, unknown>) => messages.push(structuredClone(msg))) }
    const scope: Record<string, unknown> = {
      parent,
      TextEncoder,
      crypto: webcrypto,
      queueMicrotask,
      setTimeout,
      clearTimeout,
      document: {
        readyState: 'loading',
        body: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
        currentScript: null,
        querySelector: () => null,
      },
      addEventListener: (name: string, fn: (event: unknown) => void) => {
        if (name === 'message') listeners.add(fn)
      },
      removeEventListener: (name: string, fn: (event: unknown) => void) => {
        if (name === 'message') listeners.delete(fn)
      },
    }
    scope.window = scope
    const vm = createContext(scope)
    const run = (code: string) => runInContext(code, vm)
    run(
      tavernCardBridgeScript({
        greetings: [],
        greetingIndex: 0,
        helperSnapshot: baseSnapshot,
        scriptContext: { script: scriptTrees[0] as HelperScript, trees: scriptTrees, libraryType: 'global' },
        scriptLibraries: scriptContext,
      })
        .replace(/^<script[^>]*>/, '')
        .replace(/<\/script>$/, ''),
    )
    frameCleanups.push(() => run('window.__dshTavernBridgeCleanup()'))

    // 空 data:{} 初始化后没有真实差异，同步状态保持 saved，不阻碍同一 tick 的显示重绘守卫
    expect(run('getHelperPersistenceStatus()')).toBe('saved')
    run('replaceVariables({ n: 1 }); replaceVariables({ n: 0 })')
    expect(run('getHelperPersistenceStatus()')).toBe('saved')

    run('updateScriptTreesWith(t => { t[0].name = "临时"; return t }, { type: "global" }); updateScriptTreesWith(t => { t[0].name = "空初值脚本"; return t }, { type: "global" })')
    expect(run('getHelperScriptStatus()')).toBe('saved')

    await Promise.resolve()
    expect(messages.filter(m => m.action === 'helperVariablesCommit' || m.action === 'helperScriptLibraryCommit')).toHaveLength(0)

    // 在途提交期间本地改回旧确认值，仍保持 pending 并在首批回执后补发第二批
    run('replaceVariables({ n: 1 })')
    const flushing = run('flushHelperVariables()')
    run('replaceVariables({ n: 0 })')
    expect(run('getHelperPersistenceStatus()')).toBe('pending')
    const varCommits = () => messages.filter(m => m.action === 'helperVariablesCommit')
    expect(varCommits()).toHaveLength(1)
    for (const fn of listeners) {
      fn({
        source: parent,
        data: {
          source: 'dsh-tavern-card',
          action: 'helperVariablesResult',
          requestId: varCommits()[0]!.requestId,
          runtimeId: varCommits()[0]!.runtimeId,
          ok: true,
          scopes: { '["chat",""]': { n: 1 } },
        },
      })
    }
    await vi.waitFor(() => expect(varCommits()).toHaveLength(2))
    expect(varCommits()[1]).toMatchObject({ changes: [{ key: '["chat",""]', before: { n: 1 }, value: { n: 0 } }] })
    for (const fn of listeners) {
      fn({
        source: parent,
        data: {
          source: 'dsh-tavern-card',
          action: 'helperVariablesResult',
          requestId: varCommits()[1]!.requestId,
          runtimeId: varCommits()[1]!.runtimeId,
          ok: true,
          scopes: { '["chat",""]': { n: 0 } },
        },
      })
    }
    await flushing
    expect(run('getHelperPersistenceStatus()')).toBe('saved')

    // 脚本库保存失败后进入显示重绘锁期间，refreshHelperScripts 与 flushHelperScripts({ retry: true }) 均必须拒绝发信
    run('updateScriptTreesWith(t => { t[0].name = "待重试"; return t }, { type: "global" })')
    const failedSave = run('flushHelperScripts()')
    const scriptCommits = () => messages.filter(m => m.action === 'helperScriptLibraryCommit' || m.action === 'helperScriptLibrariesGet')
    expect(scriptCommits()).toHaveLength(1)
    for (const fn of listeners) {
      fn({
        source: parent,
        data: {
          source: 'dsh-tavern-card',
          action: 'helperScriptLibraryResult',
          requestId: scriptCommits()[0]!.requestId,
          runtimeId: scriptCommits()[0]!.runtimeId,
          ok: false,
          error: '修订冲突',
        },
      })
    }
    await expect(failedSave).rejects.toThrow('修订冲突')

    run('window.__dshTavernDisplayLocked = true')
    await expect(run('refreshHelperScripts({ discardUnsaved: true })')).rejects.toThrow('卡面正在重绘')
    await expect(run('flushHelperScripts({ retry: true })')).rejects.toThrow('卡面正在重绘')
    expect(scriptCommits()).toHaveLength(1)
  })
})

describe('隔离计算池内存扩容优先保留活跃缓存 VM 与阶段回调释放', () => {
  it('扩容需要回收空闲 worker 时优先淘汰无缓存实例，保留较早空闲的缓存 QuickJS VM', async () => {
    await disposeIdleComputeWorkers()
    await TemplateSandbox.prepare()
    TemplateSandbox.clearPhaseReporter()

    const preset = defaultPreset()
    preset.entries = preset.entries.filter(entry => ['main', 'chatHistory'].includes(entry.identifier))
    preset.entries.find(entry => entry.identifier === 'main')!.content = '<% incGlobalVar("runs") %>运行=<%- getGlobalVar("runs") %>'
    const history = [{ role: 'user' as const, content: '开始' }]
    const genContext: TemplateContext = {
      variables: emptyTemplateScopes(),
      char: 'Alice',
      user: 'Bob',
      card: { name: 'Alice' },
      entries: [],
      presets: preset.entries,
      history,
      historyIdentities: [{ messageId: 'u1', swipeId: 0 }],
      messageVariables: emptyTemplateMessageVariables(),
      now: 1000,
      seed: 1,
      phase: 'generate',
      sessionId: 'session-evict-test',
      cardId: 'card-evict-test',
    }

    // Worker 1 (128 MB) 执行组装任务并保留活沙箱缓存
    const assembled = await isolated('assemble', {
      preset,
      card: null,
      personaDescription: '',
      history,
      wi: null,
      memories: [],
      worldDeltas: [],
      regexRules: [],
      macroCtx: { char: 'Alice', user: 'Bob' },
      seed: 1,
      budget: { maxTokens: 100_000, reserveForOutput: 0 },
      templates: genContext,
    })
    expect(assembled.templateReplay).toBeDefined()

    // 并发触发两个小展示任务以拉起无缓存的 Worker 2 (128 MB)，随后再单独跑一次无缓存任务使 Worker 2 成为更新的 lastUsed
    await Promise.all([
      isolated('render', { text: 'a', rules: [], macroCtx: { char: 'Alice', user: 'Bob' } }),
      isolated('render', { text: 'b', rules: [], macroCtx: { char: 'Alice', user: 'Bob' } }),
    ])
    await isolated('render', { text: 'c', rules: [], macroCtx: { char: 'Alice', user: 'Bob' } })
    expect(isolatedWorkerStats().idle).toBe(2)

    // 发送 >256 KiB 输入触发 256 MB 档位扩容：应淘汰无缓存的 Worker 2，保留较早空闲但持有缓存 VM 的 Worker 1
    const bigText = 'x'.repeat(300_000)
    const bigRendered = await isolated('render', { text: bigText, rules: [], macroCtx: { char: 'Alice', user: 'Bob' } })
    expect(bigRendered.text.length).toBe(300_000)

    const hitsBefore = isolatedWorkerStats().cacheHits
    const rendered = await isolated('template', {
      texts: ['<%- getGlobalVar("runs") %>'],
      context: {
        ...genContext,
        phase: 'render',
        variables: assembled.templateVariables!,
        messageVariables: assembled.templateMessageVariables!,
      },
      replay: assembled.templateReplay,
    })
    expect(rendered.texts).toEqual(['1'])
    expect(isolatedWorkerStats().cacheHits).toBe(hitsBefore + 1)
    await disposeIdleComputeWorkers()
  })
})
