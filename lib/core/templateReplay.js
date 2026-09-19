export const TEMPLATE_REPLAY_LIMIT = 4 * 1024 * 1024;
/** 外显哈希不覆盖闭包中的隐式格式化捕获，旧引擎的活动日志必须先在旧版本完成或回滚。 */
export function assertTemplateReplayFormatter(replay) {
    if (replay.formatterVersion === undefined)
        throw new Error('消息格式化器已更新，旧模板包含未完成重放或跨轮闭包，已拒绝执行和提交；请备份后使用旧版本完成或回滚相关楼层');
    if (replay.formatterVersion !== 2)
        throw new Error('模板消息格式化器版本不兼容，需要完成或回滚旧版本楼层');
}
export function templateReplayGenerationContext(replay) {
    for (const operation of [...replay.operations].reverse())
        if (operation.kind === 'phase' && operation.context.phase === 'generate')
            return operation.context;
    return replay.context;
}
