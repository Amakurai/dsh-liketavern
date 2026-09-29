/** 流式续写展示：只订阅当前宿主公开事件源，隐藏前文机读块的尾段，不改原始消息或变量。 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { continuationStreamText } from '../core/continuationDisplay.js';
export function useContinuationStream(source, turn, seq, text) {
    const subscribe = useCallback((listener) => source?.subscribe(listener) ?? (() => { }), [source]);
    const read = useCallback(() => source?.getSnapshot(), [source]);
    const snapshot = useSyncExternalStore(subscribe, read, read);
    const events = useMemo(() => snapshot?.entries.flatMap(entry => entry.type === 'event' ? [entry.event] : []) ?? [], [snapshot]);
    return useMemo(() => {
        if (turn === undefined || !source)
            return { text };
        try {
            return { text: continuationStreamText(events, turn, seq, text) };
        }
        catch (error) {
            return { text: '', error: error instanceof Error ? error.message : String(error) };
        }
    }, [events, turn, seq, text, source]);
}
