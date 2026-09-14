/**
 * 会话绑定：Tavern 会话 ↔ 角色卡/预设/人设/世界书选择。
 * 存 `sessions/<sessionId>.json`（host 数据目录；不随楼层回滚——绑定不是剧情状态）。
 * SessionBinding / WalLineageEntry 是纯数据形状，定义在 core/binding（remote 契约引用），此处 re-export。
 * 读写共用 parseSessionBinding 严格校验（RPC 宽松传输、存储层严格校验的落点），不再 as 断言。
 */
import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionFile } from './paths.js';
import { assertValidCardId } from '../state/workspace.js';
import { helperWorldbookSettingsCodec } from '../core/helperWorldbookSettings.js';
import { atomicWrite } from '../state/atomicWrite.js';
import { storyRoot } from '../state/story.js';
/** 绑定只是小型元数据；超限文件一律按损坏引用阻断永久删除。 */
const MAX_SESSION_BINDING_BYTES = 1024 * 1024;
const BINDING_READ_CHUNK_BYTES = 64 * 1024;
function invalidBinding(field, expect) {
    throw new Error(`会话绑定字段 ${field} 非法：期望${expect}`);
}
/**
 * 会话绑定的严格解析：必填字段缺失或类型错误即抛错，未知字段丢弃（对齐 RPC schema 的 strip 行为）。
 * service.setSessionBinding 与本文件的 load/save 共用这一个校验点；
 * interactiveCards（会话级交互卡开关，boolean | null）原样透传——客户端依它做渲染决策。
 */
export function parseSessionBinding(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input))
        invalidBinding('(root)', '对象');
    const raw = input;
    const requiredString = (field) => {
        const value = raw[field];
        if (typeof value !== 'string' || value.length === 0)
            invalidBinding(field, '非空字符串');
        return value;
    };
    const nullableString = (field) => {
        const value = raw[field];
        if (value === null)
            return null;
        if (typeof value !== 'string')
            invalidBinding(field, '字符串或 null');
        return value;
    };
    const optionalString = (field) => {
        const value = raw[field];
        if (value === undefined)
            return undefined;
        if (typeof value !== 'string')
            invalidBinding(field, '字符串');
        return value;
    };
    const optionalBoolean = (field) => {
        const value = raw[field];
        if (value === undefined)
            return undefined;
        if (typeof value !== 'boolean')
            invalidBinding(field, '布尔值');
        return value;
    };
    const sessionId = requiredString('sessionId');
    const cardId = requiredString('cardId');
    // cardId 是 characters/ 下的单层目录名；格式不对直接拒绝（防路径越界，与工作区入口同一帮手）。
    assertValidCardId(cardId);
    const storyId = optionalString('storyId');
    if (storyId !== undefined)
        storyRoot('.', storyId);
    const lorebookIdsRaw = raw['lorebookIds'];
    if (!Array.isArray(lorebookIdsRaw))
        invalidBinding('lorebookIds', '字符串数组');
    const lorebookIds = lorebookIdsRaw.map((id, i) => {
        if (typeof id !== 'string')
            invalidBinding(`lorebookIds[${i}]`, '字符串');
        return id;
    });
    const interactiveCardsRaw = raw['interactiveCards'];
    let interactiveCards;
    if (interactiveCardsRaw === null)
        interactiveCards = null;
    else if (typeof interactiveCardsRaw === 'boolean')
        interactiveCards = interactiveCardsRaw;
    else
        invalidBinding('interactiveCards', '布尔值或 null');
    const greetingIndex = raw['greetingIndex'];
    if (typeof greetingIndex !== 'number' || !Number.isSafeInteger(greetingIndex) || greetingIndex < 0) {
        invalidBinding('greetingIndex', '非负整数');
    }
    const walLineageRaw = raw['walLineage'];
    let walLineage;
    if (walLineageRaw !== undefined) {
        if (!Array.isArray(walLineageRaw))
            invalidBinding('walLineage', '数组');
        walLineage = walLineageRaw.map((entry, i) => {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
                invalidBinding(`walLineage[${i}]`, '对象');
            const item = entry;
            const entrySessionId = item['sessionId'];
            if (typeof entrySessionId !== 'string' || entrySessionId.length === 0) {
                invalidBinding(`walLineage[${i}].sessionId`, '非空字符串');
            }
            const throughTurn = item['throughTurn'];
            if (typeof throughTurn !== 'number' || !Number.isSafeInteger(throughTurn) || throughTurn < 0) {
                invalidBinding(`walLineage[${i}].throughTurn`, '非负整数');
            }
            return { sessionId: entrySessionId, throughTurn };
        });
    }
    return {
        sessionId,
        cardId,
        storyId,
        cardName: optionalString('cardName'),
        presetId: nullableString('presetId'),
        personaId: nullableString('personaId'),
        lorebookIds,
        characterLorebookId: nullableString('characterLorebookId'),
        useEmbeddedLorebook: optionalBoolean('useEmbeddedLorebook'),
        characterLorebookIds: raw.characterLorebookIds === undefined ? undefined : (() => {
            if (!Array.isArray(raw.characterLorebookIds) || raw.characterLorebookIds.length > 64 || raw.characterLorebookIds.some(id => typeof id !== 'string' || !id))
                invalidBinding('characterLorebookIds', '至多 64 项的非空字符串数组');
            return [...new Set(raw.characterLorebookIds)];
        })(),
        worldInfo: raw.worldInfo === undefined ? undefined : helperWorldbookSettingsCodec.nativePatch(raw.worldInfo),
        interactiveCards,
        helperMvu: optionalBoolean('helperMvu'),
        greetingIndex,
        authorNote: optionalString('authorNote'),
        injectJournal: optionalBoolean('injectJournal'),
        walLineage,
        createdAt: requiredString('createdAt'),
    };
}
export async function loadBinding(paths, sessionId) {
    try {
        const parsed = parseSessionBinding(JSON.parse(await readFile(sessionFile(paths, sessionId), 'utf8')));
        if (parsed.sessionId !== sessionId)
            return null;
        return parsed;
    }
    catch {
        // 文件不存在（ENOENT）、JSON 损坏或字段校验失败都视为未绑定（面板可重选）。
        return null;
    }
}
export async function saveBinding(paths, binding) {
    // 写入侧严格校验（sessionId 非空、cardId 目录名格式在 parse 内检查）：坏数据不落盘，
    // 否则合法 JSON 但字段缺失的绑定要到使用点才抛错。
    const checked = parseSessionBinding(binding);
    await atomicWrite(sessionFile(paths, checked.sessionId), JSON.stringify(checked, null, 2) + '\n');
}
export async function deleteBinding(paths, sessionId) {
    try {
        await unlink(sessionFile(paths, sessionId));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
/** 对比路径枚举、已打开句柄与读取前最终路径，拒绝中途被换成链接或另一文件。 */
function sameRegularFile(left, right) {
    return left.isFile() && !left.isSymbolicLink() && right.isFile() && !right.isSymbolicLink()
        && left.dev === right.dev && left.ino === right.ino
        && left.size === right.size && left.mtimeMs === right.mtimeMs && left.birthtimeMs === right.birthtimeMs;
}
/** 从已验证的普通文件句柄分块读取，多读 1 字节仅用于识别扫描期间增长。 */
async function readBoundedBinding(handle) {
    const chunks = [];
    let position = 0;
    while (position <= MAX_SESSION_BINDING_BYTES) {
        const length = Math.min(BINDING_READ_CHUNK_BYTES, MAX_SESSION_BINDING_BYTES + 1 - position);
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(chunk, 0, length, position);
        if (bytesRead === 0)
            return { ok: true, text: Buffer.concat(chunks, position).toString('utf8') };
        position += bytesRead;
        chunks.push(chunk.subarray(0, bytesRead));
        if (position > MAX_SESSION_BINDING_BYTES)
            return { ok: false };
    }
    return { ok: false };
}
export async function listBindingReferencesForCard(paths, cardId) {
    assertValidCardId(cardId);
    // Windows 的角色目录同样大小写不敏感；旧绑定可以保留调用方传入的大小写，
    // 尚未迁移成 story 时只能靠此处的绑定引用阻止误删。
    const isTargetCard = (value) => typeof value === 'string'
        && (process.platform === 'win32' ? value.toLowerCase() === cardId.toLowerCase() : value === cardId);
    let entries;
    try {
        entries = await readdir(paths.sessions, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { sessionIds: [], corruptFiles: [] };
        throw error;
    }
    const references = [];
    const corruptFiles = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = entry.name;
        // Windows 文件名大小写不敏感：`s1.JSON` 仍可被 `s1.json` 路径读到，
        // 引用扫描必须使用同样的保守口径，否则会漏过有效绑定。
        if (!/\.json$/i.test(file))
            continue;
        // 第一步就拒绝 symlink/junction/目录，绝不读它们指向的外部内容。
        if (!entry.isFile() || entry.isSymbolicLink()) {
            corruptFiles.push(file);
            continue;
        }
        const absolute = join(paths.sessions, file);
        let text;
        let handle;
        try {
            const before = await lstat(absolute);
            if (!before.isFile() || before.isSymbolicLink()) {
                corruptFiles.push(file);
                continue;
            }
            // POSIX 用 O_NOFOLLOW 从 open 本身拒绝最终链接；Windows 未公开该 flag，依靠
            // lstat → open/fstat → lstat 的三方文件身份比对，且身份确认前不读任何字节。
            const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
            handle = await open(absolute, constants.O_RDONLY | noFollow);
            const opened = await handle.stat();
            const after = await lstat(absolute);
            if (!sameRegularFile(before, opened) || !sameRegularFile(opened, after)
                || opened.size > MAX_SESSION_BINDING_BYTES) {
                corruptFiles.push(file);
                continue;
            }
            const bounded = await readBoundedBinding(handle);
            const finalOpened = await handle.stat();
            const finalPath = await lstat(absolute);
            if (!bounded.ok || !sameRegularFile(opened, finalOpened) || !sameRegularFile(finalOpened, finalPath)) {
                corruptFiles.push(file);
                continue;
            }
            text = bounded.text;
        }
        catch (error) {
            // 扫描与删除之间被另一路显式删掉按无引用处理；其它 I/O 错误必须阻断永久删除。
            if (error.code === 'ENOENT')
                continue;
            if (error.code === 'ELOOP') {
                corruptFiles.push(file);
                continue;
            }
            throw error;
        }
        finally {
            await handle?.close();
        }
        let raw;
        try {
            raw = JSON.parse(text);
        }
        catch {
            corruptFiles.push(file);
            continue;
        }
        const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
        let parsed = null;
        try {
            parsed = parseSessionBinding(raw);
        }
        catch {
            corruptFiles.push(file);
            // 虽然整体损坏，cardId 若仍明确，对内诊断仍保留该引用身份。
            if (record && isTargetCard(record.cardId)) {
                references.push(typeof record.sessionId === 'string' && record.sessionId ? record.sessionId : file.replace(/\.json$/, ''));
            }
            continue;
        }
        const actual = join(paths.sessions, file);
        const expected = sessionFile(paths, parsed.sessionId);
        const sameFile = process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
        if (!sameFile)
            corruptFiles.push(file);
        if (isTargetCard(parsed.cardId))
            references.push(parsed.sessionId);
    }
    return { sessionIds: [...new Set(references)].sort(), corruptFiles: [...new Set(corruptFiles)].sort() };
}
