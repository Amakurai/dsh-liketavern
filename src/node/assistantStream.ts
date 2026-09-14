/** 宿主回复收口：只认可该消息自身嵌入流中唯一、位于末尾的正常 stop，不借用失败重试的结束帧。 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export function hasNormalAssistantStop(event: SessionEvent<'assistant/message'>): boolean {
  const { stream, interrupted } = event.data
  if (interrupted || !Array.isArray(stream)) return false
  const last = stream.at(-1)
  return stream.filter(record => record.type === 'chunk' && record.chunk.type === 'finish').length === 1
    && last?.type === 'chunk' && last.chunk.type === 'finish' && last.chunk.reason.kind === 'stop'
}
