/**
 * 工作区事务文件面（WorkspaceFs）。
 *
 * 插件对角色工作区的一切写入都必须经过本类。仅当实例携带会话楼层时才向 WAL
 * 记录快照，供 roll/回退逆序回放。导入角色卡、设置面板直接编辑等非会话期写入
 * floor 为 null：照常落盘、不记 WAL——这类写入不该随对话回滚。
 *
 * 楼层隔离模型（问题1修复）：每卡一个共享句柄（TavernState.workspace），其 floor
 * 恒为 null；会话楼层写入一律走 `withFloor(floor)` 派生的独立实例——同一张卡的
 * 并发会话各有各的楼层实例，互不覆盖，回滚边界按 `sessionId#tN` 各自回放。
 * host 在 turn/start 直接 `wal.beginFloor(floor)`，turn/end 按 openFloors 记录的
 * entry 提交，不再触碰共享句柄的 floor。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { atomicWrite } from './atomicWrite.js';
import { ledgerKey, noteWrite } from './writeLedger.js';
import { withWorkspaceLock } from './workspaceLock.js';
/** 历史占位：旧版曾把非会话写入记入名为 non-floor 的 WAL 单元。现已不再使用。 */
export const NON_FLOOR = 'non-floor';
/** 工作区级回滚恢复标记（相对工作区根）：存在期间任何正文写入都必须被拒绝。 */
export const WAL_RECOVERY_PATH = 'state/wal-recovery.json';
/** 恢复期间所有写入入口统一使用的中文拒绝原因（含「回滚恢复」，供上层提示与测试匹配）。 */
export const WORKSPACE_RECOVERING_MESSAGE = '剧情正在回滚恢复：请先重新执行回退完成恢复；反复失败时可在「记忆」面板选择该剧情并重置回滚游标。本次写入未执行';
/**
 * 回滚自身需要写正文（替换、摘要展开、索引重建）。内部恢复流程通过这个上下文放行，
 * 外部/面板/其它楼层的写入拿不到它，从而在恢复游标存在期间被写屏障挡住。
 */
const recoveryWriteAccess = new AsyncLocalStorage();
/** 仅限 Wal 回滚内部使用：本上下文内的 WorkspaceFs 写入跳过恢复写屏障。 */
export function withRecoveryWriteAccess(task) {
    return recoveryWriteAccess.run(true, task);
}
async function existsFile(path) {
    try {
        await lstat(path);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
/** 工作区根是否存在回滚恢复标记；读取路径不受屏障影响，恢复流程仍可读盘。 */
export async function hasRecoveryMarker(root) {
    return existsFile(join(root, WAL_RECOVERY_PATH));
}
/**
 * 标记是否仍代表进行中的恢复：标记登记的任一楼层目录里还留着恢复游标即为活跃。
 * 崩溃落在「回滚已归档、标记未注销」之间时游标随目录改名消失，此时标记失效、不再阻断写入
 * （Wal 的下一次操作会顺手删除它）。标记无法解析或是链接时保守视为活跃。
 */
async function recoveryMarkerActive(root) {
    const marker = join(root, WAL_RECOVERY_PATH);
    let raw;
    try {
        if ((await lstat(marker)).isSymbolicLink())
            return true;
        raw = await readFile(marker, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return true;
    }
    if (typeof value !== 'object' || value === null || !Array.isArray(value.dirs))
        return true;
    const { dirs, walDir } = value;
    const walDirs = [join(root, 'state', 'wal'), ...(typeof walDir === 'string' ? [walDir] : [])];
    for (const dir of dirs) {
        if (typeof dir !== 'string' || !dir || dir.includes('/') || dir.includes('\\') || dir === '.' || dir === '..')
            return true;
        for (const base of walDirs) {
            if (await existsFile(join(base, dir, 'rollback-progress.json')))
                return true;
        }
    }
    return false;
}
/** 严格 UTF-8 解码器：非法字节序列抛错；ignoreBOM 保留开头的 BOM 字符，确保快照可还原原始字节。 */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** 工作区读写拒绝磁盘链接，避免安全的相对路径实际指向 WAL、兄弟剧情或工作区外。 */
export class WorkspaceLinkError extends Error {
}
/** 批量读取遇到超过调用方上限的文件：不把内容读进内存，由调用方给出业务含义。 */
export class WorkspaceSizeError extends Error {
}
/** 批量文件操作的并发数：小文件的打开与刷盘可以重叠，又不至于占满宿主的文件线程池。 */
const BATCH_CONCURRENCY = 8;
/** 按入参顺序并发执行；全部结束后报告顺序最靠前的错误，结果不取决于哪个调用先返回。 */
async function mapBounded(items, task) {
    const results = new Array(items.length);
    const errors = [];
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            try {
                results[index] = await task(items[index], index);
            }
            catch (error) {
                errors.push({ index, error });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, items.length) }, worker));
    if (errors.length)
        throw errors.sort((a, b) => a.index - b.index)[0].error;
    return results;
}
/**
 * 字节 → WAL 快照：文本按 UTF-8 保存，二进制按 base64 保存并显式记录编码。
 */
function snapshotOf(bytes) {
    try {
        return { value: STRICT_UTF8.decode(bytes), encoding: 'utf8' };
    }
    catch {
        return { value: Buffer.from(bytes).toString('base64'), encoding: 'base64' };
    }
}
export class WorkspaceFs {
    root;
    wal;
    /** 本实例的楼层；null 表示非会话期写入（不走 WAL）。构造后只能经 withFloor 派生改出。 */
    floor = null;
    constructor(root, wal) {
        this.root = root;
        this.wal = wal;
        this.root = resolve(root);
    }
    /**
     * 遗留兼容：直接改本实例的 floor。host 路径已改用 withFloor 派生实例 +
     * wal.beginFloor/commitFloor（见文件头「楼层隔离模型」）；保留仅为既有测试与
     * 旧调用点不 break，新代码不要再用——共享句柄上的可变 floor 会让同卡并发会话
     * 互相覆盖楼层上下文。
     */
    setFloor(floor) {
        this.floor = floor;
    }
    get currentFloor() {
        return this.floor;
    }
    /**
     * 派生一个共享 root 与 wal、floor 独立的新实例。会话楼层（含读路径口径统一）
     * 用它在楼层内读写：快照记进本实例的 floor，不影响共享句柄与其它会话的实例。
     */
    withFloor(floor) {
        const scoped = new WorkspaceFs(this.root, this.wal);
        scoped.floor = floor;
        return scoped;
    }
    /** 已持有工作区锁时推算本层回滚后的文本；只读且不推进恢复游标，供依赖正文的安全清理使用。 */
    async rollbackSnapshot(relPath, current) {
        if (!this.wal || this.floor === null)
            return current;
        const restored = await this.wal.rollbackSnapshot(this.floor, this.walPath(relPath), current === null ? null : Buffer.from(current));
        return restored === null ? null : STRICT_UTF8.decode(restored);
    }
    abs(relPath) {
        // 段级消毒：任何 '..' 段一律拒绝。只看根目录前缀挡不住
        // 'personas/../regex/rules.json' 这类「不出根但跨子树」的越权——人设/世界书/预设 id
        // 经 RPC 直达存储层时可能带 '..'，把包容性做成 fs 的性质，而不是指望每个调用方各自消毒。
        if (relPath.split(/[/\\]/).some((seg) => seg === '..')) {
            throw new Error(`工作区路径越界: ${relPath}`);
        }
        const abs = normalize(join(this.root, relPath));
        if (abs !== this.root && !abs.startsWith(this.root + sep)) {
            throw new Error(`工作区路径越界: ${relPath}`);
        }
        return abs;
    }
    /**
     * WAL 记录用的规范相对路径：正斜杠、去掉 `.` 与空段。读路径可以宽松（normalize 会折叠它们），
     * 但记进日志的路径必须是 Wal.readRecords 日后接受的形状——一条 `memory/./x.md` 会让整层
     * 日志被判定损坏，进而阻断该剧情之后所有回退与分支。盘符与 WAL 自身目录同样拒绝。
     */
    walPath(relPath) {
        const parts = relPath.replace(/\\/g, '/').split('/').filter((seg) => seg !== '' && seg !== '.');
        const path = parts.join('/');
        if (!path || path.includes(':') || parts.includes('..') || path.toLowerCase().startsWith('state/wal/')) {
            throw new Error(`工作区路径无法记录快照: ${relPath}`);
        }
        return path;
    }
    async assertNoLinks(abs) {
        let current = this.root;
        for (const segment of ['', ...relative(this.root, abs).split(sep).filter(Boolean)]) {
            if (segment)
                current = join(current, segment);
            try {
                if ((await lstat(current)).isSymbolicLink())
                    throw new WorkspaceLinkError(`工作区资产路径不能经过链接: ${abs}`);
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    return;
                throw error;
            }
        }
    }
    /**
     * 所有直接操作默认拒绝根与内部父路径上的链接。根的祖先可以是宿主安装挂载，
     * 但一旦进入指定工作区，链接不得改写剧情边界；WAL 整批预检也复用此只读检查。
     */
    async assertSafePath(relPath) {
        await this.assertNoLinks(this.abs(relPath));
    }
    /**
     * 回滚恢复写屏障：本工作区存在恢复标记（或有旧版遗留游标）时，任何写/删都必须明确失败。
     * Wal 回滚自身的正文替换、摘要展开与索引重建经 withRecoveryWriteAccess 放行。
     */
    async assertWritable() {
        if (recoveryWriteAccess.getStore())
            return;
        if (await recoveryMarkerActive(this.root))
            throw new Error(WORKSPACE_RECOVERING_MESSAGE);
    }
    async readText(relPath, _options) {
        try {
            const abs = this.abs(relPath);
            // rejectLinks 参数保留兼容；直接读取始终检查，普通记忆检索也不能绕过目录链接。
            await this.assertNoLinks(abs);
            return await readFile(abs, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        }
    }
    /** 判断路径是否存在（文件或目录）。 */
    async exists(relPath) {
        try {
            const abs = this.abs(relPath);
            await this.assertNoLinks(abs);
            await stat(abs);
            return true;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return false;
            throw error;
        }
    }
    /**
     * 单文件元信息（mtimeMs/size）；不存在返回 null。
     * 用途是廉价的「内容是否变过」指纹：一次 stat 不读数据，远便宜于全文读 + 解析，
     * 且能捕获绕开本类的落盘（WAL 回滚会直接写回文件），比进程内修订号更可靠。
     */
    async stat(relPath) {
        try {
            const abs = this.abs(relPath);
            await this.assertNoLinks(abs);
            const info = await stat(abs);
            return { mtimeMs: info.mtimeMs, size: info.size };
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        }
    }
    /**
     * 批量取文件元信息，顺序与入参一致，不存在的为 null。
     * 结果与逐个 stat 相同，但系统调用少得多：同一父目录到根的链接检查只做一次，
     * 文件本身用一次 lstat 同时判断链接和取 mtime/size（不是链接时 lstat 与 stat 结果一致）。
     * 记忆检索每次都要核对上千个归档来源的指纹，逐个 stat 是每个文件 5 次调用。
     */
    async statMany(relPaths) {
        const targets = relPaths.map((relPath) => this.abs(relPath));
        const parents = new Set(targets.map((abs) => (abs === this.root ? abs : dirname(abs))));
        for (const parent of parents)
            await this.assertNoLinks(parent);
        // 多个文件同时出错时报告顺序最靠前的那个，不取决于哪个调用先返回。
        const settled = await Promise.allSettled(targets.map((abs) => this.lstatFile(abs)));
        return settled.map((result) => {
            if (result.status === 'rejected')
                throw result.reason;
            return result.value;
        });
    }
    /** 多个目录到根的链接检查：公共祖先只查一次。 */
    async assertNoLinksAmong(dirs) {
        const cleared = new Set();
        for (const dir of dirs) {
            let current = this.root;
            for (const segment of ['', ...relative(this.root, dir).split(sep).filter(Boolean)]) {
                if (segment)
                    current = join(current, segment);
                if (cleared.has(current))
                    continue;
                try {
                    if ((await lstat(current)).isSymbolicLink())
                        throw new WorkspaceLinkError(`工作区资产路径不能经过链接: ${dir}`);
                }
                catch (error) {
                    if (error.code === 'ENOENT')
                        break;
                    throw error;
                }
                cleared.add(current);
            }
        }
    }
    /**
     * 批量读取文本，顺序与入参一致，不存在的为 null。与逐个 readText 结果相同，系统调用少得多：
     * 父目录到根的链接检查每个目录只做一次，文件本身用一次 lstat 拒绝链接并核对体积。
     * 分块保存的状态一次要读上千个小文件，逐个读取是每个文件十余次调用。
     */
    async readTextMany(relPaths, maxBytes = Number.POSITIVE_INFINITY) {
        const targets = relPaths.map((relPath) => this.abs(relPath));
        await this.assertNoLinksAmong(new Set(targets.map((abs) => (abs === this.root ? abs : dirname(abs)))));
        return mapBounded(targets, async (abs, index) => {
            const info = await this.lstatFile(abs);
            if (info === null)
                return null;
            if (info.size > maxBytes)
                throw new WorkspaceSizeError(`工作区文件超过读取上限: ${relPaths[index]}`);
            try {
                return await readFile(abs, 'utf8');
            }
            catch (error) {
                // 检查与读取之间被并发删除：按不存在处理，与 readText 的容错口径一致。
                if (error.code === 'ENOENT')
                    return null;
                throw error;
            }
        });
    }
    /**
     * 批量事务写入：全部前后镜像一次写进 WAL，再替换各文件正文；与逐个 writeText 的落盘结果相同。
     * 逐条记录每次都要重读并重写整份楼层日志，一次保存产生上百个新文件时代价随记录数平方增长。
     * 日志仍先于任何正文持久化；中途失败留下的记录在回滚时按「正文与写后镜像不符」保留现状。
     */
    async writeTextMany(entries) {
        if (!entries.length)
            return;
        await withWorkspaceLock(this.root, async () => {
            await this.assertWritable();
            const targets = entries.map(([relPath, content]) => ({ relPath, abs: this.abs(relPath), content }));
            if (new Set(targets.map((target) => ledgerKey(target.relPath))).size !== targets.length)
                throw new Error('批量写入包含重复路径');
            await this.assertNoLinksAmong(new Set(targets.map((target) => dirname(target.abs))));
            const logged = Boolean(this.wal && this.floor);
            // 目标自身也不能是链接；写前镜像与单条写入同一口径（文本原样，二进制 base64）。
            const before = await mapBounded(targets, async (target) => {
                if ((await this.lstatFile(target.abs)) === null || !logged)
                    return null;
                try {
                    return snapshotOf(await readFile(target.abs));
                }
                catch (error) {
                    if (error.code === 'ENOENT')
                        return null;
                    throw error;
                }
            });
            if (this.wal && this.floor) {
                await this.wal.recordChanges(this.floor, targets.map((target, index) => ({ path: this.walPath(target.relPath),
                    before: before[index]?.value ?? null, after: target.content, beforeEncoding: before[index]?.encoding ?? 'utf8', afterEncoding: 'utf8' })));
            }
            await mapBounded(targets, async (target) => {
                // 无论替换是否成功都登记：多登记只会让读的一方多读一次，漏登记才会留下旧缓存。
                try {
                    await atomicWrite(target.abs, target.content);
                }
                finally {
                    noteWrite(this.root, target.relPath);
                }
            });
        });
    }
    /**
     * 从另一个工作区按相同相对路径批量复制普通文件，来源不存在的跳过；来源是链接或目录时以 reject 给出的错误拒绝。
     * 每个文件仍然原子替换并刷盘，只是并发进行：剧情快照要复制上千个小文件，逐个写入的耗时取决于刷盘次数。
     * 不记 WAL，只用于尚未发布的草稿工作区。
     */
    async copyFrom(source, relPaths, reject) {
        if (this.wal && this.floor)
            throw new Error('批量复制不记录楼层快照，不能用于楼层写入');
        await withWorkspaceLock(this.root, async () => {
            await this.assertWritable();
            const targets = relPaths.map((relPath) => ({ relPath, from: source.abs(relPath), to: this.abs(relPath) }));
            await source.assertNoLinksAmong(new Set(targets.map((target) => dirname(target.from))));
            await this.assertNoLinksAmong(new Set(targets.map((target) => dirname(target.to))));
            await mapBounded(targets, async (target) => {
                const info = await lstat(target.from).catch((error) => {
                    if (error.code === 'ENOENT')
                        return null;
                    throw error;
                });
                if (!info)
                    return;
                if (!info.isFile() || info.isSymbolicLink())
                    throw reject(target.relPath);
                await this.lstatFile(target.to);
                const bytes = await readFile(target.from);
                try {
                    await atomicWrite(target.to, bytes);
                }
                finally {
                    noteWrite(this.root, target.relPath);
                }
            });
        });
    }
    /** 父路径已确认不经过链接时，对文件本身的一次检查：是链接就拒绝，不存在返回 null。 */
    async lstatFile(abs) {
        try {
            const info = await lstat(abs);
            if (info.isSymbolicLink())
                throw new WorkspaceLinkError(`工作区资产路径不能经过链接: ${abs}`);
            return { mtimeMs: info.mtimeMs, size: info.size };
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        }
    }
    /** 确保目录存在（递归创建）。目录创建幂等且无内容副作用，不纳入 WAL。 */
    async ensureDir(relPath = '') {
        const abs = this.abs(relPath);
        await this.assertNoLinks(abs);
        await mkdir(abs, { recursive: true });
    }
    /** 读取二进制内容；不存在返回 null。 */
    async readBytes(relPath) {
        try {
            const abs = this.abs(relPath);
            await this.assertNoLinks(abs);
            return await readFile(abs);
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        }
    }
    /** 事务写入：每次修改先持久化 before/after，再原子替换正文；与回退共享工作区锁。 */
    async writeText(relPath, content) {
        await withWorkspaceLock(this.root, async () => {
            await this.assertWritable();
            const abs = this.abs(relPath);
            await this.assertNoLinks(abs);
            if (this.wal && this.floor) {
                const path = this.walPath(relPath);
                const bytes = await this.readBytes(relPath);
                const before = bytes === null ? null : snapshotOf(bytes);
                await this.wal.recordChange(this.floor, path, before?.value ?? null, content, before?.encoding ?? 'utf8', 'utf8');
            }
            // 无论替换是否成功都登记：多登记只会让读的一方多读一次，漏登记才会留下旧缓存。
            try {
                await atomicWrite(abs, content);
            }
            finally {
                noteWrite(this.root, relPath);
            }
        });
    }
    /**
     * 事务写入二进制（如 card.png 头像）：语义同 writeText，
     * 已存在文件的 before 快照以 base64 + 显式编码记录，回滚时对称解码。
     */
    async writeBytes(relPath, bytes) {
        await withWorkspaceLock(this.root, async () => {
            await this.assertWritable();
            const abs = this.abs(relPath);
            await this.assertNoLinks(abs);
            if (this.wal && this.floor) {
                const path = this.walPath(relPath);
                const before = await this.readBytes(relPath);
                await this.wal.recordChange(this.floor, path, before === null ? null : Buffer.from(before).toString('base64'), Buffer.from(bytes).toString('base64'), 'base64', 'base64');
            }
            try {
                await atomicWrite(abs, bytes);
            }
            finally {
                noteWrite(this.root, relPath);
            }
        });
    }
    /**
     * 事务删除（有当前楼层时同样记录快照）。
     * 快照口径必须与 writeBytes 对称：二进制内容（严格 UTF-8 解码失败）记 base64 + 编码字段，
     * 否则回滚写回的是有损转码后的字节。无楼层时只需判存在性，不读全文。
     */
    async delete(relPath) {
        await withWorkspaceLock(this.root, async () => {
            await this.assertWritable();
            const abs = this.abs(relPath);
            await this.assertNoLinks(abs);
            if (this.wal && this.floor) {
                const path = this.walPath(relPath);
                const bytes = await this.readBytes(relPath);
                if (bytes === null)
                    return;
                const before = snapshotOf(bytes);
                await this.wal.recordChange(this.floor, path, before.value, null, before.encoding ?? 'utf8', 'utf8');
            }
            try {
                await rm(abs, { force: true });
            }
            finally {
                noteWrite(this.root, relPath);
            }
        });
    }
    /**
     * 列出 prefix 子目录下的文件（相对路径，正斜杠）。
     * 默认递归；`recursive: false` 只列本层文件（跳过子目录，不进去走）——
     * 记忆库那样「本层是热路径、子目录（archive/）只增不查」的场景必须用非递归，
     * 否则每次检索都要把归档整棵走完再丢掉，成本随归档量单调增长。
     * `skipDir` 在递归遍历遇到目录时回调（相对路径，正斜杠），返回 true 则整棵跳过——
     * state/wal、memory/archive 这类只增不查的目录应在遍历时直接排除，
     * 而不是全棵走完再由调用方过滤。
     */
    async list(prefix = '', options) {
        const recursive = options?.recursive !== false;
        const skipDir = options?.skipDir;
        const base = this.abs(prefix);
        // 遍历途中默认跳过链接资产；prefix 本身却不得是链接，否则会跨界列举整棵剧情。
        await this.assertNoLinks(base);
        const out = [];
        const walk = async (dir, rel) => {
            let entries;
            try {
                entries = await readdir(dir, { withFileTypes: true });
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    return;
                throw error;
            }
            for (const e of entries) {
                const childRel = rel ? `${rel}/${e.name}` : e.name;
                if (e.isSymbolicLink()) {
                    if (options?.rejectLinks)
                        throw new WorkspaceLinkError(`工作区目录不能包含链接: ${prefix ? `${prefix}/${childRel}` : childRel}`);
                    continue;
                }
                if (e.isDirectory()) {
                    if (recursive && !skipDir?.(childRel))
                        await walk(join(dir, e.name), childRel);
                }
                else if (e.isFile())
                    out.push(childRel);
            }
        };
        await walk(base, '');
        return out.sort();
    }
    /**
     * 列出 prefix 本层文件及其 mtime/size（非递归）。
     * 用途是廉价的「内容是否变过」指纹：N 次 stat 不读数据，远便宜于 N 次全文读 + 解析，
     * 且能捕获绕开本类的落盘（WAL 回滚会直接写回文件），故比进程内修订号更可靠。
     */
    async listStats(prefix = '') {
        // list 已确认 prefix 到根不经过链接，并跳过了本层的链接条目；这里每个文件只需一次 lstat。
        const names = await this.list(prefix, { recursive: false });
        const base = prefix ? `${prefix}/` : '';
        const stats = await Promise.all(names.map(async (name) => {
            // list 与 lstat 之间文件被并发删掉：按不存在处理（与 readText 返回 null 的容错口径一致）；
            // 期间被换成链接则照旧拒绝。
            const info = await this.lstatFile(this.abs(`${base}${name}`));
            return info && { name, ...info };
        }));
        return stats.filter((s) => s !== null);
    }
    /**
     * 遗留兼容：开始一个楼层事务并把本实例的 floor 指过去（WAL 存在时）。
     * host 路径已改为 `wal.beginFloor(floor)` + `withFloor(floor)` 派生实例；保留仅为既有测试。
     */
    async beginFloor(floor) {
        if (this.wal)
            await this.wal.beginFloor(floor);
        this.setFloor(floor);
    }
    /** 遗留兼容：提交本实例当前楼层并清除楼层上下文。host 路径已改为 `wal.commitFloor(floor)`。 */
    async commitFloor() {
        const floor = this.floor;
        if (this.wal && floor && floor !== NON_FLOOR)
            await this.wal.commitFloor(floor);
        this.setFloor(null);
    }
}
