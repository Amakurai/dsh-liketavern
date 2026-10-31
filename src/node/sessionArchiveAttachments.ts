/** 会话附件收集：仅检查宿主定义的事件内容字段，和官方导出器使用相同的引用范围。 */
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface ArchiveReferences { images: Map<string, ImageAttachmentRef>; files: Map<string, FileAttachmentRef> }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

/** 未知事件的数据保持不透明，不能把第三方对象里的路径或伪引用当作附件读取。 */
export function sessionAttachmentReferences(events: readonly SessionEvent[]): ArchiveReferences {
  const images = new Map<string, ImageAttachmentRef>(), files = new Map<string, FileAttachmentRef>()
  const content = (value: unknown) => {
    if (!Array.isArray(value)) return
    for (const block of value) {
      if (!object(block) || !object(block.attachment)) continue
      const ref = block.attachment
      if (block.type === 'image') images.set(String(ref.attachmentId), ref as unknown as ImageAttachmentRef)
      if (block.type === 'file') files.set(`${String(ref.attachmentId)}\0${String(ref.name)}`, ref as unknown as FileAttachmentRef)
    }
  }
  for (const event of events) {
    const data: unknown = event.data
    if (!object(data)) continue
    const message = object(data.message) ? data.message : undefined
    const type: string = event.type
    switch (type) {
      case 'user/message': case 'tool/ptc-dispatch': content(data.content); break
      case 'system/message': case 'developer/message': case 'tool/result': case 'team/message/queued': content(message?.content); break
      case 'agent/inbox/spliced':
        if (Array.isArray(data.inserted)) for (const item of data.inserted) if (object(item)) content(item.content)
        break
      case 'compaction/summary': content(data.summary); content(data.rawOutput); break
      case 'assistant/message': content(message?.content)
      // assistant/attempt 和 assistant/message 都可能包含完成的流式块。
      case 'assistant/attempt':
        if (Array.isArray(data.stream)) for (const item of data.stream) {
          if (object(item) && item.type === 'chunk' && object(item.chunk) && item.chunk.type === 'block-end') content([item.chunk.block])
        }
        break
    }
  }
  return { images, files }
}
