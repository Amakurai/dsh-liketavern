/** 单会话迁移格式：有界校验宿主事件、剧情归属与每个文件摘要，不让外来路径决定宿主写入位置。 */
import { createHash } from 'node:crypto';
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { assertContiguous, assertVersion, materializeCreateHeader, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4';
import { parseSessionBinding } from './bindings.js';
import { safeRelative } from './backupFiles.js';
import { isStoryPath } from '../state/story.js';
import { sessionAttachmentReferences } from './sessionArchiveAttachments.js';
export const SESSION_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
export const SESSION_ARCHIVE_MAX_JSON_BYTES = 192 * 1024 * 1024;
export const SESSION_ARCHIVE_MAX_FILES = 20_000;
function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function invalid() { throw new Error('会话迁移文件无效或已损坏'); }
/** 所有路径均相对格式内的固定作用域；大小写折叠避免跨平台别名。 */
export function validArchiveFilePath(area, path) {
    if (!safeRelative(path))
        return false;
    const lower = path.toLowerCase();
    if (area === 'card')
        return lower === 'card.json' || lower === 'card.png'
            || (lower.startsWith('assets/') && lower !== 'assets/chat-lorebook.json');
    if (area === 'story')
        return lower === 'story.json' || isStoryPath(lower);
    return /^(?:library\/(?:presets|lorebooks)\/[^/]+\.json|personas\/[^/]+\.(?:json|png)|library\/helper-scripts\.json|regex\/rules\.json)$/.test(lower);
}
export function archiveFile(area, path, bytes) {
    if (!validArchiveFilePath(area, path) || bytes.byteLength > SESSION_ARCHIVE_MAX_BYTES)
        invalid();
    const data = Buffer.from(bytes);
    return { area, path, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data: data.toString('base64') };
}
/** 先完成整份校验，再交给调用方准备导入；摘要用于检测损坏，不是存档认证。 */
function normalizeSessionArchive(input, seal) {
    if (!record(input) || input.format !== 'dsh-tavern-session' || input.version !== 1 || !record(input.session)
        || !Array.isArray(input.files) || input.files.length > SESSION_ARCHIVE_MAX_FILES || !Array.isArray(input.attachments)
        || input.attachments.length > SESSION_ARCHIVE_MAX_FILES)
        invalid();
    let binding;
    let header;
    let events;
    try {
        binding = parseSessionBinding(input.binding);
        if (!binding.storyId)
            invalid();
        header = materializeCreateHeader(input.session.header);
        assertVersion(header);
        if (header.id !== binding.sessionId || typeof header.isSeeded !== 'boolean' || !Array.isArray(input.session.events)
            || Object.keys(header).some(key => !['version', 'id', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset'].includes(key))
            || (header.cwd !== undefined && typeof header.cwd !== 'string')
            || (header.parentSession !== undefined && (typeof header.parentSession !== 'string' || !header.parentSession))
            || (header.origin !== undefined && header.origin !== 'subagent')
            || (header.delegationDepth !== undefined && (!Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0))
            || (header.agentPreset !== undefined && (typeof header.agentPreset !== 'string' || !header.agentPreset)))
            invalid();
        events = validateStoredEvents(header, structuredClone(input.session.events));
        assertContiguous(header.id, events, 0);
    }
    catch {
        return invalid();
    }
    const inherited = input.session.inheritedEventCount;
    if (!Number.isSafeInteger(inherited) || inherited < 0 || inherited > events.length
        || (!header.isSeeded && inherited !== 0))
        invalid();
    try {
        // 与宿主持久化读取使用相同的 V4 轮次、消息和继承关系校验；校验前不发布任何目标状态。
        // 源 cwd 来自另一台机器，可能是不同平台路径；导入时会替换成目标工作区，不参与源历史校验。
        restoreReleasedV4Artifact({ header: { ...header, cwd: process.cwd(), delegationDepth: header.delegationDepth ?? 0 },
            inheritedEventCount: inherited, events }, KNOWN_SESSION_EVENT_TYPES);
    }
    catch {
        invalid();
    }
    const files = [];
    const paths = new Set();
    let total = Buffer.byteLength(JSON.stringify({ binding, session: { header, inheritedEventCount: inherited, events } }));
    for (const entry of input.files) {
        if (!record(entry) || (entry.area !== 'card' && entry.area !== 'story' && entry.area !== 'global')
            || typeof entry.path !== 'string' || !validArchiveFilePath(entry.area, entry.path)
            || typeof entry.data !== 'string' || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
            || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > SESSION_ARCHIVE_MAX_BYTES)
            invalid();
        const key = `${entry.area}/${entry.path}`.normalize('NFC').toLowerCase();
        if (paths.has(key))
            invalid();
        paths.add(key);
        const size = entry.size;
        total += size;
        if (total > SESSION_ARCHIVE_MAX_BYTES || entry.data.length !== 4 * Math.ceil(size / 3))
            invalid();
        const decoded = Buffer.from(entry.data, 'base64');
        if (decoded.length !== size || decoded.toString('base64') !== entry.data
            || createHash('sha256').update(decoded).digest('hex') !== entry.sha256)
            invalid();
        files.push({ area: entry.area, path: entry.path, size, sha256: entry.sha256, data: entry.data });
    }
    const refs = sessionAttachmentReferences(events);
    const attachments = [];
    const seenAttachments = new Set();
    for (const item of input.attachments) {
        if (!record(item) || (item.kind !== 'image' && item.kind !== 'file') || !record(item.ref)
            || typeof item.ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.ref.attachmentId)
            || !Number.isSafeInteger(item.ref.bytes) || item.ref.bytes < 0
            || typeof item.data !== 'string')
            invalid();
        const size = item.ref.bytes;
        const name = item.ref.name;
        if (name !== undefined && (typeof name !== 'string' || !name || name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(name)))
            invalid();
        if (item.kind === 'file' && (typeof name !== 'string' || name === '.' || name === '..'))
            invalid();
        if (item.kind === 'image' && (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(item.ref.mediaType))
            || !Number.isSafeInteger(item.ref.width) || item.ref.width <= 0
            || !Number.isSafeInteger(item.ref.height) || item.ref.height <= 0))
            invalid();
        const key = item.kind === 'image' ? `image:${item.ref.attachmentId}` : `file:${item.ref.attachmentId}\0${name}`;
        if (seenAttachments.has(key) || !(item.kind === 'image' ? refs.images.has(item.ref.attachmentId) : refs.files.has(`${item.ref.attachmentId}\0${name}`)))
            invalid();
        const eventRef = item.kind === 'image' ? refs.images.get(item.ref.attachmentId) : refs.files.get(`${item.ref.attachmentId}\0${name}`);
        if (!eventRef || eventRef.bytes !== size || (item.kind === 'image' && ('mediaType' in eventRef)
            && (eventRef.mediaType !== item.ref.mediaType || eventRef.width !== item.ref.width || eventRef.height !== item.ref.height)))
            invalid();
        seenAttachments.add(key);
        total += size;
        if (total > SESSION_ARCHIVE_MAX_BYTES || item.data.length !== 4 * Math.ceil(size / 3))
            invalid();
        const bytes = Buffer.from(item.data, 'base64');
        if (bytes.length !== size || bytes.toString('base64') !== item.data
            || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== item.ref.attachmentId)
            invalid();
        attachments.push(item.kind === 'image' ? { kind: 'image', ref: item.ref, data: item.data }
            : { kind: 'file', ref: item.ref, data: item.data });
    }
    if (seenAttachments.size !== refs.images.size + refs.files.size)
        invalid();
    const storyMeta = files.find(file => file.area === 'story' && file.path === 'story.json');
    if (!files.some(file => file.area === 'card' && file.path === 'card.json') || !storyMeta)
        invalid();
    try {
        const meta = JSON.parse(Buffer.from(storyMeta.data, 'base64').toString('utf8'));
        if (!record(meta) || meta.version !== 1 || meta.id !== binding.storyId || meta.sessionId !== binding.sessionId
            || typeof meta.createdAt !== 'string' || typeof meta.migrated !== 'boolean')
            invalid();
    }
    catch {
        invalid();
    }
    const body = { format: 'dsh-tavern-session', version: 1, binding,
        session: { header, inheritedEventCount: inherited, events }, files, attachments };
    const manifestSha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (!seal && input.manifestSha256 !== manifestSha256)
        invalid();
    return { ...body, manifestSha256 };
}
/** 只供本机快照创建格式；外来文件一律走严格解析并校验整个清单。 */
export function sealSessionArchive(input) { return normalizeSessionArchive(input, true); }
export function parseSessionArchive(input) { return normalizeSessionArchive(input, false); }
