/** 独立聊天世界书生命周期：保存/明确放弃会关闭整个编辑器，旧草稿不能在重开时复活。 */
import { useState, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LorebookEditor } from '../src/client/panel/lorebookEditor.js'
import { DraftScope, useDraftGuard } from '../src/client/drafts.js'
import { PersistentEditor, useDraftState } from '../src/client/draftPersistence.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { Btn, ConfirmDialog } from '../src/client/util.js'
import type { TavernRemote } from '../src/client/types.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div>{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutline14: () => null, IconSearchOutline16: () => null, IconEditOutline16: () => null,
  IconTrashOutline16: () => null, IconPlusOutline16: () => null, IconChevronRightOutline14: () => null,
}))
let view: ReactTestRenderer | undefined
beforeEach(() => {
  vi.useFakeTimers()
  setTavernLocale('zh')
  vi.stubGlobal('window', Object.assign(new EventTarget(), { sessionStorage: { getItem: () => 'lorebook-persist-tests', setItem() {} } }))
})
afterEach(async () => {
  if (view) await act(async () => view!.unmount())
  view = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const ok = <T,>(value: T) => ({ ok: true as const, value })
function fixture() {
  let stored: unknown = null
  const remote = {
    getEditorDraft: async () => ok({ draft: stored ? { value: stored, updatedAt: '2026-09-05' } : null }),
    saveEditorDraft: async ({ value }: { value: unknown }) => { stored = structuredClone(value); return ok({ saved: true }) },
    deleteEditorDraft: async () => { stored = null; return ok({ deleted: true }) },
  } as unknown as TavernRemote
  const save = vi.fn(async () => ok({ saved: true }))
  function Harness() {
    const [open, setOpen] = useState(true)
    return open ? <LorebookEditor remote={remote} target={{ kind: 'chat', cardId: 'card-a', storyId: 'story-a', name: '聊天世界书' }}
      entries={[]} save={save} onSaved={() => setOpen(false)} onClose={() => setOpen(false)} /> : <span>closed</span>
  }
  return { node: <Harness />, remote, save, stored: () => stored }
}
async function click(label: string) {
  await act(async () => view!.root.findAllByType(Btn).find((button) => button.props.children === label)!.props.onClick())
}
async function prepare() {
  const f = fixture()
  await act(async () => { view = create(f.node) })
  await click('新建条目')
  await act(async () => vi.advanceTimersByTimeAsync(500))
  expect(f.stored()).not.toBeNull()
  return f
}

it('保存成功立即关闭整个窗口后删除原草稿', async () => {
  const f = await prepare()
  await click('保存')
  expect(f.save).toHaveBeenCalledOnce()
  expect(view!.root.findByType('span').children).toEqual(['closed'])
  expect(f.stored()).toBeNull()
})

it('明确放弃并关闭整个窗口后删除原草稿', async () => {
  const f = await prepare()
  await click('关闭')
  await act(async () => view!.root.findAllByType(ConfirmDialog).find((dialog) => dialog.props.open)!.props.onConfirm())
  expect(view!.root.findByType('span').children).toEqual(['closed'])
  expect(f.stored()).toBeNull()
})

function InnerEditor() {
  const [text, setText] = useDraftState('body', '')
  useDraftGuard(text !== '')
  return <input value={text} onChange={(event) => setText(event.target.value)} />
}

it('宿主关闭保护在 provider 外仍可传递放弃；取消则保留内层草稿', async () => {
  const f = fixture()
  function OuterDialog() {
    const [open, setOpen] = useState(true)
    return open ? <DraftScope>{(request) => <><Btn onClick={() => request(() => setOpen(false))}>关闭宿主窗口</Btn>
      <PersistentEditor remote={f.remote} scope="outer-dialog"><InnerEditor /></PersistentEditor>
    </>}</DraftScope> : <span>closed</span>
  }
  await act(async () => { view = create(<OuterDialog />) })
  await act(async () => view!.root.findByType('input').props.onChange({ target: { value: '待保留的内容' } }))
  await act(async () => vi.advanceTimersByTimeAsync(500))
  await click('关闭宿主窗口')
  await act(async () => view!.root.findAllByType(ConfirmDialog).find((dialog) => dialog.props.open)!.props.onCancel())
  expect(view!.root.findByType('input').props.value).toBe('待保留的内容')
  expect(f.stored()).not.toBeNull()
  await click('关闭宿主窗口')
  await act(async () => view!.root.findAllByType(ConfirmDialog).find((dialog) => dialog.props.open)!.props.onConfirm())
  expect(view!.root.findByType('span').children).toEqual(['closed'])
  expect(f.stored()).toBeNull()
})
