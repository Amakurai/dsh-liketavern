/** 前端行为回归：真实 React 编辑器配模拟 remote，验证草稿保护、失败保留、多行开场白与剧情写入边界。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'
import { DraftScope, useDraftGuard } from '../src/client/drafts.js'
import { CharacterPicker } from '../src/client/characterPicker.js'
import { CharactersSection } from '../src/client/panel/characters.js'
import { MemorySection } from '../src/client/panel/memory.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { Btn, ConfirmDialog, Dialog, IconBtn, Select } from '../src/client/util.js'
import type { CharacterDetail, CharacterSummary, TavernRemote } from '../src/client/types.js'

/** 仅替换宿主平台原语；被测组件的 hooks、草稿、remote 调用与状态更新都运行真实实现。 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (p: { children?: ReactNode }) => <button>{p.children}</button>,
  Modal: (p: { open: boolean; title: string; children?: ReactNode; footer?: ReactNode }) => p.open ? <div role="dialog" aria-label={p.title}>{p.children}{p.footer}</div> : null,
  Tooltip: (p: { children?: ReactNode }) => <>{p.children}</>,
  Toast: (p: { text: string }) => <span>{p.text}</span>,
  Menu: (p: { anchor?: ReactNode }) => <>{p.anchor}</>,
  IconChevronDownOutline14: () => null,
  IconSearchOutline16: () => null,
  IconUserOutline16: () => null,
  IconDownloadOutline16: () => null,
  IconTrashOutline16: () => null,
  IconEditOutline16: () => null,
}))

const mounted: ReactTestRenderer[] = []
async function render(node: ReactNode) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(node) })
  mounted.push(view)
  return view
}
function button(view: ReactTestRenderer, label: string) {
  return view.root.findAllByType(Btn).find((b) => b.props.children === label)!
}
function confirmation(view: ReactTestRenderer) {
  return view.root.findAllByType(ConfirmDialog).find((d) => d.props.open)!
}
const ok = <T,>(value: T) => ({ ok: true as const, value })
const summary = (cardId: string, name: string): CharacterSummary => ({ cardId, name, hasAvatar: false, hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0 })
function detail(cardId: string): CharacterDetail {
  return { ...summary(cardId, '灯塔守望者'), description: '守护海岸', personality: '', scenario: '', firstMes: '欢迎来到灯塔。',
    alternateGreetings: ['第一段\n第二段'], mesExample: '', systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', creator: '', characterVersion: '', tags: [],
    spec: 'chara_card_v2', depthPrompt: null, extensions: {} }
}
beforeEach(() => setTavernLocale('zh'))
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()) })

function DraftEditor(props: { busy?: boolean }) {
  const [text, setText] = useState('')
  useDraftGuard(text !== '', props.busy)
  return <input value={text} onChange={(e) => setText(e.target.value)} />
}

describe('编辑草稿保护', () => {
  it('有草稿或保存中阻止浏览器意外刷新，卸载后解除保护', async () => {
    const events = new EventTarget()
    vi.stubGlobal('window', events)
    try {
      const view = await render(<DraftEditor />)
      const clean = new Event('beforeunload', { cancelable: true })
      events.dispatchEvent(clean)
      expect(clean.defaultPrevented).toBe(false)
      await act(async () => view.root.findByType('input').props.onChange({ target: { value: '待保存' } }))
      const dirty = new Event('beforeunload', { cancelable: true })
      events.dispatchEvent(dirty)
      expect(dirty.defaultPrevented).toBe(true)
      await act(async () => view.update(<DraftEditor busy />))
      await act(async () => view.unmount())
      const after = new Event('beforeunload', { cancelable: true })
      events.dispatchEvent(after)
      expect(after.defaultPrevented).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })
  it('取消切页保留内容，明确放弃后才执行跳转', async () => {
    const leave = vi.fn()
    const view = await render(<DraftScope>{(request) => <><DraftEditor /><Btn onClick={() => request(leave)}>离开</Btn></>}</DraftScope>)
    await act(async () => view.root.findByType('input').props.onChange({ target: { value: '尚未保存' } }))
    await act(async () => button(view, '离开').props.onClick())
    expect(leave).not.toHaveBeenCalled()
    await act(async () => confirmation(view).props.onCancel())
    expect(view.root.findByType('input').props.value).toBe('尚未保存')
    await act(async () => button(view, '离开').props.onClick())
    await act(async () => confirmation(view).props.onConfirm())
    expect(leave).toHaveBeenCalledOnce()
  })

  it('保存期间不能卸载页面，干净的另一编辑器不会覆盖脏状态', async () => {
    const leave = vi.fn()
    const view = await render(<DraftScope>{(request) => <><DraftEditor busy /><DraftEditor /><Btn onClick={() => request(leave)}>离开</Btn></>}</DraftScope>)
    await act(async () => button(view, '离开').props.onClick())
    expect(leave).not.toHaveBeenCalled()
    expect(confirmation(view)).toBeUndefined()
  })

  it('多个编辑器独立汇报，干净的编辑器不会清除另一份草稿', async () => {
    const leave = vi.fn()
    const view = await render(<DraftScope>{(request) => <><DraftEditor /><DraftEditor /><Btn onClick={() => request(leave)}>离开</Btn></>}</DraftScope>)
    await act(async () => view.root.findAllByType('input')[0]!.props.onChange({ target: { value: '第一份草稿' } }))
    await act(async () => button(view, '离开').props.onClick())
    expect(leave).not.toHaveBeenCalled()
    expect(confirmation(view)).toBeDefined()
  })

  it('角色保存失败后保留草稿；多行开场白作为一条提交', async () => {
    const card = detail('draft-character')
    const saveCharacter = vi.fn(async (_request: unknown) => ({ ok: false, error: { code: 'IO', message: '模拟写入失败' } }))
    const remote = { listCharacters: async () => ok({ items: [summary(card.cardId, card.name)] }), getCharacterDetail: async () => ok(card),
      getAvatar: async () => ok({ dataUrl: null }), saveCharacter } as unknown as TavernRemote
    const view = await render(<CharactersSection remote={remote} />)
    await act(async () => view.root.findByProps({ className: 'dsh-tavern-charCard' }).props.onClick())
    const greeting = view.root.findAllByType('textarea').find((n) => n.props.value === '第一段\n第二段')!
    await act(async () => greeting.props.onChange({ target: { value: '新的第一段\n新的第二段' } }))
    await act(async () => button(view, '保存').props.onClick())
    expect(saveCharacter.mock.calls[0]?.[0]).toMatchObject({ alternateGreetings: ['新的第一段\n新的第二段'] })
    expect(view.root.findAllByType('textarea').some((n) => n.props.value === '新的第一段\n新的第二段')).toBe(true)
    await act(async () => view.root.findAllByType(Dialog).find((d) => d.props.width === 'xl')!.props.onClose())
    expect(confirmation(view)).toBeDefined()
  })
})

describe('剧情上下文', () => {
  function remoteForStory() {
    const saveJournal = vi.fn(async (_request: unknown) => ok({}))
    const remote = {
      listCharacters: async () => ok({ items: [summary('card-a', '灯塔守望者')] }),
      listStories: async () => ok({ items: [{ id: 'story-a', sessionId: 'session-a', createdAt: '2026-09-05', migrated: false }] }),
      getMemories: vi.fn(async () => ok({ items: [] })), getWorldDeltas: async () => ok({ items: [] }),
      getJournal: async () => ok({ text: '旧笔记' }), saveJournal,
    }
    return { remote: remote as unknown as TavernRemote, saveJournal, getMemories: remote.getMemories }
  }
  it('从聊天进入后读取和保存均带原剧情 ID', async () => {
    const { remote, saveJournal, getMemories } = remoteForStory()
    const view = await render(<MemorySection remote={remote} initialContext={{ cardId: 'card-a', storyId: 'story-a' }} />)
    expect(getMemories).toHaveBeenCalledWith({ cardId: 'card-a', storyId: 'story-a' })
    const tabs = view.root.findAllByType('button')
    await act(async () => tabs.find((b) => b.props.children === '角色笔记')!.props.onClick())
    await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: '新笔记' } }))
    await act(async () => button(view, '保存笔记').props.onClick())
    expect(saveJournal).toHaveBeenCalledWith({ cardId: 'card-a', storyId: 'story-a', text: '新笔记' })
  })
  it('有草稿时取消切换初始状态，仍保持原剧情', async () => {
    const { remote } = remoteForStory()
    const view = await render(<MemorySection remote={remote} initialContext={{ cardId: 'card-a', storyId: 'story-a' }} />)
    await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: '待记录的事实' } }))
    await act(async () => view.root.findAllByType(Select)[1]!.props.onChange(''))
    await act(async () => confirmation(view).props.onCancel())
    expect(view.root.findAllByType(Select)[1]!.props.value).toBe('story-a')
    expect(view.root.findByType('textarea').props.value).toBe('待记录的事实')
  })

  it('单条记忆编辑时禁用剧情及分区切换，取消编辑也保护正文', async () => {
    const { remote } = remoteForStory()
    remote.getMemories = async () => ok({ items: [{ id: 'm-1', body: '灯塔已经修好', tags: [], keys: [], updated: '2026-09-05', archived: false }] }) as Awaited<ReturnType<TavernRemote['getMemories']>>
    const view = await render(<MemorySection remote={remote} initialContext={{ cardId: 'card-a', storyId: 'story-a' }} />)
    await act(async () => view.root.findAllByType(IconBtn).find((b) => b.props.label === '编辑')!.props.onClick())
    expect(view.root.findAllByType(Select).every((s) => s.props.disabled)).toBe(true)
    expect(view.root.findAllByType('button').filter((b) => b.props.className === 'dsh-tavern-chip').every((b) => b.props.disabled)).toBe(true)
    await act(async () => view.root.findAllByType('textarea').find((n) => n.props.value === '灯塔已经修好')!.props.onChange({ target: { value: '尚未写入的修订' } }))
    await act(async () => button(view, '取消').props.onClick())
    expect(confirmation(view)).toBeDefined()
  })
})

describe('角色选择', () => {
  it('搜索按名字匹配并只选择命中的角色', async () => {
    const onPick = vi.fn()
    const remote = { listCharacters: async () => ok({ items: [summary('a', '灯塔守望者'), summary('b', '森林旅人')] }) } as unknown as TavernRemote
    const view = await render(<CharacterPicker remote={remote} busy={false} error={null} onPick={onPick} onClose={() => {}} />)
    await act(async () => view.root.findByType('input').props.onChange({ target: { value: '森林' } }))
    const items = view.root.findAllByProps({ className: 'dsh-tavern-pickerItem' })
    expect(items).toHaveLength(1)
    await act(async () => items[0]!.props.onClick())
    expect(onPick).toHaveBeenCalledWith('b')
  })
})
