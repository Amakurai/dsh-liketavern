/** 世界状态 JSONL 的条目级逆操作：只撤销本次改变且未被后续编辑的 id，保留其它行。 */
export declare function undoWorldDelta(before: string | null, after: string | null, current: string | null): string | null;
