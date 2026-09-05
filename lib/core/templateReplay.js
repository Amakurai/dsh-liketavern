export const TEMPLATE_REPLAY_LIMIT = 4 * 1024 * 1024;
export function templateReplayGenerationContext(replay) {
    for (const operation of [...replay.operations].reverse())
        if (operation.kind === 'phase' && operation.context.phase === 'generate')
            return operation.context;
    return replay.context;
}
