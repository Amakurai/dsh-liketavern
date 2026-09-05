/**
 * 事务层（WAL）：楼层级写入快照与回滚。
 * agent 每次写入先经 recordChange() 持久化前后镜像，再原子替换正文。
 * 回退逆序撤销本层修改，保留后续手动编辑；世界状态按条目合并撤销。
 * record()/recordAfter() 仅保留旧调用兼容，新写入不得使用后补快照协议。
 *
 * 磁盘布局（rootDir 为工作区的 state/wal/ 目录）：
 *   <root>/<floor>/meta.json      楼层事务元数据（committed/时间戳）
 *   <root>/<floor>/records.jsonl  每次修改的 before/after 及其显式编码
 * 回滚后楼层目录改名为 <floor>.rolled-back-<timestamp>，保留供调试（UI 不展示）。
 */
import { Buffer } from 'node:buffer';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { undoWorldDelta } from '../core/walUndo.js';
import { atomicWrite } from './atomicWrite.js';
import { withWorkspaceLock } from './workspaceLock.js';
import { expandAffectedMemories } from './memoryRollback.js';
import { WorkspaceFs } from './workspaceFs.js';
import { rebuildIndex } from './workspace.js';
import { estimateTokens } from '../core/tokenize.js';
/** 回滚目录名标记：<floor>.rolled-back-<timestamp>。 */
const ROLLED_BACK_MARK = '.rolled-back-';
/** 旧版本 records.jsonl 中二进制 before 快照的前缀；新记录使用 beforeEncoding 字段。 */
export const WAL_BINARY_MARK = 'binary-base64:';
// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------
/** 楼层 id → 目录名：非法字符替换为 '_'（同字符冲突由调用方保证不出现）。 */
function sanitizeFloor(floor) {
    return floor.replace(/[^A-Za-z0-9_.-]/g, '_');
}
/** 目录改名用时间戳：纯数字（毫秒精度），避开 Windows 文件名非法字符。 */
function timestamp() {
    return new Date().toISOString().replace(/[^0-9]/g, '');
}
async function isDir(p) {
    try {
        return (await stat(p)).isDirectory();
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// Wal
// ---------------------------------------------------------------------------
export class Wal {
    rootDir;
    /** 实例内 promise 队列：所有公共方法串行化，保证并发安全。 */
    queue = Promise.resolve();
    /**
     * 楼层目录名 → 记录状态（paths 用于同层同路径去重，seq 为已用最大序号）。
     * 全部公共方法按 floor 参数化、状态按楼层目录分键：多个未提交楼层可以并存
     * （同一张卡的并发会话各开各的 `sessionId#tN`），本类没有单态「当前楼层」。
     */
    states = new Map();
    /** rootDir 为工作区的 state/wal/ 目录；不存在则在首次操作时创建。 */
    constructor(rootDir) {
        this.rootDir = rootDir;
    }
    /** 开始一个楼层事务；对已存在且未 commit 的同名单元报错（防止跨会话串层）。 */
    beginFloor(floor) {
        return this.enqueue(() => this.doBeginFloor(floor));
    }
    /** 在即将写入 path 前记录快照；同层同路径只留首次快照，重复调用忽略。path 统一为正斜杠相对路径。 */
    record(floor, path, before, beforeEncoding) {
        return this.enqueue(() => this.doRecord(floor, path, before, beforeEncoding));
    }
    /** 写入完成后补记 after 快照，用于回滚前识别楼层外的人工修改。 */
    recordAfter(floor, path, after, afterEncoding) {
        return this.enqueue(() => this.doRecordAfter(floor, path, after, afterEncoding));
    }
    /** 每次修改独立记录 before/after，必须在正文原子替换之前持久化。 */
    recordChange(floor, path, before, after, beforeEncoding, afterEncoding) {
        return this.enqueue(async () => {
            const dirName = sanitizeFloor(floor);
            const dir = join(this.rootDir, dirName);
            if (!(await isDir(dir)))
                throw new Error(`楼层 "${floor}" 未开始（或已回滚），无法记录写入快照`);
            const state = await this.loadState(dirName);
            const file = join(dir, 'records.jsonl');
            const text = await readFile(file, 'utf8').catch((error) => {
                if (error.code === 'ENOENT')
                    return '';
                throw error;
            });
            const record = { seq: state.seq + 1, path: path.replace(/\\/g, '/'), before, after, beforeEncoding, afterEncoding };
            await atomicWrite(file, text + (text && !text.endsWith('\n') ? '\n' : '') + JSON.stringify(record) + '\n');
            state.seq = record.seq;
            state.paths.add(record.path);
        });
    }
    /** 提交楼层：meta.committed=true 并记录 committedAt。 */
    commitFloor(floor) {
        return this.enqueue(() => this.doCommitFloor(floor));
    }
    /** 逆序回放本楼层快照：before 为字符串写回（先确保父目录存在），为 null 删除文件；随后目录改名保留。 */
    rollbackFloor(floor, workspaceRoot) {
        return withWorkspaceLock(workspaceRoot, () => this.enqueue(() => this.doRollbackFloor(floor, workspaceRoot)));
    }
    /** 按传入顺序的逆序逐个回滚（「回退到第 N 楼」= 撤销其后所有楼层）；不存在的楼层记入 skipped。 */
    rollbackAfter(floors, workspaceRoot) {
        return withWorkspaceLock(workspaceRoot, () => this.enqueue(() => this.doRollbackAfter(floors, workspaceRoot)));
    }
    /** 列出全部楼层（含已回滚，rolledBack: true），按 startedAt 升序。 */
    listFloors() {
        return this.enqueue(() => this.doListFloors());
    }
    /** 删除已回滚且早于 keepRolledBackDays（默认 7）的楼层目录，返回删除数。 */
    prune(options) {
        return this.enqueue(() => this.doPrune(options));
    }
    // -------------------------------------------------------------------------
    // 队列与读写原语
    // -------------------------------------------------------------------------
    enqueue(task) {
        const run = this.queue.then(task);
        // 失败不阻断后续操作，队列永远向前推进
        this.queue = run.catch(() => undefined);
        return run;
    }
    async readMeta(dir) {
        try {
            return JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
        }
        catch {
            return null;
        }
    }
    async writeMeta(dir, meta) {
        await atomicWrite(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
    }
    async readRecords(dir) {
        let text;
        try {
            text = await readFile(join(dir, 'records.jsonl'), 'utf8');
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return [];
            throw err;
        }
        const records = [];
        for (const line of text.split('\n')) {
            if (!line.trim())
                continue;
            // 单行损坏跳过（与 readMeta 的容忍同一标准）：整体抛错会让 doRollbackAfter
            // 中断在该楼层，后续楼层全不回滚，工作区停在半回滚状态。
            try {
                records.push(JSON.parse(line));
            }
            catch {
                // 坏行跳过
            }
        }
        return records;
    }
    /** 读取楼层记录状态（惰性加载，进程重启后首次访问时从磁盘重建）。 */
    async loadState(dirName) {
        const cached = this.states.get(dirName);
        if (cached)
            return cached;
        const state = { paths: new Set(), seq: 0 };
        for (const rec of await this.readRecords(join(this.rootDir, dirName))) {
            state.paths.add(rec.path);
            state.seq = Math.max(state.seq, rec.seq);
        }
        this.states.set(dirName, state);
        return state;
    }
    async hasRolledBackDir(dirName) {
        try {
            const names = await readdir(this.rootDir);
            return names.some((n) => n.startsWith(dirName + ROLLED_BACK_MARK));
        }
        catch {
            return false;
        }
    }
    // -------------------------------------------------------------------------
    // 公共方法的实际实现（均在队列内串行执行）
    // -------------------------------------------------------------------------
    async doBeginFloor(floor) {
        await mkdir(this.rootDir, { recursive: true });
        const dirName = sanitizeFloor(floor);
        const dir = join(this.rootDir, dirName);
        if (await isDir(dir)) {
            const meta = await this.readMeta(dir);
            if (meta && !meta.committed) {
                throw new Error(`楼层 "${floor}" 已存在且未提交，拒绝重复开始（防止跨会话串层）`);
            }
            // 已提交（或元数据缺失）的同名旧单元：清空旧记录，作为新事务开始
            await writeFile(join(dir, 'records.jsonl'), '', 'utf8');
        }
        else {
            await mkdir(dir, { recursive: true });
        }
        await this.writeMeta(dir, { floor, startedAt: new Date().toISOString(), committed: false });
        this.states.set(dirName, { paths: new Set(), seq: 0 });
    }
    async doRecord(floor, path, before, beforeEncoding) {
        await mkdir(this.rootDir, { recursive: true });
        const dirName = sanitizeFloor(floor);
        const dir = join(this.rootDir, dirName);
        if (!(await isDir(dir))) {
            throw new Error(`楼层 "${floor}" 未开始（或已回滚），无法记录写入快照`);
        }
        const normPath = path.replace(/\\/g, '/');
        const state = await this.loadState(dirName);
        if (state.paths.has(normPath))
            return; // 同层同路径只留首次快照
        // 顺序要紧：必须先 append 成功再更新内存状态。若先记入 paths 而 append 失败，
        // 调用方重试同一路径会命中上面的「已快照」快路径，这条 before 镜像就永远不落盘，
        // 回滚只能把文件停在改后内容——静默的数据丢失。doRecord 在串行队列内执行，
        // 这段「读—写」不会与其他记录交错，推迟更新是安全的。
        const seq = state.seq + 1;
        const line = {
            seq,
            path: normPath,
            before,
            ...(beforeEncoding && before !== null ? { beforeEncoding } : {}),
        };
        await appendFile(join(dir, 'records.jsonl'), JSON.stringify(line) + '\n', 'utf8');
        state.seq = seq;
        state.paths.add(normPath);
    }
    async doRecordAfter(floor, path, after, afterEncoding) {
        const dirName = sanitizeFloor(floor);
        const dir = join(this.rootDir, dirName);
        if (!(await isDir(dir)))
            throw new Error(`楼层 "${floor}" 未开始（或已回滚），无法记录写入后快照`);
        const file = join(dir, 'records.jsonl');
        let text;
        try {
            text = await readFile(file, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                throw new Error(`楼层 "${floor}" 没有可更新的 WAL 记录`);
            }
            throw error;
        }
        const normPath = path.replace(/\\/g, '/');
        let found = false;
        const lines = text.split('\n').map((line) => {
            if (!line.trim())
                return line;
            try {
                const record = JSON.parse(line);
                if (record.path !== normPath)
                    return line;
                found = true;
                return JSON.stringify({
                    ...record,
                    after,
                    ...(afterEncoding && after !== null ? { afterEncoding } : {}),
                });
            }
            catch {
                // 坏行保留原文；补写 after 不应顺手抹掉调试信息。
                return line;
            }
        });
        if (!found)
            throw new Error(`楼层 "${floor}" 没有路径 "${normPath}" 的 WAL 记录`);
        await atomicWrite(file, lines.join('\n'));
    }
    async doCommitFloor(floor) {
        await mkdir(this.rootDir, { recursive: true });
        const dir = join(this.rootDir, sanitizeFloor(floor));
        const meta = await this.readMeta(dir);
        if (!meta)
            throw new Error(`楼层 "${floor}" 不存在，无法提交`);
        meta.committed = true;
        meta.committedAt = new Date().toISOString();
        await this.writeMeta(dir, meta);
    }
    async doRollbackFloor(floor, workspaceRoot) {
        await mkdir(this.rootDir, { recursive: true });
        const dirName = sanitizeFloor(floor);
        const dir = join(this.rootDir, dirName);
        if (!(await isDir(dir))) {
            throw new Error((await this.hasRolledBackDir(dirName))
                ? `楼层 "${floor}" 已回滚，无法重复回滚`
                : `楼层 "${floor}" 不存在，无法回滚`);
        }
        const records = await this.readRecords(dir);
        // 归并条目是来源事实的派生视图。先展开受影响的摘要，再对原条目执行逆操作；
        // 整理仍不记 WAL，但不能让已撤销事实藏在新的摘要 id 下继续检索。
        await expandAffectedMemories(workspaceRoot, records.map((record) => record.path));
        const restored = [];
        const preserved = new Set();
        for (let i = records.length - 1; i >= 0; i--) {
            const rec = records[i];
            const target = join(workspaceRoot, rec.path);
            // 新记录带 after：只有文件仍保持楼层写入后的内容才执行恢复；楼层外的人工修改
            // 留在磁盘上，避免面板编辑被回退静默覆盖。旧 WAL 没有 after，沿用原来的恢复口径。
            if (Object.prototype.hasOwnProperty.call(rec, 'after')) {
                const after = rec.after;
                const current = await readFile(target).catch((error) => {
                    if (error.code === 'ENOENT')
                        return null;
                    throw error;
                });
                const expected = after === null
                    ? null
                    : rec.afterEncoding === 'base64'
                        ? Buffer.from(after, 'base64')
                        : Buffer.from(after, 'utf8');
                const same = current === null && expected === null
                    ? true
                    : current !== null && expected !== null && Buffer.from(current).equals(expected);
                if (!same) {
                    if (rec.path === 'state/world-delta.jsonl' && rec.beforeEncoding !== 'base64' && rec.afterEncoding !== 'base64') {
                        const merged = undoWorldDelta(rec.before, after, current?.toString('utf8') ?? null);
                        if (merged === null)
                            await rm(target, { force: true });
                        else
                            await atomicWrite(target, merged);
                        restored.push(rec.path);
                    }
                    else {
                        preserved.add(rec.path);
                    }
                    continue;
                }
            }
            if (rec.before === null) {
                await rm(target, { force: true }); // 原本不存在：删除（已不存在则跳过）
            }
            else {
                await mkdir(dirname(target), { recursive: true }); // 父目录可能已被本楼层写入删除
                if (rec.beforeEncoding === 'base64' || (rec.beforeEncoding === undefined && rec.before.startsWith(WAL_BINARY_MARK))) {
                    const encoded = rec.beforeEncoding === 'base64' ? rec.before : rec.before.slice(WAL_BINARY_MARK.length);
                    await atomicWrite(target, Buffer.from(encoded, 'base64'));
                }
                else {
                    await atomicWrite(target, rec.before);
                }
            }
            restored.push(rec.path);
        }
        if (records.some((record) => record.path.startsWith('memory/') || record.path === 'state/world-delta.jsonl')) {
            await rebuildIndex(new WorkspaceFs(workspaceRoot, null), estimateTokens);
        }
        const meta = (await this.readMeta(dir)) ?? { floor, startedAt: new Date().toISOString(), committed: false };
        meta.rolledBackAt = new Date().toISOString();
        meta.preservedPaths = [...preserved];
        await this.writeMeta(dir, meta);
        await rename(dir, join(this.rootDir, `${dirName}${ROLLED_BACK_MARK}${timestamp()}`));
        this.states.delete(dirName);
        return restored;
    }
    async doRollbackAfter(floors, workspaceRoot) {
        await mkdir(this.rootDir, { recursive: true });
        const restored = [];
        const skipped = [];
        for (let i = floors.length - 1; i >= 0; i--) {
            const floor = floors[i];
            if (!(await isDir(join(this.rootDir, sanitizeFloor(floor))))) {
                skipped.push(floor); // 已不存在（含已回滚）的楼层跳过
                continue;
            }
            restored.push(...(await this.doRollbackFloor(floor, workspaceRoot)));
        }
        return { restored, skipped };
    }
    async doListFloors() {
        await mkdir(this.rootDir, { recursive: true });
        const entries = await readdir(this.rootDir, { withFileTypes: true });
        const floors = [];
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const meta = await this.readMeta(join(this.rootDir, entry.name));
            if (!meta)
                continue; // 元数据缺失/损坏的目录不展示
            floors.push({
                floor: meta.floor,
                committed: meta.committed,
                startedAt: meta.startedAt,
                rolledBack: entry.name.includes(ROLLED_BACK_MARK),
            });
        }
        floors.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        return floors;
    }
    async doPrune(options) {
        const keepDays = options.keepRolledBackDays ?? 7;
        await mkdir(this.rootDir, { recursive: true });
        const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
        const entries = await readdir(this.rootDir, { withFileTypes: true });
        let removed = 0;
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.includes(ROLLED_BACK_MARK))
                continue;
            const dir = join(this.rootDir, entry.name);
            const meta = await this.readMeta(dir);
            let rolledBackAt = meta?.rolledBackAt ? Date.parse(meta.rolledBackAt) : Number.NaN;
            if (Number.isNaN(rolledBackAt))
                rolledBackAt = (await stat(dir)).mtimeMs; // 元数据缺失时退回目录 mtime
            if (rolledBackAt < cutoff) {
                await rm(dir, { recursive: true, force: true });
                removed += 1;
            }
        }
        return removed;
    }
}
