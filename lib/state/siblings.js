/**
 * 分支兄弟索引存储：`<数据目录根>/siblings.json`，整体读改写（文件小，记录 = 一次楼层 fork）。
 *
 * 这是导航元数据，不是剧情状态：不经 WorkspaceFs、不记 WAL——回退/回滚楼层不应撤销
 * 「这个分支会话曾经创建过」的事实（分支会话本身也仍在）。删卡/解绑清掉绑定后，
 * 读路径（node/floors.ts getFloorSiblings）按存在性剪枝并落盘。
 *
 * 所有读改写（追加登记 / 读路径剪枝）必须经 mutateSiblingForks：模块级互斥串行化，
 * 否则不同会话的并发 fork 登记 / 剪枝落盘会互相覆盖丢记录。
 */
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { normalizeSiblingForks, recordSiblingFork } from '../core/siblings.js';
import { atomicWrite } from './atomicWrite.js';
import { rootIdentity } from './pathIdentity.js';
import { withWorkspaceLock } from './workspaceLock.js';
const MAX_SIBLINGS_CACHE = 32;
const siblingsCache = new Map();
/** 写路径代数：无锁并发读取跨越一次原子保存时不得用旧读结果覆盖新缓存。 */
let writeGeneration = 0;
function toSiblingStat(st) {
    return { mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino };
}
function sameSiblingStat(a, b) {
    return Boolean(a && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size && a.ino === b.ino);
}
function setSiblingsCache(key, entry) {
    if (siblingsCache.has(key))
        siblingsCache.delete(key);
    else if (siblingsCache.size >= MAX_SIBLINGS_CACHE) {
        const oldest = siblingsCache.keys().next().value;
        if (oldest !== undefined)
            siblingsCache.delete(oldest);
    }
    siblingsCache.set(key, entry);
}
export function siblingsFile(rootDir) {
    return join(rootDir, 'siblings.json');
}
/** 读取索引并区分「文件缺失」与「文件损坏」：读路径两者都当空索引，写路径不得把损坏覆盖成空。 */
async function readSiblingForks(rootDir) {
    const file = resolve(siblingsFile(rootDir));
    const key = rootIdentity(file);
    const generation = writeGeneration;
    let info = null;
    try {
        info = toSiblingStat(await stat(file));
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            if (writeGeneration === generation)
                setSiblingsCache(key, { stat: null, forks: [] });
            return { forks: [], corrupt: false };
        }
        throw error;
    }
    const cached = siblingsCache.get(key);
    if (cached && sameSiblingStat(cached.stat, info)) {
        return { forks: cached.forks.map((f) => ({ ...f })), corrupt: false };
    }
    let raw;
    try {
        raw = await readFile(file, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            if (writeGeneration === generation)
                setSiblingsCache(key, { stat: null, forks: [] });
            return { forks: [], corrupt: false };
        }
        throw error;
    }
    try {
        const value = JSON.parse(raw);
        const forks = normalizeSiblingForks(value);
        // JSON 可解析不等于索引完整；写路径不能借容错归一化静默删除坏记录。
        const corrupt = !Array.isArray(value) || forks.length !== value.length;
        if (corrupt) {
            if (writeGeneration === generation)
                siblingsCache.delete(key);
        }
        else if (writeGeneration === generation) {
            setSiblingsCache(key, { stat: info, forks: forks.map((f) => ({ ...f })) });
        }
        return { forks, corrupt };
    }
    catch {
        if (writeGeneration === generation)
            siblingsCache.delete(key);
        return { forks: [], corrupt: true };
    }
}
/** 读取索引；文件缺失或损坏视为空索引。 */
export async function loadSiblingForks(rootDir) {
    return (await readSiblingForks(rootDir)).forks;
}
/** 原子替换：崩溃不会留下截断的索引文件（截断后读成空索引，再一次登记就把全部导航记录永久抹掉）。 */
async function saveSiblingForks(rootDir, forks) {
    const file = resolve(siblingsFile(rootDir));
    const key = rootIdentity(file);
    writeGeneration++;
    siblingsCache.delete(key);
    await atomicWrite(file, JSON.stringify(forks, null, 2) + '\n');
    writeGeneration++;
    try {
        const st = await stat(file);
        setSiblingsCache(key, {
            stat: toSiblingStat(st),
            forks: forks.map((f) => ({ ...f })),
        });
    }
    catch {
        siblingsCache.delete(key);
    }
}
/**
 * 互斥内的读-改-写：fn 拿到磁盘现状，返回新值（等于原值则不落盘）。
 * fn 自身不要再调 mutateSiblingForks，避免外层旧快照覆盖内层刚写入的登记。
 */
export async function mutateSiblingForks(rootDir, fn) {
    await withWorkspaceLock(siblingsFile(rootDir), async () => {
        const { forks, corrupt } = await readSiblingForks(rootDir);
        if (corrupt)
            throw new Error('分支兄弟索引 siblings.json 损坏，拒绝以空索引覆盖；请修复或删除该文件');
        const next = await fn(forks);
        if (next !== forks && JSON.stringify(next) !== JSON.stringify(forks)) {
            await saveSiblingForks(rootDir, next);
        }
    });
}
/** 读-改-写追加一条 fork 记录（recordSiblingFork 幂等）。 */
export async function appendSiblingFork(rootDir, entry) {
    await mutateSiblingForks(rootDir, (forks) => recordSiblingFork(forks, entry));
}
