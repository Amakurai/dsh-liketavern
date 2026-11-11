/**
 * 旧 tavern:turn 快照累积诊断（只读）。
 *
 * 宿主 RuntimeContextProjection 只在 runtime context 文本变化时追加一条新快照，不替换旧的；
 * 每轮世界书命中与记忆检索都不同，于是每轮在历史里留下一份 tavern:turn。DeepSeek 官方通道
 * 由预设投影剔除旧快照（presetRequestProjection），其它供应商会把它们全部发给模型。
 * 这里只统计模型可见 surface 上、最新快照之前的 tavern:turn 段，token 为本地估算值。
 */
import { z } from 'zod';
import { estimateTokens } from '../core/tokenize.js';
import './modelRoute.js';
const TURN_CONTEXT = 'tavern:turn';
const snapshotSource = z.object({ kind: z.literal('runtime-context'), form: z.literal('snapshot'),
    sections: z.array(z.object({ name: z.string(), text: z.string() })) });
const staleTurnCache = new WeakMap();
function surfaceChecksum(nodes) {
    let hash = 2166136261;
    for (let i = 0; i < nodes.length; i++)
        hash = Math.imul(hash ^ (nodes[i] ?? 0), 16777619) >>> 0;
    return hash;
}
export function measureStaleTurnContext(session) {
    const nodes = session.surface.nodes;
    const len = nodes.length;
    const lastSeq = len > 0 ? Number(nodes[len - 1]) : -1;
    const hash = surfaceChecksum(nodes);
    const cached = staleTurnCache.get(session);
    if (cached && cached.len === len && cached.lastSeq === lastSeq && cached.hash === hash) {
        return cached.value;
    }
    const turnTexts = [];
    for (const seq of nodes) {
        const event = session.eventAt(seq);
        if (event?.type !== 'user/message')
            continue;
        const rawSource = event.data.source;
        if (!rawSource || rawSource.kind !== 'runtime-context')
            continue;
        const parsed = snapshotSource.safeParse(rawSource);
        if (!parsed.success)
            continue;
        const sections = parsed.data.sections.filter(section => section.name === TURN_CONTEXT);
        turnTexts.push(sections.length ? sections.map(section => section.text).join('\n\n') : null);
    }
    // 最后一份快照是当前生效的上下文，不算累积。
    let snapshots = 0, tokens = 0;
    for (let i = 0; i < turnTexts.length - 1; i++) {
        const text = turnTexts[i];
        if (text === null || text === undefined)
            continue;
        snapshots++;
        tokens += estimateTokens(text);
    }
    const value = { snapshots, tokens };
    staleTurnCache.set(session, { len, hash, lastSeq, value });
    return value;
}
