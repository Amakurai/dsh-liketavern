/**
 * useToast 回归：同毫秒连续两次 show 不得共用 Toast 实例（key 必须单调递增），
 * 否则第二条消息沿用第一条的停留计时器提前淡出；迟到的旧关闭回调不能清掉新通知。
 */
import { afterEach, expect, it, vi } from 'vitest'
import { act, create } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'
import { useToast } from '../src/client/util.js'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'

// class mock：componentDidMount 只在真正挂载时触发。key 撞号时 React 复用实例只更新
// props（不重挂、计时器不重置）；key 递增才会卸载旧实例并挂载新实例。
const mounts = vi.hoisted(() => [] as string[])
vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const { Component } = await import('react')
  class MockToast extends Component<{ text: string; onDone: () => void }> {
    componentDidMount() { mounts.push(this.props.text) }
    render() { return <span>{this.props.text}</span> }
  }
  return { Toast: MockToast }
})

function ToastHost(props: { onReady: (show: (text: string) => void) => void }) {
  const toast = useToast()
  props.onReady(toast.show)
  return <>{toast.node}</>
}

let view: ReactTestRenderer | undefined
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; mounts.length = 0 })

it('同一毫秒内先后两次 show 各自重新挂载 Toast，第二条不沿用第一条的计时器', async () => {
  let show!: (text: string) => void
  await act(async () => { view = create(<ToastHost onReady={(fn) => { show = fn }} />) })
  // 固定 Date.now：两次 show 分属两次渲染但时间戳相同。旧实现 key 撞号，React 复用
  // 实例只更新文本；计数器 key 保证每次 show 都重新挂载（停留计时器随之重置）。
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  try {
    await act(async () => { show('第一条') })
    await act(async () => { show('第二条') })
  } finally {
    now.mockRestore()
  }
  expect(mounts).toEqual(['第一条', '第二条'])
  expect(view.root.findAllByType('span').map((n) => n.children[0])).toEqual(['第二条'])
})

it('正常时间流下的 show 同样各自重新挂载', async () => {
  let show!: (text: string) => void
  await act(async () => { view = create(<ToastHost onReady={(fn) => { show = fn }} />) })
  await act(async () => { show('第一条') })
  await act(async () => { show('第二条') })
  expect(mounts).toEqual(['第一条', '第二条'])
})

it.each([false, true])('旧通知的迟到关闭只影响自身，第二条仍完整展示且可正常关闭，同批出现：%s', async sameBatch => {
  let show!: (text: string) => void
  await act(async () => { view = create(<ToastHost onReady={fn => { show = fn }}/>) })
  await act(async () => show('第一条'))
  const finishOld = view!.root.findByType(Toast).props.onDone as () => void
  if (sameBatch) await act(async () => { show('第二条'); finishOld() })
  else { await act(async () => show('第二条')); await act(async () => finishOld()) }
  expect(view!.root.findAllByType('span').map(span => span.children.join(''))).toEqual(['第二条'])
  await act(async () => view!.root.findByType(Toast).props.onDone())
  expect(view!.root.findAllByType('span')).toHaveLength(0)
})
