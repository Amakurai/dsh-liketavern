import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ASSET_OUTPUT_TOKEN_BUDGET, assetOutputTokens, budgetAssetFiles, budgetAssetIndex, budgetPresetCatalog, clipAssetJsonText, findPresetEntry, isPresetCatalogToken, resolveReadableAssetPath, stampAssetTokens, } from '../core/assetRead.js';
import { defaultPreset } from '../core/assemble.js';
import { TURN_WRITE_ACK_PREFIX, formatTurnStepNotice, neutralizeDshMustache } from '../core/dshPrompt.js';
import { memorySearchOptions } from '../core/memoryRetrieval.js';
import { budgetMemorySearch } from '../core/memoryToolBudget.js';
import { boundedToolError } from '../core/toolErrorBudget.js';
import { budgetLoreCatalog, clipLoreContents, isLoreCatalogQuery, selectLoreEntries, } from '../core/loreQuery.js';
import { estimateTokens } from '../core/tokenize.js';
import { rebuildIndex } from '../state/workspace.js';
import { MemoryStore, parseMemory, serializeMemory } from '../state/memory.js';
import { WorldDeltaStore } from '../state/worlddelta.js';
import { isStoryPath } from '../state/story.js';
import { WorkspaceLinkError } from '../state/workspaceFs.js';
import { withWorkspaceLock } from '../state/workspaceLock.js';
import { loadBoundLoreEntries } from './pipeline.js';
import { TOOL_OUTPUTS } from './toolOutputs.js';
/** 记忆检索一次返回的条数上限：对齐 tavern_lore_read 的 LORE_READ_MAX_TOPK，模型给的 topK 再大也不放行。 */
const MEMORY_SEARCH_MAX_TOPK = 20;
/** 变化层过期时间：ISO 8601 日期或日期时间（可带秒、小数秒与时区）。 */
const ISO_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;
function text(value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}
async function resolveCtx(state, exec, options) {
    const agent = exec.agent;
    if (!agent)
        return { error: 'no-agent：该工具只能在 Tavern 会话中使用' };
    const sessionId = agent.id;
    // 确保 turn/start 已经 beginFloor；否则本 step 的工具写入会逃出楼层事务。
    await state.waitForSessionTasks(sessionId);
    // 写工具的事务性校验：beginFloor 失败时 host 只 warn（见 index.ts），turn 照常运行，
    // 但那之后的所有写入都不记 WAL、无法回滚——宁可在这里报错让模型稍后重试，
    // 也不要静默产生一个回退边界错乱的楼层。waitForSessionTasks 之后 openFloors 必然已定。
    const entry = state.openFloors.get(sessionId);
    if (options?.requireOpenFloor && !entry) {
        return { error: 'floor-not-open：本层写入事务未开启（楼层 beginFloor 失败或 turn 未开始），已拒绝写入以保住可回滚性；请稍后重试或告知用户' };
    }
    const turn = state.currentTurns.get(sessionId);
    if (options?.requireOpenFloor && entry && (turn === undefined || entry.floor !== `${sessionId}#t${turn}`)) {
        // 上一轮提交失败会保留恢复句柄；宿主即使继续执行新轮，也不能把新事实写进旧 WAL。
        return { error: 'floor-stale：遗留楼层不属于当前轮次，已拒绝写入；请先完成旧楼层恢复再重试' };
    }
    const binding = await state.loadBinding(sessionId);
    if (!binding)
        return { error: 'no-binding：当前会话未绑定 Tavern 角色卡' };
    // 生成中换绑：楼层还开在换绑前那张卡上，按新绑定写入会把别的卡的快照记进本楼层
    // （回滚时跨卡回放），或绕过 WAL 不可回滚——拒绝写入，等下一轮在新卡上开新楼层。
    if (options?.requireOpenFloor && entry && (entry.cardId !== binding.cardId || entry.storyId !== binding.storyId)) {
        return { error: 'binding-changed：生成期间角色卡绑定已更换，楼层开在另一张卡上，已拒绝本次写入以保住可回滚性' };
    }
    // 同一张卡的并发会话各有独立楼层（index.ts onTurnStart 按 `sessionId#tN` beginFloor）。
    // 工具的写入快照必须记进本会话自己的楼层：用 withFloor 派生实例而不是共享句柄——
    // 共享句柄 floor 恒为 null，直接用它写入会逃出楼层事务；楼层属于别的卡时读工具
    // 不写入、不触发 record，scoped 口径保持统一。
    const handle = await state.storyWorkspace(binding.cardId, binding.storyId);
    const fs = handle.fs.withFloor(entry?.floor ?? null);
    const ws = { fs, memory: new MemoryStore(fs), deltas: new WorldDeltaStore(fs) };
    // 7 个工具（含读工具）的统一收口通知注入点：走到这里说明本轮确实在做多步。
    maybeInjectStepNotice(state, exec);
    return { binding, ws, sessionId, assetFs: (await state.workspace(binding.cardId)).fs };
}
/** 写工具先等会话队列，再按现有剧情→绑定锁序复核并提交；排队期间换绑/换层不能写旧句柄。 */
async function withWriteCtx(state, exec, write) {
    const resolved = await resolveCtx(state, exec, { requireOpenFloor: true });
    if ('error' in resolved)
        return boundedToolError(resolved.error);
    return withWorkspaceLock(resolved.ws.fs.root, () => withWorkspaceLock(state.paths.sessions, async () => {
        // resolveCtx 的队列/adoption 等待只能放在锁外，锁内等待会卡住需要剧情锁的结束事件。
        const binding = await state.loadBindingUnwaited(resolved.sessionId);
        if (!binding || binding.cardId !== resolved.binding.cardId || binding.storyId !== resolved.binding.storyId) {
            return boundedToolError('binding-changed：工具排队期间剧情绑定已更换，已拒绝写入旧剧情');
        }
        const entry = state.openFloors.get(resolved.sessionId), turn = state.currentTurns.get(resolved.sessionId);
        if (!entry)
            return boundedToolError('floor-not-open：工具排队期间本层事务已结束，已拒绝写入');
        if (turn === undefined || entry.floor !== `${resolved.sessionId}#t${turn}` || entry.floor !== resolved.ws.fs.currentFloor) {
            return boundedToolError('floor-stale：工具排队期间当前楼层已变化，已拒绝写入旧楼层');
        }
        if (entry.cardId !== binding.cardId || entry.storyId !== binding.storyId) {
            return boundedToolError('binding-changed：当前楼层属于另一剧情，已拒绝写入');
        }
        // 所有业务读改写、WAL、索引和成功确认在同一事务区间完成；换绑要等提交结束。
        return write(resolved);
    }));
}
function injectWriteAck(exec, detail) {
    const agent = exec.agent;
    if (!agent)
        return;
    try {
        agent.inject(createUserMessage({
            content: [{ type: 'text', text: neutralizeDshMustache(`${TURN_WRITE_ACK_PREFIX}${detail}`) }],
            source: { kind: 'dsh-tavern', form: 'notice', summary: '同轮写入确认' },
        }));
    }
    catch {
        // 注入失败不阻断工具结果
    }
}
/** 主事实已落盘后，派生目录刷新故障不能冒充主写入失败，诱使 PTC 程序重试产生重复事实。 */
async function refreshWrittenIndex(ctx, fs) {
    try {
        await rebuildIndex(fs, estimateTokens);
        return {};
    }
    catch (error) {
        try {
            ctx.logger.warn(`dsh-tavern: 事实已保存，但工具派生索引刷新失败：${error instanceof Error ? error.message : String(error)}`);
        }
        catch {
            // 日志后端不可用也不能丢失已保存事实的成功回执。
        }
        return { indexUpdated: false, hint: '事实已保存，但资产目录刷新失败；请使用返回的完整 id，不要重复写入同一事实。' };
    }
}
/**
 * 工具执行时顺便注入步骤收口通知（【Tavern 步骤】）：turn playbook 已改成固定文本以吃满
 * 宿主 runtime context 快照去重，「第几步该收口」的压力只能从 playbook 挪到这条 inject。
 * 只能在工具执行里注入——pre-step 里 inject 要等下一步 preStep 才被认领（晚一步），
 * 且 turn 结束判定会把它当未消费的 nextStep 输入、强行多拉一步产生孤儿通知。
 * 按 turn:nextStep 去重；check-and-set 之间无 await，并行工具调用不会重复注入。
 */
function maybeInjectStepNotice(state, exec) {
    const agent = exec.agent;
    if (!agent)
        return;
    const sessionId = agent.id;
    const turn = state.currentTurns.get(sessionId);
    const step = state.currentSteps.get(sessionId);
    if (turn === undefined || step === undefined)
        return;
    const nextStep = step + 1;
    const mark = `${turn}:${nextStep}`;
    if (state.stepNoticeMarks.get(sessionId) === mark)
        return;
    state.stepNoticeMarks.set(sessionId, mark);
    try {
        agent.inject(createUserMessage({
            content: [{ type: 'text', text: neutralizeDshMustache(formatTurnStepNotice(nextStep)) }],
            source: { kind: 'dsh-tavern', form: 'notice', summary: '多步收口提示' },
        }));
    }
    catch {
        // 注入失败不阻断工具结果
    }
}
function asOptionalString(value) {
    return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}
/** 对齐 clampLoreTopK：非法/非正数回退设置值，再统一压到 MEMORY_SEARCH_MAX_TOPK。 */
function clampMemoryTopK(value, fallback) {
    const raw = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : Math.floor(fallback);
    return Math.max(0, Math.min(MEMORY_SEARCH_MAX_TOPK, raw));
}
export function registerTavernTools(ctx, state) {
    // ── tavern_memory_search ────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'tavern_memory_search',
        isConcurrencySafe: () => true,
        description: '检索当前角色的长期记忆（BM25）。仅当 runtime context 里的记忆不够、需要核对更早事实时调用；不要每轮例行检索。',
        parameters: {
            query: { type: 'string', required: true, description: '检索查询（自然语言或关键词）' },
            topK: { type: 'number', description: `返回条数上限（默认跟随设置，最大 ${MEMORY_SEARCH_MAX_TOPK}）` },
        },
        output: {
            schema: TOOL_OUTPUTS.memorySearch,
            render: (_args, value) => text(value),
        },
        async execute(args, exec) {
            const resolved = await resolveCtx(state, exec);
            if ('error' in resolved)
                return boundedToolError(resolved.error);
            const config = state.config.memory;
            const topK = clampMemoryTopK(args.topK, config.retrievalTopK);
            const hits = await resolved.ws.memory.search(args.query, memorySearchOptions(topK, config.halfLifeDays));
            return budgetMemorySearch(hits, config.retrievalTokenBudget);
        },
    }));
    // ── tavern_memory_write ─────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'tavern_memory_write',
        description: '写入一条长期记忆。正文建议 200 字以内，只记事实与关系/状态变化。高度相似时应改用 tavern_memory_update。检索层下一轮才更新；同轮会注入写入确认，写完后仍须输出扮演正文。超出容量时最旧一批记忆会在本轮结束后自动压缩合并。',
        parameters: {
            body: { type: 'string', required: true, description: '记忆正文' },
            tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
            keys: { type: 'array', items: { type: 'string' }, description: '触发关键词（可选）' },
        },
        output: {
            schema: TOOL_OUTPUTS.memoryWrite,
            render: (_args, value) => text(value),
        },
        async execute(args, exec) {
            return withWriteCtx(state, exec, async (resolved) => {
                const { ws } = resolved;
                const config = state.config.memory;
                const similar = await ws.memory.findSimilar(args.body, args.keys ?? []);
                const top = similar[0];
                if (top && top.score >= config.dedupScore) {
                    const result = {
                        ok: false,
                        status: 'similar-found',
                        similarId: top.entry.id,
                        similarBody: '',
                        similarBodyTruncated: false,
                        tokensUsed: 0,
                        hint: '已存在高度相似的记忆，请改用 tavern_memory_update 更新该条目',
                    };
                    // 已存正文也可能远超建议长度；拒绝结果只展示有界预览，保留完整 id 供补读和更新。
                    const clipped = clipAssetJsonText(top.entry.body, ASSET_OUTPUT_TOKEN_BUDGET - assetOutputTokens(result) - 16);
                    result.similarBody = clipped.text;
                    result.similarBodyTruncated = clipped.truncated;
                    return stampAssetTokens(result);
                }
                // 超容量不再在本 step 同步压缩（避免多一次阻塞的 LLM 调用）：
                // 标记该工作区，turn 结束后由 runMaintenance 合并最旧批次（见 memoryMaintenance.ts）。
                const stats = await ws.memory.stats();
                const incomingTokens = estimateTokens(args.body);
                const compressScheduled = stats.count + 1 > config.maxEntries || stats.tokens + incomingTokens > config.maxTokens;
                const entry = await ws.memory.write({ body: args.body, tags: args.tags, keys: args.keys });
                if (compressScheduled)
                    state.pendingMemoryCompress.add(resolved.binding.storyId ?? resolved.binding.cardId);
                const indexStatus = await refreshWrittenIndex(ctx, ws.fs);
                injectWriteAck(exec, `记忆 id=${entry.id} 已落盘。下一轮才进入检索层；本轮把该事实视为已知，现在输出扮演正文。`);
                return {
                    ok: true,
                    id: entry.id,
                    overLength: entry.overLength,
                    ...(compressScheduled ? { compressScheduled: true } : {}),
                    ...indexStatus,
                };
            });
        },
    }));
    // ── tavern_memory_update ────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'tavern_memory_update',
        description: '更新一条已有记忆（正文/标签/关键词）。标签与关键词为并入语义（取并集）。检索层下一轮才更新；同轮会注入写入确认，改完后仍须输出扮演正文。',
        parameters: {
            id: { type: 'string', required: true, description: '记忆条目 id' },
            body: { type: 'string', description: '新正文（可选）' },
            tags: { type: 'array', items: { type: 'string' }, description: '追加标签（可选）' },
            keys: { type: 'array', items: { type: 'string' }, description: '追加关键词（可选）' },
        },
        output: {
            schema: TOOL_OUTPUTS.memoryUpdate,
            render: (_args, value) => text(value),
        },
        async execute(args, exec) {
            return withWriteCtx(state, exec, async (resolved) => {
                const existing = await resolved.ws.memory.get(args.id);
                if (!existing)
                    return boundedToolError(`not-found：记忆 ${args.id} 不存在`);
                // 容量读取属于写前检查：损坏文件或 I/O 故障不能发生在主事实已改写之后而丢失回执。
                const stats = await resolved.ws.memory.stats();
                const body = parseMemory(existing.file, serializeMemory(existing, args.body ?? existing.body)).body;
                const tokens = stats.tokens - estimateTokens(existing.body) + estimateTokens(body);
                const entry = await resolved.ws.memory.update(args.id, { body: args.body, tags: args.tags, keys: args.keys });
                if (!entry)
                    return boundedToolError(`not-found：记忆 ${args.id} 不存在`);
                if (stats.count > state.config.memory.maxEntries || tokens > state.config.memory.maxTokens) {
                    state.pendingMemoryCompress.add(resolved.binding.storyId ?? resolved.binding.cardId);
                }
                const indexStatus = await refreshWrittenIndex(ctx, resolved.ws.fs);
                injectWriteAck(exec, `记忆 id=${entry.id} 已更新。下一轮才进入检索层；本轮把更新视为已知，现在输出扮演正文。`);
                return { ok: true, id: entry.id, updated: entry.updated, ...indexStatus };
            });
        },
    }));
    // ── tavern_lore_read ────────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'tavern_lore_read',
        isConcurrencySafe: () => true,
        description: '阅读世界书（全局/角色/会话/变化层）。已知 uid 或关键词直接传 uid/query 取正文；仅未知目标时不带参数看目录（uid/键/摘要）。不要整本倾倒。仅当本轮 context 缺关键设定时调用。',
        parameters: {
            uid: { type: 'string', description: '条目 uid 或完整 key；优先精确匹配' },
            query: { type: 'string', description: '关键词，匹配键/注释/正文' },
            source: { type: 'string', description: '限定来源：global / character / chat / delta' },
            topK: { type: 'number', description: 'query 模式返回条数（默认 6，最大 20）' },
        },
        output: {
            schema: TOOL_OUTPUTS.loreRead,
            render: (_args, value) => text(value),
        },
        async execute(args, exec) {
            const resolved = await resolveCtx(state, exec);
            if ('error' in resolved)
                return boundedToolError(resolved.error);
            const q = {
                uid: asOptionalString(args.uid),
                query: asOptionalString(args.query),
                source: asOptionalString(args.source),
                topK: typeof args.topK === 'number' ? args.topK : undefined,
            };
            const { entries } = await loadBoundLoreEntries(state, resolved.binding);
            if (isLoreCatalogQuery(q)) {
                const source = q.source?.trim();
                const scoped = source ? entries.filter((e) => e.source === source) : entries;
                return budgetLoreCatalog(scoped);
            }
            const selected = selectLoreEntries(entries, q);
            return clipLoreContents(selected);
        },
    }));
    // ── tavern_worldstate_update ────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'tavern_worldstate_update',
        description: '记录一条世界状态变化（剧情中已确定发生的事实）。type：add=新增事实；update=更新某条世界书条目（需给 ref=条目 uid）；invalidate=宣告某条目失效（需给 ref）。下一轮起注入提示词；同轮会注入写入确认，写完后仍须输出扮演正文。',
        parameters: {
            type: { type: 'string', required: true, enum: ['add', 'update', 'invalidate'], description: '变化类型' },
            content: { type: 'string', required: true, description: '变化内容（当前状态描述）' },
            ref: { type: 'string', description: '指向的世界书条目 uid（update/invalidate 必填）' },
            keys: { type: 'array', items: { type: 'string' }, description: '触发关键词（可选）' },
            expiresAt: { type: 'string', description: '过期时间 ISO 字符串（可选，默认不过期）' },
        },
        output: {
            schema: TOOL_OUTPUTS.worldstateUpdate,
            render: (_args, value) => text(value),
        },
        async execute(args, exec) {
            return withWriteCtx(state, exec, async (resolved) => {
                if ((args.type === 'update' || args.type === 'invalidate') && !args.ref) {
                    return boundedToolError(`invalid-args：type=${args.type} 需要提供 ref`);
                }
                // 变化层只认可解析的时间；「明天」这类剧情内时间若原样落盘，会被当成永不过期。
                // 必须是 ISO 形态：Date.parse 会把 "3"、"day 3"、"June 5" 宽松解析成 2001 年，写入即过期、永不可见。
                const expires = args.expiresAt?.trim() ? args.expiresAt.trim() : null;
                if (expires !== null) {
                    const expiresAt = ISO_DATE_TIME_RE.test(expires) ? Date.parse(expires) : Number.NaN;
                    if (Number.isNaN(expiresAt)) {
                        return boundedToolError(`invalid-args：expiresAt=${expires} 不是可解析的 ISO 时间；不需要过期时省略该参数`);
                    }
                    if (expiresAt <= Date.now()) {
                        return boundedToolError(`invalid-args：expiresAt=${expires} 已经过去，写入后不会生效；不需要过期时省略该参数`);
                    }
                }
                const turn = state.currentTurns.get(resolved.sessionId) ?? 0;
                const delta = await resolved.ws.deltas.append({
                    type: args.type,
                    ref: args.ref ?? null,
                    content: args.content,
                    keys: args.keys ?? [],
                    order: 100,
                    sourceRange: `t${turn}`,
                    expires,
                });
                const indexStatus = await refreshWrittenIndex(ctx, resolved.ws.fs);
                injectWriteAck(exec, `世界状态 id=${delta.id} type=${args.type} 已记录。下一轮才注入检索层；本轮视为已知，现在输出扮演正文。`);
                return { ok: true, id: delta.id, ...indexStatus };
            });
        },
    }));
    // ── tavern_asset_list ───────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'tavern_asset_list',
        isConcurrencySafe: () => true,
        description: '列出当前角色工作区可读文本资产、绑定预设条目目录（与 tavern_asset_read 的白名单一致，不含 WAL/图片）。读取正文用 tavern_asset_read（path 或 preset）。不要每轮例行调用。',
        parameters: {},
        output: {
            schema: TOOL_OUTPUTS.assetList,
            render: (_args, value) => text(value),
        },
        async execute(_args, exec) {
            const resolved = await resolveCtx(state, exec);
            if ('error' in resolved)
                return boundedToolError(resolved.error);
            const { binding, ws } = resolved;
            let raw;
            try {
                raw = await ws.fs.readText('index.json', { rejectLinks: true });
            }
            catch (error) {
                if (error instanceof WorkspaceLinkError)
                    return { ok: false, error: '资产索引路径不能经过链接' };
                throw error;
            }
            // 坏文件（写盘截断等）按 index: null 返回，与 loadPreset / getChatLorebook 等
            // 读取路径同一容错——索引只是目录提示，不该让工具每次必抛。
            let index = null;
            if (raw !== null) {
                try {
                    index = JSON.parse(raw);
                }
                catch {
                    // 损坏按无索引处理
                }
            }
            const memStats = await ws.memory.stats();
            const preset = (binding.presetId ? await state.loadPreset(binding.presetId) : null) ?? defaultPreset();
            // 目录必须与 tavern_asset_read 的可读白名单一致：同一个 resolveReadableAssetPath 过滤，
            // 否则会向模型广告 state/wal/*、回滚残留目录、card.png 这些 asset_read 一律拒绝的路径。
            // 遍历时直接跳过 state/wal 与 memory/archive（skipDir）：两者只增不查、随时间单调增长，
            // 整棵走完再过滤会让本工具随数据积累越来越慢。state/ 下其余可读文件
            // （world-delta.jsonl、wi-timers）仍在白名单内，保持 list 与 read 口径一致。
            const readable = ([...(await ws.fs.list('', { skipDir: (dir) => dir === 'state/wal' || dir === 'memory/archive' })).filter(isStoryPath),
                ...(await resolved.assetFs.list('', { skipDir: (dir) => dir === 'stories' || dir === 'state' || dir === 'memory' })).filter((p) => !isStoryPath(p))]).filter((p) => { const path = resolveReadableAssetPath(p); return path.ok && path.path === p; });
            const files = budgetAssetFiles(readable, 900);
            const safeIndex = budgetAssetIndex(index, readable.filter(isStoryPath), 900);
            const out = {
                ok: true,
                index: safeIndex,
                memory: memStats,
                files: files.files,
                fileCount: files.count,
                filesTruncated: files.truncated,
                filesOmitted: files.omitted,
                filesTokensUsed: files.tokensUsed,
                tokensUsed: 0,
                truncated: false,
                hint: '读文件：tavern_asset_read({ path: "journal.md" })；读目录条目：tavern_asset_read({ presetIdentifier: "目录返回的完整 identifier" })；预设目录：tavern_asset_read({ preset: "list" })',
            };
            // 小目录使用实际花费，剩余额度给预设；索引、文件和预设共享完整输出预算。
            const catalog = budgetPresetCatalog(preset, ASSET_OUTPUT_TOKEN_BUDGET - assetOutputTokens(out) - 32);
            const result = { ...out, preset: catalog, truncated: files.truncated || Boolean(safeIndex?.truncated) || catalog.truncated };
            return stampAssetTokens(result);
        },
    }));
    // ── tavern_asset_read ───────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'tavern_asset_read',
        isConcurrencySafe: () => true,
        description: '阅读工作区文本文件或预设条目（含未启用）。path 如 journal.md、index.json、memory/xxx.md、assets/character-book.json；preset 填 list 列目录；按目录完整 identifier 读取正文用 presetIdentifier，保留前后空白且不解释目录命令。不读 WAL/图片。',
        parameters: {
            path: { type: 'string', description: '工作区相对路径' },
            preset: { type: 'string', description: 'list/catalog/* 列出预设条目；兼容旧 identifier 查询，未精确命中时去前后空白。与 presetIdentifier 互斥' },
            presetIdentifier: { type: 'string', description: '目录返回的完整 identifier，精确读取正文；保留前后空白，不解释 list/catalog/*。与 preset 互斥' },
        },
        output: {
            schema: TOOL_OUTPUTS.assetRead,
            render: (_args, value) => text(value),
        },
        async execute(args, exec) {
            const resolved = await resolveCtx(state, exec);
            if ('error' in resolved)
                return boundedToolError(resolved.error);
            const pathArg = asOptionalString(args.path);
            const presetArg = asOptionalString(args.preset);
            const exactIdentifierArg = args.presetIdentifier;
            if (Object.hasOwn(args, 'preset') && Object.hasOwn(args, 'presetIdentifier')) {
                return { ok: false, error: 'invalid-args：preset 与 presetIdentifier 不能同时提供，请选择目录命令或精确条目定位' };
            }
            if (exactIdentifierArg !== undefined && typeof exactIdentifierArg !== 'string') {
                return { ok: false, error: 'invalid-args：presetIdentifier 需要完整字符串 identifier' };
            }
            if (!pathArg?.trim() && presetArg === undefined && exactIdentifierArg === undefined) {
                return { ok: false, error: '需要 path、preset 或 presetIdentifier。先用 tavern_asset_list 看目录。' };
            }
            const out = { ok: true, tokensUsed: 0, truncated: false };
            // 先建立有界元数据，再分配正文剩余额度；同时读取两个来源也只有一份完整输出预算。
            const contents = [];
            if (presetArg !== undefined || exactIdentifierArg !== undefined) {
                const preset = (resolved.binding.presetId ? await state.loadPreset(resolved.binding.presetId) : null) ?? defaultPreset();
                if (exactIdentifierArg === undefined && presetArg !== undefined && isPresetCatalogToken(presetArg)) {
                    const catalog = budgetPresetCatalog(preset, ASSET_OUTPUT_TOKEN_BUDGET - (pathArg?.trim() ? 1200 : 64));
                    out.preset = { ...catalog, mode: 'catalog' };
                    out.truncated ||= catalog.truncated;
                }
                else {
                    const entry = exactIdentifierArg === undefined ? findPresetEntry(preset, presetArg)
                        : findPresetEntry(preset, exactIdentifierArg, { exact: true });
                    // 按最终完整定位计费；未精确命中的巨大前后空白仍可兼容查询短 identifier。
                    const identifier = entry?.identifier ?? (exactIdentifierArg ?? presetArg.trim());
                    if (assetOutputTokens(identifier) > ASSET_OUTPUT_TOKEN_BUDGET) {
                        return { ok: false, error: 'asset-output-too-large：预设 identifier 参数超过输出预算，请传入完整且有界的定位字段' };
                    }
                    if (!entry) {
                        const missing = {
                            ok: false,
                            error: `not-found：预设条目 ${identifier} 不存在`,
                            hint: 'preset 填 list 查看目录；按完整 identifier 读取用 presetIdentifier',
                        };
                        return assetOutputTokens(missing) <= ASSET_OUTPUT_TOKEN_BUDGET ? missing
                            : { ok: false, error: 'asset-output-too-large：未找到预设条目，完整错误信息超过输出预算' };
                    }
                    const name = clipAssetJsonText(preset.name, 80), entryName = clipAssetJsonText(entry.name, 80);
                    out.preset = {
                        id: preset.identifier,
                        name: name.text,
                        mode: 'content',
                        identifier: entry.identifier,
                        entryName: entryName.text,
                        enabled: entry.enabled,
                        role: entry.role,
                        marker: entry.marker,
                        markerId: entry.markerId ?? null,
                        metadataTruncated: name.truncated || entryName.truncated,
                        truncated: false,
                        tokens: 0,
                        content: '',
                    };
                    out.truncated ||= out.preset.metadataTruncated;
                    contents.push({ source: entry.content, apply: clipped => {
                            out.preset.content = clipped.text;
                            out.preset.tokens = clipped.tokens;
                            out.preset.truncated = clipped.truncated;
                        } });
                }
            }
            if (pathArg?.trim()) {
                const resolvedPath = resolveReadableAssetPath(pathArg);
                if (!resolvedPath.ok)
                    return { ok: false, error: resolvedPath.error };
                if (assetOutputTokens(resolvedPath.path) > ASSET_OUTPUT_TOKEN_BUDGET) {
                    return { ok: false, error: 'asset-output-too-large：完整文件路径超过输出预算，已拒绝返回截断定位字段' };
                }
                let body;
                try {
                    body = await (isStoryPath(resolvedPath.path) ? resolved.ws.fs : resolved.assetFs)
                        .readText(resolvedPath.path, { rejectLinks: true });
                }
                catch (error) {
                    if (error instanceof WorkspaceLinkError)
                        return { ok: false, error: '资产路径不能经过链接' };
                    // 只转换文件系统明确的长度拒绝；不回显系统绝对路径，也不掩盖权限或真实 I/O 故障。
                    if (error?.code === 'ENAMETOOLONG') {
                        return { ok: false, error: 'invalid-path：当前文件系统无法表示该资产路径，请缩短文件名或路径后重试' };
                    }
                    throw error;
                }
                if (body === null) {
                    const missing = { ok: false, error: `not-found：${resolvedPath.path}` };
                    return assetOutputTokens(missing) <= ASSET_OUTPUT_TOKEN_BUDGET ? missing
                        : { ok: false, error: 'asset-output-too-large：未找到文件，完整错误信息超过输出预算' };
                }
                out.file = {
                    path: resolvedPath.path,
                    truncated: false,
                    tokens: 0,
                    content: '',
                };
                contents.push({ source: body, apply: clipped => {
                        out.file.content = clipped.text;
                        out.file.tokens = clipped.tokens;
                        out.file.truncated = clipped.truncated;
                    } });
            }
            const metadataBudget = ASSET_OUTPUT_TOKEN_BUDGET - contents.length * 16;
            // 可选定位元数据尽量原样保留，只在完整响应真的装不下时省略；核心 identifier/path 不裁剪。
            if (assetOutputTokens(out) > metadataBudget && out.preset?.markerId != null) {
                delete out.preset.markerId;
                out.preset.markerIdOmitted = true;
                out.preset.metadataTruncated = true;
                out.truncated = true;
            }
            if (assetOutputTokens(out) > metadataBudget && out.preset?.id !== undefined) {
                delete out.preset.id;
                out.preset.idOmitted = true;
                out.preset.metadataTruncated = true;
                out.truncated = true;
            }
            if (assetOutputTokens(out) > metadataBudget) {
                return { ok: false, error: 'asset-output-too-large：资产元数据超过完整输出预算，请按单个来源读取' };
            }
            for (let i = 0; i < contents.length; i++) {
                const remaining = contents.length - i;
                const budget = Math.floor((ASSET_OUTPUT_TOKEN_BUDGET - assetOutputTokens(out) - remaining * 16) / remaining);
                const clipped = clipAssetJsonText(contents[i].source, budget);
                contents[i].apply(clipped);
                out.truncated ||= clipped.truncated;
            }
            stampAssetTokens(out);
            if (out.tokensUsed > ASSET_OUTPUT_TOKEN_BUDGET) {
                return { ok: false, error: 'asset-output-too-large：完整输出超过预算，请按单个来源读取' };
            }
            return out;
        },
    }));
}
