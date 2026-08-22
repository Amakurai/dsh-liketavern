/**
 * 世界状态变化层存储（WorldDeltaStore，plan 3.12.4）。
 * state/world-delta.jsonl，每行一个 WorldDelta JSON；文件小，整体读改写（经 WorkspaceFs 事务层）。
 * 「单条撤销」为行内 revoked 标记，不物理删除；toEngineEntries 把变化层归一化为世界书引擎的
 * 额外条目源（source='delta'），update/invalidate 紧随原条目之后并显式标注「当前状态」。
 *
 * 读改写经实例内 promise 队列串行化：同 turn 连续两次 worldstate_update、或工具写与
 * 设置面板写交错时，两个并发的「读全部行 → 全量重写」会互相覆盖丢行。
 * id 用毫秒时间戳 + 随机后缀而不按行数推导：WAL 回滚把 jsonl 恢复到更短状态后，
 * 行数推导会让新 append 复用旧 id，revoke 可能误撤。
 */
import type { WorldDelta, WorldInfoEntry } from '../core/types.js';
import type { WorkspaceFs } from './workspaceFs.js';
export declare class WorldDeltaStore {
    private readonly fs;
    /** 实例内 promise 队列：append/revoke 的读改写串行化，保证并发安全。 */
    private queue;
    constructor(fs: WorkspaceFs);
    private enqueue;
    /** 读出全部非空原始行（保留原文，重写时不丢无法解析的行）。 */
    private readRawLines;
    private static parseLine;
    /** 追加一条变化：id = `d-<36 进制毫秒>-<随机 6 hex>`（不依赖行数，回滚后不复用旧 id）；ts 默认当前 ISO。 */
    append(input: Omit<WorldDelta, 'id' | 'ts'> & {
        ts?: string;
    }): Promise<WorldDelta>;
    /** 列出变化；默认过滤 revoked 与 expires 已过期（expires ISO < now），坏行跳过。 */
    list(options?: {
        includeRevoked?: boolean;
        now?: Date;
    }): Promise<WorldDelta[]>;
    /** 单条撤销：重写该行为 revoked: true（不物理删除）；未找到返回 false。同样在互斥队列内。 */
    revoke(id: string): Promise<boolean>;
    /**
     * 变化层 → 世界书引擎条目（plan 3.12.4）：
     * ref 命中时 order = resolveRefOrder(ref) + 0.5（紧随原条目之后），否则用 delta.order；
     * update/invalidate 的 content 显式标注「当前状态」。空 keys 且 constant=false → 永不命中。
     */
    toEngineEntries(deltas: WorldDelta[], resolveRefOrder: (ref: string) => number | null): WorldInfoEntry[];
}
