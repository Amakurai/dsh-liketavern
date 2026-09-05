/** 记忆面板持久草稿行为：恢复笔记/条目后保留原剧情，首次查询不冲掉草稿，保存后正常同步。 */
import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemorySection } from '../src/client/panel/memory.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { Btn, ConfirmDialog, IconBtn, Select } from '../src/client/util.js'
import type { TavernRemote } from '../src/client/types.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (p: { children?: ReactNode }) => <button>{p.children}</button>,
  Modal: (p: { open: boolean; children?: ReactNode; footer?: ReactNode }) => p.open ? <div>{p.children}{p.footer}</div> : null,
  Tooltip: (p: { children?: ReactNode }) => <>{p.children}</>, Toast: () => null,
  Menu: (p: { anchor?: ReactNode }) => <>{p.anchor}</>,
  IconChevronDownOutline14: () => null, IconSearchOutline16: () => null,
  IconEditOutline16: () => null, IconTrashOutline16: () => null,
}))

let view: ReactTestRenderer | undefined
beforeEach(() => {
  setTavernLocale('zh')
  vi.stubGlobal('window', Object.assign(new EventTarget(), { sessionStorage: { getItem: () => 'memory-draft-tests', setItem() {} } }))
})
afterEach(async () => {
  if (view) await act(async () => view!.unmount())
  view = undefined
  vi.unstubAllGlobals()
})
const ok = <T,>(value: T) => ({ ok: true as const, value })
const contextKey = (storyId: string | null) => `memory:context:${JSON.stringify(['card-a', storyId])}`
function fixture(fields: Record<string, unknown>, restoreScope?: string) {
  let journalText = '已存笔记'
  const saveJournal = vi.fn(async (request: { text: string }) => { journalText = request.text.trim(); return ok({ saved: true }) })
  const getJournal = vi.fn(async () => ok({ text: journalText }))
  const saveMemory = vi.fn(async () => ok({ id: 'entry-a' }))
  const getEditorDraft = vi.fn(async ({ key }: { key: string }) => ok({ draft: !restoreScope || key === restoreScope
    ? { value: { version: 1, fields }, updatedAt: '2026-09-05' } : null }))
  const remote = {
    getEditorDraft, saveEditorDraft: async () => ok({ saved: true }), deleteEditorDraft: async () => ok({ deleted: true }),
    listCharacters: async () => ok({ items: [{ cardId: 'card-a', name: '工厂角色', hasAvatar: false }] }),
    listStories: async () => ok({ items: ['story-a', 'story-b'].map((id) => ({ id, sessionId: id, createdAt: '2026-09-05', migrated: false })) }),
    getJournal, saveJournal, saveMemory, getWorldDeltas: async () => ok({ items: [] }),
    getMemories: async () => ok({ items: [{ id: 'entry-a', body: '原始事实', tags: ['旧标签'], keys: ['旧关键词'], updated: '2026-09-05', archived: false }] }),
  } as unknown as TavernRemote
  return { remote, saveJournal, getJournal, saveMemory, getEditorDraft }
}
function component(remote: TavernRemote, storyId = 'story-a') {
  return <MemorySection remote={remote} initialContext={{ cardId: 'card-a', storyId }} />
}
async function mount(node: ReactNode) { await act(async () => { view = create(node) }) }
async function click(label: string) {
  await act(async () => view!.root.findAllByType(Btn).find((button) => button.props.children === label)!.props.onClick())
}

it('首次服务器笔记查询不覆盖恢复正文，保存带原剧情并回填保存后的正文', async () => {
  const key = contextKey('story-a')
  const f = fixture({ 'memory:cardId': 'card-a', 'memory:storyId': 'story-a', [`${key}:tab`]: 'journal', [`${key}:journalText`]: ' 待保存笔记 ' })
  await mount(component(f.remote))
  expect(view!.root.findByType('textarea').props.value).toBe(' 待保存笔记 ')
  await click('保存笔记')
  expect(f.saveJournal).toHaveBeenCalledWith({ cardId: 'card-a', storyId: 'story-a', text: ' 待保存笔记 ' })
  expect(view!.root.findByType('textarea').props.value).toBe('待保存笔记')
})

it('更换聊天入口卸载原范围，旧剧情的恢复草稿不能进入新剧情', async () => {
  const key = contextKey('story-a')
  const f = fixture({ 'memory:cardId': 'card-a', 'memory:storyId': 'story-a', [`${key}:newBody`]: '仅属于剧情 A 的事实' }, 'memory:["card-a","story-a"]')
  await mount(component(f.remote))
  expect(view!.root.findByType('textarea').props.value).toBe('仅属于剧情 A 的事实')
  await act(async () => view!.update(component(f.remote, 'story-b')))
  expect(view!.root.findByType('textarea').props.value).toBe('')
  expect(view!.root.findAllByType(Select)[1]!.props.value).toBe('story-b')
  expect(f.getJournal).toHaveBeenLastCalledWith({ cardId: 'card-a', storyId: 'story-b' })
})

it('恢复单条记忆编辑并保护取消；明确放弃后重开读取原条目', async () => {
  const key = contextKey('story-a')
  const entry = 'memory:entry:["card-a","story-a","entry-a"]'
  const f = fixture({ 'memory:cardId': 'card-a', 'memory:storyId': 'story-a', [`${key}:editingId`]: 'entry-a',
    [`${entry}:body`]: '尚未保存的事实', [`${entry}:tags`]: '新标签', [`${entry}:keys`]: '新关键词' })
  await mount(component(f.remote))
  expect(view!.root.findAllByType('textarea').some((field) => field.props.value === '尚未保存的事实')).toBe(true)
  expect(view!.root.findAllByType(Select).every((select) => select.props.disabled)).toBe(true)
  await click('取消')
  const dialog = view!.root.findAllByType(ConfirmDialog).find((item) => item.props.open)!
  await act(async () => dialog.props.onConfirm())
  await act(async () => view!.root.findAllByType(IconBtn).find((button) => button.props.label === '编辑')!.props.onClick())
  expect(view!.root.findAllByType('textarea').some((field) => field.props.value === '原始事实')).toBe(true)
  expect(view!.root.findAllByType('textarea').some((field) => field.props.value === '尚未保存的事实')).toBe(false)
  expect(f.saveMemory).not.toHaveBeenCalled()
})

it('恢复已选择的初始状态，不因省略 undefined 又回到聊天入口剧情', async () => {
  const key = contextKey(null)
  const f = fixture({ 'memory:cardId': 'card-a', 'memory:storyId': '', [`${key}:tab`]: 'journal', [`${key}:journalText`]: '初始状态草稿' })
  await mount(component(f.remote))
  expect(view!.root.findAllByType(Select)[1]!.props.value).toBe('')
  expect(view!.root.findByType('textarea').props.value).toBe('初始状态草稿')
  await click('保存笔记')
  expect(f.saveJournal).toHaveBeenCalledWith({ cardId: 'card-a', storyId: undefined, text: '初始状态草稿' })
})
