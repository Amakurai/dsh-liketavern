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
        const before = await this.readText(relPath);
        if (this.wal && this.floor)
            await this.wal.record(this.floor, relPath, before);
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
    /** 事务删除（有当前楼层时同样记录快照）。 */
    async delete(relPath) {
        const before = await this.readText(relPath);
        if (before === null)
            return;
        if (this.wal && this.floor)
            await this.wal.record(this.floor, relPath, before);
        await rm(this.abs(relPath), { force: true });
    }
    /** 列出 prefix 子目录下的文件（相对路径，正斜杠，递归）。 */
    async list(prefix = '') {
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
                if (e.isDirectory())
                    await walk(join(dir, e.name), childRel);
                else
                    out.push(childRel);
            }
        };
        await walk(base, '');
        return out.sort();
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
