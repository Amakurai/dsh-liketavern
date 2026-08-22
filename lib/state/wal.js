/**
 * 事务层（WAL）：楼层级写入快照与回滚。
 * agent 每回合（楼层）对工作区的所有写入，先经 record() 快照原内容；
 * 「重新生成/回退楼层」时按记录逆序回放，把工作区精确恢复到该回合开始前。
 *
 * 磁盘布局（rootDir 为工作区的 state/wal/ 目录）：
 *   <root>/<floor>/meta.json      楼层事务元数据（committed/时间戳）
 *   <root>/<floor>/records.jsonl  写入前快照，每行 {"seq":n,"path":"...","before":"...|null"}
 * 回滚后楼层目录改名为 <floor>.rolled-back-<timestamp>，保留供调试（UI 不展示）。
 */
import { Buffer } from 'node:buffer';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
/** 回滚目录名标记：<floor>.rolled-back-<timestamp>。 */
const ROLLED_BACK_MARK = '.rolled-back-';
/** records.jsonl 中二进制 before 快照的前缀（WorkspaceFs.writeBytes 写入，回滚时 base64 解码）。 */
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
    /** 楼层目录名 → 记录状态（paths 用于同层同路径去重，seq 为已用最大序号）。 */
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
    record(floor, path, before) {
        return this.enqueue(() => this.doRecord(floor, path, before));
    }
    /** 提交楼层：meta.committed=true 并记录 committedAt。 */
    commitFloor(floor) {
        return this.enqueue(() => this.doCommitFloor(floor));
    }
    /** 逆序回放本楼层快照：before 为字符串写回（先确保父目录存在），为 null 删除文件；随后目录改名保留。 */
    rollbackFloor(floor, workspaceRoot) {
        return this.enqueue(() => this.doRollbackFloor(floor, workspaceRoot));
    }
    /** 按传入顺序的逆序逐个回滚（「回退到第 N 楼」= 撤销其后所有楼层）；不存在的楼层记入 skipped。 */
    rollbackAfter(floors, workspaceRoot) {
        return this.enqueue(() => this.doRollbackAfter(floors, workspaceRoot));
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
        await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
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
            records.push(JSON.parse(line));
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
    async doRecord(floor, path, before) {
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
        const line = { seq, path: normPath, before };
        await appendFile(join(dir, 'records.jsonl'), JSON.stringify(line) + '\n', 'utf8');
        state.seq = seq;
        state.paths.add(normPath);
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
        const restored = [];
        for (let i = records.length - 1; i >= 0; i--) {
            const rec = records[i];
            const target = join(workspaceRoot, rec.path);
            if (rec.before === null) {
                await rm(target, { force: true }); // 原本不存在：删除（已不存在则跳过）
            }
            else {
                await mkdir(dirname(target), { recursive: true }); // 父目录可能已被本楼层写入删除
                if (rec.before.startsWith(WAL_BINARY_MARK)) {
                    await writeFile(target, Buffer.from(rec.before.slice(WAL_BINARY_MARK.length), 'base64'));
                }
                else {
                    await writeFile(target, rec.before, 'utf8');
                }
            }
            restored.push(rec.path);
        }
        const meta = (await this.readMeta(dir)) ?? { floor, startedAt: new Date().toISOString(), committed: false };
        meta.rolledBackAt = new Date().toISOString();
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
