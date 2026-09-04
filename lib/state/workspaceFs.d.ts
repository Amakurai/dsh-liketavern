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
    /**
     * 单文件元信息（mtimeMs/size）；不存在返回 null。
     * 用途是廉价的「内容是否变过」指纹：一次 stat 不读数据，远便宜于全文读 + 解析，
     * 且能捕获绕开本类的落盘（WAL 回滚会直接写回文件），比进程内修订号更可靠。
     */
    stat(relPath: string): Promise<{
        mtimeMs: number;
        size: number;
    } | null>;
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
    /**
     * 事务删除（有当前楼层时同样记录快照）。
     * 快照口径必须与 writeBytes 对称：二进制内容（严格 UTF-8 解码失败）记 base64 + WAL_BINARY_MARK，
     * 否则回滚写回的是有损转码后的字节。无楼层时只需判存在性，不读全文。
     */
    delete(relPath: string): Promise<void>;
    /**
     * 列出 prefix 子目录下的文件（相对路径，正斜杠）。
     * 默认递归；`recursive: false` 只列本层文件（跳过子目录，不进去走）——
     * 记忆库那样「本层是热路径、子目录（archive/）只增不查」的场景必须用非递归，
     * 否则每次检索都要把归档整棵走完再丢掉，成本随归档量单调增长。
     */
    list(prefix?: string, options?: {
        recursive?: boolean;
    }): Promise<string[]>;
    /**
     * 列出 prefix 本层文件及其 mtime/size（非递归）。
     * 用途是廉价的「内容是否变过」指纹：N 次 stat 不读数据，远便宜于 N 次全文读 + 解析，
     * 且能捕获绕开本类的落盘（WAL 回滚会直接写回文件），故比进程内修订号更可靠。
     */
    listStats(prefix?: string): Promise<Array<{
        name: string;
        mtimeMs: number;
        size: number;
    }>>;
    /** 开始一个楼层事务（WAL 存在时）。 */
    beginFloor(floor: string): Promise<void>;
    /** 提交当前楼层并清除楼层上下文。 */
    commitFloor(): Promise<void>;
}
