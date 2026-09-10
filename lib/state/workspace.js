/**
 * 角色工作区管理（plan 3.12.1）。
 *
 * 目录结构：<dataRoot>/<cardId>/{card.json, card.png?, assets/, memory/archive/,
 * state/wal/, journal.md, index.json}。本模块各函数的 dataRoot 形参即角色库目录
 * （<插件数据根>/characters，见 node/paths.ts 与 node/state.ts 的调用方式）。
 * 一切文件写入经 WorkspaceFs（本模块内均为导入期写入，wal 传 null）；
 * 例外：deleteCharacter 的整目录 rm -rf（WorkspaceFs 无递归删除语义）与
 * listCharacters 的本层 readdir（WorkspaceFs.list 只列文件、给不出目录名）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { compileCardRegexScripts } from '../core/regex.js';
import { hydrateStoredCard, normalizeBook } from './card.js';
import { WorkspaceFs } from './workspaceFs.js';
// ---------------------------------------------------------------------------
// cardId
// ---------------------------------------------------------------------------
/**
 * cardId 必须是 characters/ 下的单层目录名。
 *
 * 不能只拦截 `..`：在 Windows 上 `join(dataRoot, '.')` 会直接指向角色库根目录，
 * 若随后执行递归删除，会把全部角色一并删掉。这里同时拒绝路径分隔符、首尾点与
 * 连续点，保留旧版可能使用的字母、数字、下划线、连字符、中文和中间单点。
 * 另外拒绝 Windows 保留设备名（CON/NUL/COM1…，含带任意扩展段的形态如 CON.card）：
 * RPC 直传这类 id 时 join 会解析为设备路径，后续 mkdir/rm 行为异常。
 */
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CLOCK\$)$/i;
export function isValidCardId(cardId) {
    if (WINDOWS_RESERVED_NAME.test(cardId.split('.')[0] ?? ''))
        return false;
    return /^[A-Za-z0-9_一-龥-]+(?:\.[A-Za-z0-9_一-龥-]+)*$/.test(cardId);
}
/** 非法 cardId 统一抛错，供所有会创建/删除工作区句柄的入口复用。 */
export function assertValidCardId(cardId) {
    if (!isValidCardId(cardId))
        throw new Error(`非法的角色 ID: ${cardId}`);
}
/** 名称净化：小写，非 [a-z0-9 一-龥] 归并为 '-'，去首尾连字符，限长 24。 */
function sanitizeCardName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9一-龥]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24)
        .replace(/-+$/g, '');
}
/** 角色 ID：净化名 + '-' + sha1(name + 随机字节) 前 8 位（同名片互不覆盖）。 */
export function newCardId(name) {
    const base = sanitizeCardName(name) || 'card';
    const suffix = createHash('sha1').update(name).update(randomBytes(8)).digest('hex').slice(0, 8);
    return `${base}-${suffix}`;
}
/**
 * 导入角色卡为独立工作区：建目录结构，落盘 card.json（剔除 pngBytes、保留 raw）、
 * card.png（若有字节）、assets/character-book.json（若有内嵌书且未跳过）、
 * assets/regex-scripts.json（compileCardRegexScripts 编译产物，默认不启用）、
 * journal.md（不存在则建空文件）与初始 index.json。
 */
export async function importCard(dataRoot, card, opts) {
    const importWorldBook = opts?.importWorldBook !== false;
    const cardId = newCardId(card.name);
    const root = join(dataRoot, cardId);
    const fs = new WorkspaceFs(root, null);
    await fs.ensureDir('assets');
    await fs.ensureDir('memory/archive');
    await fs.ensureDir('state/wal');
    const { pngBytes, ...cardJson } = card;
    if (!importWorldBook)
        cardJson.characterBook = null;
    await fs.writeText('card.json', JSON.stringify(cardJson, null, 2) + '\n');
    if (pngBytes)
        await fs.writeBytes('card.png', pngBytes);
    if (importWorldBook && card.characterBook && card.characterBook.entries.length > 0) {
        const book = { name: card.characterBook.name ?? card.name, entries: card.characterBook.entries };
        await fs.writeText('assets/character-book.json', JSON.stringify(book, null, 2) + '\n');
    }
    const rules = compileCardRegexScripts(card.regexScripts, cardId);
    await fs.writeText('assets/regex-scripts.json', JSON.stringify(rules, null, 2) + '\n');
    if ((await fs.readText('journal.md')) === null)
        await fs.writeText('journal.md', '');
    const index = { files: [], updatedAt: new Date().toISOString() };
    await fs.writeText('index.json', JSON.stringify(index, null, 2) + '\n');
    return {
        cardId,
        root,
        card: importWorldBook ? card : { ...card, characterBook: null },
    };
}
/**
 * 列出全部角色（读各 card.json 的 name 与 card.png 存在性）；损坏目录容错跳过。
 * 只 readdir characters/ 本层、逐目录读 card.json 探测：卡目录约定为单层
 * characters/<cardId>/card.json，递归遍历会把每个角色的 memory/archive/、
 * state/wal/ 整棵走完（数据积累后设置面板打开随之变慢），这里不做任何递归。
 */
export async function listCharacters(dataRoot) {
    let entries;
    try {
        entries = await readdir(dataRoot, { withFileTypes: true });
    }
    catch (error) {
        // 角色库目录尚未创建（从未导入过卡）按空列表处理，与旧递归 list 的 ENOENT 口径一致
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
    // 排序保持旧实现按 cardId 字典序的观测口径，不依赖 readdir 返回顺序
    const cardIds = entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    const out = [];
    for (const cardId of cardIds) {
        try {
            // card.json 缺失/损坏时 loadCharacter 返回 null，即「探测」口径
            const ws = await loadCharacter(dataRoot, cardId);
            if (!ws)
                continue;
            const fs = new WorkspaceFs(ws.root, null);
            const bookName = ws.card.characterBook?.name ?? null;
            const entryCount = Array.isArray(ws.card.characterBook?.entries) ? ws.card.characterBook.entries.length : 0;
            out.push({
                cardId,
                name: ws.card.name,
                hasAvatar: await fs.exists('card.png'),
                hasCharacterBook: entryCount > 0 || (await fs.exists('assets/character-book.json')),
                characterBookName: bookName,
                characterBookEntryCount: entryCount,
            });
        }
        catch {
            continue; // 坏目录跳过
        }
    }
    return out;
}
/** 读取角色工作区；card.json 缺失或损坏返回 null。 */
export async function loadCharacter(dataRoot, cardId) {
    if (!isValidCardId(cardId))
        return null;
    const root = join(dataRoot, cardId);
    const fs = new WorkspaceFs(root, null);
    const text = await fs.readText('card.json');
    if (text === null)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return null;
    const record = parsed;
    // pngBytes 不持久化于 card.json（头像字节在 card.png），读回恒为 null
    const card = hydrateStoredCard(record);
    // 旧导入或 card.json 缺 characterBook 时，从落盘的内嵌书补回
    if (!Array.isArray(card.characterBook?.entries) || card.characterBook.entries.length === 0) {
        const bookText = await fs.readText('assets/character-book.json');
        if (bookText !== null) {
            try {
                const book = normalizeBook(JSON.parse(bookText));
                if (book)
                    card.characterBook = book;
            }
            catch {
                // 坏文件忽略
            }
        }
    }
    return { cardId, root, card };
}
/** 删除角色工作区整目录（rm -rf；本模块唯一直接使用 node:fs 的位置）。 */
export async function deleteCharacter(dataRoot, cardId) {
    assertValidCardId(cardId);
    await rm(join(dataRoot, cardId), { recursive: true, force: true });
}
// ---------------------------------------------------------------------------
// index.json 维护
// ---------------------------------------------------------------------------
/** md 摘要：跳过 YAML frontmatter 后首个非空行的前 60 字；空文件返回空串。 */
function summarizeMarkdown(content) {
    const lines = content.split('\n');
    let i = 0;
    if (lines[0]?.trim() === '---') {
        i = 1;
        while (i < lines.length && lines[i].trim() !== '---')
            i++;
        i++; // 跳过结束分隔线（无结束线则 i 越界，循环自然为空）
    }
    for (; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line !== '')
            return line.slice(0, 60);
    }
    return '';
}
/**
 * 重建 index.json：扫描 memory/*.md（不含 archive 子目录）、state/world-delta.jsonl 与
 * journal.md，每个文件记录 {path, summary, tokens}（tokens 由注入的估算函数计算）。
 */
export async function rebuildIndex(fs, estimateTokens) {
    const files = [];
    // 非递归列举：archive/ 不进清单，递归走一遍再丢掉会让每次写入后的重建随归档量变慢。
    const memoryFiles = await fs.list('memory', { recursive: false });
    for (const rel of memoryFiles) {
        if (!rel.endsWith('.md'))
            continue;
        const content = (await fs.readText(`memory/${rel}`)) ?? '';
        files.push({ path: `memory/${rel}`, summary: summarizeMarkdown(content), tokens: estimateTokens(content) });
    }
    const delta = await fs.readText('state/world-delta.jsonl');
    if (delta !== null) {
        const count = delta.split('\n').filter((line) => line.trim() !== '').length;
        files.push({
            path: 'state/world-delta.jsonl',
            summary: delta.trim() === '' ? '' : `${count} 条变化`,
            tokens: estimateTokens(delta),
        });
    }
    const journal = await fs.readText('journal.md');
    if (journal !== null) {
        files.push({ path: 'journal.md', summary: summarizeMarkdown(journal), tokens: estimateTokens(journal) });
    }
    const index = { files, updatedAt: new Date().toISOString() };
    await fs.writeText('index.json', JSON.stringify(index, null, 2) + '\n');
}
