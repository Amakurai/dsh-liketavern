/**
 * 气泡展示批处理：同一时刻挂载的气泡（长历史首屏、加载更早、跳转）合成 renderOutputTexts。
 * 服务端只读取一次绑定、历史与变量；卡面快照、脚本库与世界书在响应里只出现一次，这里按引用
 * 重组为各气泡的 RenderedOutput，messages/scopes 共用同一份对象，不逐条复制。
 * 只有一个待发请求、或宿主没有批量方法时沿用 renderOutputText，行为与逐条请求一致。
 */
import { helperSnapshotAt } from '../core/helperRuntime.js'
import { RENDER_OUTPUT_BATCH_MAX, type RenderedOutput, type RenderedOutputBatch } from '../remote.js'
import type { Envelope, TavernRemote } from './types.js'

type RenderRequest = { sessionId: string; text: string; messageId?: number }
interface Pending { request: RenderRequest; resolve: (value: Envelope<RenderedOutput>) => void }

// remote → sessionId → 本窗口内待发请求；窗口为一个宏任务，覆盖同一批提交里的所有气泡挂载。
const queues = new Map<TavernRemote, Map<string, Pending[]>>()

export function renderOutputBatched(remote: TavernRemote, request: RenderRequest): Promise<Envelope<RenderedOutput>> {
  if (typeof remote.renderOutputTexts !== 'function') return remote.renderOutputText(request)
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

function flush(remote: TavernRemote): void {
  const sessions = queues.get(remote)
  queues.delete(remote)
  if (!sessions) return
  for (const [sessionId, pending] of sessions) {
    if (pending.length === 1) {
      const only = pending[0]!
      void Promise.resolve().then(() => remote.renderOutputText(only.request)).then(only.resolve, (error: unknown) => only.resolve(failure(errorText(error))))
      continue
    }
    for (let start = 0; start < pending.length; start += RENDER_OUTPUT_BATCH_MAX) {
      const chunk = pending.slice(start, start + RENDER_OUTPUT_BATCH_MAX)
      const items = chunk.map(({ request }) => ({ text: request.text, ...(request.messageId === undefined ? {} : { messageId: request.messageId }) }))
      void Promise.resolve()
        .then(() => remote.renderOutputTexts({ sessionId, items }))
        .then((response) => {
          if (!response.ok) { for (const item of chunk) item.resolve(response); return }
          const outputs = expandRenderedOutputBatch(response.value)
          chunk.forEach((item, index) => item.resolve(outputs[index] ?? failure('批量展示结果缺少该消息')))
        }, (error: unknown) => { for (const item of chunk) item.resolve(failure(errorText(error))) })
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 按引用重组批次结果；声明了共享部分却缺失时该项明确失败，不静默丢掉卡面数据。 */
export function expandRenderedOutputBatch(batch: RenderedOutputBatch): Envelope<RenderedOutput>[] {
  return batch.items.map((item) => {
    if (!item.ok) return failure(item.error)
    const { helperMessageId, helperExtras, ...rest } = item.value
    if (helperMessageId !== undefined && !batch.helperBase) return failure('批量展示结果缺少卡面快照')
    if (helperExtras && (!batch.helperScripts || !batch.helperWorldbooks)) return failure('批量展示结果缺少脚本库或世界书上下文')
    const value: RenderedOutput = {
      ...rest,
      ...(helperMessageId === undefined ? {} : { helper: helperSnapshotAt(batch.helperBase!, helperMessageId) }),
      ...(helperExtras ? { helperScripts: batch.helperScripts!, helperWorldbooks: batch.helperWorldbooks! } : {}),
    }
    return { ok: true, value }
  })
}
