/**
 * 工作区事务文件面（WorkspaceFs）。
 *
 * 插件对角色工作区的一切写入都必须经过本类。仅当当前有会话楼层
 * （turn/start 已 beginFloor）时才向 WAL 记录快照，供 roll/回退逆序回放。
 * 导入角色卡、设置面板直接编辑等非会话期写入 floor 为 null：照常落盘、
 * 不记 WAL——否则会因「non-floor 未 begin」抛错，且这类写入也不该随对话回滚。
 */
import { Buffer } from 'node:buffer';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import { WAL_BINARY_MARK } from './wal.js';
/** 历史占位：旧版曾把非会话写入记入名为 non-floor 的 WAL 单元。现已不再使用。 */
export const NON_FLOOR = 'non-floor';
/** 严格 UTF-8 解码器：非法字节序列抛错，用于区分文本与二进制快照口径。 */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });
/**
 * 字节 → WAL 快照文本：能严格按 UTF-8 解码的记原文，否则记 base64 + WAL_BINARY_MARK
 * （与 writeBytes 的记录口径一致，rollback 侧对称解码）。
 */
function snapshotOf(bytes) {
    try {
        return STRICT_UTF8.decode(bytes);
    }
    catch {
        return WAL_BINARY_MARK + Buffer.from(bytes).toString('base64');
    }
}
export class WorkspaceFs {
    root;
    wal;
    /** 当前楼层；null 表示非会话期写入（不走 WAL）。 */
    floor = null;
    constructor(root, wal) {
        this.root = root;
        this.wal = wal;
    }
    setFloor(floor) {
        this.floor = floor;
    }
    get currentFloor() {
        return this.floor;
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
    async readText(relPath) {
        try {
            return await readFile(this.abs(relPath), 'utf8');
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
            await stat(this.abs(relPath));
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
            const info = await stat(this.abs(relPath));
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
        await mkdir(this.abs(relPath), { recursive: true });
    }
    /** 读取二进制内容；不存在返回 null。 */
    async readBytes(relPath) {
        try {
            return await readFile(this.abs(relPath));
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return null;
            throw error;
        }
    }
    /** 事务写入：有当前楼层时先向 WAL 记录 before 快照（同路径只记首次），再落盘。 */
    async writeText(relPath, content) {
        const abs = this.abs(relPath);
        // before 快照只在有楼层时用得上。非会话写入（面板编辑、索引重建、导入）floor 恒为 null，
        // 无条件预读会让每次写入都白读一遍全文——读必须留在 if 内。
        if (this.wal && this.floor) {
            await this.wal.record(this.floor, relPath, await this.readText(relPath));
        }
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf8');
    }
    /**
     * 事务写入二进制（如 card.png 头像）：语义同 writeText，
     * 已存在文件的 before 快照以 base64（带 WAL_BINARY_MARK 前缀）记录，回滚时对称解码。
     */
    async writeBytes(relPath, bytes) {
        const abs = this.abs(relPath);
        if (this.wal && this.floor) {
            const before = await this.readBytes(relPath);
            await this.wal.record(this.floor, relPath, before === null ? null : WAL_BINARY_MARK + Buffer.from(before).toString('base64'));
        }
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, bytes);
    }
    /**
     * 事务删除（有当前楼层时同样记录快照）。
     * 快照口径必须与 writeBytes 对称：二进制内容（严格 UTF-8 解码失败）记 base64 + WAL_BINARY_MARK，
     * 否则回滚写回的是有损转码后的字节。无楼层时只需判存在性，不读全文。
     */
    async delete(relPath) {
        if (!(this.wal && this.floor)) {
            if (!(await this.exists(relPath)))
                return;
            await rm(this.abs(relPath), { force: true });
            return;
        }
        const bytes = await this.readBytes(relPath);
        if (bytes === null)
            return;
        await this.wal.record(this.floor, relPath, snapshotOf(bytes));
        await rm(this.abs(relPath), { force: true });
    }
    /**
     * 列出 prefix 子目录下的文件（相对路径，正斜杠）。
     * 默认递归；`recursive: false` 只列本层文件（跳过子目录，不进去走）——
     * 记忆库那样「本层是热路径、子目录（archive/）只增不查」的场景必须用非递归，
     * 否则每次检索都要把归档整棵走完再丢掉，成本随归档量单调增长。
     */
    async list(prefix = '', options) {
        const recursive = options?.recursive !== false;
        const base = this.abs(prefix);
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
                if (e.isDirectory()) {
                    if (recursive)
                        await walk(join(dir, e.name), childRel);
                }
                else
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
        const names = await this.list(prefix, { recursive: false });
        const base = prefix ? `${prefix}/` : '';
        const stats = await Promise.all(names.map(async (name) => {
            try {
                const info = await stat(this.abs(`${base}${name}`));
                return { name, mtimeMs: info.mtimeMs, size: info.size };
            }
            catch (error) {
                // list 与 stat 之间文件被并发删掉：按不存在处理（与 readText 返回 null 的容错口径一致）。
                if (error.code === 'ENOENT')
                    return null;
                throw error;
            }
        }));
        return stats.filter((s) => s !== null);
    }
    /** 开始一个楼层事务（WAL 存在时）。 */
    async beginFloor(floor) {
        if (this.wal)
            await this.wal.beginFloor(floor);
        this.setFloor(floor);
    }
    /** 提交当前楼层并清除楼层上下文。 */
    async commitFloor() {
        const floor = this.floor;
        if (this.wal && floor && floor !== NON_FLOOR)
            await this.wal.commitFloor(floor);
        this.setFloor(null);
    }
}
