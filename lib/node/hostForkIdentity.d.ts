import { type Session } from '@deepseek-ai/dsh-session';
import type { TavernPaths } from './paths.js';
/** 读取来源时只需要会话头与不可变的继承前缀，持久化快照也可提供相同视图。 */
export type HostForkIdentitySource = Pick<Session, 'id' | 'header' | 'snapshotEvents'> & {
    inheritedEventCount: number;
};
/** 写入须在宿主持久化子会话之前完成；同一 ID 重试只能复用完全相同的来源和前缀。 */
export declare function writeHostForkIdentity(paths: TavernPaths, sessionId: string, parentId: string, prefix: readonly unknown[]): Promise<void>;
/** 冷恢复只接受会话 ID、继承长度和前缀摘要均一致的持久凭据。 */
export declare function readHostForkIdentity(paths: TavernPaths, child: HostForkIdentitySource): Promise<{
    parentId: Session['id'] | null;
    skipped: boolean;
} | null>;
/** 合法绑定经用户明确解除时，即使迁入的旧分支没有来源凭据，也持久保存不再接管的决定。 */
export declare function skipHostForkIdentity(paths: TavernPaths, child: Session): Promise<Session['id'] | null>;
/** 仅在宿主确认会话已删除后清理；普通卸载或重启须保留凭据。 */
export declare function deleteHostForkIdentity(paths: TavernPaths, sessionId: string): Promise<void>;
