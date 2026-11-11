/** 流式续写展示：只订阅当前宿主公开事件源，隐藏前文机读块的尾段，不改原始消息或变量。 */
import { describeError } from '../core/guards.js';
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { continuationStreamText } from '../core/continuationDisplay.js';
export function useContinuationStream(source, turn, seq, text) {
    const subscribe = useCallback((listener) => source?.subscribe(listener) ?? (() => { }), [source]);
    const read = useCallback(() => source?.getSnapshot(), [source]);
    const snapshot = useSyncExternalStore(subscribe, read, read);
    const eventsRef = useRef([]);
    const events = useMemo(() => {
        const next = [];
        if (snapshot)
            for (const entry of snapshot.entries)
                if (entry.type === 'event')
                    next.push(entry.event);
        const prev = eventsRef.current;
        if (prev.length === next.length && prev.every((event, index) => event === next[index]))
            return prev;
        eventsRef.current = next;
        return next;
    }, [snapshot]);
    return useMemo(() => {
        if (turn === undefined || !source)
            return { text };
        try {
            return { text: continuationStreamText(events, turn, seq, text) };
        }
        catch (error) {
            return { text: '', error: describeError(error) };
        }
    }, [events, turn, seq, text, source]);
}
