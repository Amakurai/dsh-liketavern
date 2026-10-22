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
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { undoWorldDelta } from '../core/walUndo.js';
import { atomicWrite } from './atomicWrite.js';
import { withWorkspaceLock } from './workspaceLock.js';
import { expandAffectedMemories } from './memoryRollback.js';
import { hasRecoveryMarker, WAL_RECOVERY_PATH, withRecoveryWriteAccess, WorkspaceFs, WORKSPACE_RECOVERING_MESSAGE } from './workspaceFs.js';
import { rebuildIndex } from './workspace.js';
import { estimateTokens } from '../core/tokenize.js';
import { readTemplateDocument, TEMPLATE_DATA_PATH } from './templateStorage.js';
/** 回滚目录名标记：<floor>.rolled-back-<timestamp>。 */
const ROLLED_BACK_MARK = '.rolled-back-';
/** 旧版本 records.jsonl 中二进制 before 快照的前缀；新记录使用 beforeEncoding 字段。 */
export const WAL_BINARY_MARK = 'binary-base64:';
/** Buffer 的 base64 解码会忽略坏字符和截断；必须往返一致才允许用作恢复镜像。 */
function isBase64(value) {
    return typeof value === 'string' && Buffer.from(value, 'base64').toString('base64') === value;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------
/** 楼层 id → 目录名：非法字符替换为 '_'（同字符冲突由调用方保证不出现）。 */
function sanitizeFloor(floor) {
    return floor.replace(/[^A-Za-z0-9_.-]/g, '_');
}
/** Windows 上大小写别名是同一个正文文件；仅用于比较，不能改写已有日志或恢复游标的 hash。 */
function recordPathIdentity(path) { return process.platform === 'win32' ? path.toLowerCase() : path; }
/**
 * 楼层目录中表明楼层已开始的文件。建目录后、写 meta 前崩溃会留下这些文件都不存在的目录：
 * 记录只在元数据存在后追加，回滚也先写游标再改正文，这种目录不可能关联任何正文修改，
 * 按未开始处理；缺元数据但有记录或回滚游标仍是损坏，照常拒绝。doctor 共用同一判定。
 */
export const WAL_FLOOR_MARKERS = ['meta.json', 'records.jsonl', 'rollback-progress.json'];
/** 独立于 WAL 目录保存已知楼层，删除日志不能被误认为剧情从未写入。 */
export const WAL_COVERAGE_PATH = 'state/wal-coverage.json';
async function isUnstartedDir(dir) {
    for (const name of WAL_FLOOR_MARKERS) {
        const present = await stat(join(dir, name)).then(() => true, (error) => {
            if (error.code === 'ENOENT')
                return false;
            throw error;
        });
        if (present)
            return false;
    }
    return true;
}
/** 目录改名用时间戳：纯数字（毫秒精度），避开 Windows 文件名非法字符。 */
function timestamp() {
let lastWalTimeMs = 0;
function nextWalIsoTime() {
    const now = Date.now();
    lastWalTimeMs = now > lastWalTimeMs ? now : lastWalTimeMs + 1;
    return new Date(lastWalTimeMs).toISOString();
}
function timestamp() {
    return nextWalIsoTime().replace(/[^0-9]/g, '');
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
/** 快照统一为实际字节的 base64；旧版省略 utf8 标签或使用 before 前缀也必须得到相同身份。 */
function snapshotBytes(rec, side) {
    const value = rec[side] ?? null;
    if (value === null)
        return null;
    const encoding = side === 'before' ? rec.beforeEncoding : rec.afterEncoding;
    if (encoding === 'base64')
        return value;
    if (side === 'before' && encoding === undefined && value.startsWith(WAL_BINARY_MARK))
        return value.slice(WAL_BINARY_MARK.length);
    return Buffer.from(value).toString('base64');
}
/**
 * 后继世界状态快照是否依赖先前修改的 id。快照来自正文原样镜像，而正文读写（WorldDeltaStore、undoWorldDelta）
 * 都刻意保留无法解析的行；这里同样只按能解析出字符串 id 的行比较，坏行不能让预检抛出原始解析错误。
 */
function deltaChangesDependOn(previous, next) {
    const snapshots = (rec) => {
        const rows = (text) => new Map((text ?? '').split('\n').filter((line) => line.trim()).flatMap((line) => {
            let id;
            try {
                id = JSON.parse(line)?.id;
            }
            catch {
                return [];
            }
            return typeof id === 'string' ? [[id, line]] : [];
        }));
        const text = (side) => {
            const bytes = snapshotBytes(rec, side);
            return bytes === null ? null : Buffer.from(bytes, 'base64').toString('utf8');
        };
        const before = rows(text('before')), after = rows(text('after'));
        return { before, after, changed: new Set([...before.keys(), ...after.keys()].filter((id) => before.get(id) !== after.get(id))) };
    };
    const a = snapshots(previous), b = snapshots(next);
    // 中间插入其它 id 或保留坏行会改变整文件镜像，但不会消除同一条目的前后依赖。
    // 人工修改过同一 id 的情况则必须保留，不能只因 id 重叠就拒绝撤销。
    return [...b.changed].some((id) => a.changed.has(id) && a.after.get(id) === b.before.get(id));
}
/** before 与 after 字节相同的记录：恢复时不改文件，既不会被复活，也不能作为别的楼层的依赖锚点。 */
function isNoopRecord(rec) {
    return 'after' in rec && snapshotBytes(rec, 'before') === snapshotBytes(rec, 'after');
}
/** 从同一记录与撤销前正文推导恢复目标；执行与恢复游标预检共用，禁止游标自行提供新正文。 */
function rollbackTarget(rec, current) {
    let desired = snapshotBytes(rec, 'before');
    if ('after' in rec && current !== snapshotBytes(rec, 'after')) {
        if (recordPathIdentity(rec.path) !== 'state/world-delta.jsonl' || rec.beforeEncoding === 'base64' || rec.afterEncoding === 'base64') {
            return { restore: false };
        }
        const merged = undoWorldDelta(rec.before, rec.after ?? null, current === null ? null : Buffer.from(current, 'base64').toString('utf8'));
        desired = merged === null ? null : Buffer.from(merged).toString('base64');
        if (desired === current)
            return { restore: false };
    }
    return { restore: true, value: desired };
}
export class Wal {
    rootDir;
    logFs;
    hasCoverage;
    /** 最近一次确认已登记的楼层身份。 */
    covered;
    /** rootDir 为工作区的 state/wal/ 目录；不存在则在首次操作时创建。 */
    constructor(rootDir) {
        this.rootDir = resolve(rootDir);
        const state = dirname(this.rootDir);
        // 宿主日志的边界是所属工作区，state 父路径也不能改成兄弟剧情的链接；安装祖先挂载不受影响。
        // 独立日志根继续采用调用方显式给定的边界，不要求正文目录与日志目录是同一个根。
        const anchor = basename(state).toLowerCase() === 'state' && basename(this.rootDir).toLowerCase() === 'wal'
            ? dirname(state) : this.rootDir;
        this.logFs = new WorkspaceFs(anchor, null);
        this.hasCoverage = anchor !== this.rootDir;
    }
    async readCoverage() {
        if (!this.hasCoverage)
            return null;
        const info = await this.logFs.stat(WAL_COVERAGE_PATH);
        if (info && info.size > 4 * 1024 * 1024)
            throw new Error('WAL 楼层清单超过上限');
        const raw = await this.logFs.readText(WAL_COVERAGE_PATH);
        if (raw === null)
            return null;
        if (Buffer.byteLength(raw) > 4 * 1024 * 1024)
            throw new Error('WAL 楼层清单超过上限');
        const value = JSON.parse(raw);
        if (!isRecord(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'floors'].includes(key))
            || !Array.isArray(value.floors) || value.floors.some(floor => !isRecord(floor)
            || Object.keys(floor).some(key => !['floor', 'startedAt'].includes(key))
            || typeof floor.floor !== 'string' || !floor.floor || floor.floor.length > 512
            || typeof floor.startedAt !== 'string' || !Number.isFinite(Date.parse(floor.startedAt)))
            || new Set(value.floors.map(floor => floor.floor)).size !== value.floors.length)
            throw new Error('WAL 楼层清单损坏');
        return value.floors;
    }
    async writeCoverage(floors) {
        await this.writeCoverageFloors(floors.filter(floor => !floor.rolledBack).map(({ floor, startedAt }) => ({ floor, startedAt })));
    }
    async writeCoverageFloors(floors) {
        if (!this.hasCoverage)
            return;
        const raw = JSON.stringify({ version: 1, floors: [...floors].sort((a, b) => a.floor.localeCompare(b.floor)) });
        if (Buffer.byteLength(raw) > 4 * 1024 * 1024)
            throw new Error('WAL 楼层清单超过上限');
        const path = join(this.logFs.root, WAL_COVERAGE_PATH);
        await this.assertLogPath(path);
        // 由 WAL 队列串行化；这里不能反向认领工作区锁，否则会与正文写入形成锁序倒置。
        if (raw !== await this.logFs.readText(WAL_COVERAGE_PATH))
            await atomicWrite(path, raw);
    }
    async recordCoverage(meta) {
        if (!this.hasCoverage)
            return;
        // 同一楼层连续写入只核对一次；楼层身份含开始时间，重生成的同名楼层会重新登记。
        const identity = JSON.stringify([meta.floor, meta.startedAt]);
        if (this.covered === identity)
            return;
        const coverage = await this.readCoverage();
        if (!coverage?.some(floor => floor.floor === meta.floor && floor.startedAt === meta.startedAt)) {
            // 旧剧情首次登记才完整列举。已有清单只追加或替换本层，其它楼层的登记原样保留：
            // 每次开层都重新列举既随楼层数变慢，也不该由磁盘现状重建已有的登记。
            if (coverage === null)
                await this.writeCoverage(await this.doListFloors());
            else
                await this.writeCoverageFloors([...coverage.filter(floor => floor.floor !== meta.floor), { floor: meta.floor, startedAt: meta.startedAt }]);
        }
        this.covered = identity;
    }
    /**
     * 开层前核对已登记楼层的日志目录仍在（回滚副本同样算数），被清理后不能继续开新层。
     * 普通新层只比目录名；重用已登记 id 时只核对该身份的回滚完成证明，不能用新开始时间洗掉丢日志的证据。
     * 其它楼层的元数据与开始时间完整检查仍留给列举、回退与分支。
     */
    async assertCoveredFloorDirs(targetFloor) {
        const coverage = await this.readCoverage();
        if (!coverage?.length)
            return;
        const directories = (await readdir(this.rootDir, { withFileTypes: true })).filter(entry => entry.isDirectory());
        const names = new Set(directories.map(entry => entry.name.split(ROLLED_BACK_MARK)[0]));
        for (const floor of coverage) {
            if (!names.has(sanitizeFloor(floor.floor)))
                throw new Error(`WAL 楼层缺失：${floor.floor}；请恢复完整日志，不能继续回退或分支`);
        }
        const previous = coverage.find(floor => floor.floor === targetFloor);
        if (!previous)
            return;
        // 空目录可能是首次开层前的崩溃遗留，也可能是已有层的日志被清空。
        // 清单已登记的身份只有完成回滚后才能替换；更早一次同名层的副本不能充当当前层的证明。
        const prefix = sanitizeFloor(targetFloor) + ROLLED_BACK_MARK;
        for (const entry of directories) {
            if (!entry.name.startsWith(prefix))
                continue;
            const dir = join(this.rootDir, entry.name);
            const meta = await this.readMeta(dir);
            if (meta?.floor !== previous.floor || meta.startedAt !== previous.startedAt)
                continue;
            const records = await this.readRecords(dir);
            const progress = await this.readRollbackProgress(dir, records);
            if (typeof meta.rolledBackAt === 'string' && Number.isFinite(Date.parse(meta.rolledBackAt))
                && progress.next === -1 && !progress.pending)
                return;
        }
        throw new Error(`WAL 已登记楼层缺失或未完成回滚：${targetFloor}；请恢复完整日志，不能重新开始`);
    }
    async assertLogPath(target = this.rootDir) {
        await this.logFs.assertSafePath(relative(this.logFs.root, target));
    }
    /** 开始新的楼层事务；已有楼层必须显式 reopen 或先回滚，不能覆盖原始镜像。 */
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
        return this.recordChanges(floor, [{ path, before, after, beforeEncoding, afterEncoding }]);
    }
    /**
     * 一批修改一次追加，序号按入参顺序连续；全部记录持久化后调用方才能替换其中任何正文。
     * 追加要重读并原子重写整份日志，逐条记录的代价随同层记录数平方增长。
     */
    recordChanges(floor, changes) {
        return this.enqueue(async () => {
            if (!changes.length)
                return;
            const dirName = sanitizeFloor(floor);
            const dir = join(this.rootDir, dirName);
            await this.assertLogPath(dir);
            if (!(await isDir(dir)))
                throw new Error(`楼层 "${floor}" 未开始（或已回滚），无法记录写入快照`);
            await this.assertNotRecovering(dir);
            await this.assertWorkspaceReady();
            const meta = await this.readFloorMeta(dir, floor);
            await this.recordCoverage(meta);
            const state = await this.loadState(dirName);
            const file = join(dir, 'records.jsonl');
            const text = await readFile(file, 'utf8').catch((error) => {
                if (error.code === 'ENOENT')
                    return '';
                throw error;
            });
            const lines = changes.map((change, index) => JSON.stringify({ seq: state.seq + 1 + index, path: change.path.replace(/\\/g, '/'),
                before: change.before, after: change.after, beforeEncoding: change.beforeEncoding, afterEncoding: change.afterEncoding }));
            await atomicWrite(file, text + (text && !text.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n');
        });
    }
    /** 提交楼层：meta.committed=true 并记录 committedAt。 */
    commitFloor(floor) {
        return this.enqueue(() => this.doCommitFloor(floor));
    }
    /** 已完成楼层追加受控事务前重新标记未收口；保留全部快照和时间，先验证整层，不能用旧 committed 掩盖新写入失败。 */
    reopenFloor(floor) {
        return this.enqueue(async () => {
            const dir = join(this.rootDir, sanitizeFloor(floor));
            await this.assertLogPath(dir);
            if (!(await isDir(dir)))
                throw new Error(`WAL 楼层缺失或已回滚：${floor}`);
            await this.assertNotRecovering(dir);
            await this.assertWorkspaceReady();
            const meta = await this.readFloorMeta(dir, floor);
            await this.readRecords(dir);
            if (!meta.committed)
                return;
            meta.committed = false;
            delete meta.committedAt;
            await this.writeMeta(dir, meta);
        });
    }
    /** 逆序回放本楼层快照：before 为字符串写回（先确保父目录存在），为 null 删除文件；随后目录改名保留。 */
    rollbackFloor(floor, workspaceRoot) {
        return withWorkspaceLock(workspaceRoot, () => this.enqueue(async () => {
            await this.preflightRollback([floor], workspaceRoot);
            return this.doRollbackFloor(floor, workspaceRoot);
        }));
    }
    /**
     * 只读推算指定正文在完整撤销本层后的最终字节，用于回收根不再需要的生成恢复正文。
     * 调用方须持有工作区锁，使传入的当前正文与日志一致；按正式回滚相同规则保留楼层外修订。
     * 这里只处理给定路径，不执行模板块保留、记忆展开或索引重建，不能代替实际回滚。
     */
    rollbackSnapshot(floor, path, current) {
        const identity = recordPathIdentity(path.replace(/\\/g, '/'));
        let snapshot = current === null ? null : Buffer.from(current).toString('base64');
        return this.enqueue(async () => {
            const dir = join(this.rootDir, sanitizeFloor(floor));
            await this.assertLogPath(dir);
            await this.readFloorMeta(dir, floor);
            await this.assertNotRecovering(dir);
            const records = await this.readRecords(dir);
            for (let index = records.length - 1; index >= 0; index--) {
                const record = records[index];
                if (recordPathIdentity(record.path) !== identity)
                    continue;
                const target = rollbackTarget(record, snapshot);
                if (target.restore)
                    snapshot = target.value;
            }
            return snapshot === null ? null : Buffer.from(snapshot, 'base64');
        });
    }
    /** 按传入顺序的逆序逐个回滚（「回退到第 N 楼」= 撤销其后所有楼层）；不存在的楼层记入 skipped。 */
    rollbackAfter(floors, workspaceRoot) {
        return withWorkspaceLock(workspaceRoot, () => this.enqueue(() => this.doRollbackAfter(floors, workspaceRoot)));
    }
    /** 列出全部楼层（含已回滚，rolledBack: true），按 startedAt 升序。 */
    listFloors() {
        return this.enqueue(() => this.doListFloors());
    }
    /** 只读检查可用楼层：元数据、序号、路径与快照必须有效；回滚中的旧 committed 不能作为完成证明。 */
    validateFloor(floor) {
        return this.enqueue(async () => {
            const dir = join(this.rootDir, sanitizeFloor(floor));
            await this.assertLogPath(dir);
            if (!(await isDir(dir)))
                throw new Error(`WAL 楼层缺失或已回滚：${floor}`);
            const meta = await this.readFloorMeta(dir, floor);
            await this.assertNotRecovering(dir);
            await this.assertWorkspaceReady();
            await this.readRecords(dir);
            return { floor, committed: meta.committed, startedAt: meta.startedAt, rolledBack: false };
        });
    }
    /** 删除已回滚且早于 keepRolledBackDays（默认 7）的楼层目录，返回删除数。 */
    prune(options) {
        return this.enqueue(() => this.doPrune(options));
    }
    // -------------------------------------------------------------------------
    // 队列与读写原语
    // -------------------------------------------------------------------------
    enqueue(task) {
        // 同一日志目录的所有句柄共享队列，路径别名也由工作区锁规范化。
        return withWorkspaceLock(this.rootDir, async () => {
            await this.assertLogPath();
            return task();
        });
    }
    async readMeta(dir) {
        await this.assertLogPath(join(dir, 'meta.json'));
        const raw = await readFile(join(dir, 'meta.json'), 'utf8').catch((error) => {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        });
        if (raw === null)
            return null;
        let meta;
        try {
            meta = JSON.parse(raw);
        }
        catch {
            throw new Error(`WAL 元数据损坏：${dir}`);
        }
        if (!meta || typeof meta.floor !== 'string' || !meta.floor || typeof meta.startedAt !== 'string'
            || !Number.isFinite(Date.parse(meta.startedAt)) || typeof meta.committed !== 'boolean')
            throw new Error(`WAL 元数据形状损坏：${dir}`);
        return meta;
    }
    async writeMeta(dir, meta) {
        await this.assertLogPath(join(dir, 'meta.json'));
        await atomicWrite(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
    }
    /** 目录存在不代表楼层可写；元数据必须完整且属于请求的原始楼层，不能只比净化后的目录名。 */
    async readFloorMeta(dir, floor) {
        const meta = await this.readMeta(dir);
        if (!meta || meta.floor !== floor)
            throw new Error(`WAL 楼层元数据不存在或不匹配：${floor}`);
        return meta;
    }
    /** 恢复游标绑定原始记录集合；中断后只能继续回滚，追加或提交会使游标失效或误报已完成。 */
    async assertNotRecovering(dir) {
        await this.assertLogPath(join(dir, 'rollback-progress.json'));
        const progress = await stat(join(dir, 'rollback-progress.json')).catch((error) => {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        });
        if (progress)
            throw new Error(`WAL 楼层正在回滚恢复，完成恢复前不能追加或提交：${dir}`);
    }
    /** 工作区级恢复标记的绝对路径；非标准日志根（无 state/wal 布局）退回日志目录内。 */
    recoveryMarkerPath() {
        return this.hasCoverage ? join(this.logFs.root, WAL_RECOVERY_PATH) : join(this.rootDir, 'wal-recovery.json');
    }
    /** 读恢复标记中的楼层清单；文件缺失或损坏按空处理（标记是自有的保护信息，不参与回滚数据）。 */
    async readRecoveryFloors() {
        const path = this.recoveryMarkerPath();
        await this.assertLogPath(path);
        const raw = await readFile(path, 'utf8').catch((error) => {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        });
        if (raw === null)
            return [];
        try {
            const value = JSON.parse(raw);
            if (!isRecord(value) || !Array.isArray(value.floors))
                return [];
            return value.floors.filter((floor) => typeof floor === 'string' && floor.length > 0);
        }
        catch {
            return [];
        }
    }
    /**
     * 标记同时记下日志目录与各层净化后的目录名，WorkspaceFs 据此只凭标记即可判断游标是否仍在，
     * 失效标记（回滚已归档、未注销）不会挡住正文写入。非标准日志根时正文工作区另写一份副本，
     * 否则 WorkspaceFs（只看 <root>/state/wal-recovery.json）看不到屏障。
     */
    async writeRecoveryFloors(floors, bodyRoot) {
        const path = this.recoveryMarkerPath();
        await this.assertLogPath(path);
        const unique = [...new Set(floors)];
        const bodyMarker = !this.hasCoverage && bodyRoot ? join(resolve(bodyRoot), WAL_RECOVERY_PATH) : null;
        if (!unique.length) {
            await rm(path, { force: true });
            if (bodyMarker)
                await rm(bodyMarker, { force: true });
            return;
        }
        const text = JSON.stringify({ version: 1, floors: unique, dirs: unique.map(sanitizeFloor), walDir: this.rootDir }) + '\n';
        await atomicWrite(path, text);
        if (bodyMarker)
            await atomicWrite(bodyMarker, text);
    }
    /** 回滚开始前登记本层：先写标记再写恢复游标，任何游标存在期间工作区都有写屏障。 */
    async markRecovering(floor, bodyRoot) {
        await this.writeRecoveryFloors([...(await this.readRecoveryFloors()), floor], bodyRoot);
    }
    /** 回滚完成后注销本层；没有其它恢复中楼层时删除标记。顺手丢掉已随归档消失的陈旧条目。 */
    async clearRecovering(floor, bodyRoot) {
        const remaining = (await this.readRecoveryFloors()).filter((item) => item !== floor);
        await this.writeRecoveryFloors(await this.activeRecoveryFloors(remaining), bodyRoot);
    }
    /** 标记里仍“活着”的恢复楼层：活动目录存在且游标还在；已改名归档/被删除的条目算失效。 */
    async activeRecoveryFloors(floors) {
        const active = [];
        for (const floor of floors) {
            const dir = join(this.rootDir, sanitizeFloor(floor));
            if (!(await isDir(dir)))
                continue;
            const progress = await stat(join(dir, 'rollback-progress.json')).catch((error) => {
                if (error.code === 'ENOENT')
                    return null;
                throw error;
            });
            if (progress)
                active.push(floor);
        }
        return active;
    }
    /**
     * 清理崩溃窗口留下的失效标记条目（回滚已改名归档、但还没来得及注销标记）。
     * 只保留活动目录里仍有游标的楼层；没有剩余时删除标记文件。
     */
    async reconcileRecoveryMarker() {
        const floors = await this.readRecoveryFloors();
        if (!floors.length) {
            await this.writeRecoveryFloors([]);
            return [];
        }
        const active = await this.activeRecoveryFloors(floors);
        if (active.length !== floors.length)
            await this.writeRecoveryFloors(active);
        return active;
    }
    /**
     * 普通写入只查标记文件（一次 stat），标记存在时顺带清掉失效条目再判断。
     * `scanCursors` 供开层/分支快照等低频入口使用，兜底识别旧版本崩溃遗留、还没有标记文件的恢复游标；
     * 已改名归档的回滚副本不算恢复中（它的游标只是完成回滚后的历史记录，`ROLLED_BACK_MARK` 目录一律跳过）。
     */
    async assertWorkspaceReady(options) {
        const markerRoot = this.hasCoverage ? this.logFs.root : this.rootDir;
        if (await hasRecoveryMarker(markerRoot)) {
            if ((await this.reconcileRecoveryMarker()).length)
                throw new Error(WORKSPACE_RECOVERING_MESSAGE);
        }
        if (!options?.scanCursors)
            return;
        const entries = await readdir(this.rootDir, { withFileTypes: true }).catch((error) => {
            if (error.code === 'ENOENT')
                return [];
            throw error;
        });
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.includes(ROLLED_BACK_MARK))
                continue;
            const progress = await stat(join(this.rootDir, entry.name, 'rollback-progress.json')).catch((error) => {
                if (error.code === 'ENOENT')
                    return null;
                throw error;
            });
            if (progress)
                throw new Error(WORKSPACE_RECOVERING_MESSAGE);
        }
    }
    /** 供分支快照等外部入口复用：有未完成恢复（或旧版遗留游标）时明确拒绝，并清理失效标记。 */
    assertWorkspaceWritable() {
        return this.enqueue(() => this.assertWorkspaceReady({ scanCursors: true }));
    }
    /** 列出当前处于回滚恢复中的楼层（标记清单 + 磁盘游标），供面板/诊断决定是否提示重置。 */
    async recoveringFloors() {
        return this.enqueue(async () => {
            const floors = new Set(await this.reconcileRecoveryMarker());
            const entries = await readdir(this.rootDir, { withFileTypes: true }).catch((error) => {
                if (error.code === 'ENOENT')
                    return [];
                throw error;
            });
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.includes(ROLLED_BACK_MARK))
                    continue;
                const progress = await stat(join(this.rootDir, entry.name, 'rollback-progress.json')).catch((error) => {
                    if (error.code === 'ENOENT')
                        return null;
                    throw error;
                });
                if (progress) {
                    const meta = await this.readMeta(join(this.rootDir, entry.name));
                    if (meta)
                        floors.add(meta.floor);
                }
            }
            return [...floors];
        });
    }
    /**
     * 受控重置：删除本层恢复游标并注销标记，让冲突/损坏的恢复不再是永久死锁。
     * 下一次回滚会从当前磁盘状态重新回放（已还原的正文按既有「保留人工修订」语义处理），
     * 因此这不是“跳过回滚”，调用方仍必须重新执行回滚才能撤销本层。
     */
    resetRollbackCursor(floor) {
        return this.enqueue(async () => {
            const dir = join(this.rootDir, sanitizeFloor(floor));
            await this.assertLogPath(dir);
            if (!(await isDir(dir)))
                throw new Error(`楼层 "${floor}" 不存在或已回滚，无法重置回滚游标`);
            await this.readFloorMeta(dir, floor);
            await this.assertLogPath(join(dir, 'rollback-progress.json'));
            await rm(join(dir, 'rollback-progress.json'), { force: true });
            await this.clearRecovering(floor);
        });
    }
    async readRecords(dir) {
        await this.assertLogPath(join(dir, 'records.jsonl'));
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
            let rec;
            try {
                rec = JSON.parse(line);
            }
            catch {
                throw new Error(`WAL 记录损坏：${dir}`);
            }
            if (!isRecord(rec))
                throw new Error(`WAL 记录形状损坏：${dir}`);
            // 所有写入协议都从 1 连续编号；只验证递增会把丢失首条或中间行的日志误认完整，
            // 回滚后残留被漏记的事实，却已撤销其它楼层并标记成功。空白行不占序号。
            if (!Number.isSafeInteger(rec.seq) || rec.seq !== records.length + 1)
                throw new Error(`WAL 记录序号损坏：${dir}`);
            const safePath = typeof rec.path === 'string' && rec.path.length > 0 && !rec.path.includes('\\')
                && !rec.path.includes(':') && !rec.path.startsWith('/') && rec.path.split('/').every((part) => part !== '..' && part !== '.' && part !== '')
                && !rec.path.toLowerCase().startsWith('state/wal/');
            if (!safePath
                || !(rec.before === null || typeof rec.before === 'string')
                || ('after' in rec && !(rec.after === null || typeof rec.after === 'string'))
                || (rec.beforeEncoding !== undefined && !['utf8', 'base64'].includes(rec.beforeEncoding))
                || (rec.afterEncoding !== undefined && !['utf8', 'base64'].includes(rec.afterEncoding))) {
                throw new Error(`WAL 记录形状或路径损坏：${dir}`);
            }
            const before = rec.beforeEncoding === undefined && rec.before?.startsWith(WAL_BINARY_MARK)
                ? rec.before.slice(WAL_BINARY_MARK.length) : rec.before;
            if ((before !== null && (rec.beforeEncoding === 'base64' || before !== rec.before) && !isBase64(before))
                || (rec.afterEncoding === 'base64' && rec.after !== null && !isBase64(rec.after))) {
                throw new Error(`WAL 快照编码损坏：${dir}`);
            }
            records.push(rec);
        }
        return records;
    }
    /** 预检与执行共用同一套只读校验，任何坏游标都必须在修改批次中首个文件前被发现。 */
    async readRollbackProgress(dir, records) {
        await this.assertLogPath(join(dir, 'rollback-progress.json'));
        const hash = createHash('sha256').update(JSON.stringify(records)).digest('hex');
        const saved = await readFile(join(dir, 'rollback-progress.json'), 'utf8').catch((error) => {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        });
        if (saved === null)
            return { hash, next: records.length - 1, restored: [], preserved: [] };
        let value;
        try {
            value = JSON.parse(saved);
        }
        catch {
            throw new Error(`WAL 回滚恢复游标损坏：${dir}`);
        }
        const paths = new Set(records.map(record => record.path));
        const isPaths = (items) => Array.isArray(items)
            && items.every(item => typeof item === 'string' && paths.has(item));
        if (!isRecord(value) || value.hash !== hash || typeof value.next !== 'number'
            || !Number.isSafeInteger(value.next) || value.next < -1 || value.next >= records.length
            || !isPaths(value.restored) || !isPaths(value.preserved)
            || value.restored.length + value.preserved.length !== records.length - value.next - 1) {
            throw new Error(`WAL 回滚恢复游标损坏：${dir}`);
        }
        const progress = { hash, next: value.next, restored: value.restored, preserved: value.preserved };
        // 完成数组必须恰好覆盖 next 之后已处理的记录；只比总数会让错路径/重复路径跳过真实修改。
        const remaining = new Map();
        for (const record of records.slice(value.next + 1))
            remaining.set(record.path, (remaining.get(record.path) ?? 0) + 1);
        for (const path of [...progress.restored, ...progress.preserved]) {
            const count = remaining.get(path) ?? 0;
            if (!count)
                throw new Error(`WAL 回滚恢复游标路径与处理进度不符：${dir}`);
            remaining.set(path, count - 1);
        }
        if ('pending' in value) {
            const pending = value.pending;
            if (!isRecord(pending) || typeof pending.path !== 'string' || pending.path !== records[value.next]?.path
                || !(pending.from === null || isBase64(pending.from)) || !(pending.to === null || isBase64(pending.to))) {
                throw new Error(`WAL 回滚恢复记录损坏：${dir}`);
            }
            const target = rollbackTarget(records[value.next], pending.from);
            if (!target.restore || pending.to !== target.value)
                throw new Error(`WAL 回滚恢复目标与原记录不符：${dir}`);
            progress.pending = { path: pending.path, from: pending.from, to: pending.to };
        }
        return progress;
    }
    /** 每次从当前日志读取序号和去重路径；其它实例追加及替换后报错都不能复用旧缓存。 */
    async loadState(dirName) {
        const state = { paths: new Set(), afterPaths: new Set(), seq: 0 };
        for (const rec of await this.readRecords(join(this.rootDir, dirName))) {
            state.paths.add(rec.path);
            // 已有 after 的记录来自新协议 recordChanges；遗留 record/recordAfter 不能与它混用。
            if ('after' in rec)
                state.afterPaths.add(rec.path);
            state.seq = Math.max(state.seq, rec.seq);
        }
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
        await this.assertLogPath(dir);
        for (const marker of WAL_FLOOR_MARKERS)
            await this.assertLogPath(join(dir, marker));
        if (await isDir(dir) && !(await isUnstartedDir(dir))) {
            const meta = await this.readMeta(dir);
            if (meta && !meta.committed) {
                throw new Error(`楼层 "${floor}" 已存在且未提交，拒绝重复开始（防止跨会话串层）`);
            }
            // records 与 meta 两次原子替换仍有崩溃窗口；重复楼层不得清空旧镜像。
            // 已完成层的受控追加使用 reopenFloor；重生成先回滚再开新层。
            throw new Error(`楼层 "${floor}" 已存在，拒绝重复开始；追加写入请显式重新打开，重新生成请先回滚`);
        }
        // 先核对旧清单，不能在日志被清理后继续开新层。
        await this.assertCoveredFloorDirs(floor);
        // 恢复游标存在期间禁止开新层：部分撤销的正文不能被新楼层当作基线写入。
        // 这里同时兜底扫描旧版本崩溃遗留、还没有标记文件的游标（只在开层这种低频入口做）。
        await this.assertWorkspaceReady({ scanCursors: true });
        await mkdir(dir, { recursive: true });
        const meta = { floor, startedAt: nextWalIsoTime(), committed: false };
        await this.writeMeta(dir, meta);
        await this.recordCoverage(meta);
    }
    async doRecord(floor, path, before, beforeEncoding) {
        await mkdir(this.rootDir, { recursive: true });
        const dirName = sanitizeFloor(floor);
        const dir = join(this.rootDir, dirName);
        await this.assertLogPath(dir);
        if (!(await isDir(dir))) {
            throw new Error(`楼层 "${floor}" 未开始（或已回滚），无法记录写入快照`);
        }
        await this.assertNotRecovering(dir);
        await this.assertWorkspaceReady();
        await this.readFloorMeta(dir, floor);
        const normPath = path.replace(/\\/g, '/');
        const state = await this.loadState(dirName);
        if (state.paths.has(normPath)) {
            // 遗留 record() 只保留首次快照；若该路径已有新协议记录（带 after），混用会让回滚
            // 把本层后续写入误判成人工修改而静默漏撤，直接拒绝。
            if (state.afterPaths.has(normPath))
                throw new Error(`楼层 "${floor}" 的路径 "${normPath}" 已有新协议 WAL 记录，不能混用遗留 record()；请改用 WorkspaceFs 写入`);
            return; // 同层同路径只留首次快照
        }
        // 序号和去重均基于当前磁盘，追加失败后的重试不会误认路径已快照。
        // 读写全程持有共享日志锁，另一个实例不能在中间插入记录。
        // 遗留协议继续用 appendFile（旧调用方与既有故障注入依赖它）；新写入一律走 recordChanges 的原子重写。
        const seq = state.seq + 1;
        const line = {
            seq,
            path: normPath,
            before,
            ...(beforeEncoding && before !== null ? { beforeEncoding } : {}),
        };
        await appendFile(join(dir, 'records.jsonl'), JSON.stringify(line) + '\n', 'utf8');
    }
    async doRecordAfter(floor, path, after, afterEncoding) {
        const dirName = sanitizeFloor(floor);
        const dir = join(this.rootDir, dirName);
        await this.assertLogPath(dir);
        if (!(await isDir(dir)))
            throw new Error(`楼层 "${floor}" 未开始（或已回滚），无法记录写入后快照`);
        await this.assertNotRecovering(dir);
        await this.assertWorkspaceReady();
        await this.readFloorMeta(dir, floor);
        await this.readRecords(dir);
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
        let duplicates = 0;
        let alreadyAfter = false;
        const lines = text.split('\n').map((line) => {
            if (!line.trim())
                return line;
            try {
                const record = JSON.parse(line);
                if (record.path !== normPath)
                    return line;
                found = true;
                duplicates += 1;
                // 新协议 recordChanges 每次写入都带 after；对这类记录再补遗留 after 会把较早记录
                // 的 after 一起改写，回滚时被误判为人工修改而静默漏撤。同路径多条也拒绝（遗留协议只认一条）。
                if ('after' in record)
                    alreadyAfter = true;
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
        if (alreadyAfter)
            throw new Error(`楼层 "${floor}" 的路径 "${normPath}" 已有新协议写后镜像，拒绝混用遗留 recordAfter()；请改用 WorkspaceFs 写入`);
        if (duplicates > 1)
            throw new Error(`楼层 "${floor}" 的路径 "${normPath}" 有多条 WAL 记录，遗留 recordAfter() 无法确定归属；请改用 WorkspaceFs 写入`);
        await atomicWrite(file, lines.join('\n'));
    }
    async doCommitFloor(floor) {
        await mkdir(this.rootDir, { recursive: true });
        const dir = join(this.rootDir, sanitizeFloor(floor));
        const meta = await this.readFloorMeta(dir, floor);
        await this.assertNotRecovering(dir);
        await this.assertWorkspaceReady();
        // 提交是完成证明，不能让读取/回滚均拒绝的日志得到 committed=true。
        await this.readRecords(dir);
        meta.committed = true;
        meta.committedAt = nextWalIsoTime();
        await this.writeMeta(dir, meta);
    }
    async doRollbackFloor(floor, workspaceRoot) {
        await mkdir(this.rootDir, { recursive: true });
        const dirName = sanitizeFloor(floor);
        const dir = join(this.rootDir, dirName);
        await this.assertLogPath(dir);
        if (!(await isDir(dir))) {
            throw new Error((await this.hasRolledBackDir(dirName))
                ? `楼层 "${floor}" 已回滚，无法重复回滚`
                : `楼层 "${floor}" 不存在，无法回滚`);
        }
        const records = await this.readRecords(dir);
        const bodyFs = new WorkspaceFs(workspaceRoot, null);
        const progressFile = join(dir, 'rollback-progress.json');
        const progress = await this.readRollbackProgress(dir, records);
        // 先登记工作区级恢复标记，再写恢复游标：标记存在期间所有外部/面板/其它楼层写入都被拒绝，
        // 恢复自身的正文替换与摘要展开经 withRecoveryWriteAccess 放行。崩溃遗留的标记会在下一次
        // 回滚重试时继续生效，完成后才注销；受控重置用 resetRollbackCursor。
        await this.markRecovering(floor, workspaceRoot);
        return await withRecoveryWriteAccess(async () => {
            const checkpoint = async () => {
                await this.assertLogPath(progressFile);
                await atomicWrite(progressFile, JSON.stringify(progress) + '\n');
            };
            // 摘要展开本身也会恢复/删除正文；先固定恢复状态，展开中断后不能再把旧 committed
            // 当成完成证明，也不能允许迟到的写入改变原日志使后续恢复游标失效。
            await checkpoint();
            // 同值快照没有撤销事实；不能仅因路径出现过就拆掉后来生成的摘要与归档来源。
            // 沿用字节级判定，兼容文本、base64 以及旧版补写 after 的日志。
            await expandAffectedMemories(workspaceRoot, records.filter((record) => !isNoopRecord(record)).map((record) => record.path));
            const currentBytes = async (path) => {
                const bytes = await bodyFs.readBytes(path);
                return bytes === null ? null : Buffer.from(bytes).toString('base64');
            };
            const applyPending = async () => {
                const pending = progress.pending;
                const current = await currentBytes(pending.path);
                // 崩溃可能发生在文件替换后、游标推进前。已到目标值则直接推进，避免重放较新的 before。
                if (current !== pending.to) {
                    if (current !== pending.from)
                        throw new Error(`WAL 恢复期间文件又被修改：${pending.path}`);
                    if (pending.to === null)
                        await bodyFs.delete(pending.path);
                    else
                        await bodyFs.writeBytes(pending.path, Buffer.from(pending.to, 'base64'));
                }
                progress.restored.push(pending.path);
                delete progress.pending;
                progress.next--;
                await checkpoint();
            };
            if (progress.pending)
                await applyPending();
            let templateBlocks;
            for (let i = progress.next; i >= 0; i--) {
                const rec = records[i];
                const current = await currentBytes(rec.path);
                const path = recordPathIdentity(rec.path);
                if (path === 'state/template.json')
                    templateBlocks = undefined;
                if (path.startsWith(TEMPLATE_DATA_PATH + '/') && !templateBlocks) {
                    // 手动维护可能发布新根并复用旧块；保留根时不能随后删掉它仍引用的内容。
                    const references = new Set();
                    await readTemplateDocument(bodyFs, 'state/template.json', references);
                    templateBlocks = new Set([...references].map(recordPathIdentity));
                }
                const target = templateBlocks?.has(path) ? { restore: false } : rollbackTarget(rec, current);
                if (!target.restore) {
                    progress.preserved.push(rec.path);
                    progress.next = i - 1;
                    await checkpoint();
                    continue;
                }
                progress.pending = { path: rec.path, from: current, to: target.value };
                await checkpoint();
                await applyPending();
            }
            const restored = progress.restored;
            const preserved = new Set(progress.preserved);
            if (records.some((record) => recordPathIdentity(record.path).startsWith('memory/') || recordPathIdentity(record.path) === 'state/world-delta.jsonl')) {
                await rebuildIndex(new WorkspaceFs(workspaceRoot, null), estimateTokens);
            }
            const meta = (await this.readMeta(dir)) ?? { floor, startedAt: new Date().toISOString(), committed: false };
            meta.rolledBackAt = nextWalIsoTime();
            meta.preservedPaths = [...preserved];
            await this.writeMeta(dir, meta);
            const archived = join(this.rootDir, `${dirName}${ROLLED_BACK_MARK}${timestamp()}`);
            await this.assertLogPath(dir);
            await this.assertLogPath(archived);
            await rename(dir, archived);
            // 只有整层改名归档后才注销恢复标记；中途失败保留标记，重试仍受同一屏障保护。
            await this.clearRecovering(floor, workspaceRoot);
            return restored;
        });
    }
    /** 整批先校验；不能在撤销较新楼层后才发现较旧日志损坏。 */
    async preflightRollback(floors, workspaceRoot) {
        const bodyFs = new WorkspaceFs(workspaceRoot, null);
        const logRelative = relative(workspaceRoot, this.rootDir);
        // 正常剧情日志在工作区内，要连同内部父路径一起检查；独立日志根仍遵守自己的显式边界。
        if (!isAbsolute(logRelative) && !logRelative.split(/[/\\]/).includes('..'))
            await bodyFs.assertSafePath(logRelative);
        await this.assertLogPath();
        const directories = await readdir(this.rootDir, { withFileTypes: true }).catch((error) => {
            if (error.code === 'ENOENT')
                return [];
            throw error;
        });
        // 后继依赖预检也会读未选中日志，所有可见楼层标记都必须在第一次日志读取前拒绝链接。
        for (const directory of directories) {
            if (!directory.isDirectory() && !directory.isSymbolicLink())
                continue;
            await this.assertLogPath(join(this.rootDir, directory.name));
            for (const marker of WAL_FLOOR_MARKERS)
                await this.assertLogPath(join(this.rootDir, directory.name, marker));
        }
        const lastStep = new Map(floors.map((floor, index) => [floor, index]));
        const changes = [];
        let expandsMemory = false;
        let rebuildsIndex = false;
        for (const floor of floors) {
            const dir = join(this.rootDir, sanitizeFloor(floor));
            // 净化目录名不是楼层身份：不同原始 id 可能共用同一目录名。
            // 必须在整批开始前核对元数据，不能撤销到另一个楼层或等较新楼层已恢复才发现冲突。
            const meta = await isDir(dir) && !(await isUnstartedDir(dir)) ? await this.readFloorMeta(dir, floor) : null;
            const records = await this.readRecords(dir);
            await this.readRollbackProgress(dir, records);
            const startedAt = meta ? Date.parse(meta.startedAt) : null;
            for (const rec of records) {
                await bodyFs.assertSafePath(rec.path);
                const path = recordPathIdentity(rec.path);
                expandsMemory ||= path.startsWith('memory/');
                rebuildsIndex ||= path.startsWith('memory/') || path === 'state/world-delta.jsonl';
                if (!isNoopRecord(rec))
                    changes.push({ rec, startedAt, step: lastStep.get(floor) });
            }
        }
        // 摘要展开与索引重建读写记录外的路径；整批准备时检查，不能等较新楼层已恢复才失败。
        if (rebuildsIndex) {
            await bodyFs.list('memory', { recursive: expandsMemory, rejectLinks: true });
            for (const path of ['state/world-delta.jsonl', 'journal.md', 'index.json'])
                await bodyFs.assertSafePath(path);
        }
        // 后继写入以被撤销记录的写后内容为写前快照；null 也代表删除后的状态，重建文件同样依赖它。
        // 只有已在目标楼层开始前完成的旧楼层才能排除。
        // 旧共享工作区的会话可能交错：较早开始的楼层仍会较晚写入，重新打开的完成楼层也会追加写入。
        // 不能单凭 startedAt 排除它们，否则之后撤销该楼层时会复活已经撤销的事实。
        // 已更早完成楼层的同值 before 不是依赖：轮到它时恢复的正是它自己的 before。
        // 每轮重写相同定时器、标志位来回切换的普通剧情都会让旧楼层出现同值 before，若不分先后，
        // 第三层起就再也无法只重生成最新楼层。
        for (const floor of await this.doListFloors()) {
            const otherStep = lastStep.get(floor.floor);
            if (floor.rolledBack)
                continue;
            const dir = join(this.rootDir, sanitizeFloor(floor.floor));
            const meta = await this.readMeta(dir);
            const completedAt = meta?.committed && meta.committedAt ? Date.parse(meta.committedAt) : NaN;
            const records = await this.readRecords(dir);
            for (const rec of records) {
                if (isNoopRecord(rec))
                    continue;
                if (changes.some(({ rec: change, startedAt, step }) => (otherStep === undefined || otherStep < step)
                    && (startedAt === null || !Number.isFinite(completedAt) || completedAt >= startedAt)
                    && recordPathIdentity(change.path) === recordPathIdentity(rec.path) && 'after' in change
                    && (recordPathIdentity(rec.path) === 'state/world-delta.jsonl'
                        ? deltaChangesDependOn(change, rec)
                        : snapshotBytes(rec, 'before') === snapshotBytes(change, 'after')))) {
                    throw new Error(`WAL 存在未撤销的后继依赖：${floor.floor}（${rec.path}）；请从最新楼层依次回退`);
                }
            }
        }
    }
    async doRollbackAfter(floors, workspaceRoot) {
        await this.preflightRollback(floors, workspaceRoot);
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
        // 崩溃可能落在「回滚已改名归档、标记还没注销」之间；列举是恢复流程的固定入口，顺手清掉失效标记，
        // 否则残留的标记会一直挡住后续写入与分支。
        if (await hasRecoveryMarker(this.hasCoverage ? this.logFs.root : this.rootDir))
            await this.reconcileRecoveryMarker();
        const entries = await readdir(this.rootDir, { withFileTypes: true });
        const floors = [];
        for (const entry of entries) {
            if (entry.isSymbolicLink())
                await this.assertLogPath(join(this.rootDir, entry.name));
            if (!entry.isDirectory())
                continue;
            const dir = join(this.rootDir, entry.name);
            await this.assertLogPath(dir);
            for (const marker of WAL_FLOOR_MARKERS)
                await this.assertLogPath(join(dir, marker));
            if (await isUnstartedDir(dir))
                continue;
            const meta = await this.readMeta(dir);
            if (!meta || sanitizeFloor(meta.floor) !== entry.name.split(ROLLED_BACK_MARK)[0])
                throw new Error(`WAL 元数据缺失或目录不匹配：${entry.name}`);
            floors.push({
                floor: meta.floor,
                committed: meta.committed,
                startedAt: meta.startedAt,
                rolledBack: entry.name.includes(ROLLED_BACK_MARK),
            });
        }
        floors.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        // 同一 id 重生成后仍可能有旧回滚副本；清单还须匹配开始时间，不能拿旧副本充当当前日志。
        const identity = (floor) => JSON.stringify([floor.floor, floor.startedAt]);
        const present = new Set(floors.map(identity));
        for (const floor of await this.readCoverage() ?? [])
            if (!present.has(identity(floor)))
                throw new Error(`WAL 楼层缺失：${floor.floor}；请恢复完整日志，不能继续回退或分支`);
        return floors;
    }
    async doPrune(options) {
        // 先从清单移除已完成回滚的楼层，再清理调试副本；中断也不会留下假缺失。
        if (this.hasCoverage)
            await this.writeCoverage(await this.doListFloors());
        const keepDays = options.keepRolledBackDays ?? 7;
        await mkdir(this.rootDir, { recursive: true });
        const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
        const entries = await readdir(this.rootDir, { withFileTypes: true });
        let removed = 0;
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.includes(ROLLED_BACK_MARK))
                continue;
            const dir = join(this.rootDir, entry.name);
            await this.assertLogPath(dir);
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
