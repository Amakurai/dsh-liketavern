import { type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { type SessionBinding } from './bindings.js';
export declare const SESSION_ARCHIVE_MAX_BYTES: number;
export declare const SESSION_ARCHIVE_MAX_JSON_BYTES: number;
export declare const SESSION_ARCHIVE_MAX_FILES = 20000;
export type SessionArchiveArea = 'card' | 'story' | 'global';
export interface SessionArchiveFile {
    area: SessionArchiveArea;
    path: string;
    size: number;
    sha256: string;
    data: string;
}
export type SessionArchiveAttachment = {
    kind: 'image';
    ref: ImageAttachmentRef;
    data: string;
} | {
    kind: 'file';
    ref: FileAttachmentRef;
    data: string;
};
export interface SessionArchive {
    format: 'dsh-tavern-session';
    version: 1;
    binding: SessionBinding;
    session: {
        header: SessionHeader;
        inheritedEventCount: number;
        events: SessionEvent[];
    };
    files: SessionArchiveFile[];
    attachments: SessionArchiveAttachment[];
    manifestSha256: string;
}
/** 所有路径均相对格式内的固定作用域；大小写折叠避免跨平台别名。 */
export declare function validArchiveFilePath(area: SessionArchiveArea, path: string): boolean;
export declare function archiveFile(area: SessionArchiveArea, path: string, bytes: Uint8Array): SessionArchiveFile;
/** 只供本机快照创建格式；外来文件一律走严格解析并校验整个清单。 */
export declare function sealSessionArchive(input: unknown): SessionArchive;
export declare function parseSessionArchive(input: unknown): SessionArchive;
