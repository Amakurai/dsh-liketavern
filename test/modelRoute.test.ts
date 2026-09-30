/** 会话实际模型路由：请求头优先于创建时默认值，成对取用，布局通道映射回官方 provider，缺少请求头能力的替身也不抛错。 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { sessionModelRoute } from '../src/node/modelRoute.js'

const agentWith = (options: object, header?: object) => ({
  options,
  session: header === undefined ? {} : { requestHeader: () => header },
}) as unknown as Agent

describe('sessionModelRoute', () => {
  it('会话内换模后以最近请求头为准，不沿用创建时的默认 options', () => {
    expect(sessionModelRoute(agentWith({ provider: 'p-default', model: 'm-default' }, { config: { provider: 'p-now', model: 'm-now' } })))
      .toEqual({ provider: 'p-now', model: 'm-now' })
  })

  it('还没有请求头（首轮前）或替身不提供请求头时回退 options', () => {
    expect(sessionModelRoute(agentWith({ provider: 'p', model: 'm' }, undefined))).toEqual({ provider: 'p', model: 'm' })
    expect(sessionModelRoute(agentWith({ provider: 'p', model: 'm' }))).toEqual({ provider: 'p', model: 'm' })
  })

  it('请求头缺一半时整对回退，不拼出不存在的 provider/model 组合', () => {
    expect(sessionModelRoute(agentWith({ provider: 'p', model: 'm' }, { config: { provider: 'other', model: ' ' } })))
      .toEqual({ provider: 'p', model: 'm' })
  })

  it('本插件的布局通道映射回官方 provider；两处都没有路由时返回空', () => {
    expect(sessionModelRoute(agentWith({}, { config: { provider: 'tavern-deepseek', model: 'deepseek-v4' } })))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-v4' })
    expect(sessionModelRoute(agentWith({}, undefined))).toEqual({})
  })
})
