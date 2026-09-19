/** 共享读取 Hook 的生命周期回归：切换目标首帧隔离旧值，禁用不消费结果，超时与重试保持可恢复。 */
import { useLayoutEffect, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setTavernLocale } from '../src/client/i18n.js'
import { useLoader } from '../src/client/util.js'
import type { Envelope } from '../src/client/types.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Modal: () => null, Menu: () => null, Toast: () => null, Tooltip: () => null,
  IconChevronDownOutline14: () => null, IconSearchOutline16: () => null, IconUserOutline16: () => null,
}))

const ok = (value: string): Envelope<string> => ({ ok: true, value })
const mounted: ReactTestRenderer[] = []
beforeEach(() => setTavernLocale('zh'))
afterEach(async () => {
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  vi.useRealTimers()
})

function Probe(props: { id: string; enabled?: boolean; load: (id: string) => Promise<Envelope<string>>;
  consume: (id: string, value: string) => void }) {
  const { state, reload } = useLoader(() => props.load(props.id), [props.id], props.enabled ?? true, 100)
  // 模拟消费方提交时绑定身份：首帧泄漏不能靠后续 effect 再擦除来补救。
  useLayoutEffect(() => { if (state.status === 'ready') props.consume(props.id, state.value) }, [state, props.id, props.consume])
  return <div data-status={state.status}>
    {state.status === 'ready' ? state.value : state.status === 'error' ? state.message : null}
    <button onClick={reload}>reload</button>
  </div>
}

async function render(node: ReactNode) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(node) })
  mounted.push(view)
  return view
}

it('目标变化与禁用的第一次提交都不向消费方提供上次读取值', async () => {
  const pending = Promise.withResolvers<Envelope<string>>()
  const load = vi.fn((id: string) => id === 'first' ? Promise.resolve(ok('第一份内容')) : pending.promise)
  const consume = vi.fn()
  const component = (id: string, enabled = true) => <Probe id={id} enabled={enabled} load={load} consume={consume} />
  const view = await render(component('first'))
  expect(consume).toHaveBeenLastCalledWith('first', '第一份内容')
  consume.mockClear()
  await act(async () => view.update(component('second')))
  expect(consume).not.toHaveBeenCalled()
  expect(view.root.findByType('div').props['data-status']).toBe('loading')
  await act(async () => pending.resolve(ok('第二份内容')))
  expect(consume).toHaveBeenLastCalledWith('second', '第二份内容')
  consume.mockClear()
  await act(async () => view.update(component('second', false)))
  expect(consume).not.toHaveBeenCalled()
  expect(view.root.findByType('div').props['data-status']).toBe('idle')
  expect(load).toHaveBeenCalledTimes(2)
  await act(async () => view.update(component('second')))
  expect(consume).toHaveBeenLastCalledWith('second', '第二份内容')
  expect(load).toHaveBeenCalledTimes(3)
})

it('超时后迟到成功可恢复，主动重试后旧请求失败不覆盖最新结果', async () => {
  vi.useFakeTimers()
  const first = Promise.withResolvers<Envelope<string>>()
  const superseded = Promise.withResolvers<Envelope<string>>()
  const load = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => superseded.promise).mockResolvedValue(ok('重新读取的内容'))
  const consume = vi.fn()
  const view = await render(<Probe id="current" load={load} consume={consume} />)
  await act(async () => vi.advanceTimersByTime(100))
  expect(view.root.findByType('div').props['data-status']).toBe('error')
  await act(async () => first.resolve(ok('迟到的内容')))
  expect(consume).toHaveBeenLastCalledWith('current', '迟到的内容')
  await act(async () => view.root.findByType('button').props.onClick())
  expect(view.root.findByType('div').props['data-status']).toBe('loading')
  await act(async () => view.root.findByType('button').props.onClick())
  expect(consume).toHaveBeenLastCalledWith('current', '重新读取的内容')
  await act(async () => superseded.reject(new Error('过时的连接故障')))
  expect(view.root.findByType('div').props['data-status']).toBe('ready')
  expect(JSON.stringify(view.toJSON())).not.toContain('过时的连接故障')
  expect(consume).toHaveBeenLastCalledWith('current', '重新读取的内容')
  expect(load).toHaveBeenCalledTimes(3)
})
