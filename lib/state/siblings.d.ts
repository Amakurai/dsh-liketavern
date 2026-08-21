import { type SiblingFork } from '../core/siblings.js';
export declare function siblingsFile(rootDir: string): string;
/** 读取索引；文件缺失或损坏视为空索引。 */
export declare function loadSiblingForks(rootDir: string): Promise<SiblingFork[]>;
export declare function saveSiblingForks(rootDir: string, forks: readonly SiblingFork[]): Promise<void>;
/** 读-改-写追加一条 fork 记录（recordSiblingFork 幂等）。 */
export declare function appendSiblingFork(rootDir: string, entry: SiblingFork): Promise<void>;
