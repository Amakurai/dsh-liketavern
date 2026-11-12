/** 流式续写展示：只订阅当前宿主公开事件源，隐藏前文机读块的尾段，不改原始消息或变量。 */
import { describeError } from '../core/guards.js';
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { continuationStreamText } from '../core/continuationDisplay.js';
const EMPTY_EVENTS = [];
export function useContinuationStream(source, turn, seq, text) {
    const subscribe = useCallback((listener) => source?.subscribe(listener) ?? (() => { }), [source]);
    const read = useCallback(() => source?.getSnapshot(), [source]);
    const snapshot = useSyncExternalStore(subscribe, read, read);
    const cacheRef = useRef({ source: undefined, revision: -1, events: EMPTY_EVENTS });
    const events = useMemo(() => {
        if (!snapshot)
            return EMPTY_EVENTS;
        const prev = cacheRef.current;
        if (typeof snapshot.revision === 'number' && snapshot.change) {
            if (prev.source === source && prev.revision === snapshot.revision)
                return prev.events;
            if (prev.source === source && snapshot.change.kind === 'append' && prev.revision + 1 === snapshot.revision) {
                let added;
                for (const entry of snapshot.change.entries) {
                    if (entry.type === 'event') {
                        added ??= [];
                        added.push(entry.event);
                    }
                }
                const next = added ? [...prev.events, ...added] : prev.events;
                cacheRef.current = { source, revision: snapshot.revision, events: next };
                return next;
            }
            const next = [];
            for (const entry of snapshot.entries)
                if (entry.type === 'event')
                    next.push(entry.event);
            const resolved = prev.events.length === next.length && prev.events.every((event, index) => event === next[index]) ? prev.events : next;
            cacheRef.current = { source, revision: snapshot.revision, events: resolved };
            return resolved;
        }
        const next = [];
        for (const entry of snapshot.entries)
            if (entry.type === 'event')
                next.push(entry.event);
        if (prev.events.length === next.length && prev.events.every((event, index) => event === next[index]))
            return prev.events;
        cacheRef.current = { source, revision: -1, events: next };
        return next;
    }, [source, snapshot]);
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
