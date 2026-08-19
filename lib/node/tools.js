import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { clipAssetText, findPresetEntry, isPresetCatalogToken, listPresetCatalog, resolveReadableAssetPath, } from '../core/assetRead.js';
import { defaultPreset } from '../core/assemble.js';
import { TURN_WRITE_ACK_PREFIX, neutralizeDshMustache } from '../core/dshPrompt.js';
import { memorySearchOptions } from '../core/memoryRetrieval.js';
import { LORE_CATALOG_MAX, clipLoreContents, isLoreCatalogQuery, selectLoreEntries, toLoreCatalogItem, } from '../core/loreQuery.js';
import { estimateTokens } from '../core/tokenize.js';
import { rebuildIndex } from '../state/workspace.js';
import { loadBoundLoreEntries } from './pipeline.js';
function text(value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}
async function resolveCtx(state, exec) {
    const agent = exec.agent;
    if (!agent)
        return { error: 'no-agent：该工具只能在 Tavern 会话中使用' };
    const sessionId = agent.id;
    // 确保 turn/start 已经 beginFloor；否则本 step 的工具写入会逃出楼层事务。
    await state.waitForSessionTasks(sessionId);
    const binding = await state.loadBinding(sessionId);
    if (!binding)
        return { error: 'no-binding：当前会话未绑定 Tavern 角色卡' };
    const ws = await state.workspace(binding.cardId);
    return { binding, ws, sessionId };
}
function injectWriteAck(exec, detail) {
    const agent = exec.agent;
    if (!agent)
        return;
    try {
        agent.inject(createUserMessage({
            content: [{ type: 'text', text: neutralizeDshMustache(`${TURN_WRITE_ACK_PREFIX}${detail}`) }],
            source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'notice', summary: '同轮写入确认' },
        }));
    }
    catch {
        // 注入失败不阻断工具结果
    }
}
function asOptionalString(value) {
    return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}
export function registerTavernTools(ctx, state) {
    // ── tavern_memory_search ────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'tavern_memory_search',
        description: '检索当前角色的长期记忆（BM25）。仅当 runtime context 里的记忆不够、需要核对更早事实时调用；不要每轮例行检索。',
        parameters: {
            query: { type: 'string', required: true, description: '检索查询（自然语言或关键词）' },
            topK: { type: 'number', description: '返回条数上限（默认跟随设置）' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => text(value),
        },
        async execute(args, exec) {
            const resolved = await resolveCtx(state, exec);
            if ('error' in resolved)
                return { ok: false, error: resolved.error };
            const topK = typeof args.topK === 'number' && args.topK > 0 ? Math.floor(args.topK) : state.config.memory.retrievalTopK;
            const hits = await resolved.ws.memory.search(args.query, memorySearchOptions(topK, state.config.memory.halfLifeDays));
            return {
                ok: true,
                results: hits.map((h) => ({ id: h.entry.id, score: h.score, tags: h.entry.tags, keys: h.entry.keys, body: h.entry.body })),
            };
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
            schema: { type: 'json' },
            render: (_args, value) => text(value),
        },
        async execute(args, exec) {
            const resolved = await resolveCtx(state, exec);
            if ('error' in resolved)
                return { ok: false, error: resolved.error };
            const { ws } = resolved;
            const config = state.config.memory;
            const similar = await ws.memory.findSimilar(args.body, args.keys ?? []);
            const top = similar[0];
            if (top && top.score >= config.dedupScore) {
                return {
                    ok: false,
                    status: 'similar-found',
                    similarId: top.entry.id,
                    similarBody: top.entry.body,
                    hint: '已存在高度相似的记忆，请改用 tavern_memory_update 更新该条目',
                };
            }
            // 超容量不再在本 step 同步压缩（避免多一次阻塞的 LLM 调用）：
            // 标记该工作区，turn 结束后由 runMaintenance 合并最旧批次（见 memoryMaintenance.ts）。
            const stats = await ws.memory.stats();
            const incomingTokens = estimateTokens(args.body);
            const compressScheduled = stats.count + 1 > config.maxEntries || stats.tokens + incomingTokens > config.maxTokens;
            if (compressScheduled)
                state.pendingMemoryCompress.add(resolved.binding.cardId);
            const entry = await ws.memory.write({ body: args.body, tags: args.tags, keys: args.keys });
            await rebuildIndex(ws.fs, estimateTokens);
            injectWriteAck(exec, `记忆 id=${entry.id} 已落盘。下一轮才进入检索层；本轮把该事实视为已知，现在输出扮演正文。`);
            return {
                ok: true,
                id: entry.id,
                overLength: entry.overLength,
                ...(compressScheduled ? { compressScheduled: true } : {}),
            };
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
            schema: { type: 'json' },
            render: (_args, value) => text(value),
        },
        async execute(args, exec) {
            const resolved = await resolveCtx(state, exec);
            if ('error' in resolved)
                return { ok: false, error: resolved.error };
            const entry = await resolved.ws.memory.update(args.id, { body: args.body, tags: args.tags, keys: args.keys });
            if (!entry)
                return { ok: false, error: `not-found：记忆 ${args.id} 不存在` };
            await rebuildIndex(resolved.ws.fs, estimateTokens);
            injectWriteAck(exec, `记忆 id=${entry.id} 已更新。下一轮才进入检索层；本轮把更新视为已知，现在输出扮演正文。`);
            return { ok: true, id: entry.id, updated: entry.updated };
        },
    }));
    // ── tavern_lore_read ────────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'tavern_lore_read',
        description: '阅读世界书（全局/角色/会话/变化层）。不带参数返回目录（uid/键/摘要）；给 uid 或 query 再取正文。不要整本倾倒。仅当本轮 context 缺设定或长上下文遗忘时调用。',
        parameters: {
            uid: { type: 'string', description: '条目 uid 或完整 key；优先精确匹配' },
            query: { type: 'string', description: '关键词，匹配键/注释/正文' },
            source: { type: 'string', description: '限定来源：global / character / chat / delta' },
            topK: { type: 'number', description: 'query 模式返回条数（默认 6，最大 20）' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => text(value),
        },
        async execute(args, exec) {
            const resolved = await resolveCtx(state, exec);
            if ('error' in resolved)
                return { ok: false, error: resolved.error };
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
                const catalog = scoped.slice(0, LORE_CATALOG_MAX).map(toLoreCatalogItem);
                return {
                    ok: true,
                    mode: 'catalog',
                    count: scoped.length,
                    truncated: scoped.length > LORE_CATALOG_MAX,
                    entries: catalog,
                    hint: '用 uid 或 query 取正文；disabled 条目仍可读。',
                };
            }
            const selected = selectLoreEntries(entries, q);
            if (selected.length === 0) {
                return { ok: true, mode: 'content', entries: [], hint: '无匹配。先不带参数看目录。' };
            }
            const clipped = clipLoreContents(selected);
            return {
                ok: true,
                mode: 'content',
                tokensUsed: clipped.tokensUsed,
                omitted: clipped.omitted,
                entries: clipped.entries,
            };
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
            schema: { type: 'json' },
            render: (_args, value) => text(value),
        },
        async execute(args, exec) {
            const resolved = await resolveCtx(state, exec);
            if ('error' in resolved)
                return { ok: false, error: resolved.error };
            if ((args.type === 'update' || args.type === 'invalidate') && !args.ref) {
                return { ok: false, error: `invalid-args：type=${args.type} 需要提供 ref` };
            }
            const turn = state.currentTurns.get(resolved.sessionId) ?? 0;
            const delta = await resolved.ws.deltas.append({
                type: args.type,
                ref: args.ref ?? null,
                content: args.content,
                keys: args.keys ?? [],
                order: 100,
                sourceRange: `t${turn}`,
                expires: args.expiresAt ?? null,
            });
            injectWriteAck(exec, `世界状态 id=${delta.id} type=${args.type} 已记录。下一轮才注入检索层；本轮视为已知，现在输出扮演正文。`);
            return { ok: true, id: delta.id };
        },
    }));
    // ── tavern_asset_list ───────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'tavern_asset_list',
        description: '列出当前角色工作区资产摘要、绑定预设条目目录。读取正文用 tavern_asset_read（path 或 preset）。不要每轮例行调用。',
        parameters: {},
        output: {
            schema: { type: 'json' },
            render: (_args, value) => text(value),
        },
        async execute(_args, exec) {
            const resolved = await resolveCtx(state, exec);
            if ('error' in resolved)
                return { ok: false, error: resolved.error };
            const { binding, ws } = resolved;
            const raw = await ws.fs.readText('index.json');
            const index = (raw === null ? null : JSON.parse(raw));
            const memStats = await ws.memory.stats();
            const preset = (binding.presetId ? await state.loadPreset(binding.presetId) : null) ?? defaultPreset();
            return {
                ok: true,
                index,
                memory: memStats,
                files: await ws.fs.list(),
                preset: { id: preset.identifier, name: preset.name, entries: listPresetCatalog(preset) },
                hint: '读文件：tavern_asset_read({ path: "journal.md" })；读预设：tavern_asset_read({ preset: "identifier 或 list" })',
            };
        },
    }));
    // ── tavern_asset_read ───────────────────────────────────────────────────
    ctx.tools.register(defineTool({
        name: 'tavern_asset_read',
        description: '阅读工作区文本文件或预设条目（含未启用）。path 如 journal.md、index.json、memory/xxx.md、assets/character-book.json；preset 填 list 列目录，或填 identifier 取正文。不读 WAL/图片。',
        parameters: {
            path: { type: 'string', description: '工作区相对路径' },
            preset: { type: 'string', description: 'list/* 列出预设条目；或条目 identifier' },
        },
        output: {
            schema: { type: 'json' },
            render: (_args, value) => text(value),
        },
        async execute(args, exec) {
            const resolved = await resolveCtx(state, exec);
            if ('error' in resolved)
                return { ok: false, error: resolved.error };
            const pathArg = asOptionalString(args.path);
            const presetArg = asOptionalString(args.preset);
            if (!pathArg?.trim() && presetArg === undefined) {
                return { ok: false, error: '需要 path 或 preset。先用 tavern_asset_list 看目录。' };
            }
            const out = { ok: true };
            if (presetArg !== undefined) {
                const preset = (resolved.binding.presetId ? await state.loadPreset(resolved.binding.presetId) : null) ?? defaultPreset();
                if (isPresetCatalogToken(presetArg)) {
                    out.preset = { id: preset.identifier, name: preset.name, mode: 'catalog', entries: listPresetCatalog(preset) };
                }
                else {
                    const entry = findPresetEntry(preset, presetArg);
                    if (!entry) {
                        return {
                            ok: false,
                            error: `not-found：预设条目 ${presetArg} 不存在`,
                            hint: 'preset 填 list 查看 identifier',
                        };
                    }
                    const clipped = clipAssetText(entry.content);
                    out.preset = {
                        id: preset.identifier,
                        name: preset.name,
                        mode: 'content',
                        identifier: entry.identifier,
                        entryName: entry.name,
                        enabled: entry.enabled,
                        role: entry.role,
                        marker: entry.marker,
                        markerId: entry.markerId ?? null,
                        truncated: clipped.truncated,
                        tokens: clipped.tokens,
                        content: clipped.text,
                    };
                }
            }
            if (pathArg?.trim()) {
                const resolvedPath = resolveReadableAssetPath(pathArg);
                if (!resolvedPath.ok)
                    return { ok: false, error: resolvedPath.error };
                const body = await resolved.ws.fs.readText(resolvedPath.path);
                if (body === null)
                    return { ok: false, error: `not-found：${resolvedPath.path}` };
                const clipped = clipAssetText(body);
                out.file = {
                    path: resolvedPath.path,
                    truncated: clipped.truncated,
                    tokens: clipped.tokens,
                    content: clipped.text,
                };
            }
            return out;
        },
    }));
}
