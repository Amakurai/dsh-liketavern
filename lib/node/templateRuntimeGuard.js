/** 活动模板兼容预检：调用方持有剧情锁，检查最新持久状态与实际选用的缓存日志，不展开或执行检查点。 */
import { assertTemplateReplayFormatter } from '../core/templateReplay.js';
import { resolveTemplateContinuation } from '../state/templateContinuation.js';
import { assertTemplateCheckpointRuntime } from './templateRuntime.js';
/** 版本或安装边界失败必须保留原楼层，不能按普通模板脚本异常收口提交。 */
export class TemplateRuntimeCompatibilityError extends Error {
    constructor(cause) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.name = 'TemplateRuntimeCompatibilityError';
    }
}
export async function assertTemplateReplayRuntime(replay) {
    if (!replay)
        return;
    try {
        assertTemplateReplayFormatter(replay);
        await assertTemplateCheckpointRuntime(replay);
    }
    catch (error) {
        throw new TemplateRuntimeCompatibilityError(error);
    }
}
/** prepared 只约束其所属会话；跨轮 continuation 属于整个当前剧情。缓存不能遮蔽其中任一不兼容日志。 */
export async function assertActiveTemplateRuntime(stored, sessionId, selected) {
    const carried = resolveTemplateContinuation(stored)?.replay;
    const prepared = stored.generation?.status === 'prepared' && stored.generation.sessionId === sessionId ? stored.generation.replay : undefined;
    await assertTemplateReplayRuntime(carried);
    if (prepared !== carried)
        await assertTemplateReplayRuntime(prepared);
    if (selected !== carried && selected !== prepared)
        await assertTemplateReplayRuntime(selected);
}
