/** 会话附件收集：仅检查宿主定义的事件内容字段，和官方导出器使用相同的引用范围。 */
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
export interface ArchiveReferences {
    images: Map<string, ImageAttachmentRef>;
    files: Map<string, FileAttachmentRef>;
}
/** 未知事件的数据保持不透明，不能把第三方对象里的路径或伪引用当作附件读取。 */
export declare function sessionAttachmentReferences(events: readonly SessionEvent[]): ArchiveReferences;
