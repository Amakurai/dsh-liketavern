import { type SiblingFork } from '../core/siblings.js';
export declare function siblingsFile(rootDir: string): string;
/** 读取索引；文件缺失或损坏视为空索引。 */
export declare function loadSiblingForks(rootDir: string): Promise<SiblingFork[]>;
/** 原子替换：崩溃不会留下截断的索引文件（截断后读成空索引，再一次登记就把全部导航记录永久抹掉）。 */
export declare function saveSiblingForks(rootDir: string, forks: readonly SiblingFork[]): Promise<void>;
/**
 * 互斥内的读-改-写：fn 拿到磁盘现状，返回新值（等于原值则不落盘）。
 * fn 自身不要再调 mutateSiblingForks（会死锁——互斥不可重入）。
 */
export declare function mutateSiblingForks(rootDir: string, fn: (forks: SiblingFork[]) => Promise<SiblingFork[]> | SiblingFork[]): Promise<void>;
/** 读-改-写追加一条 fork 记录（recordSiblingFork 幂等）。 */
export declare function appendSiblingFork(rootDir: string, entry: SiblingFork): Promise<void>;
