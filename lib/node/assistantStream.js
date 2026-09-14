export function hasNormalAssistantStop(event) {
    const { stream, interrupted } = event.data;
    if (interrupted || !Array.isArray(stream))
        return false;
    const last = stream.at(-1);
    return stream.filter(record => record.type === 'chunk' && record.chunk.type === 'finish').length === 1
        && last?.type === 'chunk' && last.chunk.type === 'finish' && last.chunk.reason.kind === 'stop';
}
