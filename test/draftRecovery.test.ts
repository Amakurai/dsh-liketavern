/** 本页恢复记录的资源与回执边界：容量保留未确认数据、连接隔离、UTF-8 上限和迟到回执均用真实事件目标验证。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { acquireDraftRecovery, confirmDraftRecovery, DRAFT_RECOVERY_SCOPE_LIMIT, DraftRecoveryTooLargeError,
  failDraftRecovery, releaseDraftRecovery, restorePreviousDraftRecovery, stageDraftRecovery, unavailableDraftRecovery,
  type DraftRecoveryChannel } from '../src/client/draftRecovery.js'

const leases: Array<{ remote: object; key: string; holder: object; channel: DraftRecoveryChannel }> = []
function acquire(remote: object, key: string) {
  const holder = {}, channel = acquireDraftRecovery(remote, key, holder)
  if (channel) leases.push({ remote, key, holder, channel })
  return channel
}
const content = (text: string) => JSON.stringify({ version: 1, fields: { text } })
beforeEach(() => { vi.stubGlobal('window', new EventTarget()) })
afterEach(async () => {
  for (const { remote, key, holder, channel } of leases.splice(0)) {
    if (channel.pending) confirmDraftRecovery(remote, key, channel, channel.pending)
    releaseDraftRecovery(remote, key, channel, holder)
  }
  await Promise.resolve()
  vi.unstubAllGlobals()
})

it('连接与分区各自保留恢复内容，不能共享同一键的另一宿主数据', () => {
  const first = {}, second = {}, a = acquire(first, 'same')!, b = acquire(second, 'same')!, other = acquire(first, 'other')!
  stageDraftRecovery(a, content('第一宿主的未确认正文'))
  expect(b.pending).toBeUndefined(); expect(other.pending).toBeUndefined()
  expect(acquire(first, 'same')).toBe(a)
  expect(a.pending?.serialized).toBe(content('第一宿主的未确认正文'))
})

it('槽位满时不逐出未确认内容，原分区仍能重开确认，释放后才接受新分区', async () => {
  const remote = {}, entries: DraftRecoveryChannel[] = []
  for (let index = 0; index < DRAFT_RECOVERY_SCOPE_LIMIT; index++) {
    const channel = acquire(remote, String(index))!
    stageDraftRecovery(channel, content(`未确认 ${index}`)); entries.push(channel)
  }
  expect(acquire(remote, 'overflow')).toBeNull()
  expect(acquire(remote, '0')).toBe(entries[0])
  for (let index = 0; index < entries.length; index++) expect(entries[index]!.pending?.serialized).toBe(content(`未确认 ${index}`))
  const channel = entries[0]!
  confirmDraftRecovery(remote, '0', channel, channel.pending!)
  for (const lease of leases.filter(lease => lease.channel === channel)) releaseDraftRecovery(remote, '0', channel, lease.holder)
  await Promise.resolve()
  expect(acquire(remote, 'overflow')).not.toBeNull()
  for (let index = 1; index < entries.length; index++) expect(entries[index]!.pending?.serialized).toBe(content(`未确认 ${index}`))
})

it('旧成功与旧失败回执均不能清除或污染更新的恢复记录', () => {
  const remote = {}, channel = acquire(remote, 'draft')!
  const first = stageDraftRecovery(channel, content('旧正文')), latest = stageDraftRecovery(channel, content('最新正文'))
  confirmDraftRecovery(remote, 'draft', channel, first)
  failDraftRecovery(channel, first, '旧请求错误')
  expect(channel.pending).toBe(latest)
  expect(latest.error).toBeUndefined()
  failDraftRecovery(channel, latest, '当前请求失败')
  expect(latest.error).toBe('当前请求失败')
})

it('失败标记保留上一份有界草稿，过时的恢复确认不能丢掉更新正文', () => {
  const remote = {}, channel = acquire(remote, 'draft')!
  stageDraftRecovery(channel, content('上一份正文'))
  unavailableDraftRecovery(channel, '最新修改超限')
  const marker = channel.pending!
  expect(marker.unavailable).toBe(true)
  expect(marker.serialized).toBe(content('上一份正文'))
  const latest = stageDraftRecovery(channel, content('另一编辑器的新正文'))
  restorePreviousDraftRecovery(remote, 'draft', channel, marker)
  expect(channel.pending).toBe(latest)
})

it('恢复上限按 UTF-8 字节计算，不能以较短字符数接收超限正文', () => {
  const channel = acquire({}, 'draft')!, previous = stageDraftRecovery(channel, content('已确认前的正文'))
  const large = content('界'.repeat(700_000))
  expect(large.length).toBeLessThan(2 * 1024 * 1024)
  expect(() => stageDraftRecovery(channel, large)).toThrow(DraftRecoveryTooLargeError)
  expect(channel.pending).toBe(previous)
})

it('关闭全部编辑器后未确认数据继续保护页面离开，成功确认后解除', async () => {
  const remote = {}, key = 'draft', channel = acquire(remote, key)!, record = stageDraftRecovery(channel, content('本页正文'))
  const lease = leases.at(-1)!
  releaseDraftRecovery(remote, key, channel, lease.holder)
  await Promise.resolve()
  const pending = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(pending)
  expect(pending.defaultPrevented).toBe(true)
  confirmDraftRecovery(remote, key, channel, record)
  const done = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(done)
  expect(done.defaultPrevented).toBe(false)
})
