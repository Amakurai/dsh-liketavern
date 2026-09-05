import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { estimateTokens } from '../core/tokenize.js';
import { applyRegexRules } from '../core/regex.js';
import { presentRenderedOutput } from '../core/displaySanitize.js';
import { expandIdentityMacros } from '../core/macros.js';
import { DEFAULT_USER_NAME } from '../core/persona.js';
import { exportLorebook, mergeDeltasForExport, parseLorebook } from '../state/lorebook.js';
import { exportStPreset, parseStPreset } from '../state/presetStore.js';
import { rebuildIndex } from '../state/workspace.js';
import { parseSessionBinding } from './bindings.js';
import { parseJsonCard, parsePngCard } from '../state/card.js';
import { FloorError, continueFloor, editAssistantMessage, editUserMessage, enterGreetingConversation, getFloorAssistantMessage, getFloorSiblings, getFloorUserMessage, getGreetingSwipe, regenerate, rollbackToFloor, swipeGreeting } from './floors.js';
import { impersonate } from './impersonate.js';
import { runTavernPipeline } from './pipeline.js';
/** 头像缓存条数上限：卡删除/再导入会产生新 cardId，旧条目无人主动清，超上限淘汰最旧（只多一次重读，无正确性影响）。 */
const AVATAR_CACHE_MAX = 32;
export class TavernService extends TypertRemoteService {
    state;
    settingsScope;
    constructor(ctx, 
    /** 运行时中枢（agent 面插件经 ctx.tavern 访问）。 */
    state, settingsScope) {
        super(ctx, 'tavern');
        this.state = state;
        this.settingsScope = settingsScope;
    }
    /**
     * 头像 dataURL 进程内缓存：getAvatar 每次调用都全文读盘 + Base64 编码整图，
     * 与会话头/英雄区的渲染频率不匹配。指纹用 WorkspaceFs.stat('card.png') 的
     * mtimeMs+size——与 state.ts 卡级正则指纹缓存同一思路：一次 stat 不读数据，
     * 且能捕获绕开写方法直写磁盘的路径（WAL 回滚 / 外部换图）。
     */
    avatarCache = new Map();
    // ── 设置 ─────────────────────────────────────────────────────────────────
    getSettings(_request) {
        return { settings: this.settingsScope.get() };
    }
    async updateSettings(request) {
        await this.settingsScope.update(request.patch ?? {});
        return { settings: this.settingsScope.get() };
    }
    // ── 角色 ─────────────────────────────────────────────────────────────────
    async listCharacters(_request) {
        return { items: await this.state.listCharacters() };
    }
    async inspectCharacter(request) {
        try {
            const bytes = Buffer.from(request.dataBase64, 'base64');
            const card = /\.png$/i.test(request.name)
                ? parsePngCard(bytes)
                : parseJsonCard(JSON.parse(new TextDecoder().decode(bytes)));
            const bookEntries = card.characterBook?.entries;
            const entryCount = Array.isArray(bookEntries) ? bookEntries.length : 0;
            return {
                name: card.name,
                hasAvatar: Boolean(card.pngBytes && card.pngBytes.length > 0),
                hasCharacterBook: entryCount > 0,
                characterBookName: card.characterBook?.name ?? null,
                entryCount,
            };
        }
        catch (error) {
            throw new FloorError('invalid-card', error instanceof Error ? error.message : String(error));
        }
    }
    async importCharacter(request) {
        const bytes = Buffer.from(request.dataBase64, 'base64');
        const ws = await this.state.importCharacter(request.name, bytes, { importWorldBook: request.importWorldBook !== false });
        return { cardId: ws.cardId, name: ws.card.name };
    }
    async deleteCharacter(request) {
        const { salvagedLorebook } = await this.state.deleteCharacter(request.cardId);
        return { deleted: true, salvagedLorebook };
    }
    async getCharacterDetail(request) {
        const ws = await this.state.loadCharacter(request.cardId);
        if (!ws)
            throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`);
        const handle = await this.state.workspace(request.cardId);
        const { card } = ws;
        return {
            cardId: ws.cardId,
            name: card.name,
            description: card.description,
            personality: card.personality,
            scenario: card.scenario,
            firstMes: card.firstMes,
            alternateGreetings: card.alternateGreetings,
            mesExample: card.mesExample,
            systemPrompt: card.systemPrompt,
            postHistoryInstructions: card.postHistoryInstructions,
            creatorNotes: card.creatorNotes,
            creator: card.creator,
            characterVersion: card.characterVersion,
            tags: card.tags,
            spec: card.spec,
            hasCharacterBook: card.characterBook !== null && card.characterBook.entries.length > 0,
            characterBookName: card.characterBook?.name ?? null,
            characterBookEntryCount: card.characterBook?.entries.length ?? 0,
            hasAvatar: await handle.fs.exists('card.png'),
            depthPrompt: card.depthPrompt,
            extensions: card.extensions,
        };
    }
    async saveCharacter(request) {
        try {
            return await this.state.saveCharacter(request.cardId, {
                name: request.name,
                description: request.description,
                personality: request.personality,
                scenario: request.scenario,
                firstMes: request.firstMes,
                alternateGreetings: request.alternateGreetings,
                mesExample: request.mesExample,
                systemPrompt: request.systemPrompt,
                postHistoryInstructions: request.postHistoryInstructions,
                creatorNotes: request.creatorNotes,
                creator: request.creator,
                characterVersion: request.characterVersion,
                tags: request.tags,
                depthPrompt: request.depthPrompt,
            });
        }
        catch (error) {
            throw new FloorError('invalid-card', error instanceof Error ? error.message : String(error));
        }
    }
    async createCharacter(request) {
        const name = request.name?.trim();
        if (!name)
            throw new FloorError('invalid-card', '角色名不能为空');
        const ws = await this.state.createCharacter(name);
        return { cardId: ws.cardId, name: ws.card.name };
    }
    async exportCharacter(request) {
        try {
            return await this.state.exportCharacter(request.cardId);
        }
        catch (error) {
            throw new FloorError('card-not-found', error instanceof Error ? error.message : String(error));
        }
    }
    // ── 预设 ─────────────────────────────────────────────────────────────────
    async listPresets(_request) {
        return { items: await this.state.listPresetSummaries() };
    }
    async importPreset(request) {
        const { preset, warnings } = parseStPreset(request.json);
        if (request.name && preset.name === '未命名预设')
            preset.name = request.name;
        // 回显用落盘后的实际 id（identifier 含非法字符时会被净化），UI 按它打开才与磁盘一致。
        const id = await this.state.savePreset(preset);
        return { id, warnings };
    }
    async savePreset(request) {
        if (!request.preset || typeof request.preset.identifier !== 'string' || !request.preset.identifier) {
            throw new FloorError('invalid-preset', '预设缺少 identifier');
        }
        // 宽松传输、严格校验：remote schema 对复杂资产是宽松形状，落盘前用现有预设解析帮手
        // 整体过一遍——经 ST 导出形态往返（exportStPreset → parseStPreset）：结构非法
        // （非对象 / entries 缺失或不是数组）直接抛错；往返后条目变少说明有缺失或重复
        // identifier 的条目被丢弃，同样拒绝。校验不过不写盘。
        try {
            const normalized = parseStPreset(exportStPreset(request.preset)).preset;
            if (normalized.entries.length !== request.preset.entries?.length) {
                throw new Error('预设条目缺失，或存在缺失/重复的 identifier');
            }
        }
        catch (error) {
            throw new FloorError('invalid-preset', error instanceof Error ? error.message : String(error));
        }
        // 回显用落盘后的实际 id（理由同 importPreset）。
        const id = await this.state.savePreset(request.preset);
        return { id };
    }
    async deletePreset(request) {
        await this.state.deletePreset(request.id);
        return { deleted: true };
    }
    async getPreset(request) {
        const preset = await this.state.loadPreset(request.id);
        if (!preset)
            throw new FloorError('preset-not-found', `预设 ${request.id} 不存在`);
        return { preset };
    }
    // ── 世界书库 ──────────────────────────────────────────────────────────────
    async listLorebooks(_request) {
        return { items: await this.state.listLorebooks() };
    }
    async getLorebook(request) {
        const json = await this.state.loadLorebookJson(request.name);
        if (json === null)
            throw new FloorError('lorebook-not-found', `世界书 ${request.name} 不存在`);
        return { json };
    }
    async importLorebook(request) {
        // 先归一化验证可读性，再原样落盘；回显名以落盘后的实际 id 为准（原始名带非法字符会被净化）。
        const entries = parseLorebook(request.json, { source: 'global', sourceRef: request.name });
        const id = await this.state.saveLorebook(request.name, request.json);
        return { name: id, entryCount: entries.length };
    }
    async saveLorebook(request) {
        parseLorebook(request.json, { source: 'global', sourceRef: request.name });
        // 回显名以落盘后的实际 id 为准（同 importLorebook）。
        const id = await this.state.saveLorebook(request.name, request.json);
        return { name: id };
    }
    async deleteLorebook(request) {
        await this.state.deleteLorebook(request.name);
        return { deleted: true };
    }
    async getCharacterLorebook(request) {
        const book = await this.state.loadCharacterLorebookRaw(request.cardId);
        if (!book)
            throw new FloorError('lorebook-not-found', `角色 ${request.cardId} 没有内嵌世界书`);
        return book;
    }
    async saveCharacterLorebook(request) {
        parseLorebook(request.json, { source: 'character', sourceRef: request.cardId });
        return this.state.saveCharacterLorebook(request.cardId, request.json);
    }
    async deleteEmbeddedLorebook(request) {
        await this.state.deleteCharacterLorebook(request.cardId);
        return { deleted: true };
    }
    async getChatLorebook(request) {
        if ((await this.state.loadCharacter(request.cardId)) === null) {
            throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`);
        }
        const json = await this.state.getChatLorebook(request.cardId);
        return { json };
    }
    async saveChatLorebook(request) {
        if ((await this.state.loadCharacter(request.cardId)) === null) {
            throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`);
        }
        await this.state.saveChatLorebook(request.cardId, request.json);
        return { saved: true };
    }
    async getJournal(request) {
        if ((await this.state.loadCharacter(request.cardId)) === null) {
            throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`);
        }
        return { text: await this.state.getJournal(request.cardId) };
    }
    async saveJournal(request) {
        if ((await this.state.loadCharacter(request.cardId)) === null) {
            throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`);
        }
        await this.state.saveJournal(request.cardId, request.text ?? '');
        return { saved: true };
    }
    // ── 人设 ─────────────────────────────────────────────────────────────────
    async listPersonas(_request) {
        return { items: await this.state.listPersonas() };
    }
    async savePersona(request) {
        if (!request.persona?.id)
            throw new FloorError('invalid-persona', '人设缺少 id');
        // 回显与默认页都用落盘后的实际 id：id 被净化过时磁盘 JSON 里的 id 也一并改写，
        // 若继续用原始 id，默认页指向的净化文件与这里回显的 id 会各说各话。
        const id = await this.state.savePersona(request.persona);
        const settings = this.settingsScope.get();
        if (!settings.defaults?.personaId) {
            await this.settingsScope.update({
                defaults: { ...settings.defaults, personaId: id },
            });
        }
        return { id };
    }
    async deletePersona(request) {
        await this.state.deletePersona(request.id);
        const settings = this.settingsScope.get();
        if (settings.defaults?.personaId === request.id) {
            await this.settingsScope.update({
                defaults: { ...settings.defaults, personaId: '' },
            });
        }
        return { deleted: true };
    }
    // ── 正则 ─────────────────────────────────────────────────────────────────
    async listRegexRules(_request) {
        return { rules: await this.state.listRegexRules() };
    }
    async saveRegexRules(request) {
        const rules = Array.isArray(request.rules) ? request.rules : [];
        await this.state.saveRegexRules(rules);
        return { count: rules.length };
    }
    // ── 会话绑定 ──────────────────────────────────────────────────────────────
    async getSessionBinding(request) {
        const session = this.ctx.sessions.get(request.sessionId);
        const canSwipeGreeting = Boolean(session && !session.snapshotEvents().some((e) => e.type === 'user/message'));
        const binding = await this.state.loadBinding(request.sessionId);
        if (!binding)
            return { binding: null, userName: DEFAULT_USER_NAME, canSwipeGreeting: false };
        const persona = await this.state.resolvePersona(binding.personaId);
        return { binding, userName: persona?.name ?? DEFAULT_USER_NAME, canSwipeGreeting };
    }
    async setSessionBinding(request) {
        // 宽松传输、严格校验：绑定整体过 parseSessionBinding（缺字段/类型不符抛错，不落盘），
        // 不能只抽查 sessionId/cardId 就把客户端自报的其余字段原样写盘。
        let binding;
        try {
            binding = parseSessionBinding(request.binding);
        }
        catch (error) {
            throw new FloorError('invalid-binding', error instanceof Error ? error.message : String(error));
        }
        if ((await this.state.loadCharacter(binding.cardId)) === null) {
            throw new FloorError('card-not-found', `角色 ${binding.cardId} 不存在`);
        }
        const existing = await this.state.loadBinding(binding.sessionId);
        // fork WAL 祖先由 host 维护；同卡编辑绑定时保留，换卡则清空，不能信任客户端自报。
        // createdAt 由 parseSessionBinding 保证必填非空，无需再兜底。
        const walLineage = existing?.cardId === binding.cardId ? existing.walLineage : undefined;
        await this.state.saveBinding({
            ...binding,
            walLineage,
        });
        return { saved: true };
    }
    async clearSessionBinding(request) {
        if (!request.sessionId)
            throw new FloorError('invalid-binding', '绑定缺少 sessionId');
        await this.state.clearBinding(request.sessionId);
        return { cleared: true };
    }
    // ── 开场白与楼层 ──────────────────────────────────────────────────────────
    async ensureGreeting(request) {
        return this.state.enqueueSessionTask(request.sessionId, async () => ({
            created: await enterGreetingConversation(this.floorDeps(), request.sessionId),
        }));
    }
    async swipeGreeting(request) {
        return this.state.enqueueSessionTask(request.sessionId, () => swipeGreeting(this.floorDeps(), request.sessionId, request.index));
    }
    async getGreetingSwipe(request) {
        return getGreetingSwipe(this.floorDeps(), request.sessionId, request.messageId);
    }
    /** 分支兄弟导航是只读查询：等排队中的楼层任务落定即可，不进串行队列。 */
    async getFloorSiblings(request) {
        await this.state.waitForSessionTasks(request.sessionId);
        return getFloorSiblings(this.floorDeps(), request.sessionId, request.messageId, request.turn);
    }
    async renderOutputText(request) {
        const text = request.text ?? '';
        const settings = this.settingsScope.get();
        const whitelist = [...settings.cardNetworkWhitelist];
        const session = this.ctx.sessions.get(request.sessionId);
        const canSwipeGreeting = Boolean(session && !session.snapshotEvents().some((e) => e.type === 'user/message'));
        const binding = await this.state.loadBinding(request.sessionId);
        if (!binding) {
            const presented = presentRenderedOutput(text, settings.interactiveCards);
            return {
                ...presented,
                interactiveCards: settings.interactiveCards,
                whitelist,
                greetings: [],
                greetingIndex: 0,
                canSwipeGreeting: false,
            };
        }
        const rules = await this.state.rulesFor(binding);
        const ws = await this.state.loadCharacter(binding.cardId);
        const persona = await this.state.resolvePersona(binding.personaId);
        const names = { char: ws?.card.name ?? 'Assistant', user: persona?.name ?? DEFAULT_USER_NAME };
        // SillyTavern：先 substituteParams 再跑展示正则，开场白里的 {{user}} 才能被按名字匹配。
        const named = expandIdentityMacros(text, names);
        const rendered = applyRegexRules(named, rules, { scope: 'output', timing: 'render' }, { ...names, outlets: {} });
        const presented = presentRenderedOutput(rendered.text, settings.interactiveCards);
        const htmls = presented.htmls.map((h) => expandIdentityMacros(h, names));
        const greetings = (ws ? [ws.card.firstMes, ...ws.card.alternateGreetings] : []).map((g) => expandIdentityMacros(g, names));
        return {
            html: htmls[0] ?? null,
            htmls,
            text: expandIdentityMacros(presented.text, names),
            interactiveCards: settings.interactiveCards,
            whitelist,
            greetings,
            greetingIndex: binding.greetingIndex,
            canSwipeGreeting,
        };
    }
    regenerate(request) {
        return this.state.enqueueSessionTask(request.sessionId, () => regenerate(this.floorDeps(), request.sessionId, request.messageId, request.turn));
    }
    rollbackToFloor(request) {
        return this.state.enqueueSessionTask(request.sessionId, () => rollbackToFloor(this.floorDeps(), request.sessionId, request.messageId, request.turn));
    }
    async getFloorUserMessage(request) {
        await this.state.waitForSessionTasks(request.sessionId);
        return getFloorUserMessage(this.floorDeps(), request.sessionId, request.messageId);
    }
    editUserMessage(request) {
        return this.state.enqueueSessionTask(request.sessionId, () => editUserMessage(this.floorDeps(), request.sessionId, request.messageId, request.text));
    }
    async getFloorAssistantMessage(request) {
        await this.state.waitForSessionTasks(request.sessionId);
        return getFloorAssistantMessage(this.floorDeps(), request.sessionId, request.messageId);
    }
    editAssistantMessage(request) {
        return this.state.enqueueSessionTask(request.sessionId, () => editAssistantMessage(this.floorDeps(), request.sessionId, request.messageId, request.text));
    }
    continueFloor(request) {
        return this.state.enqueueSessionTask(request.sessionId, () => continueFloor(this.floorDeps(), request.sessionId, request.messageId));
    }
    /** impersonate 是带外一次性调用，不进会话串行队列（不改会话状态）。 */
    impersonate(request) {
        return impersonate({ ctx: this.ctx, state: this.state }, request.sessionId);
    }
    // ── 记忆 ─────────────────────────────────────────────────────────────────
    async getMemories(request) {
        const ws = await this.state.workspace(request.cardId);
        return { items: await ws.memory.list() };
    }
    async saveMemory(request) {
        // 面板/服务层非会话写路径一律走 plainWorkspace（floor 恒 null，绝不记 WAL）：
        // 生成进行中的面板编辑若走携带楼层的实例，会被记进当前楼层 WAL、回退时静默改回旧值。
        const ws = await this.state.plainWorkspace(request.cardId);
        let entry;
        if (request.id) {
            entry = await ws.memory.update(request.id, { body: request.body, tags: request.tags, keys: request.keys }, { listMode: 'replace' });
            if (!entry)
                throw new FloorError('memory-not-found', `记忆 ${request.id} 不存在`);
        }
        else {
            entry = await ws.memory.write({ body: request.body, tags: request.tags, keys: request.keys });
        }
        await rebuildIndex(ws.fs, estimateTokens);
        return { id: entry.id };
    }
    async deleteMemory(request) {
        // 面板写路径走 plainWorkspace（理由同 saveMemory）。
        const ws = await this.state.plainWorkspace(request.cardId);
        const deleted = await ws.memory.delete(request.id);
        if (deleted)
            await rebuildIndex(ws.fs, estimateTokens);
        return { deleted };
    }
    /** 无 LLM 的确定性归并：原文逐条保留，只减少条目数，不宣称减少 token。 */
    async compressMemories(request) {
        // 面板写路径走 plainWorkspace（理由同 saveMemory）。
        const ws = await this.state.plainWorkspace(request.cardId);
        const batch = await ws.memory.oldest(this.state.config.memory.compressBatch);
        if (batch.length < 2)
            return { merged: 0 };
        const merged = batch.map((b, i) => `${i + 1}. ${b.body}`).join('\n');
        // 顺序与 memoryMaintenance.compressOldestMemories 一致：先落合并条目成功后再归档原条目——
        // 先归档的话，合并写失败会让整批从活跃库消失（丢事实）；反过来写失败批次原样保留可重试，
        // 归档中途失败的最坏结果只是新旧并存，下次压缩把残余再合并一次，有冗余但不丢事实。
        const count = await ws.memory.mergeBatch(batch, merged, 'merge');
        await rebuildIndex(ws.fs, estimateTokens);
        return { merged: count };
    }
    // ── 世界状态 ──────────────────────────────────────────────────────────────
    async getWorldDeltas(request) {
        const ws = await this.state.workspace(request.cardId);
        return { items: await ws.deltas.list({ includeRevoked: true }) };
    }
    async revokeWorldDelta(request) {
        // 面板写路径走 plainWorkspace（理由同 saveMemory）。
        const ws = await this.state.plainWorkspace(request.cardId);
        return { revoked: await ws.deltas.revoke(request.id) };
    }
    async addWorldDelta(request) {
        if (!request.content?.trim())
            throw new FloorError('invalid-delta', '世界状态内容不能为空');
        if ((await this.state.loadCharacter(request.cardId)) === null) {
            throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`);
        }
        // 面板写路径走 plainWorkspace（理由同 saveMemory）。
        const ws = await this.state.plainWorkspace(request.cardId);
        const delta = await ws.deltas.append({
            type: request.type,
            ref: request.ref ?? null,
            content: request.content.trim(),
            keys: request.keys ?? [],
            order: request.order ?? 100,
            sourceRange: 'manual',
            expires: null,
        });
        await rebuildIndex(ws.fs, estimateTokens);
        return { id: delta.id };
    }
    async exportMergedLorebook(request) {
        const charWs = await this.state.loadCharacter(request.cardId);
        if (!charWs)
            throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`);
        const ws = await this.state.workspace(request.cardId);
        const book = await this.state.loadCharacterLorebookRaw(request.cardId);
        const originals = book ? parseLorebook(book.json, { source: 'character', sourceRef: request.cardId }) : [];
        const deltas = await ws.deltas.list();
        const merged = mergeDeltasForExport(originals, deltas);
        return { json: exportLorebook(merged, charWs.card.name) };
    }
    // ── 调试 ─────────────────────────────────────────────────────────────────
    getTriggerLog(request) {
        return { log: this.state.triggerLogs.get(request.sessionId) ?? null };
    }
    async previewPrompt(request) {
        const agent = this.ctx.agents.get(request.sessionId);
        if (!agent)
            throw new FloorError('session-not-live', `会话 ${request.sessionId} 不在线，无法预览（请先打开该会话）`);
        const llm = this.ctx.get('llm');
        const result = await runTavernPipeline({ state: this.state, sessionId: request.sessionId, agent, llm, mode: 'preview' });
        if (!result)
            throw new FloorError('no-binding', '当前会话未绑定 Tavern 角色卡');
        return {
            standing: result.standing,
            turnContext: result.turnContext,
            system: result.system,
            messages: result.messages,
            logLines: result.logLines,
            worldInfoBudget: result.wiBudget,
            assembleBudget: result.assembled.stats,
        };
    }
    /**
     * 上下文占用（宿主 rc.2 起 sessionProjections.stateOf 只读 token-meter 投影）。
     * 会话不在线、宿主未挂投影或尚无数据时 usage=null，调用方按未知处理。
     */
    getContextUsage(request) {
        const session = this.ctx.sessions.get(request.sessionId);
        if (!session)
            return { usage: null };
        const projections = this.ctx.get('sessionProjections');
        const pressure = projections?.stateOf?.(session, 'contextPressure');
        if (!pressure || typeof pressure.surfaceTokens !== 'number')
            return { usage: null };
        const breakdown = projections?.stateOf?.(session, 'contextBreakdown');
        const percent = typeof pressure.pressureTokens === 'number' && typeof pressure.contextWindow === 'number' && pressure.contextWindow > 0
            ? Math.round((pressure.pressureTokens / pressure.contextWindow) * 100)
            : null;
        return {
            usage: {
                surfaceTokens: pressure.surfaceTokens,
                pressureTokens: pressure.pressureTokens ?? null,
                contextWindow: pressure.contextWindow ?? null,
                percent,
                systemTokens: breakdown?.systemTokens ?? null,
                toolsTokens: breakdown?.toolsTokens ?? null,
                messageTokens: breakdown?.messageTokens ?? null,
            },
        };
    }
    /** Tavern 数据目录（$DSH_HOME/dsh-tavern），设置面板展示用。 */
    getDataInfo(_request) {
        return { dataHome: this.state.paths.root };
    }
    async getAvatar(request) {
        const charWs = await this.state.loadCharacter(request.cardId);
        if (!charWs)
            return { dataUrl: null };
        const ws = await this.state.workspace(request.cardId);
        // 指纹一致直接回缓存：一次 stat 代替全文读 + Base64 编码（指纹口径见 avatarCache 注释）。
        const info = await ws.fs.stat('card.png');
        const fingerprint = info ? `${info.mtimeMs}:${info.size}` : 'missing';
        const cached = this.avatarCache.get(request.cardId);
        if (cached && cached.fingerprint === fingerprint)
            return { dataUrl: cached.dataUrl };
        const bytes = info ? await ws.fs.readBytes('card.png') : null;
        const dataUrl = bytes ? `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` : null;
        if (this.avatarCache.size >= AVATAR_CACHE_MAX && !this.avatarCache.has(request.cardId)) {
            const oldest = this.avatarCache.keys().next().value;
            if (oldest !== undefined)
                this.avatarCache.delete(oldest);
        }
        this.avatarCache.set(request.cardId, { fingerprint, dataUrl });
        return { dataUrl };
    }
    floorDeps() {
        return { ctx: this.ctx, state: this.state };
    }
}
export function createTavernService(ctx, state, settingsScope) {
    return new TavernService(ctx, state, settingsScope);
}
