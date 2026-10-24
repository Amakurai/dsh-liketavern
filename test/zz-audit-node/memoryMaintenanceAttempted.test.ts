/**
 * 记忆维护「每个已结束轮次只尝试一次」登记表的有界淘汰回归：
 * attempted 只在失败回滚时删除，key 随剧情数量增长；没有上限时进程长驻会无界膨胀
 * （同口径的 triggerLogs/helperTurnClosures 都有界）。验证超限淘汰最旧 key、
 * 已有 key 更新不挤掉别人、上限内行为不变。
 */
import { expect, it } from 'vitest'
import { ATTEMPTED_KEYS_MAX, noteAttemptedMarker } from '../../src/node/memoryMaintenance.js'

it('超过上限时淘汰最旧的 key，保留最近的登记', () => {
  const attempted = new Map<string, string>()
  for (let i = 0; i < ATTEMPTED_KEYS_MAX; i++) attempted.set(`story-${i}`, `agent#t${i}`)
  noteAttemptedMarker(attempted, 'story-new', 'agent#t9')
  expect(attempted.size).toBe(ATTEMPTED_KEYS_MAX)
  expect(attempted.has('story-0')).toBe(false)
  expect(attempted.get('story-new')).toBe('agent#t9')
  expect(attempted.has(`story-${ATTEMPTED_KEYS_MAX - 1}`)).toBe(true)
})

it('更新已有 key 不触发淘汰，也不挤掉其它 key', () => {
  const attempted = new Map<string, string>()
  for (let i = 0; i < ATTEMPTED_KEYS_MAX; i++) attempted.set(`story-${i}`, `agent#t${i}`)
  noteAttemptedMarker(attempted, 'story-0', 'agent#t100')
  expect(attempted.size).toBe(ATTEMPTED_KEYS_MAX)
  expect(attempted.get('story-0')).toBe('agent#t100')
  expect(attempted.has('story-1')).toBe(true)
})

it('上限内正常记录且可区分同轮重复与新一轮', () => {
  const attempted = new Map<string, string>()
  noteAttemptedMarker(attempted, 'story-a', 'agent-1#t3')
  expect(attempted.get('story-a')).toBe('agent-1#t3')
  // 同一轮的重复 idle：调用方先比对 marker，一致则跳过（这里模拟比对语义仍成立）
  noteAttemptedMarker(attempted, 'story-a', 'agent-1#t4')
  expect(attempted.get('story-a')).toBe('agent-1#t4')
})
