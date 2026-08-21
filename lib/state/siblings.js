/**
 * 分支兄弟索引存储：`<数据目录根>/siblings.json`，整体读改写（文件小，记录 = 一次楼层 fork）。
 *
 * 这是导航元数据，不是剧情状态：不经 WorkspaceFs、不记 WAL——回退/回滚楼层不应撤销
 * 「这个分支会话曾经创建过」的事实（分支会话本身也仍在）。删卡/解绑清掉绑定后，
 * 读路径（node/floors.ts getFloorSiblings）按存在性剪枝并落盘。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeSiblingForks, recordSiblingFork } from '../core/siblings.js';
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
/** 读-改-写追加一条 fork 记录（recordSiblingFork 幂等）。 */
export async function appendSiblingFork(rootDir, entry) {
    const forks = await loadSiblingForks(rootDir);
    const next = recordSiblingFork(forks, entry);
    if (next.length !== forks.length)
        await saveSiblingForks(rootDir, next);
}
