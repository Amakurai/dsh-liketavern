/**
 * TavernState：host 侧运行时中枢。
 * 聚合数据目录、设置、各资产存储与工作区句柄，供 remote 服务、工具与组装管线共用。
 */
import { join } from 'node:path';
import { estimateTokens } from '../core/tokenize.js';
import { compileCardRegexScripts, compilePresetRegexScripts } from '../core/regex.js';
import { normalizeBook, parseJsonCard, parsePngCard, regexScriptsOf, applyCharacterPatch, cardToStJson, createBlankCard, embedCardInPng } from '../state/card.js';
import { parseLorebook } from '../state/lorebook.js';
import { MemoryStore } from '../state/memory.js';
import { loadTemplateTimers, saveTemplateTimers } from '../state/template.js';
import { Wal } from '../state/wal.js';
import { WorldDeltaStore } from '../state/worlddelta.js';
import { deleteCharacter as deleteCharacterFromDisk, importCard as importCardToWorkspace, assertValidCardId, listCharacters, loadCharacter, rebuildIndex, } from '../state/workspace.js';
import { WorkspaceFs } from '../state/workspaceFs.js';
import { resolveStaleBinding } from '../core/binding.js';
import { pickPersona } from '../core/persona.js';
import { pinStandingText, stableFingerprintHash, standingPinKey } from '../core/standingPin.js';
import { clearBindingsForCard, deleteBinding, loadBinding, saveBinding } from './bindings.js';
import { ensurePaths } from './paths.js';
import { withWorkspaceLock } from '../state/workspaceLock.js';
import { discardStory, legacyStoryId, newStoryId, readStory, snapshotStory, storyRoot, listStories } from '../state/story.js';
/** 模型元数据缓存 TTL：适配器目录运行期通常不变，但 provider 配置可能热更，过期重解析。 */
const MODEL_INFO_TTL_MS = 5 * 60 * 1000;
/** 触发日志保留的会话数上限（会话关闭无清理事件，防长驻进程无界增长）。 */
const TRIGGER_LOG_SESSIONS_MAX = 64;
/** standing 钉位条数上限（淘汰只会导致重算一次 standing，无正确性影响）。 */
const STANDING_PINS_MAX = 256;
/** 从资产 JSON 取非空白字符串字段（非对象/非字符串/空白按缺失返回 null）。 */
function stringField(json, key) {
    if (!json || typeof json !== 'object')
        return null;
    const value = json[key];
    return typeof value === 'string' && value.trim() ? value : null;
}
/** RegexScope / RegexTiming 的合法取值（types.ts 只导出类型，取值集合在此守住落盘边界）。 */
const REGEX_SCOPE_VALUES = ['input', 'output', 'prompt'];
const REGEX_TIMING_VALUES = ['assemble', 'send', 'render'];
const CHAT_ROLE_VALUES = ['system', 'user', 'assistant'];
const REGEX_SOURCE_VALUES = ['user', 'card', 'preset'];
function isMember(value, allowed) {
    return typeof value === 'string' && allowed.includes(value);
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function isDepthBound(value) {
    return value === null || (typeof value === 'number' && Number.isFinite(value));
}
/**
 * 全局正则规则落盘前的逐条结构校验（问题7修复）：remote 入参是宽松 schema 的任意 JSON，
 * 字段缺失/类型错误的规则一旦落盘，之后渲染/组装（rule.scopes.includes 等）才抛错。
 * 非法规则在这里抛错，不写盘。
 */
function assertValidRegexRules(rules) {
    for (const [index, rule] of rules.entries()) {
        const where = `第 ${index + 1} 条正则规则`;
        if (!rule || typeof rule !== 'object')
            throw new Error(`${where}不是对象`);
        const r = rule;
        if (typeof r.id !== 'string' || !r.id)
            throw new Error(`${where}缺少 id`);
        const label = `${where}（${r.id}）`;
        if (typeof r.name !== 'string')
            throw new Error(`${label}缺少 name`);
        if (typeof r.find !== 'string' || !r.find)
            throw new Error(`${label}的 find 必须是非空字符串`);
        if (typeof r.replace !== 'string')
            throw new Error(`${label}的 replace 必须是字符串`);
        if (typeof r.enabled !== 'boolean')
            throw new Error(`${label}的 enabled 必须是布尔值`);
        if (!Array.isArray(r.scopes) || r.scopes.some((s) => !isMember(s, REGEX_SCOPE_VALUES))) {
            throw new Error(`${label}的 scopes 只能是 input/output/prompt 数组`);
        }
        if (!Array.isArray(r.timing) || r.timing.some((t) => !isMember(t, REGEX_TIMING_VALUES))) {
            throw new Error(`${label}的 timing 只能是 assemble/send/render 数组`);
        }
        if (!isDepthBound(r.minDepth) || !isDepthBound(r.maxDepth)) {
            throw new Error(`${label}的 minDepth/maxDepth 必须是数字或 null`);
        }
        if (r.substituteRegex !== 0 && r.substituteRegex !== 1 && r.substituteRegex !== 2) {
            throw new Error(`${label}的 substituteRegex 只能是 0/1/2`);
        }
        if (!isMember(r.source, REGEX_SOURCE_VALUES))
            throw new Error(`${label}的 source 只能是 user/card/preset`);
        if (r.roles !== undefined && (!Array.isArray(r.roles) || r.roles.some((role) => !isMember(role, CHAT_ROLE_VALUES)))) {
            throw new Error(`${label}的 roles 只能是 system/user/assistant 数组`);
        }
        if (r.trimStrings !== undefined && !isStringArray(r.trimStrings))
            throw new Error(`${label}的 trimStrings 必须是字符串数组`);
        if (r.trimStringsRegex !== undefined && !isStringArray(r.trimStringsRegex)) {
            throw new Error(`${label}的 trimStringsRegex 必须是字符串数组`);
        }
    }
}
export class TavernState {
    paths;
    getConfig;
    workspaces = new Map();
    triggerLogs = new Map();
    /** 会话当前 turn 号（session/event 的 turn/start 维护；WI/记忆检索按 turn 缓存）。 */
    requestDiagnostics = new Map();
    turnPlans = new Map();
    /** 已成功组装但尚未完成持久化的计划；失败重试只提交快照，不再次执行模板或推进 WI。 */
    pendingTurnPlans = new Map();
    currentTurns = new Map();
    /** 当前 turn 内的 step（pre-step / step/start 维护；turn 开始时为 1）。 */
    currentSteps = new Map();
    /**
     * 步骤收口通知去重标记（sessionId → `turn:nextStep`）：工具执行时注入的【Tavern 步骤】
     * 通知按下一步号去重，防并行工具调用重复注入；turn/end 清除。
     */
    stepNoticeMarks = new Map();
    /**
     * 会话 → 本轮 beginFloor 实际开的楼层（turn/start 记，turn/end 取走）。
     * 同一张卡的并发会话各有独立楼层（`sessionId#tN`），turn 内写入经
     * `WorkspaceFs.withFloor(entry.floor)` 派生实例隔离，互不覆盖（问题1修复）。
     * 不变式：楼层必须由开层那张卡提交。turn 中途换绑/解绑后当前绑定已经是另一张卡，
     * 若按当前绑定提交，开层那张卡的楼层会永远悬在未提交状态；工具写路径也凭
     * entry.cardId 与当前绑定比对，不一致即拒绝写入（见 tools.ts resolveCtx）。
     */
    openFloors = new Map();
    /**
     * 每 turn 一次的 WI/记忆/变化层评估缓存（turn/end 清除）。
     * lastCharMessage / journalText 同轮冻结：第 1 步之后 history 会多出 assistant 文本、
     * journal.md 可能被面板编辑，二者若随步变化会让含 {{lastcharmessage}} 的 turn 侧条目
     * 或 journal 段字节漂移，宿主快照按字节去重即失效——同轮后续步复用第 1 步的值。
     */
    wiCache = new Map();
    /** 已入 inbox 尚未入日志的用户输入文本（agent/inbox/inserted 维护；turn/end 清除）。 */
    pendingInputs = new Map();
    pendingTemplateInputs = new Map();
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
    personaCache = new Map();
    /** 全局正则规则解析缓存（rulesFor 每 step 调一次；saveRegexRules bump `regex:global`）。 */
    globalRegexCache = null;
    /**
     * 卡级正则解析缓存（assets/regex-scripts.json），按 mtime+size 的 stat 指纹失效。
     * 为什么不用 assetRevs 修订号：该文件的写入点都绕开本类写方法——导入走 workspace.ts 的
     * plainFs 直写，楼层 WAL 回滚更是绕过一切写方法把旧内容直接写回磁盘；指纹两条路径都能
     * 捕获（同 MemoryStore 的指纹缓存思路）。同尺寸且同 mtime 刻度的极端回滚指纹兜不住，
     * 由 floors.ts 回滚后手动调 invalidateCardRegex 兜底。
     */
    cardRegexCache = new Map();
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
    /** 资产初始状态与独立剧情状态共用文件面；storyId 缺省仅供初始状态面板及旧数据迁移。 */
    async storyWorkspace(cardId, storyId) {
        if (!storyId)
            return this.workspace(cardId);
        assertValidCardId(cardId);
        const cardRoot = join(this.paths.characters, cardId);
        await readStory(cardRoot, storyId);
        const key = `${cardId}/${storyId}`;
        const cached = this.workspaces.get(key);
        if (cached)
            return cached;
        const root = storyRoot(cardRoot, storyId);
        const wal = new Wal(join(root, 'state/wal'));
        const fs = new WorkspaceFs(root, wal);
        const handle = { fs, wal, memory: new MemoryStore(fs), deltas: new WorldDeltaStore(fs) };
        this.workspaces.set(key, handle);
        return handle;
    }
    async discardUnboundStory(cardId, storyId, sessionId) {
        await withWorkspaceLock(this.paths.sessions, async () => {
            if ((await loadBinding(this.paths, sessionId))?.storyId === storyId)
                return;
            await discardStory(join(this.paths.characters, cardId), storyId, sessionId);
            this.workspaces.delete(`${cardId}/${storyId}`);
        });
    }
    async listStories(cardId) {
        assertValidCardId(cardId);
        return listStories(join(this.paths.characters, cardId));
    }
    /** 准备子剧情，在副本内撤销未继承楼层；准备失败不改变源剧情，也不发布半成品。 */
    async forkStory(binding, sessionId, prepare) {
        const source = await this.storyWorkspace(binding.cardId, binding.storyId);
        const id = newStoryId();
        await snapshotStory({ cardRoot: join(this.paths.characters, binding.cardId), sourceRoot: source.fs.root,
            id, sessionId, includeWal: true, prepare });
        return id;
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
        return this.probeAvailableAssetId(clean, (id) => Promise.resolve(existing.has(id)));
    }
    /** 占用探测：base 被占用时顺次试 -2/-3…（至多 99），再不行退回时间戳后缀。 */
    async probeAvailableAssetId(base, taken) {
        if (!(await taken(base)))
            return base;
        for (let i = 2; i < 100; i++) {
            const candidate = `${base}-${i}`;
            if (!(await taken(candidate)))
                return candidate;
        }
        return `${base}-${Date.now()}`;
    }
    /**
     * assetFileId 多对一净化的冲突检测（问题5修复）：不同显示名可能净化成同一文件 id
     * （「主线 设定」/「主线?设定」→「主线_设定」），后保存者会静默覆盖前者。
     * 落盘前若目标 id 文件已存在且文件内资产身份与本次不同（sameAsset 判定），
     * 另起 -2/-3 后缀，返回实际落盘 id。同身份再保存是编辑（含改名：预设/人设的
     * 身份是 identifier/id，显示名可改），原 id 照常覆盖。
     */
    async resolveAssetWriteId(fs, dir, name, sameAsset) {
        const base = this.assetFileId(name);
        return this.probeAvailableAssetId(base, async (candidate) => {
            const raw = await fs.readText(`${dir}/${candidate}.json`);
            if (raw === null)
                return false;
            let existing = null;
            try {
                const json = JSON.parse(raw);
                existing = stringField(json, 'identifier') ?? stringField(json, 'id') ?? stringField(json, 'name');
            }
            catch {
                existing = null;
            }
            // 文件内取不到身份（损坏/缺字段）时以文件 id 兜底：编辑路径回传的 name 就是
            // 列表给的文件 id，sameAsset 命中即同一资产的再保存；否则按不同资产处理，
            // 宁可另起 id 也不覆盖无法辨认的既有数据。
            return !sameAsset(existing ?? candidate);
        });
    }
    /** 删除角色卡内嵌世界书（assets/character-book.json + card.json 的 characterBook 置空）。非楼层写入，不记 WAL。 */
    async deleteCharacterLorebook(cardId) {
        assertValidCardId(cardId);
        return withWorkspaceLock(join(this.paths.characters, cardId), async () => {
            const charWs = await this.loadCharacter(cardId);
            if (!charWs)
                throw new Error(`角色 ${cardId} 不存在`);
            const fs = this.plainFs(cardId);
            await fs.delete('assets/character-book.json');
            const cardJson = { ...charWs.card, characterBook: null };
            delete cardJson.pngBytes;
            await fs.writeText('card.json', JSON.stringify(cardJson, null, 2) + '\n');
            this.bumpAssetRev(`charlore:${cardId}`);
        });
    }
    /** 导入角色卡（PNG/JSON 字节），落盘工作区并初始化索引。 */
    async importCharacter(fileName, bytes, opts) {
        const card = /\.png$/i.test(fileName) ? parsePngCard(bytes) : parseJsonCard(JSON.parse(new TextDecoder().decode(bytes)));
        const ws = await importCardToWorkspace(this.paths.characters, card, opts);
        await rebuildIndex(this.plainFs(ws.cardId), estimateTokens);
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
        assertValidCardId(cardId);
        return withWorkspaceLock(join(this.paths.characters, cardId), async () => {
            const book = normalizeBook(json);
            if (!book || book.entries.length === 0)
                throw new Error('内嵌世界书缺少条目');
            const charWs = await this.loadCharacter(cardId);
            if (!charWs)
                throw new Error(`角色 ${cardId} 不存在`);
            const fs = this.plainFs(cardId);
            await fs.writeText('assets/character-book.json', JSON.stringify(json, null, 2) + '\n');
            const cardJson = { ...charWs.card, characterBook: book };
            delete cardJson.pngBytes;
            await fs.writeText('card.json', JSON.stringify(cardJson, null, 2) + '\n');
            this.bumpAssetRev(`charlore:${cardId}`);
            return { name: book.name ?? charWs.card.name, entryCount: book.entries.length };
        });
    }
    async saveCharacter(cardId, patch) {
        assertValidCardId(cardId);
        return withWorkspaceLock(join(this.paths.characters, cardId), async () => {
            const charWs = await this.loadCharacter(cardId);
            if (!charWs)
                throw new Error(`角色 ${cardId} 不存在`);
            if (patch.name !== undefined && !patch.name.trim())
                throw new Error('角色名不能为空');
            const next = applyCharacterPatch(charWs.card, patch);
            const { pngBytes: _png, ...cardJson } = next;
            await this.plainFs(cardId).writeText('card.json', JSON.stringify(cardJson, null, 2) + '\n');
            this.bumpAssetRev(`card:${cardId}`);
            return { cardId, name: next.name };
        });
    }
    async createCharacter(name) {
        const card = createBlankCard(name);
        const ws = await importCardToWorkspace(this.paths.characters, card);
        await rebuildIndex(this.plainFs(ws.cardId), estimateTokens);
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
    async getJournal(cardId, storyId) {
        const handle = await this.storyWorkspace(cardId, storyId);
        return (await handle.fs.readText('journal.md')) ?? '';
    }
    async saveJournal(cardId, text, storyId) {
        const { fs } = await this.plainWorkspace(cardId, storyId);
        await fs.writeText('journal.md', text);
        await rebuildIndex(fs, estimateTokens);
    }
    async getChatLorebook(cardId, storyId) {
        const handle = await this.storyWorkspace(cardId, storyId);
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
    async saveChatLorebook(cardId, json, storyId) {
        parseLorebook(json, { source: 'chat', sourceRef: 'chat-lorebook' });
        const { fs } = await this.plainWorkspace(cardId, storyId);
        await fs.writeText('assets/chat-lorebook.json', JSON.stringify(json, null, 2) + '\n');
        this.bumpAssetRev(`chatlore:${cardId}${storyId ? ':' + storyId : ''}`);
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
        const fs = await this.rootFs();
        // 世界书没有独立于显示名的内部 id：身份 = 文件内的 name 字段。json 缺 name 时把传入名
        // 补进文件（ST 世界书本就有 name 字段）——否则「主线 设定」与「主线?设定」这类净化撞名
        // 在磁盘上无法区分，同名再保存与撞名冲突必有一个判错。
        const content = stringField(json, 'name') === null && json !== null && typeof json === 'object' && !Array.isArray(json)
            ? { ...json, name }
            : json;
        const identity = stringField(content, 'name') ?? name;
        const id = await this.resolveAssetWriteId(fs, 'library/lorebooks', name, (existing) => existing === identity);
        await fs.writeText(`library/lorebooks/${id}.json`, JSON.stringify(content, null, 2) + '\n');
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
        // 并行读取：首次进设置面板时全库都没缓存，串行 await 会线性放大 I/O 等待。
        const out = await Promise.all(ids.map(async (id) => {
            const preset = await this.loadPreset(id);
            return {
                id,
                name: preset?.name?.trim() || id,
                regexCount: preset?.regexScripts?.length ?? 0,
            };
        }));
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
        const fs = await this.rootFs();
        // 预设身份是 identifier（编辑器内不可改，name 可改）：改名是编辑不是冲突。
        const id = await this.resolveAssetWriteId(fs, 'library/presets', preset.identifier, (existing) => existing === preset.identifier);
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
        // 并行读取：人设是设置面板与芯片的高频列表，串行 await 会线性放大 I/O 等待。
        const parsed = await Promise.all(files.map(async (file) => {
            try {
                return JSON.parse((await fs.readText(`personas/${file}`)));
            }
            catch {
                return null; // 坏文件跳过
            }
        }));
        return parsed.filter((p) => p !== null).sort((a, b) => a.name.localeCompare(b.name));
    }
    async loadPersona(id) {
        if (!id)
            return null;
        // rev-keyed 解析缓存：resolvePersona 每 step 会被调两次（loadBinding 自愈 + pipeline），
        // 每次都读 1–2 个人设文件。写方法 bump `persona:<id>`，绕开本类手改文件不捕获（重启即清）。
        const key = this.assetFileId(id);
        const rev = this.assetRevs.get(`persona:${key}`) ?? 0;
        const cached = this.personaCache.get(key);
        if (cached && cached.rev === rev)
            return cached.value;
        const fs = await this.rootFs();
        const raw = await fs.readText(`personas/${key}.json`);
        let value = null;
        if (raw !== null) {
            try {
                value = JSON.parse(raw);
            }
            catch {
                value = null;
            }
        }
        this.personaCache.set(key, { rev, value });
        return value;
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
    /** 落盘并返回磁盘上的 id；id 被净化过（含冲突后缀）时连同 JSON 里的 id 一起改写，避免文件名和内容各说各话。 */
    async savePersona(persona) {
        const fs = await this.rootFs();
        // 人设身份是 id（客户端生成，编辑器内不可改，name 可改）：改名是编辑不是冲突。
        // 文件内的 id 是落盘时改写过的净化 id，故原始 id 与净化 id 都认作同一资产。
        const clean = this.assetFileId(persona.id);
        const id = await this.resolveAssetWriteId(fs, 'personas', persona.id, (existing) => existing === persona.id || existing === clean);
        await fs.writeText(`personas/${id}.json`, JSON.stringify({ ...persona, id }, null, 2) + '\n');
        this.bumpAssetRev(`persona:${id}`);
        return id;
    }
    async deletePersona(id) {
        const key = this.assetFileId(id);
        const fs = await this.rootFs();
        await fs.delete(`personas/${key}.json`);
        this.bumpAssetRev(`persona:${key}`);
    }
    // ── 全局正则 ──────────────────────────────────────────────────────────────
    async listRegexRules() {
        // rev-keyed 解析缓存：rulesFor 每 step 调一次，全局规则文件不该每步重读重解析。
        const rev = this.assetRevs.get('regex:global') ?? 0;
        if (this.globalRegexCache && this.globalRegexCache.rev === rev)
            return this.globalRegexCache.value;
        const fs = await this.rootFs();
        const raw = await fs.readText('regex/rules.json');
        let value = [];
        if (raw !== null) {
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed))
                    value = parsed;
            }
            catch {
                value = [];
            }
        }
        this.globalRegexCache = { rev, value };
        return value;
    }
    async saveRegexRules(rules) {
        // 逐条结构校验：合法 JSON 但字段缺失的规则落盘后会在渲染/组装时才抛错，必须在写盘边界挡下。
        assertValidRegexRules(rules);
        const fs = await this.rootFs();
        await fs.writeText('regex/rules.json', JSON.stringify(rules, null, 2) + '\n');
        this.bumpAssetRev('regex:global');
    }
    /** 某会话生效的全部正则（全局 + 当前角色卡内嵌 + 当前预设内嵌）。 */
    async rulesFor(binding) {
        const global = await this.listRegexRules();
        const ws = await this.workspace(binding.cardId);
        const cardRules = await this.cardRegexRules(binding.cardId, ws);
        let presetRules = [];
        if (binding.presetId) {
            const preset = await this.loadPreset(binding.presetId);
            if (preset?.regexScripts && preset.regexScripts.length > 0) {
                presetRules = compilePresetRegexScripts(preset.regexScripts, binding.presetId);
            }
        }
        return [...global, ...cardRules, ...presetRules];
    }
    /** 作废卡级正则缓存：WAL 回滚绕过写路径直写磁盘，由 floors.ts 回滚后调用（见 cardRegexCache）。 */
    invalidateCardRegex(cardId) {
        this.cardRegexCache.delete(cardId);
    }
    /**
     * 卡级正则（assets/regex-scripts.json）带 stat 指纹缓存的读取。
     * rulesFor 每 step 调一次；缓存把每步的全文读 + 解析降成一次 stat。
     */
    async cardRegexRules(cardId, ws) {
        const path = 'assets/regex-scripts.json';
        const info = await ws.fs.stat(path);
        let fingerprint = info ? `${info.mtimeMs}:${info.size}` : 'missing';
        const cached = this.cardRegexCache.get(cardId);
        if (cached && cached.fingerprint === fingerprint)
            return cached.value;
        let cardRules = [];
        // 解析成功（含空数组）即为确定结论：导入时无条件落盘该文件，`[]` 表示该卡确认无正则，
        // 直接短路。只有文件缺失/损坏（旧导入）才走卡内重编译兜底——否则无正则的卡
        // （大多数）每次组装、每次渲染都要全量读卡重编译一遍，永不收敛。编译产物为 `[]` 时
        // 照旧不写回文件，但同样按 missing 指纹进缓存，兜底重编译每卡只跑一次。
        let resolved = false;
        if (info) {
            const raw = await ws.fs.readText(path);
            if (raw !== null) {
                try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) {
                        cardRules = parsed;
                        resolved = true;
                    }
                }
                catch {
                    // 损坏走兜底
                }
            }
        }
        if (!resolved) {
            const loaded = await this.loadCharacter(cardId);
            if (loaded) {
                cardRules = compileCardRegexScripts(regexScriptsOf(loaded.card), cardId);
                if (cardRules.length > 0) {
                    // 兜底重编译是派生缓存的物化，不是楼层写入：共享句柄 floor 恒为 null，不记 WAL；
                    // 回滚不会动这个文件（旧版本楼层若记过它，回滚直写磁盘仍由 stat 指纹捕获）。
                    await ws.fs.writeText(path, JSON.stringify(cardRules, null, 2) + '\n');
                    // 回写改了文件，指纹按新状态重取（仅兜底路径走到，多一次 stat 无所谓）
                    const after = await ws.fs.stat(path);
                    fingerprint = after ? `${after.mtimeMs}:${after.size}` : 'missing';
                }
            }
        }
        this.cardRegexCache.set(cardId, { fingerprint, value: cardRules });
        return cardRules;
    }
    // ── 会话绑定 ──────────────────────────────────────────────────────────────
    /**
     * 读会话绑定；若 cardId 对应工作区已删，按名字或「库里只剩一张卡」改写到新 ID。
     * 人设未绑定时，接到默认页或库里唯一一条，避免 {{user}} 落成 User。
     * 回收失败则删除绑定文件并返回 null，避免 UI 把文件夹 ID 当成角色名。
     */
    async loadBinding(sessionId) {
        return withWorkspaceLock(this.paths.sessions, () => this.loadBindingNow(sessionId));
    }
    async loadBindingNow(sessionId) {
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
        let next = personaId !== resolved.personaId ? { ...resolved, personaId } : resolved;
        if (next.cardId !== parsed.cardId)
            next = { ...next, storyId: undefined, walLineage: undefined };
        if (!next.storyId) {
            const id = legacyStoryId(sessionId);
            const cardRoot = join(this.paths.characters, next.cardId);
            await snapshotStory({ cardRoot, sourceRoot: cardRoot, id, sessionId, migrated: true, includeWal: true });
            next = { ...next, storyId: id };
        }
        if (next.cardId !== parsed.cardId || next.cardName !== parsed.cardName || next.personaId !== parsed.personaId || next.storyId !== parsed.storyId) {
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
        return withWorkspaceLock(this.paths.sessions, async () => {
            const ws = await this.loadCharacter(binding.cardId);
            const existing = await loadBinding(this.paths, binding.sessionId);
            let id = binding.storyId ?? (existing?.cardId === binding.cardId ? existing.storyId : undefined);
            if (!id) {
                id = newStoryId();
                const cardRoot = join(this.paths.characters, binding.cardId);
                await snapshotStory({ cardRoot, sourceRoot: cardRoot, id, sessionId: binding.sessionId });
            }
            const story = await readStory(join(this.paths.characters, binding.cardId), id);
            if (story.sessionId !== binding.sessionId)
                throw new Error('剧情状态属于另一会话，必须通过分支快照继承');
            await saveBinding(this.paths, { ...binding, storyId: id, cardName: ws?.card.name ?? binding.cardName });
        });
    }
    /**
     * 绑定不变时复用第一次 standing，避免组装抖动打穿 KV。钉位按会话 × 生成场景（standingPinKey）。
     * 返回 `reused` 供调用方记观测日志（[standing:pin] hit/recompute）。
     */
    pinStanding(sessionId, generationType, fingerprint, computed) {
        // 钉位表防泄漏：会话关闭没有事件可清，超上限时淘汰最旧条目
        // （被淘汰只是重算一次 standing，无正确性影响）。
        const key = standingPinKey(sessionId, generationType);
        if (this.standingPins.size >= STANDING_PINS_MAX && !this.standingPins.has(key)) {
            const oldest = this.standingPins.keys().next().value;
            if (oldest !== undefined)
                this.standingPins.delete(oldest);
        }
        const reused = this.standingPins.get(key)?.fingerprint === fingerprint;
        return { text: pinStandingText(this.standingPins, key, fingerprint, computed), reused };
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
        const chatKey = `chatlore:${binding.cardId}${binding.storyId ? ':' + binding.storyId : ''}`;
        tags.push(`${chatKey}=${this.assetRevs.get(chatKey) ?? 0}`);
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
    async loadTimers(cardId, sessionId, storyId) {
        const ws = await this.storyWorkspace(cardId, storyId);
        return loadTemplateTimers(ws.fs, sessionId);
    }
    async saveTimers(cardId, sessionId, state, floor, storyId) {
        const ws = await this.storyWorkspace(cardId, storyId);
        // turn 流程传入本轮楼层（openFloors entry）→ 定时器随楼层记 WAL、可回滚；
        // 缺省/null = 非会话写入（fork 复制定时器、楼层未开启的会话），共享句柄 floor 恒 null，不记 WAL。
        const fs = floor ? ws.fs.withFloor(floor) : ws.fs;
        await saveTemplateTimers(fs, sessionId, state);
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
    /**
     * 面板/服务层非会话写入专用的角色工作区文件面：floor 恒为 null，绝不记 WAL。
     * 共享句柄 workspace(cardId).fs 不再携带楼层（楼层由 withFloor 派生实例持有），
     * 生成进行中用户在面板的编辑若复用楼层实例，会被记进当前楼层 WAL，回退楼层时把编辑静默改回旧值。
     * turn 流程内的工具写路径仍走 withFloor 派生实例（快照必须进 WAL），这里只供非会话写路径使用。
     */
    plainFs(cardId) {
        assertValidCardId(cardId);
        return new WorkspaceFs(join(this.paths.characters, cardId), null);
    }
    /**
     * 面板/服务层写路径专用的工作区句柄：floor 恒为 null 的文件面（绝不记 WAL），
     * memory/deltas 建在这个无楼层文件面上。供 service 面板写路径使用；
     * turn 流程内的写路径仍走 workspace(cardId) + withFloor(openFloors 的 entry.floor)。
     */
    async plainWorkspace(cardId, storyId) {
        const handle = await this.storyWorkspace(cardId, storyId);
        const fs = new WorkspaceFs(handle.fs.root, null);
        return { fs, memory: new MemoryStore(fs), deltas: new WorldDeltaStore(fs) };
    }
}
