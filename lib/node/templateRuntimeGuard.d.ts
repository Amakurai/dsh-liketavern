/** 活动模板兼容预检：调用方持有剧情锁，检查最新持久状态与实际选用的缓存日志，不展开或执行检查点。 */
import { type TemplateReplay } from '../core/templateReplay.js';
import type { TemplateMetadata } from '../state/template.js';
/** 版本或安装边界失败必须保留原楼层，不能按普通模板脚本异常收口提交。 */
export declare class TemplateRuntimeCompatibilityError extends Error {
    constructor(cause: unknown);
}
export declare function assertTemplateReplayRuntime(replay: TemplateReplay | undefined): Promise<void>;
/** prepared 只约束其所属会话；跨轮 continuation 属于整个当前剧情。缓存不能遮蔽其中任一不兼容日志。 */
export declare function assertActiveTemplateRuntime(stored: TemplateMetadata, sessionId: string, selected?: TemplateReplay): Promise<void>;
