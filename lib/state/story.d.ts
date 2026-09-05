import { WorkspaceFs } from './workspaceFs.js';
export interface StorySummary {
    id: string;
    sessionId: string;
    createdAt: string;
    migrated: boolean;
}
export declare function newStoryId(): string;
export declare function legacyStoryId(sessionId: string): string;
export declare function storyRoot(cardRoot: string, id: string): string;
/** 剧情的可变路径；其它资产由角色工作区提供。 */
export declare function isStoryPath(path: string): boolean;
export declare function readStory(cardRoot: string, id: string): Promise<StorySummary>;
export declare function listStories(cardRoot: string): Promise<StorySummary[]>;
/** 只复制剧情状态，不复制卡片、图片或其它剧情。锁住来源，保证多文件快照一致。 */
export declare function snapshotStory(options: {
    cardRoot: string;
    sourceRoot: string;
    id: string;
    sessionId: string;
    migrated?: boolean;
    includeWal?: boolean;
    prepare?: (fs: WorkspaceFs) => Promise<void>;
}): Promise<void>;
/** 仅供创建分支失败时清理刚创建、尚未绑定的副本，调用方负责复核绑定。 */
export declare function discardStory(cardRoot: string, id: string, sessionId: string): Promise<void>;
