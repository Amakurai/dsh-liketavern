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
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeSiblingForks, recordSiblingFork } from '../core/siblings.js';
/** 数据根 → 串行链。进程内数据根唯一，Map 实际只有一项，无需清理。 */
const mutexes = new Map();
export function siblingsFile(rootDir) {
    return join(rootDir, 'siblings.json');
}
/** 读取索引；文件缺失或损坏视为空索引。 */
export async function loadSiblingForks(rootDir) {
    try {
        return normalizeSiblingForks(JSON.parse(await readFile(siblingsFile(rootDir), 'utf8')));
    }
    catch {
        return [];
    }
}
export async function saveSiblingForks(rootDir, forks) {
    await writeFile(siblingsFile(rootDir), JSON.stringify(forks, null, 2) + '\n', 'utf8');
}
/**
 * 互斥内的读-改-写：fn 拿到磁盘现状，返回新值（等于原值则不落盘）。
 * fn 自身不要再调 mutateSiblingForks（会死锁——互斥不可重入）。
 */
export async function mutateSiblingForks(rootDir, fn) {
    const previous = mutexes.get(rootDir) ?? Promise.resolve();
    const run = previous.then(async () => {
        const forks = await loadSiblingForks(rootDir);
        const next = await fn(forks);
        if (next !== forks && JSON.stringify(next) !== JSON.stringify(forks)) {
            await saveSiblingForks(rootDir, next);
        }
    });
    mutexes.set(rootDir, run.catch(() => undefined));
    await run;
}
/** 读-改-写追加一条 fork 记录（recordSiblingFork 幂等）。 */
export async function appendSiblingFork(rootDir, entry) {
    await mutateSiblingForks(rootDir, (forks) => recordSiblingFork(forks, entry));
}
