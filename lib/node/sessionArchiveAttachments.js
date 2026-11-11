import { isRecord } from '../core/guards.js';
/** 未知事件的数据保持不透明，不能把第三方对象里的路径或伪引用当作附件读取。 */
export function sessionAttachmentReferences(events) {
    const images = new Map(), files = new Map();
    const content = (value) => {
        if (!Array.isArray(value))
            return;
        for (const block of value) {
            if (!isRecord(block) || !isRecord(block.attachment))
                continue;
            const ref = block.attachment;
            if (block.type === 'image')
                images.set(String(ref.attachmentId), ref);
            if (block.type === 'file')
                files.set(`${String(ref.attachmentId)}\0${String(ref.name)}`, ref);
        }
    };
    for (const event of events) {
        const data = event.data;
        if (!isRecord(data))
            continue;
        const message = isRecord(data.message) ? data.message : undefined;
        const type = event.type;
        switch (type) {
            case 'user/message':
            case 'tool/ptc-dispatch':
                content(data.content);
                break;
            case 'system/message':
            case 'developer/message':
            case 'tool/result':
            case 'team/message/queued':
                content(message?.content);
                break;
            case 'agent/inbox/spliced':
                if (Array.isArray(data.inserted))
                    for (const item of data.inserted)
                        if (isRecord(item))
                            content(item.content);
                break;
            case 'compaction/summary':
                content(data.summary);
                content(data.rawOutput);
                break;
            case 'assistant/message': content(message?.content);
            // assistant/attempt 和 assistant/message 都可能包含完成的流式块。
            case 'assistant/attempt':
                if (Array.isArray(data.stream))
                    for (const item of data.stream) {
                        if (isRecord(item) && item.type === 'chunk' && isRecord(item.chunk) && item.chunk.type === 'block-end')
                            content([item.chunk.block]);
                    }
                break;
        }
    }
    return { images, files };
}
