/** 辅助模型调用的完整性边界：只接受 stop 终止帧；超时/截断/错误均不得提交半截正文。 */
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

export async function collectCompleteText(stream: AsyncIterable<StreamChunk>, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const iterator = stream[Symbol.asyncIterator]()
  let text = ''
  let complete = false
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('生成已取消'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    while (true) {
      // 先安装取消的拒绝处理，再调用 next；适配器同步抛错也不会留下未处理的取消 Promise。
      const item = await Promise.race([Promise.resolve().then(() => iterator.next()), aborted])
      // 缓冲适配器可同步兑现 next；同刻取消时它可能先赢 race，终止帧也须复核信号。
      signal.throwIfAborted()
      if (item.done) break
      const chunk = item.value
      if (complete) throw new Error('模型在终止帧后继续发送内容')
      if (chunk.type === 'text-delta') {
        text += chunk.text
        if (text.length > 100_000) throw new Error('辅助生成正文超过上限')
      } else if (chunk.type === 'finish') {
        if (chunk.reason.kind !== 'stop') throw new Error(`模型未正常完成：${chunk.reason.kind}`)
        complete = true
      }
    }
    if (!complete || !text.trim()) throw new Error('模型未返回完整正文和成功终止帧')
    return text.trim()
  } finally {
    signal.removeEventListener('abort', onAbort)
    // 不等待忽略取消信号的适配器关闭，否则超时本身也会挂住维护队列。
    // 同步或异步关闭失败都不能遮掉原来的取消/模型故障。
    void Promise.resolve().then(() => iterator.return?.()).catch(() => {})
  }
}
