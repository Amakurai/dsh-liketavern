import { Wal } from './wal.js';
/** 历史占位：旧版曾把非会话写入记入名为 non-floor 的 WAL 单元。现已不再使用。 */
export declare const NON_FLOOR = "non-floor";
export declare class WorkspaceFs {
    readonly root: string;
    private readonly wal;
    /** 当前楼层；null 表示非会话期写入（不走 WAL）。 */
    private floor;
    constructor(root: string, wal: Wal | null);
    setFloor(floor: string | null): void;
    get currentFloor(): string | null;
    private abs;
    readText(relPath: string): Promise<string | null>;
    /** 判断路径是否存在（文件或目录）。 */
    exists(relPath: string): Promise<boolean>;
    /** 确保目录存在（递归创建）。目录创建幂等且无内容副作用，不纳入 WAL。 */
    ensureDir(relPath?: string): Promise<void>;
    /** 读取二进制内容；不存在返回 null。 */
    readBytes(relPath: string): Promise<Uint8Array | null>;
    /** 事务写入：有当前楼层时先向 WAL 记录 before 快照（同路径只记首次），再落盘。 */
    writeText(relPath: string, content: string): Promise<void>;
    /**
     * 事务写入二进制（如 card.png 头像）：语义同 writeText，
     * 已存在文件的 before 快照以 base64（带 WAL_BINARY_MARK 前缀）记录，回滚时对称解码。
     */
    writeBytes(relPath: string, bytes: Uint8Array): Promise<void>;
    /** 事务删除（有当前楼层时同样记录快照）。 */
    delete(relPath: string): Promise<void>;
    /** 列出 prefix 子目录下的文件（相对路径，正斜杠，递归）。 */
    list(prefix?: string): Promise<string[]>;
    /** 开始一个楼层事务（WAL 存在时）。 */
    beginFloor(floor: string): Promise<void>;
    /** 提交当前楼层并清除楼层上下文。 */
    commitFloor(): Promise<void>;
}
