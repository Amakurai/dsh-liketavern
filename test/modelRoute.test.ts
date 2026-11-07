/**
 * 会话实际模型路由：与宿主 modelSelection 投影同口径——尚未被请求使用的最新选择优先（换模后第一轮），
 * 其次最近请求头，再次创建时默认值；成对取用，布局通道映射回官方 provider，缺少日志能力的替身也不抛错。
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ensureAgentRequestSelectionSync, sessionModelRoute } from '../src/node/modelRoute.js'

const agentWith = (options: object, header?: object) => ({
  options,
  session: header === undefined ? {} : { requestHeader: () => header },
}) as unknown as Agent

const selection = (provider: string, model: string) => ({ type: 'model/selection', data: { provider, model } })
const request = (provider: string, model: string) => ({ type: 'request/header', data: { header: { config: { provider, model } } } })
const agentWithEvents = (options: object, events: object[]) => ({ options, session: { snapshotEvents: () => events } }) as unknown as Agent

describe('sessionModelRoute', () => {
  it('会话内换模后以最近请求头为准，不沿用创建时的默认 options', () => {
    expect(sessionModelRoute(agentWith({ provider: 'p-default', model: 'm-default' }, { config: { provider: 'p-now', model: 'm-now' } })))
      .toEqual({ provider: 'p-now', model: 'm-now' })
  })

  it('换模后第一轮：新选择尚未发出请求，也以本次选择为准，而不是上一轮的请求头', () => {
    const options = { provider: 'p-default', model: 'm-default' }
    expect(sessionModelRoute(agentWithEvents(options, [request('p-a', 'big-window'), selection('p-b', 'small-window')])))
      .toEqual({ provider: 'p-b', model: 'small-window' })
    // 请求用过该选择后保持不变；之后的请求头继续跟随
    expect(sessionModelRoute(agentWithEvents(options, [selection('p-b', 'small'), request('p-b', 'small')])))
      .toEqual({ provider: 'p-b', model: 'small' })
    // 布局通道改写了请求 provider：选择不被消耗，仍映射到同一官方路由
    expect(sessionModelRoute(agentWithEvents(options, [selection('deepseek-official', 'v4'), request('tavern-deepseek', 'v4')])))
      .toEqual({ provider: 'deepseek-official', model: 'v4' })
    // 日志里还没有任何路由时回退 options
    expect(sessionModelRoute(agentWithEvents(options, []))).toEqual(options)
  })

  it('还没有请求头（首轮前）或替身不提供日志能力时回退 options', () => {
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

it('安装 Tavern 请求兼容时不改变其它会话的模型选择，也不覆盖首轮前已选择的模型', async () => {
  type Selection = { provider: string; model: string }
  class Model {
    state: { pending: Selection | null; lastUsed: Selection | null }
    readonly calls: Selection[] = []
    readonly session = { ownEvents: () => [] }
    constructor(readonly options: Selection, pending: Selection | null, lastUsed: Selection | null) {
      this.state = { pending, lastUsed }
    }
    readState() { return this.state }
    current() { return this.state.pending ?? this.state.lastUsed ?? this.options }
    select(selection: Selection) { this.calls.push(selection); this.state.pending = selection }
  }
  class Machine {
    readonly requestHeaderLogged = false
    readonly dispatch = { waterfall: async () => ({ provider: 'unused', model: 'unused' }) }
    readonly session = { snapshotEvents: () => [] }
    constructor(readonly options: Selection, readonly model: Model) {}
    async preStep() { return { kind: 'enter', selection: this.model.current() } }
  }
  const defaults = { provider: 'factory', model: 'default' }
  const chosen = { provider: 'factory', model: 'chosen' }
  const inherited = { provider: 'factory', model: 'inherited' }
  const tavern = new Machine(defaults, new Model(defaults, chosen, null))
  const other = new Machine(defaults, new Model(defaults, null, inherited))

  ensureAgentRequestSelectionSync(tavern)
  expect(other.model.current()).toEqual(inherited)
  expect((await other.preStep()).selection).toEqual(inherited)
  expect(other.model.calls).toEqual([])
  expect((await tavern.preStep()).selection).toEqual(chosen)
  expect(tavern.model.calls).toEqual([])
})
