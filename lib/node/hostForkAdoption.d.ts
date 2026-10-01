import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { type SessionBinding } from './bindings.js';
import type { TavernPaths } from './paths.js';
export interface HostForkAdoptionPlan {
    version: 1;
    status: 'unverified' | 'checkpoint' | 'ready' | 'skipped';
    sessionId: string;
    parentId: Session['id'];
    inheritedCount: number;
    seedHash: string;
    sourceCheckpoint?: string | null;
    sourceUncertain?: boolean;
    binding?: SessionBinding;
    rollbackFromTurn?: number;
}
export declare const hostForkAdoptionFile: (sessionId: string) => string;
export declare function hostForkSeedHash(prefix: readonly SessionEvent[]): string;
/** 服务已在绑定锁内验证合法 current 后保存明确解除意图；未知接管失败不能调用此入口绕过屏障。 */
export declare function writeHostForkSkipped(paths: TavernPaths, child: Session): Promise<void>;
/** 记录按原始会话 ID 哈希定位；字段、来源绑定与种子指纹全部验证，不按宽松 null 处理损坏。 */
export declare function readHostForkAdoption(paths: TavernPaths, child: Session, prefix: readonly SessionEvent[]): Promise<HostForkAdoptionPlan | null>;
/** 来源卡与剧情目录都在 characters 锚点内预检，不能先经 cardRoot 链接准备副本再到发布时拒绝。 */
export declare function assertHostForkSource(paths: TavernPaths, binding: SessionBinding): Promise<void>;
/** 首次记录未验证身份；只有已保存检查点/来源的后续原子记录才允许冷恢复继续准备。 */
export declare function writeHostForkAdoption(paths: TavernPaths, plan: HostForkAdoptionPlan): Promise<void>;
export declare function deleteHostForkAdoption(paths: TavernPaths, sessionId: string): Promise<void>;
