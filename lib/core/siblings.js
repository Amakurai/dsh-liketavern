/**
 * 分支兄弟索引的纯逻辑（无 I/O）：同一父会话 + 同一楼层 fork 出的分支互为兄弟，
 * 供 ST 式 ‹ n/m › 切换（UI 在 actions.tsx，存储在 state/siblings.ts，编排在 node/floors.ts）。
 *
 * 同一 turn 的记录连成无向边（parent—child），查询 = 含当前会话的连通分量。
 * 嵌套同层 fork（在分支里再 fork 同一楼层）因此自然并入同一组：
 * A→B（t3）、B→C（t3）得 {A,B,C}。位次按创建先后：组的根（无入边记录的一方）在前，
 * 其余按 createdAt 升序。索引是导航元数据而非剧情状态，不进 WAL、不随回退撤销。
 */
/** 从不可信 JSON 归一化索引记录；坏记录跳过。 */
export function normalizeSiblingForks(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    for (const item of raw) {
        if (typeof item !== 'object' || item === null)
            continue;
        const rec = item;
        if (typeof rec.parentSessionId !== 'string' || !rec.parentSessionId)
            continue;
        if (typeof rec.childSessionId !== 'string' || !rec.childSessionId)
            continue;
        if (typeof rec.turn !== 'number' || !Number.isSafeInteger(rec.turn) || rec.turn < 0)
            continue;
        out.push({
            parentSessionId: rec.parentSessionId,
            childSessionId: rec.childSessionId,
            turn: rec.turn,
            createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : '',
        });
    }
    return out;
}
/** 追加一条 fork 记录；childSessionId 已存在则原样返回（幂等，重试不重复登记）。 */
export function recordSiblingFork(forks, entry) {
    if (entry.parentSessionId === entry.childSessionId)
        return [...forks];
    if (forks.some((f) => f.childSessionId === entry.childSessionId))
        return [...forks];
    return [...forks, entry];
}
/** 剪掉悬空记录（父或子会话已不存在）；changed = 是否有记录被剪掉。 */
export function pruneSiblingForks(forks, exists) {
    const next = forks.filter((f) => exists(f.parentSessionId) && exists(f.childSessionId));
    return { forks: next, changed: next.length !== forks.length };
}
/**
 * 查询会话在指定楼层的兄弟序列；该楼层无任何（存活的）分支记录时返回 null。
 * exists 过滤已删除的会话：成员被删则从组里剔除，位次重新计算。
 */
export function siblingSwipe(forks, sessionId, turn, exists) {
    const edges = forks.filter((f) => f.turn === turn &&
        f.parentSessionId !== f.childSessionId &&
        (!exists || (exists(f.parentSessionId) && exists(f.childSessionId))));
    if (edges.length === 0)
        return null;
    // 连通分量：同 turn 的 parent—child 无向边。childSessionId 全局唯一（每次 fork 新建），
    // 所以分量是一棵以「无入边记录者」为根的树。
    const adj = new Map();
    const link = (a, b) => {
        const list = adj.get(a);
        if (list)
            list.push(b);
        else
            adj.set(a, [b]);
    };
    for (const e of edges) {
        link(e.parentSessionId, e.childSessionId);
        link(e.childSessionId, e.parentSessionId);
    }
    if (!adj.has(sessionId))
        return null;
    const seen = new Set([sessionId]);
    const component = [];
    const queue = [sessionId];
    while (queue.length > 0) {
        const cur = queue.shift();
        component.push(cur);
        for (const next of adj.get(cur) ?? []) {
            if (!seen.has(next)) {
                seen.add(next);
                queue.push(next);
            }
        }
    }
    if (component.length < 2)
        return null;
    // 位次：入边记录的 createdAt 即该分支的创建时间；根（无入边）排最前，其余升序。
    const created = new Map();
    for (const e of edges) {
        if (!seen.has(e.childSessionId))
            continue;
        const prev = created.get(e.childSessionId);
        if (prev === undefined || e.createdAt < prev)
            created.set(e.childSessionId, e.createdAt);
    }
    component.sort((a, b) => {
        const ca = created.get(a);
        const cb = created.get(b);
        if (ca === undefined && cb === undefined)
            return a < b ? -1 : 1;
        if (ca === undefined)
            return -1;
        if (cb === undefined)
            return 1;
        if (ca !== cb)
            return ca < cb ? -1 : 1;
        return a < b ? -1 : 1;
    });
    const index = component.indexOf(sessionId);
    return { index, total: component.length, siblings: component };
}
