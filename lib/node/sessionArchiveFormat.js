/** 单会话迁移格式：有界校验宿主事件、剧情归属与每个文件摘要，不让外来路径决定宿主写入位置。 */
import { createHash } from 'node:crypto';
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { assertContiguous, assertVersion, materializeCreateHeader, validateStoredEvents } from '@deepseek-ai/dsh-session-persistence';
import { restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4';
import { parseSessionBinding } from './bindings.js';
import { safeRelative } from './backupFiles.js';
import { isStoryPath } from '../state/story.js';
import { sessionAttachmentReferences } from './sessionArchiveAttachments.js';
import { isRecord } from '../core/guards.js';
export const SESSION_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
export const SESSION_ARCHIVE_MAX_JSON_BYTES = 192 * 1024 * 1024;
export const SESSION_ARCHIVE_MAX_FILES = 20_000;
const OS_JUNK_BASENAMES = new Set(['thumbs.db', '.ds_store', 'desktop.ini']);
function invalid(reason) {
    throw new Error(`会话迁移文件无效或已损坏（${reason}）`);
}
/** 过滤常见桌面系统自动生成的目录杂项文件，避免误触发迁移损坏或卡面资产差异。 */
export function isOsJunkPath(path) {
    const slash = path.lastIndexOf('/');
    const name = (slash === -1 ? path : path.slice(slash + 1)).toLowerCase();
    return OS_JUNK_BASENAMES.has(name);
}
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
    if (!validArchiveFilePath(area, path))
        invalid('包含不允许的归档文件路径');
    if (bytes.byteLength > SESSION_ARCHIVE_MAX_BYTES)
        invalid('单个文件超过 128 MiB 大小上限，请使用全量备份');
    const data = Buffer.from(bytes);
    return { area, path, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), data: data.toString('base64') };
}
/** 先完成整份校验，再交给调用方准备导入；摘要用于检测损坏，不是存档认证。 */
function normalizeSessionArchive(input, seal) {
    if (!isRecord(input) || input.format !== 'dsh-tavern-session')
        invalid('格式标识不匹配');
    if (input.version !== 1)
        invalid('版本不兼容，仅支持版本 1');
    if (!isRecord(input.session) || !Array.isArray(input.files) || !Array.isArray(input.attachments)) {
        invalid('缺少会话、文件或附件字段');
    }
    if (input.files.length > SESSION_ARCHIVE_MAX_FILES) {
        invalid(`文件数量超过 ${SESSION_ARCHIVE_MAX_FILES} 个上限，请使用全量备份`);
    }
    if (input.attachments.length > SESSION_ARCHIVE_MAX_FILES) {
        invalid(`附件数量超过 ${SESSION_ARCHIVE_MAX_FILES} 个上限，请使用全量备份`);
    }
    let binding;
    try {
        binding = parseSessionBinding(input.binding);
    }
    catch {
        return invalid('会话绑定信息无效');
    }
    if (!binding.storyId)
        invalid('会话绑定缺少剧情标识');
    let header;
    try {
        header = materializeCreateHeader(input.session.header);
        assertVersion(header);
    }
    catch {
        return invalid('宿主会话头无效或版本不兼容');
    }
    if (header.id !== binding.sessionId || typeof header.isSeeded !== 'boolean' || !Array.isArray(input.session.events)
        || Object.keys(header).some(key => !['version', 'id', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset'].includes(key))
        || (header.cwd !== undefined && typeof header.cwd !== 'string')
        || (header.parentSession !== undefined && (typeof header.parentSession !== 'string' || !header.parentSession))
        || (header.origin !== undefined && header.origin !== 'subagent')
        || (header.delegationDepth !== undefined && (!Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0))
        || (header.agentPreset !== undefined && (typeof header.agentPreset !== 'string' || !header.agentPreset))) {
        invalid('宿主会话头与绑定不一致或包含不支持的字段');
    }
    let events;
    try {
        events = validateStoredEvents(header, structuredClone(input.session.events));
        assertContiguous(header.id, events, 0);
    }
    catch {
        return invalid('宿主会话事件不连续或格式无效');
    }
    const inherited = input.session.inheritedEventCount;
    if (!Number.isSafeInteger(inherited) || inherited < 0 || inherited > events.length
        || (!header.isSeeded && inherited !== 0))
        invalid('会话继承事件计数无效');
    try {
        // 与宿主持久化读取使用相同的 V4 轮次、消息和继承关系校验；校验前不发布任何目标状态。
        // 源 cwd 来自另一台机器，可能是不同平台路径；导入时会替换成目标工作区，不参与源历史校验。
        restoreReleasedV4Artifact({ header: { ...header, cwd: process.cwd(), delegationDepth: header.delegationDepth ?? 0 },
            inheritedEventCount: inherited, events }, KNOWN_SESSION_EVENT_TYPES);
    }
    catch {
        invalid('宿主会话轮次或消息历史结构无效');
    }
    const files = [];
    const paths = new Set();
    let total = Buffer.byteLength(JSON.stringify({ binding, session: { header, inheritedEventCount: inherited, events } }));
    if (total > SESSION_ARCHIVE_MAX_BYTES)
        invalid('归档元数据超过 128 MiB 大小上限，请使用全量备份');
    for (const entry of input.files) {
        if (!isRecord(entry) || (entry.area !== 'card' && entry.area !== 'story' && entry.area !== 'global')
            || typeof entry.path !== 'string')
            invalid('文件条目格式无效');
        if (!validArchiveFilePath(entry.area, entry.path))
            invalid('包含不允许的归档文件路径');
        if (typeof entry.data !== 'string' || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
            invalid('文件编码或校验和格式无效');
        }
        if (!Number.isSafeInteger(entry.size) || entry.size < 0)
            invalid('文件大小字段无效');
        if (entry.size > SESSION_ARCHIVE_MAX_BYTES)
            invalid('单个文件超过 128 MiB 大小上限，请使用全量备份');
        const key = `${entry.area}/${entry.path}`.normalize('NFC').toLowerCase();
        if (paths.has(key))
            invalid('存在重复或大小写冲突的文件路径');
        paths.add(key);
        const size = entry.size;
        total += size;
        if (total > SESSION_ARCHIVE_MAX_BYTES)
            invalid('归档总大小超过 128 MiB 上限，请使用全量备份');
        if (entry.data.length !== 4 * Math.ceil(size / 3))
            invalid('文件 Base64 编码长度不匹配');
        const decoded = Buffer.from(entry.data, 'base64');
        if (decoded.length !== size || decoded.toString('base64') !== entry.data)
            invalid('文件 Base64 编码内容损坏');
        if (createHash('sha256').update(decoded).digest('hex') !== entry.sha256)
            invalid('文件校验和不匹配');
        files.push({ area: entry.area, path: entry.path, size, sha256: entry.sha256, data: entry.data });
    }
    const refs = sessionAttachmentReferences(events);
    const attachments = [];
    const seenAttachments = new Set();
    for (const item of input.attachments) {
        if (!isRecord(item) || (item.kind !== 'image' && item.kind !== 'file') || !isRecord(item.ref)
            || typeof item.ref.attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.ref.attachmentId)
            || !Number.isSafeInteger(item.ref.bytes) || item.ref.bytes < 0
            || typeof item.data !== 'string')
            invalid('附件元数据格式无效');
        const size = item.ref.bytes;
        const name = item.ref.name;
        if (name !== undefined && (typeof name !== 'string' || !name || name.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(name))) {
            invalid('附件名称无效');
        }
        if (item.kind === 'file' && (typeof name !== 'string' || name === '.' || name === '..'))
            invalid('文件附件名称无效');
        if (item.kind === 'image' && (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(item.ref.mediaType))
            || !Number.isSafeInteger(item.ref.width) || item.ref.width <= 0
            || !Number.isSafeInteger(item.ref.height) || item.ref.height <= 0))
            invalid('图片附件元数据无效');
        const key = item.kind === 'image' ? `image:${item.ref.attachmentId}` : `file:${item.ref.attachmentId}\0${name}`;
        if (seenAttachments.has(key))
            invalid('存在重复附件条目');
        if (!(item.kind === 'image' ? refs.images.has(item.ref.attachmentId) : refs.files.has(`${item.ref.attachmentId}\0${name}`))) {
            invalid('包含会话历史未引用的多余附件');
        }
        const eventRef = item.kind === 'image' ? refs.images.get(item.ref.attachmentId) : refs.files.get(`${item.ref.attachmentId}\0${name}`);
        if (!eventRef || eventRef.bytes !== size || (item.kind === 'image' && ('mediaType' in eventRef)
            && (eventRef.mediaType !== item.ref.mediaType || eventRef.width !== item.ref.width || eventRef.height !== item.ref.height))) {
            invalid('附件元数据与会话事件引用不一致');
        }
        seenAttachments.add(key);
        total += size;
        if (total > SESSION_ARCHIVE_MAX_BYTES)
            invalid('含附件的归档总大小超过 128 MiB 上限，请使用全量备份');
        if (item.data.length !== 4 * Math.ceil(size / 3))
            invalid('附件 Base64 编码长度不匹配');
        const bytes = Buffer.from(item.data, 'base64');
        if (bytes.length !== size || bytes.toString('base64') !== item.data)
            invalid('附件 Base64 编码内容损坏');
        if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== item.ref.attachmentId)
            invalid('附件校验和不匹配');
        attachments.push(item.kind === 'image' ? { kind: 'image', ref: item.ref, data: item.data }
            : { kind: 'file', ref: item.ref, data: item.data });
    }
    if (seenAttachments.size !== refs.images.size + refs.files.size)
        invalid('缺少会话历史引用的附件');
    const storyMeta = files.find(file => file.area === 'story' && file.path === 'story.json');
    if (!files.some(file => file.area === 'card' && file.path === 'card.json'))
        invalid('缺少角色卡元数据 card.json');
    if (!storyMeta)
        invalid('缺少剧情元数据 story.json');
    try {
        const meta = JSON.parse(Buffer.from(storyMeta.data, 'base64').toString('utf8'));
        if (!isRecord(meta) || meta.version !== 1 || meta.id !== binding.storyId || meta.sessionId !== binding.sessionId
            || typeof meta.createdAt !== 'string' || typeof meta.migrated !== 'boolean') {
            invalid('剧情元数据 story.json 无效或与绑定不一致');
        }
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('会话迁移文件无效或已损坏'))
            throw error;
        invalid('剧情元数据 story.json 无法解析');
    }
    const body = { format: 'dsh-tavern-session', version: 1, binding,
        session: { header, inheritedEventCount: inherited, events }, files, attachments };
    const manifestSha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    if (!seal && input.manifestSha256 !== manifestSha256)
        invalid('清单整体校验和不匹配');
    return { ...body, manifestSha256 };
}
/** 只供本机快照创建格式；外来文件一律走严格解析并校验整个清单。 */
export function sealSessionArchive(input) { return normalizeSessionArchive(input, true); }
export function parseSessionArchive(input) { return normalizeSessionArchive(input, false); }
