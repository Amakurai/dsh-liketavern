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
const TURN_CONTEXT = 'tavern:turn';
const snapshotSource = z.object({ kind: z.literal('runtime-context'), form: z.literal('snapshot'),
    sections: z.array(z.object({ name: z.string(), text: z.string() })) });
export function measureStaleTurnContext(session) {
    const turnTexts = [];
    for (const seq of session.surface.nodes) {
        const event = session.eventAt(seq);
        if (event?.type !== 'user/message')
            continue;
        const parsed = snapshotSource.safeParse(event.data.source);
        if (!parsed.success)
            continue;
        const sections = parsed.data.sections.filter(section => section.name === TURN_CONTEXT);
        turnTexts.push(sections.length ? sections.map(section => section.text).join('\n\n') : null);
    }
    // 最后一份快照是当前生效的上下文，不算累积。
    let snapshots = 0, tokens = 0;
    for (const text of turnTexts.slice(0, -1)) {
        if (text === null)
            continue;
        snapshots++;
        tokens += estimateTokens(text);
    }
    return { snapshots, tokens };
}
