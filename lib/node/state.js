import { join } from 'node:path';
import { estimateTokens } from '../core/tokenize.js';
import { EMPTY_TIMER_STATE } from '../core/types.js';
import { compileCardRegexScripts, compilePresetRegexScripts } from '../core/regex.js';
import { normalizeBook, parseJsonCard, parsePngCard, regexScriptsOf, applyCharacterPatch, cardToStJson, createBlankCard, embedCardInPng } from '../state/card.js';
import { parseLorebook } from '../state/lorebook.js';
import { MemoryStore } from '../state/memory.js';
import { Wal } from '../state/wal.js';
import { WorldDeltaStore } from '../state/worlddelta.js';
import { deleteCharacter as deleteCharacterFromDisk, importCard as importCardToWorkspace, assertValidCardId, listCharacters, loadCharacter, rebuildIndex, } from '../state/workspace.js';
import { WorkspaceFs } from '../state/workspaceFs.js';
import { resolveStaleBinding } from '../core/binding.js';
import { pickPersona } from '../core/persona.js';
import { pinStandingText, stableFingerprintHash, standingPinKey } from '../core/standingPin.js';
import { clearBindingsForCard, deleteBinding, loadBinding, saveBinding } from './bindings.js';
import { ensurePaths } from './paths.js';
/** 模型元数据缓存 TTL：适配器目录运行期通常不变，但 provider 配置可能热更，过期重解析。 */
const MODEL_INFO_TTL_MS = 5 * 60 * 1000;
/** 触发日志保留的会话数上限（会话关闭无清理事件，防长驻进程无界增长）。 */
const TRIGGER_LOG_SESSIONS_MAX = 64;
/** standing 钉位条数上限（淘汰只会导致重算一次 standing，无正确性影响）。 */
const STANDING_PINS_MAX = 256;
export class TavernState {
    paths;
    getConfig;
    workspaces = new Map();
    triggerLogs = new Map();
    /** 会话当前 turn 号（session/event 的 turn/start 维护；WI/记忆检索按 turn 缓存）。 */
    currentTurns = new Map();
    /** 当前 turn 内的 step（pre-step / step/start 维护；turn 开始时为 1）。 */
    currentSteps = new Map();
    /**
     * 步骤收口通知去重标记（sessionId → `turn:nextStep`）：工具执行时注入的【Tavern 步骤】
     * 通知按下一步号去重，防并行工具调用重复注入；turn/end 清除。
     */
    stepNoticeMarks = new Map();
    /**
     * 会话 → 本轮 beginFloor 实际开在哪个 cardId 上（turn/start 记，turn/end 取走）。
     * 不变式：楼层必须由开层那张卡提交。turn 中途换绑/解绑后当前绑定已经是另一张卡，
     * 若按当前绑定提交，开层那张卡的 WorkspaceFs.floor 会永远悬着，之后的非会话写入被误记 WAL。
     */
    openFloors = new Map();
    /** 每 turn 一次的 WI/记忆/变化层评估缓存（turn/end 清除）。 */
    wiCache = new Map();
    /** 已入 inbox 尚未入日志的用户输入文本（agent/inbox/inserted 维护；turn/end 清除）。 */
    pendingInputs = new Map();
    /** 会话 standing 钉死（键 = 会话 × 生成场景；绑定指纹不变则复用第一次写入的字节）。 */
    standingPins = new Map();
    /** standing 依赖资产的进程内修订号：经本类写方法编辑/删除即 bump，standing 指纹随内容变化失效重算。 */
    assetRevs = new Map();
    /**
     * 库资产解析缓存（热路径读盘放大治理）：key 与 assetRevs 的修订号键对应，
     * 写方法 bump 修订号时 tag 变化即失效。绕开 TavernState 手改文件不会被捕获
     * （与 standing 钉死同一语义，重启即清）。返回值视为只读，调用方不得原地修改。
     */
    presetCache = new Map();
    loreCache = new Map();
    cardCache = new Map();
    /** 模型元数据进程内缓存：resolveModelInfo 每步被调（reasoningEffort / 上下文窗口），带 TTL 防配置热更后拿到旧值。 */
    modelInfoCache = new Map();
    /** 待异步压缩的角色工作区（memory_write 超容量时标记；idle 期 runMaintenance 消费，见 memoryMaintenance.ts）。 */
    pendingMemoryCompress = new Set();
    /**
     * 会话事件副作用串行队列。session/event 与 inbox 回调本身不能阻塞平台事件派发，
     * 但 beginFloor / 开场白 / commitFloor / idle maintenance 必须保持事件发生顺序。
     */
    sessionTaskTails = new Map();
    constructor(paths, getConfig) {
        this.paths = paths;
        this.getConfig = getConfig;
    }
    async init() {
        await ensurePaths(this.paths);
    }
    get config() {
        return this.getConfig();
    }
    /**
     * 把一个副作用接到同会话队尾；前一任务失败不会毒死后续队列，调用方仍会收到本次异常。
     * 不同会话互不等待，避免把全局运行时退化成单线程。
     */
    enqueueSessionTask(sessionId, task) {
        const previous = this.sessionTaskTails.get(sessionId) ?? Promise.resolve();
        const result = previous.then(task);
        const tail = result.then(() => undefined, () => undefined);
        this.sessionTaskTails.set(sessionId, tail);
        void tail.finally(() => {
            if (this.sessionTaskTails.get(sessionId) === tail)
                this.sessionTaskTails.delete(sessionId);
        });
        return result;
    }
    /** 等待调用时已经排入该会话的副作用完成。 */
    async waitForSessionTasks(sessionId) {
        await (this.sessionTaskTails.get(sessionId) ?? Promise.resolve());
    }
    // ── 角色工作区 ────────────────────────────────────────────────────────────
    async workspace(cardId) {
        // 工作区根必须始终是 characters/ 下的单层目录；否则 WorkspaceFs 自身的
        // 相对路径保护只会约束在错误根目录内，挡不住 `cardId=..` 先把根挪出去。
        assertValidCardId(cardId);
        const cached = this.workspaces.get(cardId);
        if (cached)
            return cached;
        const root = join(this.paths.characters, cardId);
        const wal = new Wal(join(root, 'state', 'wal'));
        const fs = new WorkspaceFs(root, wal);
        const handle = { fs, wal, memory: new MemoryStore(fs), deltas: new WorldDeltaStore(fs) };
        this.workspaces.set(cardId, handle);
        return handle;
    }
    async listCharacters() {
        return listCharacters(this.paths.characters);
    }
    async loadCharacter(cardId) {
        // 解析缓存：card.json 的全部写路径（saveCharacter / saveCharacterLorebook /
        // deleteCharacterLorebook）都 bump card:/charlore: 修订号，tag 变化即失效重读。
        const tag = `${this.assetRevs.get(`card:${cardId}`) ?? 0}:${this.assetRevs.get(`charlore:${cardId}`) ?? 0}`;
        const cached = this.cardCache.get(cardId);
        if (cached && cached.tag === tag)
            return cached.value;
        const value = await loadCharacter(this.paths.characters, cardId);
        this.cardCache.set(cardId, { tag, value });
        return value;
    }
    /** 删除角色卡工作区、清掉指向它的会话绑定，并逐出缓存句柄。cascadeDeleteEmbeddedBook=false 时先把内嵌书抢救到世界书库。 */
    async deleteCharacter(cardId) {
        let salvagedLorebook = null;
        if (!this.config.cascadeDeleteEmbeddedBook) {
            const book = await this.loadCharacterLorebookRaw(cardId);
            if (book) {
                // 以 saveLorebook 落盘后的实际 id 为准，UI 打开的目标才和磁盘一致。
                salvagedLorebook = await this.saveLorebook(await this.salvageLorebookName(book.name), book.json);
            }
        }
        await deleteCharacterFromDisk(this.paths.characters, cardId);
        await clearBindingsForCard(this.paths, cardId);
        this.workspaces.delete(cardId);
        this.cardCache.delete(cardId);
        return { salvagedLorebook };
    }
    /** 抢救内嵌书到世界书库时的去重文件名（与 saveLorebook 同一套净化规则）。 */
    async salvageLorebookName(base) {
        const clean = this.assetFileId(base.trim() || 'embedded-book');
        const existing = new Set(await this.listLorebooks());
        if (!existing.has(clean))
            return clean;
        for (let i = 2; i < 100; i++) {
            const candidate = `${clean}-${i}`;
            if (!existing.has(candidate))
                return candidate;
        }
        return `${clean}-${Date.now()}`;
    }
    /** 删除角色卡内嵌世界书（assets/character-book.json + card.json 的 characterBook 置空）。非楼层写入，不记 WAL。 */
    async deleteCharacterLorebook(cardId) {
        const charWs = await this.loadCharacter(cardId);
        if (!charWs)
            throw new Error(`角色 ${cardId} 不存在`);
        const handle = await this.workspace(cardId);
        await handle.fs.delete('assets/character-book.json');
        const cardJson = { ...charWs.card, characterBook: null };
        delete cardJson.pngBytes;
        await handle.fs.writeText('card.json', JSON.stringify(cardJson, null, 2) + '\n');
        this.bumpAssetRev(`charlore:${cardId}`);
    }
    /** 导入角色卡（PNG/JSON 字节），落盘工作区并初始化索引。 */
    async importCharacter(fileName, bytes, opts) {
        const card = /\.png$/i.test(fileName) ? parsePngCard(bytes) : parseJsonCard(JSON.parse(new TextDecoder().decode(bytes)));
        const ws = await importCardToWorkspace(this.paths.characters, card, opts);
        const handle = await this.workspace(ws.cardId);
        await rebuildIndex(handle.fs, estimateTokens);
        return ws;
    }
    /**
     * 读取角色卡内嵌世界书原文（card.characterBook 优先，否则 assets/character-book.json）。
     * 供组装管线、工具与设置面板共用，避免只认 library/lorebooks 而漏掉卡内书。
     */
    async loadCharacterLorebookRaw(cardId) {
        const charWs = await this.loadCharacter(cardId);
        if (!charWs)
            return null;
        const book = charWs.card.characterBook;
        if (book && book.entries.length > 0) {
            const json = book.raw ?? { name: book.name ?? charWs.card.name, entries: book.entries };
            return { name: book.name ?? charWs.card.name, json, entryCount: book.entries.length };
        }
        const handle = await this.workspace(cardId);
        const file = await handle.fs.readText('assets/character-book.json');
        if (file === null)
            return null;
        try {
            const json = JSON.parse(file);
            const normalized = normalizeBook(json);
            if (!normalized || normalized.entries.length === 0)
                return null;
            return { name: normalized.name ?? charWs.card.name, json, entryCount: normalized.entries.length };
        }
        catch {
            return null;
        }
    }
    async saveCharacterLorebook(cardId, json) {
        const book = normalizeBook(json);
        if (!book || book.entries.length === 0)
            throw new Error('内嵌世界书缺少条目');
        const charWs = await this.loadCharacter(cardId);
        if (!charWs)
            throw new Error(`角色 ${cardId} 不存在`);
        const handle = await this.workspace(cardId);
        await handle.fs.writeText('assets/character-book.json', JSON.stringify(json, null, 2) + '\n');
        const cardJson = { ...charWs.card, characterBook: book };
        delete cardJson.pngBytes;
        await handle.fs.writeText('card.json', JSON.stringify(cardJson, null, 2) + '\n');
        this.bumpAssetRev(`charlore:${cardId}`);
        return { name: book.name ?? charWs.card.name, entryCount: book.entries.length };
    }
    async saveCharacter(cardId, patch) {
        const charWs = await this.loadCharacter(cardId);
        if (!charWs)
            throw new Error(`角色 ${cardId} 不存在`);
        if (patch.name !== undefined && !patch.name.trim())
            throw new Error('角色名不能为空');
        const next = applyCharacterPatch(charWs.card, patch);
        const handle = await this.workspace(cardId);
        const { pngBytes: _png, ...cardJson } = next;
        await handle.fs.writeText('card.json', JSON.stringify(cardJson, null, 2) + '\n');
        this.bumpAssetRev(`card:${cardId}`);
        return { cardId, name: next.name };
    }
    async createCharacter(name) {
        const card = createBlankCard(name);
        const ws = await importCardToWorkspace(this.paths.characters, card);
        const handle = await this.workspace(ws.cardId);
        await rebuildIndex(handle.fs, estimateTokens);
        this.bumpAssetRev(`card:${ws.cardId}`);
        return ws;
    }
    async exportCharacter(cardId) {
        const charWs = await this.loadCharacter(cardId);
        if (!charWs)
            throw new Error(`角色 ${cardId} 不存在`);
        const json = cardToStJson(charWs.card);
        const handle = await this.workspace(cardId);
        const png = await handle.fs.readBytes('card.png');
        const embedded = embedCardInPng(png, json, charWs.card.spec);
        return { json, pngBase64: Buffer.from(embedded).toString('base64'), name: charWs.card.name };
    }
    async getJournal(cardId) {
        const handle = await this.workspace(cardId);
        return (await handle.fs.readText('journal.md')) ?? '';
    }
    async saveJournal(cardId, text) {
        const handle = await this.workspace(cardId);
        await handle.fs.writeText('journal.md', text);
        await rebuildIndex(handle.fs, estimateTokens);
    }
    async getChatLorebook(cardId) {
        const handle = await this.workspace(cardId);
        const raw = await handle.fs.readText('assets/chat-lorebook.json');
        if (raw === null)
            return { entries: {} };
        try {
            return JSON.parse(raw);
        }
        catch {
            return { entries: {} };
        }
    }
    async saveChatLorebook(cardId, json) {
        parseLorebook(json, { source: 'chat', sourceRef: 'chat-lorebook' });
        const handle = await this.workspace(cardId);
        await handle.fs.writeText('assets/chat-lorebook.json', JSON.stringify(json, null, 2) + '\n');
        this.bumpAssetRev(`chatlore:${cardId}`);
    }
    // ── 世界书库 ─────────────────────────────────────────────────────────────
    async listLorebooks() {
        const fs = await this.rootFs();
        return (await fs.list('library/lorebooks')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    }
    /** 读取世界书原始 JSON（供设置面板编辑）；不存在或损坏返回 null。 */
    async loadLorebookJson(name) {
        const id = this.assetFileId(name);
        const fs = await this.rootFs();
        const raw = await fs.readText(`library/lorebooks/${id}.json`);
        if (raw === null)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    async loadLorebookEntries(name, source) {
        const id = this.assetFileId(name);
        // rev-keyed 解析缓存（source 参与归一化，一并进 key）；归一化抛错不缓存，行为与直读一致。
        const cacheKey = `${id}\0${source}`;
        const rev = this.assetRevs.get(`lore:${id}`) ?? 0;
        const cached = this.loreCache.get(cacheKey);
        if (cached && cached.rev === rev)
            return cached.value;
        const fs = await this.rootFs();
        const raw = await fs.readText(`library/lorebooks/${id}.json`);
        if (raw === null)
            return [];
        const value = parseLorebook(JSON.parse(raw), { source, sourceRef: id });
        this.loreCache.set(cacheKey, { rev, value });
        return value;
    }
    /** 落盘并 bump 修订号，返回磁盘上的 id：调用方（服务层/客户端）之后要按这个 id 打开，不能用原始名。 */
    async saveLorebook(name, json) {
        const id = this.assetFileId(name);
        const fs = await this.rootFs();
        await fs.writeText(`library/lorebooks/${id}.json`, JSON.stringify(json, null, 2) + '\n');
        this.bumpAssetRev(`lore:${id}`);
        return id;
    }
    async deleteLorebook(name) {
        const id = this.assetFileId(name);
        const fs = await this.rootFs();
        await fs.delete(`library/lorebooks/${id}.json`);
        this.bumpAssetRev(`lore:${id}`);
    }
    // ── 预设库 ────────────────────────────────────────────────────────────────
    async listPresets() {
        const fs = await this.rootFs();
        return (await fs.list('library/presets')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
    }
    async listPresetSummaries() {
        const ids = await this.listPresets();
        const out = [];
        for (const id of ids) {
            const preset = await this.loadPreset(id);
            out.push({
                id,
                name: preset?.name?.trim() || id,
                regexCount: preset?.regexScripts?.length ?? 0,
            });
        }
        return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    }
    async loadPreset(id) {
        // rev-keyed 解析缓存。解析失败按 null 缓存并回退默认预设——
        // 损坏的预设文件不该打崩每一步组装（对比 loadLorebookJson / listPersonas 的同类容错）。
        const key = this.assetFileId(id);
        const rev = this.assetRevs.get(`preset:${key}`) ?? 0;
        const cached = this.presetCache.get(key);
        if (cached && cached.rev === rev)
            return cached.value;
        const fs = await this.rootFs();
        const raw = await fs.readText(`library/presets/${key}.json`);
        let value = null;
        if (raw !== null) {
            try {
                value = JSON.parse(raw);
            }
            catch {
                value = null;
            }
        }
        this.presetCache.set(key, { rev, value });
        return value;
    }
    /** 落盘并 bump 修订号，返回磁盘上的 id（identifier 含非法字符时与 preset.identifier 不同）。 */
    async savePreset(preset) {
        const id = this.assetFileId(preset.identifier);
        const fs = await this.rootFs();
        await fs.writeText(`library/presets/${id}.json`, JSON.stringify(preset, null, 2) + '\n');
        this.bumpAssetRev(`preset:${id}`);
        return id;
    }
    async deletePreset(id) {
        const safe = this.assetFileId(id);
        const fs = await this.rootFs();
        await fs.delete(`library/presets/${safe}.json`);
        this.bumpAssetRev(`preset:${safe}`);
    }
    // ── 人设 ─────────────────────────────────────────────────────────────────
    async listPersonas() {
        const fs = await this.rootFs();
        const files = (await fs.list('personas')).filter((f) => f.endsWith('.json'));
        const out = [];
        for (const file of files) {
            try {
                out.push(JSON.parse((await fs.readText(`personas/${file}`))));
            }
            catch {
                // 坏文件跳过
            }
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }
    async loadPersona(id) {
        if (!id)
            return null;
        const fs = await this.rootFs();
        const raw = await fs.readText(`personas/${this.assetFileId(id)}.json`);
        if (raw === null)
            return null;
        try {
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    /**
     * 本会话实际用人设：绑定指定 > 默认页 > 库里只剩一条。
     * 只建了人设、没在芯片/默认页勾选时，{{user}} 仍应展开成人设名而不是 User。
     */
    async resolvePersona(personaId) {
        const bound = await this.loadPersona(personaId);
        const fallback = await this.loadPersona(this.config.defaults.personaId || null);
        if (bound || fallback)
            return pickPersona(bound, fallback, []);
        return pickPersona(null, null, await this.listPersonas());
    }
    /** 落盘并返回磁盘上的 id；id 被净化过时连同 JSON 里的 id 一起改写，避免文件名和内容各说各话。 */
    async savePersona(persona) {
        const id = this.assetFileId(persona.id);
        const fs = await this.rootFs();
        await fs.writeText(`personas/${id}.json`, JSON.stringify({ ...persona, id }, null, 2) + '\n');
        return id;
    }
    async deletePersona(id) {
        const fs = await this.rootFs();
        await fs.delete(`personas/${this.assetFileId(id)}.json`);
    }
    // ── 全局正则 ──────────────────────────────────────────────────────────────
    async listRegexRules() {
        const fs = await this.rootFs();
        const raw = await fs.readText('regex/rules.json');
        if (raw === null)
            return [];
        try {
            return JSON.parse(raw);
        }
        catch {
            return [];
        }
    }
    async saveRegexRules(rules) {
        const fs = await this.rootFs();
        await fs.writeText('regex/rules.json', JSON.stringify(rules, null, 2) + '\n');
    }
    /** 某会话生效的全部正则（全局 + 当前角色卡内嵌 + 当前预设内嵌）。 */
    async rulesFor(binding) {
        const global = await this.listRegexRules();
        const ws = await this.workspace(binding.cardId);
        const raw = await ws.fs.readText('assets/regex-scripts.json');
        let cardRules = [];
        // 解析成功（含空数组）即为确定结论：导入时无条件落盘该文件，`[]` 表示该卡确认无正则，
        // 直接短路。只有文件缺失/损坏（旧导入）才走卡内重编译兜底——否则无正则的卡
        // （大多数）每次组装、每次渲染都要全量读卡重编译一遍，永不收敛。
        let resolved = false;
        if (raw !== null) {
            try {
                cardRules = JSON.parse(raw);
                resolved = Array.isArray(cardRules);
            }
            catch {
                // 损坏走兜底
            }
        }
        if (!resolved) {
            const loaded = await this.loadCharacter(binding.cardId);
            if (loaded) {
                cardRules = compileCardRegexScripts(regexScriptsOf(loaded.card), binding.cardId);
                if (cardRules.length > 0) {
                    await ws.fs.writeText('assets/regex-scripts.json', JSON.stringify(cardRules, null, 2) + '\n');
                }
            }
        }
        let presetRules = [];
        if (binding.presetId) {
            const preset = await this.loadPreset(binding.presetId);
            if (preset?.regexScripts && preset.regexScripts.length > 0) {
                presetRules = compilePresetRegexScripts(preset.regexScripts, binding.presetId);
            }
        }
        return [...global, ...cardRules, ...presetRules];
    }
    // ── 会话绑定 ──────────────────────────────────────────────────────────────
    /**
     * 读会话绑定；若 cardId 对应工作区已删，按名字或「库里只剩一张卡」改写到新 ID。
     * 人设未绑定时，接到默认页或库里唯一一条，避免 {{user}} 落成 User。
     * 回收失败则删除绑定文件并返回 null，避免 UI 把文件夹 ID 当成角色名。
     */
    async loadBinding(sessionId) {
        const parsed = await loadBinding(this.paths, sessionId);
        if (!parsed)
            return null;
        // 快路径：cardId 对应工作区仍在时直接用（resolveStaleBinding 对在册卡只做 cardName 同步），
        // 不必每次读绑定都全库扫描角色目录。只有 cardId 失效（卡被删）才需要全量列表做接回。
        const live = await this.loadCharacter(parsed.cardId);
        const resolved = live
            ? parsed.cardName === live.card.name
                ? parsed
                : { ...parsed, cardName: live.card.name }
            : resolveStaleBinding(parsed, await this.listCharacters());
        if (!resolved) {
            this.clearStandingPins(sessionId);
            await deleteBinding(this.paths, sessionId);
            return null;
        }
        const persona = await this.resolvePersona(resolved.personaId);
        const personaId = persona?.id ?? null;
        const next = personaId !== resolved.personaId ? { ...resolved, personaId } : resolved;
        if (next.cardId !== parsed.cardId || next.cardName !== parsed.cardName || next.personaId !== parsed.personaId) {
            // 自愈是读路径上的写：loadBinding 是热路径且不走 enqueueSessionTask，
            // 从 loadBinding 读到落盘之间用户可能已经换了卡。落盘前复读一次比对，
            // 只有磁盘仍是我们读到的那份才写回；否则丢弃本次自愈（下次读会重新算），
            // 免得在途自愈把用户刚选的角色悄悄覆盖回旧绑定。
            const current = await loadBinding(this.paths, sessionId);
            if (current && current.cardId === parsed.cardId && current.personaId === parsed.personaId) {
                await saveBinding(this.paths, next);
            }
        }
        return next;
    }
    async saveBinding(binding) {
        const ws = await this.loadCharacter(binding.cardId);
        return saveBinding(this.paths, { ...binding, cardName: ws?.card.name ?? binding.cardName });
    }
    /** 绑定不变时复用第一次 standing，避免组装抖动打穿 KV。钉位按会话 × 生成场景（standingPinKey）。 */
    pinStanding(sessionId, generationType, fingerprint, computed) {
        // 钉位表防泄漏：会话关闭没有事件可清，超上限时淘汰最旧条目
        // （被淘汰只是重算一次 standing，无正确性影响）。
        const key = standingPinKey(sessionId, generationType);
        if (this.standingPins.size >= STANDING_PINS_MAX && !this.standingPins.has(key)) {
            const oldest = this.standingPins.keys().next().value;
            if (oldest !== undefined)
                this.standingPins.delete(oldest);
        }
        return pinStandingText(this.standingPins, key, fingerprint, computed);
    }
    /**
     * 组装失败兜底用：只读地取本会话同场景已钉死的 standing，且仅当钉位属于同一张卡才返回。
     * 宁可穿旧同卡钉位也不回退 UNBOUND_STANDING——换段文案会把整个 system 前缀打穿成 0% 缓存。
     * 指纹第三段是 cardId（standingFingerprint 布局），\0 分隔不会出现在字段值里。
     */
    peekStanding(sessionId, generationType, cardId) {
        const pin = this.standingPins.get(standingPinKey(sessionId, generationType));
        if (!pin)
            return undefined;
        return pin.fingerprint.split('\0')[2] === cardId ? pin.text : undefined;
    }
    /** 清掉会话全部场景的 standing 钉位（换绑/回收绑定时）。 */
    clearStandingPins(sessionId) {
        const prefix = `${sessionId}\0`;
        for (const key of [...this.standingPins.keys()]) {
            if (key.startsWith(prefix))
                this.standingPins.delete(key);
        }
    }
    bumpAssetRev(key) {
        this.assetRevs.set(key, (this.assetRevs.get(key) ?? 0) + 1);
    }
    /**
     * standing 指纹的资产修订标记（稳定顺序）：绑定预设 + 全局世界书 + 主世界书（库书或卡内嵌书）
     * + 卡 + 会话书 + 人设书，末尾再加一个 config 标记。
     * 编辑/删除经本类写方法 bump；运行期绕开 TavernState 手改文件不捕获（standingPins 进程内，重启即清）。
     * 资产键一律走 assetFileId：绑定里可能存着原始名，与写方法 bump 的键必须是同一个。
     */
    standingRevTags(binding, extra) {
        const presetKey = `preset:${this.assetFileId(binding.presetId ?? '')}`;
        const tags = [`${presetKey}=${this.assetRevs.get(presetKey) ?? 0}`];
        for (const id of binding.lorebookIds) {
            const key = `lore:${this.assetFileId(id)}`;
            tags.push(`${key}=${this.assetRevs.get(key) ?? 0}`);
        }
        const charKey = binding.characterLorebookId
            ? `lore:${this.assetFileId(binding.characterLorebookId)}`
            : `charlore:${binding.cardId}`;
        tags.push(`${charKey}=${this.assetRevs.get(charKey) ?? 0}`);
        tags.push(`card:${binding.cardId}=${this.assetRevs.get(`card:${binding.cardId}`) ?? 0}`);
        tags.push(`chatlore:${binding.cardId}=${this.assetRevs.get(`chatlore:${binding.cardId}`) ?? 0}`);
        if (extra?.personaLorebookId) {
            const key = `lore:${this.assetFileId(extra.personaLorebookId)}`;
            tags.push(`${key}=${this.assetRevs.get(key) ?? 0}`);
        }
        // 设置也进指纹，否则改了设置整个进程生命周期都到不了模型（没有任何写方法会 bump 修订号）。
        // 只取真正决定 standing 字节的键：
        // - characterStrategy 决定多来源条目（含 standing 侧常驻）的落位顺序；
        // - useGroupScoring 决定 inclusion group 里哪条常驻条目胜出；
        // - sampling.maxTokens 决定 trimNonHistory 的裁剪线。
        // 其余世界书键（scanDepth / tokenBudget / contextPercent / 递归 / 大小写等）只影响 turn 层
        // 触发与计费——常驻条目激活不靠键、且豁免预算后不再被截断，改这些键不许白白打穿前缀缓存。
        // 注意：新增会影响 standing 字节的设置键时必须加进这里，否则改动永远到不了模型。
        tags.push(`config=${stableFingerprintHash({
            wiStrategy: this.config.worldInfo.characterStrategy,
            wiScoring: this.config.worldInfo.useGroupScoring,
            out: this.config.sampling.maxTokens,
        })}`);
        return tags;
    }
    /**
     * 模型元数据解析缓存：同 provider+model 复用一次解析结果（含 reasoning 档与上下文窗口），
     * TTL 过期重解析（provider 配置热更后不再拿旧窗口）。失败不缓存（删掉条目让下次重试）；
     * signal 只作用于首次真实解析。
     */
    resolveModelInfoCached(llm, provider, model, signal) {
        const key = `${provider}\0${model}`;
        const cached = this.modelInfoCache.get(key);
        if (cached && Date.now() - cached.at < MODEL_INFO_TTL_MS)
            return cached.promise;
        const promise = llm.resolveModelInfo(provider, model, signal);
        this.modelInfoCache.set(key, { at: Date.now(), promise });
        promise.catch(() => {
            if (this.modelInfoCache.get(key)?.promise === promise)
                this.modelInfoCache.delete(key);
        });
        return promise;
    }
    /** 清掉会话绑定文件；空白新对话复用旧会话时用来去掉上次留下的角色卡。 */
    async clearBinding(sessionId) {
        this.clearStandingPins(sessionId);
        await deleteBinding(this.paths, sessionId);
    }
    // ── 世界书定时状态（工作区内，随 WAL 回滚） ───────────────────────────────
    async loadTimers(cardId, sessionId) {
        const ws = await this.workspace(cardId);
        const raw = await ws.fs.readText(`state/wi-timers/${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
        if (raw === null)
            return structuredClone(EMPTY_TIMER_STATE);
        try {
            return JSON.parse(raw);
        }
        catch {
            return structuredClone(EMPTY_TIMER_STATE);
        }
    }
    async saveTimers(cardId, sessionId, state) {
        const ws = await this.workspace(cardId);
        await ws.fs.writeText(`state/wi-timers/${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`, JSON.stringify(state, null, 2) + '\n');
    }
    // ── 触发日志（内存态，最近一次组装的明细） ────────────────────────────────
    recordTriggerLog(sessionId, lines) {
        // 会话数上限：与 standingPins 同理防无界增长，淘汰最旧会话的日志。
        if (this.triggerLogs.size >= TRIGGER_LOG_SESSIONS_MAX && !this.triggerLogs.has(sessionId)) {
            const oldest = this.triggerLogs.keys().next().value;
            if (oldest !== undefined)
                this.triggerLogs.delete(oldest);
        }
        const max = this.config.triggerLogMax;
        this.triggerLogs.set(sessionId, { at: new Date().toISOString(), lines: lines.slice(0, max) });
    }
    // ── 内部 ─────────────────────────────────────────────────────────────────
    /**
     * 库资产（世界书 / 预设 / 人设）显示名 → 磁盘文件 id。
     * 写盘路径、删除路径、读取路径和修订号键必须共用这一个 id：
     * 曾经出现过「按净化名写文件、按原始名 bump 修订号」，绑定里存的是净化名，
     * standing 指纹于是一直读一个没人 bump 的键，编辑世界书后钉死永不失效。
     */
    assetFileId(name) {
        return name.replace(/[^A-Za-z0-9_一-鿿.-]/g, '_');
    }
    rootFsPromise = null;
    /** 数据目录根的 WorkspaceFs（library/personas/regex 等，非角色工作区，无 WAL）。 */
    rootFs() {
        this.rootFsPromise ??= Promise.resolve(new WorkspaceFs(this.paths.root, null));
        return this.rootFsPromise;
    }
}
