/**
 * 前后端用户体验与交互性能优化回归：
 * - 楼层操作状态批处理（getFloorActionStates 单次事件快照、合并 RPC、仅末层显示续写、Ctrl+Enter 快捷保存）
 * - AI 代答直填输入框、草稿方向扩写（hint）、连续重抽去重与飞行期并发手写保护
 * - SillyTavern / 原生正则 JSON 导入解析与规则上下排序保存
 * - 会话芯片懒加载角色列表、未保存绑定拦截与角色笔记直达入口
 * - 多条目世界书按需挂载表单与复制条目、搜索框清空与 Esc 拦截、默认预设/人设徽标、记忆筛选与笔记预算提示
 */
import type { ComponentProps, ReactNode } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage, type GenerateOptions, type LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TAVERN_GREETING_SOURCE } from '../src/core/greetingLog.js'
import { parseImportedRegexRules } from '../src/core/regex.js'
import { JOURNAL_TURN_TOKEN_BUDGET } from '../src/core/turnBudget.js'
import type { WorldInfoEntry } from '../src/core/types.js'
import { TavernFloorActions } from '../src/client/actions.js'
import { invalidateCharacter, invalidateSessionBinding } from '../src/client/cache.js'
import { TavernHeaderChip, defaultBinding } from '../src/client/chip.js'
import { DraftScope } from '../src/client/drafts.js'
import { installChoiceInput } from '../src/client/helperChoices.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { LorebookEditor } from '../src/client/panel/lorebookEditor.js'
import { MemorySection } from '../src/client/panel/memory.js'
import { PersonasSection } from '../src/client/panel/personas.js'
import { PresetsSection } from '../src/client/panel/presets.js'
import { RegexSection } from '../src/client/panel/regex.js'
import { TavernSeatChip } from '../src/client/seatChip.js'
import { markSessionView } from '../src/client/sessionViews.js'
import type { Envelope, TavernRemote } from '../src/client/types.js'
import { Badge, Btn, ConfirmDialog, Dialog, FileBtn, IconBtn, SearchInput, Select } from '../src/client/util.js'
import { resolveConfig, type TavernConfigRaw, type TavernSettingsScope } from '../src/node/config.js'
import { getFloorActionStates } from '../src/node/floors.js'
import { impersonate } from '../src/node/impersonate.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'
import { jsonEditRevision } from '../src/state/characterRevision.js'
import { appendSiblingFork } from '../src/state/siblings.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: (props: { open: boolean; onClose?: () => void; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: (props: { text: string }) => <div role="status">{props.text}</div>,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconBranchOutlineMedium: () => null,
  IconChevronDownOutlineMedium: () => null,
  IconChevronLeftOutlineMedium: () => null,
  IconChevronRightOutlineMedium: () => null,
  IconCopyOutlineMedium: () => null,
  IconDownloadOutlineMedium: () => null,
  IconEditOutlineMedium: () => null,
  IconFolderOpenOutlineMedium: () => null,
  IconListPenOutlineMedium: () => null,
  IconLoadingOutlineMedium: () => null,
  IconPlayOutlineMedium: () => null,
  IconPlusOutlineMedium: () => null,
  IconRefreshOutlineMedium: () => null,
  IconSearchOutlineMedium: () => null,
  IconTrashOutlineMedium: () => null,
  IconUserOutlineMedium: () => null,
}))
vi.mock('../src/client/helperScripts.js', () => ({ HelperScripts: () => null }))

const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })
const mounted: ReactTestRenderer[] = []
const tempDirs: string[] = []
const cleanups: Array<() => void> = []

beforeEach(() => {
  setTavernLocale('zh')
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    sessionStorage: { getItem: () => 'ux-opt-tests', setItem() {} },
  }))
})

afterEach(async () => {
  for (const fn of cleanups.splice(0)) fn()
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  vi.unstubAllGlobals()
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function makeTempState(rawConfig: TavernConfigRaw = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tavern-ux-opt-'))
  tempDirs.push(root)
  let currentRaw: TavernConfigRaw = structuredClone(rawConfig)
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
    () => resolveConfig(currentRaw),
  )
  await state.init()
  const settingsScope: TavernSettingsScope = {
    get: () => resolveConfig(currentRaw),
    raw: () => currentRaw,
    update: (patch: TavernConfigRaw) => {
      currentRaw = {
        ...currentRaw,
        ...patch,
        defaults: { ...currentRaw.defaults, ...patch.defaults },
      }
    },
  } as unknown as TavernSettingsScope
  return { root, state, settingsScope }
}

async function renderView(node: ReactNode): Promise<ReactTestRenderer> {
  let view!: ReactTestRenderer
  await act(async () => { view = create(node) })
  mounted.push(view)
  return view
}

const useTavernSessionsFor = (sessionId: string) =>
  <T,>(select: (s: { byId: Record<string, { projectionValues: { agentPreset: string } }> }) => T): T =>
    select({ byId: { [sessionId]: { projectionValues: { agentPreset: 'tavern' } } } })

describe('批量楼层操作状态与操作条优化', () => {
  it('getFloorActionStates 单次扫描会话事件，准确区分开场白、中间楼层与末层可续写状态', async () => {
    const { state } = await makeTempState()
    const { cardId } = await state.createCharacter('守夜人')
    await state.saveCharacter(cardId, { firstMes: '第一版开场', alternateGreetings: ['第二版开场'] })
    const sessionId = 'session-batch-floors'
    await state.saveBinding({
      ...defaultBinding(sessionId, cardId),
      createdAt: new Date(0).toISOString(),
    })
    await appendSiblingFork(state.paths.root, {
      parentSessionId: sessionId,
      childSessionId: 'session-sibling-2',
      turn: 2,
      createdAt: new Date(0).toISOString(),
    })

    const events: SessionEvent[] = [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          stream: [],
          turn: 1,
          step: 1,
          message: { ...createAssistantMessage({ content: [{ type: 'text', text: '第一版开场' }], source: TAVERN_GREETING_SOURCE }), id: 'msg-1' },
        },
      },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 2 } },
      {
        type: 'user/message',
        surfaceOp: 'append',
        data: { ...createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }), id: 'u-2' },
      },
      {
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          stream: [],
          turn: 2,
          step: 1,
          message: { ...createAssistantMessage({ content: [{ type: 'text', text: '第二层回复' }], source: { provider: 'test', model: 'test' } }), id: 'msg-2' },
        },
      },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 3 } },
      {
        type: 'user/message',
        surfaceOp: 'append',
        data: { ...createUserMessage({ content: [{ type: 'text', text: '继续走' }], source: { kind: 'user' } }), id: 'u-3' },
      },
      {
        type: 'assistant/message',
        surfaceOp: 'append',
        data: {
          stream: [],
          turn: 3,
          step: 1,
          message: { ...createAssistantMessage({ content: [{ type: 'text', text: '第三层回复' }], source: { provider: 'test', model: 'test' } }), id: 'msg-3' },
        },
      },
      { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } },
    ].map((e, seq) => ({ ...e, seq, time: seq })) as SessionEvent[]

    const snapshotEvents = vi.fn(() => events)
    const liveSessions = new Map<string, unknown>([
      [sessionId, { id: sessionId, header: { agentPreset: 'tavern' }, snapshotEvents }],
      ['session-sibling-2', { id: 'session-sibling-2', header: { agentPreset: 'tavern' }, snapshotEvents: () => [] }],
    ])
    const ctx = {
      get: (key: string) => (key === 'sessionProjections' ? { stateOf: () => 'tavern' } : undefined),
      agents: { get: () => undefined },
      sessions: { get: (id: string) => liveSessions.get(id), exists: async (id: string) => liveSessions.has(id) },
    } as unknown as Context

    const result = await getFloorActionStates({ ctx, state }, sessionId, ['msg-1', 'msg-2', 'msg-3'])
    expect(snapshotEvents).toHaveBeenCalledOnce()
    expect(result.items).toHaveLength(3)
    expect(result.items[0]).toEqual({
      greeting: { isGreeting: true, started: true, swipe: null },
      siblings: { swipe: null },
      canContinue: false,
    })
    expect(result.items[1]).toEqual({
      greeting: { isGreeting: false, started: true, swipe: null },
      siblings: { swipe: { turn: 2, index: 0, total: 2, siblings: [sessionId, 'session-sibling-2'] } },
      canContinue: false,
    })
    expect(result.items[2]).toEqual({
      greeting: { isGreeting: false, started: true, swipe: null },
      siblings: { swipe: null },
      canContinue: true,
    })

    // 若新轮次尚未关闭（openTurn !== null），所有楼层均不可续写
    const openEvents = [...events, { type: 'turn/start', data: { turn: 4 }, seq: 99, time: 99 } as unknown as SessionEvent]
    snapshotEvents.mockReturnValueOnce(openEvents)
    const openResult = await getFloorActionStates({ ctx, state }, sessionId, ['msg-3'])
    expect(openResult.items[0]!.canContinue).toBe(false)
  })

  it('同批挂载的多条 TavernFloorActions 合并为单次批量 RPC，旧楼层在新楼层挂载后自动收起续写且支持 Ctrl+Enter 保存编辑', async () => {
    const sessionId = 'session-coalesce-actions'
    invalidateSessionBinding(sessionId)
    cleanups.push(markSessionView(sessionId, true))

    const getFloorActionStatesMock = vi.fn<TavernRemote['getFloorActionStates']>(async ({ messageIds }) =>
      ok({
        items: messageIds.map((id) => ({
          greeting: { isGreeting: false, started: true, swipe: null },
          siblings: { swipe: null },
          canContinue: id === messageIds.at(-1),
        })),
      }),
    )
    const editUserMessage = vi.fn<TavernRemote['editUserMessage']>(async () => ok({ childSessionId: 'child-edited', title: '编辑分支' }))
    const remote = {
      getSessionBinding: vi.fn(async () => ok({ binding: defaultBinding(sessionId, 'card-1'), userName: '旅人', canSwipeGreeting: false, conversationStarted: true })),
      getFloorActionStates: getFloorActionStatesMock,
      getFloorUserMessage: vi.fn(async () => ok({ turn: 2, text: '原台词' })),
      editUserMessage,
    } as unknown as TavernRemote
    const sessions = { open: vi.fn(), refresh: vi.fn(async () => {}) }
    const useSessions = useTavernSessionsFor(sessionId)

    const view = await renderView(
      <div>
        <TavernFloorActions remote={remote} sessionId={sessionId} sessions={sessions} messageId="m-1" useSessions={useSessions} />
        <TavernFloorActions remote={remote} sessionId={sessionId} sessions={sessions} messageId="m-2" useSessions={useSessions} />
      </div>,
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15))
    })
    expect(getFloorActionStatesMock).toHaveBeenCalledExactlyOnceWith({ sessionId, messageIds: ['m-1', 'm-2'] })
    expect(view.root.findAllByProps({ 'aria-label': t('actions.continue') })).toHaveLength(1)

    // 同一会话新增第 3 层并拿到 canContinue=true 后，第 2 层的续写按钮立即收起，只剩最新楼层保留续写
    await act(async () => {
      view.update(
        <div>
          <TavernFloorActions remote={remote} sessionId={sessionId} sessions={sessions} messageId="m-1" useSessions={useSessions} />
          <TavernFloorActions remote={remote} sessionId={sessionId} sessions={sessions} messageId="m-2" useSessions={useSessions} />
          <TavernFloorActions remote={remote} sessionId={sessionId} sessions={sessions} messageId="m-3" useSessions={useSessions} />
        </div>,
      )
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15))
    })
    expect(getFloorActionStatesMock).toHaveBeenCalledTimes(2)
    expect(view.root.findAllByProps({ 'aria-label': t('actions.continue') })).toHaveLength(1)

    // 打开编辑用户消息弹窗并用 Ctrl+Enter 快捷提交
    const editBtns = view.root.findAllByProps({ 'aria-label': t('actions.editUser') })
    await act(async () => { editBtns[1]!.props.onClick() })
    const textarea = view.root.findByType('textarea')
    await act(async () => { textarea.props.onChange({ target: { value: '改写后的台词' } }) })
    await act(async () => {
      textarea.props.onKeyDown({ ctrlKey: true, metaKey: false, key: 'Enter', nativeEvent: { isComposing: false }, preventDefault: vi.fn() })
    })
    expect(editUserMessage).toHaveBeenCalledWith({ sessionId, messageId: 'm-2', text: '改写后的台词' })
    expect(sessions.open).toHaveBeenCalledWith('child-edited')
  })
})

describe('AI 代答草稿扩写与宿主输入框直填', () => {
  it('后端 impersonate 将非空 hint 拼入一次性预览提示，且不写入剧情 WAL', async () => {
    const { state } = await makeTempState()
    const { cardId } = await state.createCharacter('向导')
    const sessionId = 'session-impersonate-hint'
    await state.saveBinding({ ...defaultBinding(sessionId, cardId), createdAt: new Date(0).toISOString() })
    const binding = (await state.loadStoryBinding(sessionId))!

    let capturedOptions: GenerateOptions | undefined
    const llm = {
      resolveModelInfo: async () => ({ context: { contextWindow: 32768 } }),
      stream: async function* (opts: GenerateOptions) {
        capturedOptions = opts
        yield { type: 'text-delta', text: '我推开木门，询问今晚的守夜安排。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as unknown as LlmRuntime

    const session = {
      id: sessionId,
      header: { agentPreset: 'tavern' },
      snapshotEvents: () => [],
      deriveMessages: () => [
        createAssistantMessage({ content: [{ type: 'text', text: '风雪渐紧，你要进屋吗？' }], source: { provider: 'deepseek', model: 'deepseek-chat' } }),
      ],
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }),
    } as unknown as Session

    const ctx = {
      get: (key: string) => (key === 'llm' ? llm : key === 'agentPresets' ? { composedPreset: () => 'tavern' } : undefined),
      sessions: { get: (id: string) => (id === sessionId ? session : undefined) },
      agents: { get: () => ({ session, options: { provider: 'deepseek', model: 'deepseek-chat' } }) },
    } as unknown as Context

    const out = await impersonate({ ctx, state }, sessionId, '  推门进去询问守夜安排  ')
    expect(out.text).toBe('我推开木门，询问今晚的守夜安排。')
    const lastUser = capturedOptions?.messages.at(-1)
    const promptText = JSON.stringify(lastUser)
    expect(promptText).toContain('推门进去询问守夜安排')
    const ws = await state.plainWorkspace(cardId, binding.storyId)
    expect(await ws.fs.list('state/wal')).toEqual([])
  })

  it('前端代答优先携带手写草稿填入输入框，连续重抽不把上次代答当 hint，飞行期用户手改则保护草稿回退剪贴板', async () => {
    const sessionId = 'session-impersonate-composer'
    invalidateSessionBinding(sessionId)
    cleanups.push(markSessionView(sessionId, true))

    let draftState = { draft: '半句起笔', draftRev: 1, phase: 'plain' as const, occurrences: [] as readonly never[], attachmentIds: [] as readonly never[], queue: [] as readonly never[] }
    const focus = vi.fn()
    const fakeInput = {
      state: { getSnapshot: () => draftState, subscribe: () => () => {} },
      setDraft: (next: string) => { draftState = { ...draftState, draft: next, draftRev: draftState.draftRev + 1 } },
      focus,
    } as unknown as SessionInput
    cleanups.push(installChoiceInput((id) => (id === sessionId ? fakeInput : undefined)))

    const writeClipboard = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText: writeClipboard } })

    const impersonateRpc = vi.fn<TavernRemote['impersonate']>()
      .mockResolvedValueOnce(ok({ text: '顺着半句起笔扩写出的完整台词' }))
      .mockResolvedValueOnce(ok({ text: '重抽换一版的台词' }))
    const remote = {
      getSessionBinding: vi.fn(async () => ok({ binding: defaultBinding(sessionId, 'card-1'), userName: '旅人', canSwipeGreeting: false, conversationStarted: true })),
      getFloorActionStates: vi.fn(async () => ok({ items: [{ greeting: { isGreeting: false, started: true, swipe: null }, siblings: { swipe: null }, canContinue: true }] })),
      impersonate: impersonateRpc,
    } as unknown as TavernRemote

    const view = await renderView(
      <TavernFloorActions
        remote={remote}
        sessionId={sessionId}
        sessions={{ open: vi.fn(), refresh: vi.fn(async () => {}) }}
        messageId="msg-1"
        useSessions={useTavernSessionsFor(sessionId)}
      />,
    )
    await act(async () => { await new Promise((r) => setTimeout(r, 15)) })

    const trigger = () => view.root.findByProps({ 'aria-label': t('actions.impersonate') }).props.onClick as () => void
    // 1) 输入框有用户手写起笔 → 作为 hint 发送并直填输入框
    await act(async () => { trigger()() })
    expect(impersonateRpc).toHaveBeenNthCalledWith(1, { sessionId, hint: '半句起笔' })
    expect(draftState.draft).toBe('顺着半句起笔扩写出的完整台词')
    expect(focus).toHaveBeenCalledOnce()
    expect(writeClipboard).not.toHaveBeenCalled()

    // 2) 未改动代答结果直接再点一次 → 视为重抽（不传 hint）并原地替换草稿
    await act(async () => { trigger()() })
    expect(impersonateRpc).toHaveBeenNthCalledWith(2, { sessionId })
    expect(draftState.draft).toBe('重抽换一版的台词')

    // 3) 代答飞行期间用户手改了输入框草稿 → 绝不覆盖用户新打的字，自动回退剪贴板
    const inflight = Promise.withResolvers<Envelope<{ text: string }>>()
    impersonateRpc.mockImplementationOnce(() => inflight.promise)
    await act(async () => { trigger()() })
    draftState = { ...draftState, draft: '用户等待期间自己打的新句子', draftRev: draftState.draftRev + 1 }
    await act(async () => { inflight.resolve(ok({ text: '迟到的代答结果' })) })
    expect(draftState.draft).toBe('用户等待期间自己打的新句子')
    expect(writeClipboard).toHaveBeenCalledWith('迟到的代答结果')
  })
})

describe('正则导入解析与排序、芯片防丢稿与面板体验优化', () => {
  it('parseImportedRegexRules 兼容 ST 单条/数组/包装对象与本机规则并赋予独立 user 身份，RegexSection 支持导入与上下移动', async () => {
    const stSingle = {
      id: 'st-fixed-id',
      scriptName: '折叠状态栏',
      findRegex: '/<status>[\\s\\S]*?<\\/status>/g',
      replaceString: '',
      placement: [2],
      markdownOnly: true,
      disabled: false,
    }
    const parsedSingle = parseImportedRegexRules(stSingle)
    expect(parsedSingle).toHaveLength(1)
    expect(parsedSingle[0]).toMatchObject({
      name: '折叠状态栏',
      scopes: ['output'],
      timing: ['render'],
      source: 'user',
    })
    expect(parsedSingle[0]!.id).not.toBe('st-fixed-id')

    const wrapped = parseImportedRegexRules({ regex_scripts: [stSingle, { ...stSingle, scriptName: '提示词清洗', markdownOnly: false, promptOnly: true }] })
    expect(wrapped.map((r) => r.name)).toEqual(['折叠状态栏', '提示词清洗'])
    expect(wrapped[0]!.id).not.toBe(wrapped[1]!.id)

    const { state, settingsScope } = await makeTempState()
    const service = new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state, settingsScope)
    const remote = {
      listRegexRules: vi.fn(async () => ok(await service.listRegexRules({}))),
      saveRegexRules: vi.fn(async (req: Parameters<TavernRemote['saveRegexRules']>[0]) => ok(await service.saveRegexRules(req))),
      listPresets: vi.fn(async () => ok({ items: [] })),
    } as unknown as TavernRemote

    const view = await renderView(<DraftScope>{() => <RegexSection remote={remote} />}</DraftScope>)
    await act(async () => { await new Promise((r) => setTimeout(r, 15)) })

    const fileBtn = view.root.findByType(FileBtn)
    const file = new File([JSON.stringify([
      { scriptName: '第一条规则', findRegex: 'foo', replaceString: 'bar', placement: [2], markdownOnly: true },
      { scriptName: '第二条规则', findRegex: 'baz', replaceString: 'qux', placement: [2], markdownOnly: true },
    ])], 'regex.json', { type: 'application/json' })
    await act(async () => {
      fileBtn.props.onFile(file)
      await new Promise((r) => setTimeout(r, 15))
    })

    const moveDownBtns = view.root.findAllByType(IconBtn).filter((b) => b.props.label === t('regex.moveDown'))
    expect(moveDownBtns).toHaveLength(2)
    expect(moveDownBtns[1]!.props.disabled).toBe(true)
    await act(async () => { moveDownBtns[0]!.props.onClick() })

    const saveAll = view.root.findAllByType(Btn).find((b) => b.props.children === t('regex.saveAll'))!
    await act(async () => {
      saveAll.props.onClick()
      await new Promise((r) => setTimeout(r, 30))
    })
    const saved = await service.listRegexRules({})
    expect(saved.rules.map((r) => r.name)).toEqual(['第二条规则', '第一条规则'])
  })

  it('TavernHeaderChip 未展开时不扫描全量角色列表，编辑后关闭触发未保存确认，且支持直达角色笔记页签', async () => {
    const sessionId = 'session-chip-ux'
    const cardId = 'card-lighthouse'
    invalidateSessionBinding(sessionId)
    invalidateCharacter(cardId)

    const binding = { ...defaultBinding(sessionId, cardId), storyId: 'story-1', cardName: '灯塔守望者' }
    const listCharacters = vi.fn(async () => ok({ items: [{ cardId, name: '灯塔守望者', hasAvatar: false, hasCharacterBook: false, characterBookName: null, tags: [], creator: '', characterVersion: '' }] }))
    const remote = {
      getSessionBinding: vi.fn(async () => ok({ binding, userName: '旅人', canSwipeGreeting: false, conversationStarted: true })),
      getCharacterDetail: vi.fn(async () => ok({
        cardId, revision: 'rev-1', name: '灯塔守望者', description: '', personality: '', scenario: '',
        firstMes: '你好', alternateGreetings: [], mesExample: '', systemPrompt: '', postHistoryInstructions: '',
        creatorNotes: '', creator: '', characterVersion: '', tags: [], spec: 'chara_card_v2',
        hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0, hasAvatar: false, depthPrompt: null, extensions: {},
      })),
      getAvatar: vi.fn(async () => ok({ dataUrl: null })),
      listCharacters,
      listPresets: vi.fn(async () => ok({ items: [] })),
      listPersonas: vi.fn(async () => ok({ items: [] })),
      listLorebooks: vi.fn(async () => ok({ items: [] })),
      getContextUsage: vi.fn(async () => ok({ usage: null, staleTurnContext: null })),
      listStories: vi.fn(async () => ok({ items: [{ id: 'story-1', sessionId, createdAt: '2026-10-01', migrated: false }] })),
      getMemories: vi.fn(async () => ok({ items: [] })),
      getWorldDeltas: vi.fn(async () => ok({ items: [] })),
      getJournal: vi.fn(async () => ok({ text: '角色笔记正文', revision: jsonEditRevision('角色笔记正文') })),
      getStoryRecovery: vi.fn(async () => ok({ floors: [] })),
      getEditorDraft: vi.fn(async () => ok({ draft: null })),
      saveEditorDraft: vi.fn(async () => ok({ saved: true })),
      deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
    } as unknown as TavernRemote

    const view = await renderView(
      <TavernHeaderChip
        remote={remote}
        sessionId={sessionId}
        sessions={{ open: vi.fn() }}
        useSessions={useTavernSessionsFor(sessionId)}
      />,
    )
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    // 面板未打开时不触发全量角色目录扫描
    expect(listCharacters).not.toHaveBeenCalled()

    await act(async () => { view.root.findByType(TavernSeatChip).props.onClick() })
    await act(async () => { await vi.waitFor(() => expect(listCharacters).toHaveBeenCalledOnce()) })

    // 修改作者注释后出现未保存徽标，关闭弹窗先弹放弃确认
    const authorNoteInput = view.root.findByType('textarea')
    await act(async () => { authorNoteInput.props.onChange({ target: { value: '本轮保持悬疑氛围' } }) })
    expect(JSON.stringify(view.toJSON())).toContain(t('draft.unsaved'))

    const mainDialog = view.root.findAllByType(Dialog).find((d) => d.props.title === t('chip.dialog.title'))!
    await act(async () => { mainDialog.props.onClose() })
    const leaveConfirm = view.root.findAllByType(ConfirmDialog).find((d) => d.props.open && d.props.title === t('draft.leaveTitle'))
    expect(leaveConfirm).toBeDefined()
    await act(async () => { leaveConfirm!.props.onCancel() })
    expect(view.root.findAllByType(Dialog).some((d) => d.props.title === t('chip.dialog.title') && d.props.open)).toBe(true)

    // 点击「编辑角色笔记」直达 MemorySection 的角色笔记页签
    const editJournalBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('chip.journal.edit'))!
    await act(async () => { editJournalBtn.props.onClick() })
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    expect(view.root.findAllByType('textarea').some((el) => el.props.value === '角色笔记正文')).toBe(true)
  })

  it('多条目世界书按需懒挂载表单并支持复制条目，SearchInput 支持 Esc 清空且不冒泡关闭弹窗', async () => {
    const makeEntry = (uid: string, comment: string): WorldInfoEntry => ({
      key: `global:book:${uid}`,
      uid,
      source: 'global',
      sourceRef: 'book',
      keys: [comment],
      secondaryKeys: [],
      selective: false,
      selectiveLogic: 0,
      comment,
      content: `${comment}正文`,
      constant: false,
      enabled: true,
      order: 100,
      position: 0,
      depth: 4,
      role: 0,
      outletName: '',
      probability: 100,
      useProbability: true,
      caseSensitive: null,
      matchWholeWords: null,
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
    })

    const view = await renderView(
      <LorebookEditor
        target={{ kind: 'library', name: '世界设定集' }}
        entries={[makeEntry('e-1', '北境城邦'), makeEntry('e-2', '南方港口'), makeEntry('e-3', '古神遗迹')]}
        revision="rev-1"
        onClose={() => {}}
        onSaved={() => {}}
        save={async () => ok({ revision: 'rev-2' })}
      />,
    )
    // 多条目世界书初始全部收起，不挂载隐藏的 EntryForm textarea
    expect(view.root.findAllByType('textarea')).toHaveLength(0)

    // 搜索框输入后展示清空按钮，按 Escape 清空搜索词且阻止事件冒泡
    const search = view.root.findByType(SearchInput)
    const searchInputEl = search.findByType('input')
    await act(async () => { searchInputEl.props.onChange({ target: { value: '港口' } }) })
    expect(view.root.findAllByProps({ 'aria-label': t('action.clearSearch') })).toHaveLength(1)
    const stopPropagation = vi.fn()
    const preventDefault = vi.fn()
    await act(async () => { searchInputEl.props.onKeyDown({ key: 'Escape', stopPropagation, preventDefault }) })
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(view.root.findByType(SearchInput).props.value).toBe('')

    // 点击第一条展开表单并点击「复制条目」，紧随其后生成「（副本）」并自动展开副本
    const heads = view.root.findAllByProps({ className: 'dsh-tavern-entryHead' })
    await act(async () => { heads[0]!.props.onClick() })
    expect(view.root.findAllByType('textarea')).toHaveLength(1)
    const dupBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('lorebookEditor.duplicateEntry'))!
    await act(async () => { dupBtn.props.onClick() })
    const titles = view.root.findAllByProps({ className: 'dsh-tavern-entryTitle' }).map((n) => n.children.join(''))
    expect(titles).toEqual(['北境城邦', `北境城邦${t('lorebookEditor.copySuffix')}`, '南方港口', '古神遗迹'])
  })

  it('预设与人设列表展示当前默认项徽标，记忆面板自动预填活跃会话剧情、支持状态过滤与角色笔记超预算告警', async () => {
    const { state, settingsScope } = await makeTempState()
    const service = new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state, settingsScope)
    const { id: presetId } = await service.savePreset({ preset: { name: '主力预设', identifier: 'main-preset', entries: [] }, expectedRevision: null })
    const { id: personaId } = await service.savePersona({ persona: { id: 'p-1', name: '夜行侦探', description: '擅长推理', avatar: null }, expectedRevision: null })
    await service.updateSettings({ patch: { defaults: { presetId, personaId } } })

    const activeSessionId = 'session-active-memory'
    const { cardId } = await state.createCharacter('夏洛特')
    await state.saveBinding({ ...defaultBinding(activeSessionId, cardId), createdAt: new Date(0).toISOString() })
    const activeBinding = (await state.loadBinding(activeSessionId))!
    const storyWs = await state.plainWorkspace(cardId, activeBinding.storyId)
    const m1 = await storyWs.memory.write({ body: '活跃线索：怀表停在十一点', tags: ['线索'] })
    const m2 = await storyWs.memory.write({ body: '另一条见闻：初抵雾都车站', tags: ['往事'] })
    const d1 = await service.addWorldDelta({ cardId, storyId: activeBinding.storyId, type: 'add', content: '市政厅处于戒严状态' })
    const d2 = await service.addWorldDelta({ cardId, storyId: activeBinding.storyId, type: 'add', content: '旧码头仍在营业' })
    await service.revokeWorldDelta({ cardId, storyId: activeBinding.storyId, id: d2.id })
    await storyWs.fs.writeText('journal.md', '记'.repeat(JOURNAL_TURN_TOKEN_BUDGET + 50))

    invalidateSessionBinding(activeSessionId)
    cleanups.push(markSessionView(activeSessionId, true))

    const remote = {
      listPresets: async () => ok(await service.listPresets({})),
      listPersonas: async () => ok(await service.listPersonas({})),
      listLorebooks: async () => ok(await service.listLorebooks({})),
      getSettings: async () => ok(await service.getSettings({})),
      updateSettings: async (req: Parameters<TavernRemote['updateSettings']>[0]) => ok(await service.updateSettings(req)),
      getSessionBinding: async () => ok({ binding: activeBinding, userName: '夜行侦探', canSwipeGreeting: false, conversationStarted: true }),
      listCharacters: async () => ok(await service.listCharacters({})),
      listStories: async (req: Parameters<TavernRemote['listStories']>[0]) => ok(await service.listStories(req)),
      getMemories: async (req: Parameters<TavernRemote['getMemories']>[0]) => ok(await service.getMemories(req)),
      saveMemory: vi.fn(async (req: Parameters<TavernRemote['saveMemory']>[0]) => ok(await service.saveMemory(req))),
      getWorldDeltas: async (req: Parameters<TavernRemote['getWorldDeltas']>[0]) => ok(await service.getWorldDeltas(req)),
      getJournal: async (req: Parameters<TavernRemote['getJournal']>[0]) => ok(await service.getJournal(req)),
      getStoryRecovery: async (req: Parameters<TavernRemote['getStoryRecovery']>[0]) => ok(await service.getStoryRecovery(req)),
      getEditorDraft: async () => ok({ draft: null }),
      saveEditorDraft: async () => ok({ saved: true }),
      deleteEditorDraft: async () => ok({ deleted: true }),
    } as unknown as TavernRemote

    const presetsView = await renderView(<DraftScope>{() => <PresetsSection remote={remote} />}</DraftScope>)
    const personasView = await renderView(<DraftScope>{() => <PersonasSection remote={remote} />}</DraftScope>)
    await act(async () => { await new Promise((r) => setTimeout(r, 15)) })
    expect(presetsView.root.findAllByType(Badge).some((b) => b.props.children === t('presets.defaultBadge'))).toBe(true)
    expect(presetsView.root.findAllByType(Btn).find((b) => b.props.children === t('presets.isDefault'))?.props.disabled).toBe(true)
    expect(personasView.root.findAllByType(Badge).some((b) => b.props.children === t('personas.defaultBadge'))).toBe(true)
    expect(personasView.root.findAllByType(Btn).find((b) => b.props.children === t('personas.isDefault'))?.props.disabled).toBe(true)

    // MemorySection 从设置页无参打开时，自动选中当前正在浏览会话的角色与剧情，并标注「（当前会话）」
    const memView = await renderView(<MemorySection remote={remote} />)
    for (let i = 0; i < 4; i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    }
    const selects = memView.root.findAllByType(Select)
    expect(selects[0]!.props.value).toBe(cardId)
    expect(selects[1]!.props.value).toBe(activeBinding.storyId)
    expect(JSON.stringify(selects[1]!.props.options)).toContain('（当前会话）')

    // 记忆关键词检索：输入「怀表」仅保留 m1，清空后恢复全部
    const memSearch = memView.root.findByType(SearchInput)
    await act(async () => { memSearch.props.onChange('怀表') })
    let renderedMemText = JSON.stringify(memView.toJSON())
    expect(renderedMemText).toContain(m1.id)
    expect(renderedMemText).not.toContain(m2.id)
    await act(async () => { memSearch.props.onChange('') })

    // 新增记忆时可直接填写标签与检索键一次落盘
    const newMemoArea = memView.root.findByType('textarea')
    await act(async () => { newMemoArea.props.onChange({ target: { value: '教堂钟楼藏着密信' } }) })
    const tagInput = memView.root.findByProps({ placeholder: t('memory.newTagsPlaceholder') })
    const keyInput = memView.root.findByProps({ placeholder: t('memory.newKeysPlaceholder') })
    await act(async () => {
      tagInput.props.onChange({ target: { value: '地点, 线索' } })
      keyInput.props.onChange({ target: { value: '钟楼, 密信' } })
    })
    await act(async () => {
      memView.root.findAllByType(Btn).find((b) => b.props.children === t('memory.addEntry'))!.props.onClick()
      await new Promise((r) => setTimeout(r, 25))
    })
    expect(remote.saveMemory).toHaveBeenCalledWith({
      cardId,
      storyId: activeBinding.storyId,
      body: '教堂钟楼藏着密信',
      tags: ['地点', '线索'],
      keys: ['钟楼', '密信'],
    })

    // 切到世界状态页签，过滤「已撤销」仅显示已撤销条目 d2，不显示活跃条目 d1
    const deltaTab = memView.root.findAllByType('button').find((b) => b.props.children === t('memory.tab.delta', { count: 2 }))!
    await act(async () => { deltaTab.props.onClick() })
    const revokedChip = memView.root.findAllByType('button').find((b) => b.props.children === t('memory.deltaFilter.revoked', { count: 1 }))!
    await act(async () => { revokedChip.props.onClick() })
    renderedMemText = JSON.stringify(memView.toJSON())
    expect(renderedMemText).toContain('旧码头仍在营业')
    expect(renderedMemText).not.toContain('市政厅处于戒严状态')
    expect(d1.id).not.toBe(d2.id)

    // 切到角色笔记页签，超过 800 token 时展示超预算告警徽标与说明
    const journalTab = memView.root.findAllByType('button').find((b) => b.props.children === t('memory.tab.journal'))!
    await act(async () => { journalTab.props.onClick() })
    expect(JSON.stringify(memView.toJSON())).toContain(t('memory.journalBudgetExceeded', { limit: JOURNAL_TURN_TOKEN_BUDGET }))
  })
})
