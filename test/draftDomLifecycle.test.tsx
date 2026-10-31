// @vitest-environment jsdom
/** 真实 React DOM 草稿生命周期：Suspense 只卸载布局 effect，StrictMode 重放挂载，均不能提前释放恢复记录或离开保护。 */
import { act, StrictMode, Suspense, useLayoutEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PersistentEditor, useDraftState } from '../src/client/draftPersistence.js'
import { useDraftGuard } from '../src/client/drafts.js'
import { setTavernLocale } from '../src/client/i18n.js'
import type { TavernRemote } from '../src/client/types.js'
import type { TavernMethodRequests } from '../src/remote.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) => <button {...props}>{children}</button>,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: () => null, Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
}))

const ok = <T,>(value: T) => ({ ok: true as const, value })
let container: HTMLDivElement, root: Root, restore: (() => void) | undefined
const snapshot = (text: string) => ({ version: 1, fields: { 'dom:text': text } })
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  window.sessionStorage.setItem('dsh-tavern-editor-owner', 'dom-browser-owner')
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  setTavernLocale('zh')
})
afterEach(async () => {
  restore?.(); restore = undefined
  await act(async () => root.unmount())
  await advance()
  container.remove()
  window.sessionStorage.clear()
  vi.useRealTimers(); vi.unstubAllGlobals()
})
async function advance() { await act(async () => { await vi.advanceTimersByTimeAsync(600) }) }
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}
async function change(text: string) {
  const input = container.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function leaving() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

it.each([{ strict: false, seeded: false }, { strict: false, seeded: true }, { strict: true, seeded: true }])(
  '隐藏并恢复后，失败草稿关闭重开仍保留，确认后释放保护（%j）', async ({ strict, seeded }) => {
    let stored = seeded ? snapshot('宿主已确认的旧正文') : null, failing = false, gate = Promise.withResolvers<void>()
    const lifecycle = { setups: 0, cleanups: 0 }
    const remote = {
      getEditorDraft: async () => ok({ draft: stored ? { value: structuredClone(stored), updatedAt: new Date().toISOString() } : null }),
      saveEditorDraft: async ({ value }: TavernMethodRequests['saveEditorDraft']) => {
        if (failing) return { ok: false as const, error: { code: 'factory', message: '恢复后宿主不可写' } }
        stored = structuredClone(value) as ReturnType<typeof snapshot>; return ok({ saved: true })
      },
      deleteEditorDraft: async () => { stored = null; return ok({ deleted: true }) },
    } as unknown as TavernRemote
    restore = () => { failing = false; gate.resolve() }
    function Gate({ hidden }: { hidden: boolean }) { if (hidden) throw gate.promise; return null }
    function Editor() {
      const [text, setText] = useDraftState('dom:text', 'base')
      useDraftGuard(text !== 'base')
      useLayoutEffect(() => { lifecycle.setups++; return () => { lifecycle.cleanups++ } }, [])
      return <input aria-label="工厂正文" value={text} onChange={event => setText(event.target.value)} />
    }
    function Harness() {
      const [hidden, setHidden] = useState(false), [open, setOpen] = useState(true)
      return <>
        <button onClick={() => { gate = Promise.withResolvers<void>(); setHidden(true) }}>隐藏</button>
        <button onClick={() => { gate.resolve(); setHidden(false) }}>显示</button>
        <button onClick={() => setOpen(false)}>关闭</button><button onClick={() => setOpen(true)}>重开</button>
        <Suspense fallback={<p>等待子组件</p>}><Gate hidden={hidden} />
          {open && <PersistentEditor remote={remote} scope="dom-lifecycle"><Editor /></PersistentEditor>}
        </Suspense>
      </>
    }
    await act(async () => root.render(strict ? <StrictMode><Harness /></StrictMode> : <Harness />))
    await advance()
    expect(container.querySelector('input')!.value).toBe(seeded ? '宿主已确认的旧正文' : 'base')
    if (strict) expect(lifecycle.setups).toBeGreaterThan(1)
    const initialSetups = lifecycle.setups
    await click('隐藏')
    expect(container.textContent).toContain('等待子组件')
    expect(lifecycle.cleanups).toBe(initialSetups)
    await click('显示')
    expect(lifecycle.setups).toBeGreaterThan(initialSetups)
    failing = true
    await change('隐藏恢复后的最新正文'); await advance()
    expect(container.textContent).toContain('恢复后宿主不可写')
    await click('关闭')
    expect(leaving()).toBe(true)
    await click('重开')
    expect(container.querySelector('input')!.value).toBe('隐藏恢复后的最新正文')
    expect(stored).toEqual(seeded ? snapshot('宿主已确认的旧正文') : null)
    failing = false
    await click('重试')
    expect(stored).toEqual(snapshot('隐藏恢复后的最新正文'))
    await click('关闭')
    expect(leaving()).toBe(false)
  },
)
