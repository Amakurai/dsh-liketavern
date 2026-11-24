/**
 * 气泡展示批处理：同一时刻挂载的气泡（长历史首屏、加载更早、跳转）合成 renderOutputTexts。
 * 服务端只读取一次绑定、历史与变量；卡面快照、脚本库与世界书在响应里只出现一次，这里按引用
 * 重组为各气泡的 RenderedOutput，messages/scopes 共用同一份对象，不逐条复制。
 * 只有一个待发请求、或宿主没有批量方法时沿用 renderOutputText，行为与逐条请求一致。
 */
import { describeError } from '../core/guards.js'
import { helperSnapshotAt } from '../core/helperRuntime.js'
import { RENDER_OUTPUT_BATCH_MAX, type RenderedOutput, type RenderedOutputBatch } from '../remote.js'
import type { Envelope, TavernRemote } from './types.js'

type RenderRequest = { sessionId: string; text: string; messageId?: number }
interface Pending { request: RenderRequest; resolve: (value: Envelope<RenderedOutput>) => void }

// remote → sessionId → 本窗口内待发请求；窗口为一个宏任务，覆盖同一批提交里的所有气泡挂载。
const queues = new Map<TavernRemote, Map<string, Pending[]>>()

export function renderOutputBatched(remote: TavernRemote, request: RenderRequest): Promise<Envelope<RenderedOutput>> {
  if (typeof remote.renderOutputTexts !== 'function') {
    return Promise.resolve().then(() => remote.renderOutputText(request)).catch((error: unknown) => failure(errorText(error)))
  }
  return new Promise((resolve) => {
    let sessions = queues.get(remote)
    if (!sessions) {
      sessions = new Map()
      queues.set(remote, sessions)
      setTimeout(() => flush(remote), 0)
    }
    const list = sessions.get(request.sessionId) ?? []
    list.push({ request, resolve })
    sessions.set(request.sessionId, list)
  })
}

function failure(message: string): Envelope<RenderedOutput> {
  return { ok: false, error: { code: 'render-failed', message } }
}

function requestKey(request: RenderRequest): string {
  return `${request.messageId === undefined ? 'none' : String(request.messageId)}\0${request.text}`
}

function flush(remote: TavernRemote): void {
  const sessions = queues.get(remote)
  queues.delete(remote)
  if (!sessions) return
  for (const [sessionId, pending] of sessions) {
    // 同帧（如 StrictMode 双挂载）对同一气泡发起相同请求时先去重，再决定走单条还是分批。
    const unique: Array<{ request: RenderRequest; resolvers: Array<Pending['resolve']> }> = []
    const byKey = new Map<string, Array<Pending['resolve']>>()
    for (const item of pending) {
      const key = requestKey(item.request)
      let resolvers = byKey.get(key)
      if (!resolvers) {
        resolvers = []
        byKey.set(key, resolvers)
        unique.push({ request: item.request, resolvers })
      }
      resolvers.push(item.resolve)
    }
    if (unique.length === 1) {
      const only = unique[0]!
      const fanout = (result: Envelope<RenderedOutput>) => {
        for (const resolve of only.resolvers) resolve(result)
      }
      void Promise.resolve()
        .then(() => remote.renderOutputText(only.request))
        .then(fanout, (error: unknown) => fanout(failure(errorText(error))))
      continue
    }
    for (let start = 0; start < unique.length; start += RENDER_OUTPUT_BATCH_MAX) {
      const chunk = unique.slice(start, start + RENDER_OUTPUT_BATCH_MAX)
      const items = chunk.map(({ request }) => ({ text: request.text, ...(request.messageId === undefined ? {} : { messageId: request.messageId }) }))
      // 用 .catch 收口而不是 .then 的第二参数：重组跨网关的 unknown 响应可能抛错，
      // onFulfilled 内抛出的异常不属于原 Promise 的拒绝，第二参数接不住，会让整批气泡永久 pending。
      void Promise.resolve()
        .then(() => remote.renderOutputTexts({ sessionId, items }))
        .then((response) => {
          if (!response.ok) {
            for (const entry of chunk) for (const resolve of entry.resolvers) resolve(response)
            return
          }
          const outputs = expandRenderedOutputBatch(response.value)
          chunk.forEach((entry, index) => {
            const out = outputs[index] ?? failure('批量展示结果缺少该消息')
            for (const resolve of entry.resolvers) resolve(out)
          })
        })
        .catch((error: unknown) => {
          const err = failure(errorText(error))
          for (const entry of chunk) for (const resolve of entry.resolvers) resolve(err)
        })
    }
  }
}

function errorText(error: unknown): string {
  return describeError(error)
}

/** 按引用重组批次结果；单项异常只影响该项，声明了共享部分却缺失时明确失败，不静默丢掉卡面数据。 */
export function expandRenderedOutputBatch(batch: RenderedOutputBatch): Envelope<RenderedOutput>[] {
  if (!batch || !Array.isArray(batch.items)) throw new Error('批量展示结果格式无效')
  return batch.items.map((item) => {
    try {
      if (!item || typeof item !== 'object') return failure('批量展示单项格式无效')
      if (!item.ok) return failure(typeof item.error === 'string' && item.error ? item.error : '展示渲染失败')
      if (!item.value || typeof item.value !== 'object') return failure('批量展示单项缺少结果对象')
      const { helperMessageId, helperExtras, ...rest } = item.value
      if (helperMessageId !== undefined && !batch.helperBase) return failure('批量展示结果缺少卡面快照')
      if (helperExtras && (!batch.helperScripts || !batch.helperWorldbooks)) return failure('批量展示结果缺少脚本库或世界书上下文')
      const value: RenderedOutput = {
        ...rest,
        ...(helperMessageId === undefined ? {} : { helper: helperSnapshotAt(batch.helperBase!, helperMessageId) }),
        ...(helperExtras ? { helperScripts: batch.helperScripts!, helperWorldbooks: batch.helperWorldbooks! } : {}),
      }
      return { ok: true, value }
    } catch (error) {
      return failure(errorText(error))
    }
  })
}
