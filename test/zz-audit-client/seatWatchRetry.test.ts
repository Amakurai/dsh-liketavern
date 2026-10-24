/**
 * seatWatch 补偿状态机回归：冷却窗口（1.5s）会吞掉真边沿——用户在冷却内切走再切回
 * Tavern 时，切回的边沿被 coolingDown 拦截后既不重试也不再出现在 lastTavern 比较里，
 * 若首次补偿又被宿主静默失败（无工作区/基线未就绪），补偿永久丢失、dock 不出现。
 * 验证：冷却结束主动复查补发；会话出现后停止重试；持续失败时复查有上限、卸载后不再补发；切走放弃后新边沿仍有效；刷新基线不触发。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installTavernSeatWatch, SEAT_RETRY_MAX } from '../../src/client/seatWatch.js'

let chipTitle = '选择新任务使用的 Agent 预设'
let chipText = ''
let chipOnTree = true
let shownSession = false
const startSession = vi.fn()
let domChange!: () => void
let dispose: (() => void) | undefined

class FakeMutationObserver {
  callback: () => void
  constructor(callback: () => void) { this.callback = callback }
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.useFakeTimers()
  const button = {
    getAttribute: (name: string) => name === 'title' ? chipTitle : name === 'class' ? 'cubgiG_seat' : null,
    get textContent() { return chipText },
  }
  const observers: FakeMutationObserver[] = []
  domChange = () => { for (const observer of observers) observer.callback() }
  vi.stubGlobal('document', {
    body: {},
    querySelectorAll: () => chipOnTree ? [button] : [],
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  vi.stubGlobal('MutationObserver', class extends FakeMutationObserver {
    constructor(callback: () => void) { super(callback); observers.push(this) }
  })
  chipTitle = '选择新任务使用的 Agent 预设'; chipText = ''; chipOnTree = true; shownSession = false
  startSession.mockClear()
})

afterEach(() => {
  dispose?.(); dispose = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 安装并等待首个采样，建立基线（此时 chipText 已是基线值）。 */
function installWithBaseline(): void {
  dispose = installTavernSeatWatch(
    { get: () => ({ startSession }), workspaces: {} } as never,
    { hasShownSession: () => shownSession },
  )
  vi.advanceTimersByTime(200)
}

it('首次补偿失败后，冷却内切走再切回的边沿不丢：冷却结束复查再补一次', () => {
  installWithBaseline()
  chipText = 'Tavern 模式'
  domChange(); vi.advanceTimersByTime(200)
  expect(startSession).toHaveBeenCalledTimes(1)
  // 冷却内切走再切回（宿主静默失败的场景）
  chipText = ''
  domChange(); vi.advanceTimersByTime(200)
  chipText = 'Tavern 模式'
  domChange(); vi.advanceTimersByTime(200)
  expect(startSession).toHaveBeenCalledTimes(1)
  // 冷却结束：目标状态仍满足（chip=Tavern、无会话）→ 主动复查补发
  vi.advanceTimersByTime(1500 + 200)
  expect(startSession).toHaveBeenCalledTimes(2)
})

it('会话出现后冷却结束的复查不再补发', () => {
  installWithBaseline()
  chipText = 'Tavern 模式'
  domChange(); vi.advanceTimersByTime(200)
  expect(startSession).toHaveBeenCalledTimes(1)
  shownSession = true
  vi.advanceTimersByTime(1500 + 200)
  domChange(); vi.advanceTimersByTime(200)
  expect(startSession).toHaveBeenCalledTimes(1)
})

it('用户切走即放弃补偿；冷却过后切回是新的真边沿，正常补发', () => {
  installWithBaseline()
  chipText = 'Tavern 模式'
  domChange(); vi.advanceTimersByTime(200)
  expect(startSession).toHaveBeenCalledTimes(1)
  chipText = ''
  domChange(); vi.advanceTimersByTime(200)
  vi.advanceTimersByTime(1500)
  chipText = 'Tavern 模式'
  domChange(); vi.advanceTimersByTime(200)
  expect(startSession).toHaveBeenCalledTimes(2)
})

it('刷新页面且默认预设就是 Tavern 时只建基线，不自动开会话', () => {
  chipText = 'Tavern 模式'
  installWithBaseline()
  domChange(); vi.advanceTimersByTime(200)
  domChange(); vi.advanceTimersByTime(200)
  expect(startSession).not.toHaveBeenCalled()
})

it('宿主持续静默失败时复查补发到上限即停，不会在条件迟后满足时凭空开会话', () => {
  installWithBaseline()
  chipText = 'Tavern 模式'
  domChange(); vi.advanceTimersByTime(200)
  // 每个冷却周期（1500 冷却 + 200 合并窗口）补发一次，直到上限
  vi.advanceTimersByTime((1500 + 200) * (SEAT_RETRY_MAX + 5))
  expect(startSession).toHaveBeenCalledTimes(1 + SEAT_RETRY_MAX)
  // 放弃后 DOM 继续变动（流式输出等）也不再补发
  domChange(); vi.advanceTimersByTime(200)
  vi.advanceTimersByTime(60_000)
  expect(startSession).toHaveBeenCalledTimes(1 + SEAT_RETRY_MAX)
})

it('达到上限后用户再次切走切回是新的真边沿，额度重新计算', () => {
  installWithBaseline()
  chipText = 'Tavern 模式'
  domChange(); vi.advanceTimersByTime(200)
  vi.advanceTimersByTime((1500 + 200) * (SEAT_RETRY_MAX + 2))
  expect(startSession).toHaveBeenCalledTimes(1 + SEAT_RETRY_MAX)
  chipText = ''
  domChange(); vi.advanceTimersByTime(200)
  chipText = 'Tavern 模式'
  domChange(); vi.advanceTimersByTime(200)
  expect(startSession).toHaveBeenCalledTimes(2 + SEAT_RETRY_MAX)
  vi.advanceTimersByTime(1500 + 200)
  expect(startSession).toHaveBeenCalledTimes(3 + SEAT_RETRY_MAX)
})

it('卸载后冷却结束不再复查补发', () => {
  installWithBaseline()
  chipText = 'Tavern 模式'
  domChange(); vi.advanceTimersByTime(200)
  expect(startSession).toHaveBeenCalledTimes(1)
  dispose?.(); dispose = undefined
  vi.advanceTimersByTime(10_000)
  expect(startSession).toHaveBeenCalledTimes(1)
})
