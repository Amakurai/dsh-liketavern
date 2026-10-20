/**
 * 修复回归：会话内换模后立即分支，forkAgentOptions 必须复用 modelRoute 的最新路由口径
 * （未被请求消费的 model/selection 优先），保证子会话带父会话最新 provider/model；
 * 同时仍只继承父 agent.options 的 maxTokens，不把 header 采样升级成子会话默认值。
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { forkAgentOptions } from '../../src/node/floors.js'
import { sessionModelRoute } from '../../src/node/modelRoute.js'

const request = (provider: string, model: string) => ({
  type: 'request/header', seq: 1, time: 0, data: { header: { config: { provider, model } } },
})
const selection = (provider: string, model: string) => ({
  type: 'model/selection', seq: 2, time: 0, data: { provider, model },
})

describe('换模后立即分支的模型路由', () => {
  it('forkAgentOptions 取未消费的新选择，与 sessionModelRoute 口径一致', () => {
    const options = { provider: 'deepseek-official', model: 'deepseek-v4-old' }
    const events = [request('deepseek-official', 'deepseek-v4-old'), selection('deepseek-official', 'deepseek-v4-new')]
    const session = {
      requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-old' } }),
      snapshotEvents: () => events,
    } as unknown as Session

    const forked = forkAgentOptions({ options } as Pick<Agent, 'options'>, session)
    expect(forked).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-new' })

    const route = sessionModelRoute({ options, session } as unknown as Pick<Agent, 'options' | 'session'>)
    expect(forked).toMatchObject(route)
  })

  it('仍只继承父 agent.options 的 maxTokens，不继承 header 采样上限', () => {
    const session = {
      requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-chat', maxTokens: 8192 } }),
      snapshotEvents: () => [],
    } as unknown as Session
    expect(forkAgentOptions({ options: { maxTokens: 100 } } as Pick<Agent, 'options'>, session))
      .toEqual({ maxTokens: 100, provider: 'deepseek-official', model: 'deepseek-chat' })
  })

  it('布局通道 provider 映射回官方通道，不把 tavern-deepseek 写进子会话', () => {
    const session = {
      requestHeader: () => ({ config: { provider: 'tavern-deepseek', model: 'deepseek-v4' } }),
      snapshotEvents: () => [],
    } as unknown as Session
    expect(forkAgentOptions(undefined, session)).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4' })
  })

  it('没有日志路由时仍回退 options / 最近非开场白 assistant source', () => {
    const session = {
      requestHeader: () => undefined,
      snapshotEvents: () => [],
    } as unknown as Session
    expect(forkAgentOptions({ options: { provider: 'deepseek', model: 'deepseek-v4' } } as Pick<Agent, 'options'>, session))
      .toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
  })
})
