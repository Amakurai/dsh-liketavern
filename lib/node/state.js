/**
 * TavernState：host 侧运行时中枢。
 * 聚合数据目录、设置、各资产存储与工作区句柄，供 remote 服务、工具与组装管线共用。
 */
import { basename, join } from 'node:path';
import { characterEditRevision, jsonEditRevision, personaEditRevision, presetEditRevision, regexEditRevision } from '../state/characterRevision.js';
import { createHash, randomUUID } from 'node:crypto';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { CHAT_WORLDBOOK_PATH, parseChatWorldbookFile, encodeChatWorldbooks, plainChatWorldbook } from '../state/chatWorldbooks.js';
import { characterHelperScripts, characterHelperSettings, helperScriptSettings, parseHelperScriptTrees } from '../core/helperScripts.js';
import { helperJson } from '../core/helperRuntime.js';
import { estimateTokens } from '../core/tokenize.js';
import { compileCardRegexScripts, compilePresetRegexScripts } from '../core/regex.js';
import { normalizeBook, parseJsonCard, parsePngCard, regexScriptsOf, applyCharacterPatch, cardToStJson, createBlankCard, embedCardInPng, withoutEmbeddedCharacterBook } from '../state/card.js';
import { parseLorebook } from '../state/lorebook.js';
import { parseStoredPreset } from '../state/presetStore.js';
import { MemoryStore } from '../state/memory.js';
import { loadTemplateTimers, saveTemplateTimers } from '../state/template.js';
import { Wal } from '../state/wal.js';
import { WorldDeltaStore } from '../state/worlddelta.js';
import { archiveCharacter as archiveCharacterOnDisk, CHARACTER_ARCHIVE_FILE, deleteCharacter as deleteCharacterFromDisk, importCard as importCardToWorkspace, assertValidCardId, listArchivedCharacters, listCharacters, loadCharacter, readCharacterArchiveMetadata, restoreCharacter as restoreCharacterOnDisk, rebuildIndex, } from '../state/workspace.js';
import { WorkspaceFs } from '../state/workspaceFs.js';
import { sweepOrphanTemps } from '../state/atomicWrite.js';
import { resolveStaleBinding } from '../core/binding.js';
import { parsePersona, pickPersona } from '../core/persona.js';
import { pinStandingText, stableFingerprintHash, standingPinKey } from '../core/standingPin.js';
import { assertBindingFileIdentity, deleteBinding, listBindingReferencesForCard, loadBinding, parseSessionBinding, saveBinding } from './bindings.js';
import { ensurePaths, sessionFile } from './paths.js';
import { withWorkspaceLock } from '../state/workspaceLock.js';
import { discardStory, legacyStoryId, newStoryId, readStory, snapshotStory, storyRoot, listStories } from '../state/story.js';
/** 模型元数据缓存 TTL：适配器目录运行期通常不变，但 provider 配置可能热更，过期重解析。 */
const MODEL_INFO_TTL_MS = 5 * 60 * 1000;
/** 触发日志保留的会话数上限（会话关闭无清理事件，防长驻进程无界增长）。 */
const TRIGGER_LOG_SESSIONS_MAX = 64;
/** standing 钉位条数上限（淘汰只会导致重算一次 standing，无正确性影响）。 */
const STANDING_PINS_MAX = 256;
/** 真正的 typert 业务错误：内部保留引用身份供测试/诊断，线上 details 只穿透计数。 */
export class CharacterInUseError extends RemoteError {
    references;
    constructor(references) {
        const sessions = references.sessionIds.length;
        const stories = references.stories.length;
        const corrupt = references.corruptBindingFiles.length;
        const reasons = [
            sessions > 0 ? `${sessions} 个会话绑定` : '',
            stories > 0 ? `${stories} 条剧情引用` : '',
            corrupt > 0 ? `${corrupt} 个损坏绑定无法安全归属` : '',
        ].filter(Boolean).join('、');
        super('tavern/character-in-use', `角色仍有${reasons}，请先清理后再永久删除`, { sessionCount: sessions, storyCount: stories, corruptBindingCount: corrupt });
        this.references = references;
    }
}
/** 永久删除只接受当前仍持有有效收纳标记的角色，阻断旧确认框与直接 RPC。 */
export class CharacterNotArchivedError extends RemoteError {
    constructor(cause) {
        super('tavern/character-not-archived', '角色不在收纳箱或收纳标记已损坏，已拒绝永久删除', {}, cause === undefined ? undefined : { cause });
    }
}
/** 收纳后只允许原会话原 story 更新选项，不允许新绑定绕过活动列表。 */
export class CharacterArchivedError extends RemoteError {
    constructor() {
        super('tavern/character-archived', '角色已在收纳箱，不能创建新会话或切换剧情', {});
    }
}
/** 从资产 JSON 取非空白字符串字段（非对象/非字符串/空白按缺失返回 null）。 */
function stringField(json, key) {
    if (!json || typeof json !== 'object')
        return null;
    const value = json[key];
    return typeof value === 'string' && value.trim() ? value : null;
}
/** 角色卡 raw 可重解析时优先沿用，以保留 data 外的厂商字段；旧空 raw 回退标准导出结构。 */
function preferredCardMetadata(card) {
    if (card.raw && typeof card.raw === 'object' && !Array.isArray(card.raw)) {
        try {
            parseJsonCard(card.raw);
            return card.raw;
        }
        catch {
            // 旧工作区可能只有空对象占位；下方用归一化卡生成完整、可重解析的元数据。
        }
    }
    const fallback = cardToStJson(card);
    if (!fallback || typeof fallback !== 'object' || Array.isArray(fallback)) {
        throw new Error('无法生成角色卡元数据');
    }
    return fallback;
}
/** 在已清掉全部旧别名的元数据上只挂一个 canonical character_book，避免新旧书并存。 */
function attachCharacterBookMetadata(card, book) {
    const metadata = preferredCardMetadata(card);
    const payload = book.raw ?? { name: book.name ?? card.name, entries: book.entries };
    if (metadata.data && typeof metadata.data === 'object' && !Array.isArray(metadata.data)) {
        return { ...metadata, data: { ...metadata.data, character_book: payload } };
    }
    return { ...metadata, character_book: payload };
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
    if (!Array.isArray(rules))
        throw new Error('正则规则必须是数组');
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
    warn;
    /** 宿主作用域持有的布局适配器；agent 销毁不影响其它剧情的注册。 */
    presetAdapter;
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
    /** 本轮已认领尚未入日志的输入（agent/inbox/claimed 按 turn 经会话队列发布；turn/end 清除）。 */
    pendingInputs = new Map();
    pendingTemplateInputs = new Map();
    /** 会话 standing 钉死（键 = 会话 × 生成场景；绑定指纹不变则复用第一次写入的字节）。 */
    standingPins = new Map();
    /**
     * 本步 system-prompt/assemble 实际写入宿主 system 的 standing（宿主在同一步先组装、后 pre-step）。
     * 布局载体必须记录这份字节；钉位复用旧文本而当轮重算不同（如手改文件未触发修订号）时，
     * 按重算结果建计划会让投影每轮都找不到 standing 而失败。
     */
    appliedStanding = new Map();
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
     * plainFs 直写；指纹能捕获（同 MemoryStore 的指纹缓存思路）。楼层 WAL 回滚只写剧情
     * 草稿根，本缓存读取的是共享卡根（rulesFor → workspace(cardId)），回滚不触及；
     * 旧架构（0.1.8 前回滚写卡根）遗留的 floors.ts 回滚后调用已随重构移除。
     * invalidateCardRegex 保留给同尺寸同刻度的极端直写场景手动兜底。
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
    /** 实时助手事件的收口回执；只保留最近 256 轮，历史加载不依赖或回放这些回执。 */
    helperTurnClosures = new Map();
    /** warn 是非致命维护问题的日志出口；host 传入 ctx.logger.warn，测试缺省静默。 */
    constructor(paths, getConfig, warn = () => { }) {
        this.paths = paths;
        this.getConfig = getConfig;
        this.warn = warn;
    }
    async init() {
        await ensurePaths(this.paths);
        // 角色与剧情目录较大，改在各自首次打开时清理；这里只覆盖绑定、资产库与草稿。
        await this.sweepTemps(this.paths.root, (rel) => rel === 'characters');
    }
    /** 清理崩溃遗留的原子写临时文件；只是回收空间，失败不能阻断启动或打开剧情。 */
    async sweepTemps(dir, skipDir) {
        await sweepOrphanTemps(dir, { skipDir }).catch((error) => {
            this.warn(`dsh-tavern: 清理临时文件失败：${error instanceof Error ? error.message : String(error)}`);
        });
    }
    worldInfoFor(binding) { return { ...this.config.worldInfo, ...binding.worldInfo }; }
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
        await this.sweepTemps(root, (rel) => rel === 'stories');
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
        await this.sweepTemps(root);
        return handle;
    }
    async discardUnboundStory(cardId, storyId, sessionId) {
        await withWorkspaceLock(this.paths.sessions, async () => {
            const binding = await loadBinding(this.paths, sessionId);
            if (binding?.storyId === storyId)
                return;
            // loadBinding 的容错 null 也包含读取失败或损坏；有文件却无法确认归属时保留剧情。
            // rename 已完成而随后的读回暂失败，不能导致刚绑定成功的正文被失败清理删除。
            if (!binding && await new WorkspaceFs(this.paths.sessions, null).exists(basename(sessionFile(this.paths, sessionId))))
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
    async forkStory(binding, sessionId, prepare, beforePublish) {
        const source = await this.storyWorkspace(binding.cardId, binding.storyId);
        const id = newStoryId();
        await snapshotStory({ cardRoot: join(this.paths.characters, binding.cardId), sourceRoot: source.fs.root,
            id, sessionId, includeWal: true, prepare, beforePublish });
        return id;
    }
    async listCharacters() {
        return listCharacters(this.paths.characters);
    }
    /** 收纳箱是角色资产视图；卡目录不搬动，已绑定剧情仍可按原 ID 继续读写。 */
    async listArchivedCharacters() {
        return listArchivedCharacters(this.paths.characters);
    }
    async archiveCharacter(cardId) {
        // 与 saveBinding/deleteCharacter 共用 sessions → card 锁序：归档与新绑定只能按一个顺序线性化。
        await withWorkspaceLock(this.paths.sessions, () => archiveCharacterOnDisk(this.paths.characters, cardId));
    }
    async restoreCharacter(cardId) {
        await withWorkspaceLock(this.paths.sessions, () => restoreCharacterOnDisk(this.paths.characters, cardId));
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
    /**
     * 永久删除角色。会话锁先于卡锁，与 saveBinding（绑定 → 剧情快照）同序；
     * 有效收纳标记、引用检查与 rm 处在同一临界区，避免恢复后旧确认或预检后新绑定插入。
     * 任一绑定、已发布 story 或无法归属的损坏 session JSON 存在时
     * 明确拒绝，不再像旧实现那样连带清掉绑定。cascadeDeleteEmbeddedBook=false 时只在
     * 预检通过后把内嵌书抢救到世界书库，失败请求不产生半成品抢救文件。
     */
    async deleteCharacter(cardId) {
        assertValidCardId(cardId);
        const cardRoot = join(this.paths.characters, cardId);
        return withWorkspaceLock(this.paths.sessions, () => withWorkspaceLock(cardRoot, async () => {
            let archived = null;
            let archiveFailure;
            try {
                archived = await readCharacterArchiveMetadata(this.paths.characters, cardId);
            }
            catch (error) {
                archiveFailure = error;
            }
            if (!archived)
                throw new CharacterNotArchivedError(archiveFailure);
            const bindingScan = await listBindingReferencesForCard(this.paths, cardId);
            const references = {
                sessionIds: bindingScan.sessionIds,
                stories: await listStories(cardRoot),
                corruptBindingFiles: bindingScan.corruptFiles,
            };
            if (references.sessionIds.length > 0 || references.stories.length > 0 || references.corruptBindingFiles.length > 0) {
                throw new CharacterInUseError(references);
            }
            let salvagedLorebook = null;
            if (!this.config.cascadeDeleteEmbeddedBook) {
                const book = await this.loadCharacterLorebookRaw(cardId);
                if (book) {
                    // 抢救只创建独立副本，不能按书内同名身份替换用户已有的库书。
                    salvagedLorebook = await this.salvageLorebook(book.name, book.json);
                }
            }
            await deleteCharacterFromDisk(this.paths.characters, cardId);
            // 整卡目录已 rm：以 `${cardId}/` 为前缀的剧情句柄（含 Wal/MemoryStore）与正则缓存
            // 一并逐出，避免后续缓存命中与进程内存滞留；这不撤销在途调用已持有的句柄。
            // Windows 的大小写别名指向同一目录，删除请求与已缓存的 cardId 未必同形；
            // 遗漏别名会让 saveBinding 的锁内存在性检查命中旧卡并重建孤儿剧情。
            const storageKey = (key) => process.platform === 'win32' ? key.toLowerCase() : key;
            const deletedKey = storageKey(cardId);
            for (const key of [...this.workspaces.keys()]) {
                const normalized = storageKey(key);
                if (normalized === deletedKey || normalized.startsWith(`${deletedKey}/`))
                    this.workspaces.delete(key);
            }
            for (const key of this.cardCache.keys()) {
                if (storageKey(key) === deletedKey)
                    this.cardCache.delete(key);
            }
            for (const key of this.cardRegexCache.keys()) {
                if (storageKey(key) === deletedKey)
                    this.cardRegexCache.delete(key);
            }
            return { salvagedLorebook };
        }));
    }
    /** 抢救的分配与写入共用资产锁；按实际路径探测占位，不复用同身份旧后缀或 Windows 别名。 */
    async salvageLorebook(base, json) {
        const fs = await this.rootFs();
        return withWorkspaceLock(fs.root, async () => {
            const clean = this.assetFileId(base.trim() || 'embedded-book');
            const id = await this.probeAvailableAssetId(clean, candidate => fs.exists(`library/lorebooks/${candidate}.json`));
            const path = `library/lorebooks/${id}.json`;
            // 时间戳兜底也必须确认空闲；抢救失败可重试，但绝不能覆盖已有正文。
            if (await fs.exists(path))
                throw new Error('抢救世界书没有可用的空闲文件名，请保留角色并重试');
            const content = stringField(json, 'name') === null && json !== null && typeof json === 'object' && !Array.isArray(json)
                ? { ...json, name: id } : json;
            try {
                await fs.writeText(path, JSON.stringify(content, null, 2) + '\n');
            }
            finally {
                this.bumpAssetRev(`lore:${id}`);
            }
            return id;
        });
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
     * 先在 base 与数字后缀中定位既有身份，再为新资产寻找空槽；不能让较早的空槽
     * 截断身份查找。同身份多份时无法凭修订推断用户选择，必须显式指定文件 ID。
     * 返回目录中的实际拼写，身份字符串仍严格比较；调用方持有整个资产读改写锁。
     */
    async resolveAssetWriteId(fs, dir, name, sameAsset) {
        const base = this.assetFileId(name);
        const baseKey = this.assetFileKey(base);
        const matches = [];
        for (const candidate of await this.assetFileIds(fs, dir)) {
            const key = this.assetFileKey(candidate);
            if (key !== baseKey && !(key.startsWith(`${baseKey}-`) && /^\d+$/.test(key.slice(baseKey.length + 1))))
                continue;
            const raw = await fs.readText(`${dir}/${candidate}.json`);
            if (raw === null)
                continue;
            let existing = null;
            try {
                const json = JSON.parse(raw);
                existing = stringField(json, 'identifier') ?? stringField(json, 'id') ?? stringField(json, 'name');
            }
            catch {
                existing = null;
            }
            // base 是调用方传回的直接目标，保留旧文件缺身份时的修复入口；未知后缀
            // 只接受实际内部身份，不能把坏文件猜成某个资产。Windows fallback 用请求名。
            if (existing !== null ? sameAsset(existing) : key === baseKey && sameAsset(base))
                matches.push(candidate);
        }
        if (matches.length > 1)
            throw new Error('资产身份对应多个文件，请按实际文件 ID 打开后保存');
        if (matches.length === 1)
            return matches[0];
        return this.probeAvailableAssetId(base, async (candidate) => await fs.readText(`${dir}/${candidate}.json`) !== null);
    }
    /** 文件名比较遵守宿主文件系统，目录清单保留实际拼写以便修订号与缓存定位一致。 */
    assetFileKey(id) {
        return process.platform === 'win32' ? id.toLowerCase() : id;
    }
    async assetFileIds(fs, dir) {
        return (await fs.list(dir, { recursive: false }))
            .filter(file => this.assetFileKey(file).endsWith('.json')).map(file => file.slice(0, -5));
    }
    /** 删除角色卡内嵌世界书（规范字段、兼容别名、独立资产与 PNG 元数据一并清理）。非楼层写入，不记 WAL。 */
    async deleteCharacterLorebook(cardId, beforeWrite) {
        assertValidCardId(cardId);
        return withWorkspaceLock(join(this.paths.characters, cardId), async () => {
            const charWs = await this.loadCharacter(cardId);
            if (!charWs)
                throw new Error(`角色 ${cardId} 不存在`);
            const fs = this.plainFs(cardId);
            const cleaned = withoutEmbeddedCharacterBook(charWs.card);
            // 先完成元数据清洗与 PNG 重嵌计算；坏图会在任何删除/写入前失败，不留下半清理状态。
            const metadata = preferredCardMetadata(cleaned);
            const next = { ...cleaned, raw: metadata };
            const currentPng = await fs.readBytes('card.png');
            const rewrittenPng = currentPng
                ? embedCardInPng(currentPng, metadata, next.spec)
                : null;
            const { pngBytes: _png, ...cardJson } = next;
            beforeWrite?.();
            try {
                await fs.delete('assets/character-book.json');
                await fs.writeText('card.json', JSON.stringify(cardJson, null, 2) + '\n');
                if (rewrittenPng)
                    await fs.writeBytes('card.png', rewrittenPng);
            }
            finally {
                this.bumpAssetRev(`charlore:${cardId}`);
            }
        });
    }
    /** 导入角色卡（PNG/JSON 字节），落盘工作区并初始化索引。 */
    async importCharacter(fileName, bytes, opts) {
        const card = /\.png$/i.test(fileName) ? parsePngCard(bytes) : parseJsonCard(JSON.parse(new TextDecoder().decode(bytes)));
        const ws = await importCardToWorkspace(this.paths.characters, card, opts);
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
        if (book) {
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
            if (!normalized)
                return null;
            return { name: normalized.name ?? charWs.card.name, json, entryCount: normalized.entries.length };
        }
        catch {
            return null;
        }
    }
    async saveCharacterLorebook(cardId, json, expectedRevision, beforeWrite) {
        assertValidCardId(cardId);
        return withWorkspaceLock(join(this.paths.characters, cardId), async () => {
            const book = normalizeBook(json);
            if (!book)
                throw new Error('内嵌世界书缺少合法结构');
            const charWs = await this.loadCharacter(cardId);
            if (!charWs)
                throw new Error(`角色 ${cardId} 不存在`);
            if (expectedRevision !== undefined) {
                const current = await this.loadCharacterLorebookRaw(cardId);
                if ((current ? jsonEditRevision(current.json) : null) !== expectedRevision) {
                    throw new Error('内嵌世界书已被修改或删除，请保留草稿并重新打开后再保存');
                }
            }
            const fs = this.plainFs(cardId);
            // 旧卡可能同时含 character_book/lorebook/characterBook/world 等兼容落点；
            // 先统一清除，再只写一个 canonical character_book，避免导出时新旧两本书并存。
            const cleaned = withoutEmbeddedCharacterBook(charWs.card);
            const nextWithoutRaw = { ...cleaned, characterBook: book };
            const next = {
                ...nextWithoutRaw,
                raw: attachCharacterBookMetadata(cleaned, book),
            };
            const { pngBytes: _png, ...cardJson } = next;
            beforeWrite?.();
            try {
                await fs.writeText('assets/character-book.json', JSON.stringify(json, null, 2) + '\n');
                await fs.writeText('card.json', JSON.stringify(cardJson, null, 2) + '\n');
            }
            finally {
                this.bumpAssetRev(`charlore:${cardId}`);
            }
            return { name: book.name ?? charWs.card.name, entryCount: book.entries.length, revision: jsonEditRevision(json) };
        });
    }
    async saveCharacter(cardId, patch, expectedRevision) {
        assertValidCardId(cardId);
        return withWorkspaceLock(join(this.paths.characters, cardId), async () => {
            const charWs = await this.loadCharacter(cardId);
            if (!charWs)
                throw new Error(`角色 ${cardId} 不存在`);
            // 工作区锁同时覆盖版本比较和写入；旧编辑器不能把新正文覆盖回去。
            if (expectedRevision !== undefined && expectedRevision !== characterEditRevision(charWs.card)) {
                throw new Error('角色已被其他编辑器修改；草稿已保留，请复制草稿后重新打开角色并合并修改');
            }
            if (patch.name !== undefined && !patch.name.trim())
                throw new Error('角色名不能为空');
            const next = applyCharacterPatch(charWs.card, patch);
            const { pngBytes: _png, ...cardJson } = next;
            await this.plainFs(cardId).writeText('card.json', JSON.stringify(cardJson, null, 2) + '\n');
            this.bumpAssetRev(`card:${cardId}`);
            return { cardId, name: next.name, revision: characterEditRevision(next) };
        });
    }
    async createCharacter(name) {
        const card = createBlankCard(name);
        const ws = await importCardToWorkspace(this.paths.characters, card);
        this.bumpAssetRev(`card:${ws.cardId}`);
        return ws;
    }
    /** 脚本树修订只覆盖脚本资产；用户同时修改描述等其它字段时，保存脚本不得覆盖它们。 */
    async getCharacterHelperScripts(cardId) {
        assertValidCardId(cardId);
        const character = await this.loadCharacter(cardId);
        if (!character)
            throw new Error('角色不存在');
        const trees = characterHelperScripts(character.card.extensions);
        const revision = createHash('sha256').update(JSON.stringify(helperJson(trees, 4 * 1024 * 1024))).digest('hex');
        return { cardId, trees, revision };
    }
    async saveCharacterHelperScripts(cardId, revision, input, beforeWrite) {
        assertValidCardId(cardId);
        const trees = parseHelperScriptTrees(input);
        // 归一化后再次校验预算，确保写出的资产下一次能够直接读取。
        parseHelperScriptTrees(trees);
        return withWorkspaceLock(join(this.paths.characters, cardId), async () => {
            const current = await this.getCharacterHelperScripts(cardId);
            beforeWrite?.();
            if (JSON.stringify(current.trees) === JSON.stringify(trees))
                return current;
            if (current.revision !== revision)
                throw new Error('脚本库已被其他编辑器修改，请重新读取后合并');
            const workspace = await this.loadCharacter(cardId);
            if (!workspace)
                throw new Error('角色不存在');
            const extensions = { ...workspace.card.extensions, tavern_helper: { ...characterHelperSettings(workspace.card.extensions), scripts: trees } };
            delete extensions.TavernHelper_scripts;
            const { pngBytes: _png, ...card } = workspace.card;
            beforeWrite?.();
            try {
                await this.plainFs(cardId).writeText('card.json', JSON.stringify({ ...card, extensions }, null, 2) + '\n');
            }
            finally {
                this.bumpAssetRev(`card:${cardId}`);
            }
            return this.getCharacterHelperScripts(cardId);
        });
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
    /** 全局脚本与预设脚本是共享资产；运行变量继续归属当前剧情，不在此处初始化。 */
    async getHelperScriptLibrary(target) {
        if (target.type === 'character') {
            const library = await this.getCharacterHelperScripts(target.cardId);
            return { target: { type: 'character', cardId: library.cardId }, revision: library.revision, trees: library.trees };
        }
        let input = [];
        if (target.type === 'global') {
            const raw = await (await this.rootFs()).readText('library/helper-scripts.json');
            if (raw !== null)
                input = JSON.parse(raw);
        }
        else if (target.type === 'preset') {
            if (!target.presetId)
                throw new Error('预设 ID 不能为空');
            const id = this.assetFileId(target.presetId), preset = await this.loadPreset(id);
            if (!preset)
                throw new Error('预设不存在或无法读取');
            input = helperScriptSettings(preset.helperSettings ?? {}).scripts;
            target = { type: 'preset', presetId: id };
        }
        else
            throw new Error('脚本库类型无效');
        const trees = parseHelperScriptTrees(input);
        return { target, trees, revision: createHash('sha256').update(JSON.stringify(helperJson(trees, 4 * 1024 * 1024))).digest('hex') };
    }
    async saveHelperScriptLibrary(target, revision, input, beforeWrite) {
        if (target.type === 'character') {
            const library = await this.saveCharacterHelperScripts(target.cardId, revision, input, beforeWrite);
            return { target: { type: 'character', cardId: library.cardId }, revision: library.revision, trees: library.trees };
        }
        const trees = parseHelperScriptTrees(parseHelperScriptTrees(input)), fs = await this.rootFs();
        return withWorkspaceLock(fs.root, async () => {
            const current = await this.getHelperScriptLibrary(target);
            beforeWrite?.();
            if (JSON.stringify(current.trees) === JSON.stringify(trees))
                return current;
            if (current.revision !== revision)
                throw new Error('脚本库已被其他编辑器修改，请重新读取后合并');
            if (current.target.type === 'global')
                await fs.writeText('library/helper-scripts.json', JSON.stringify(trees, null, 2) + '\n');
            else if (current.target.type === 'preset') {
                const id = current.target.presetId, preset = await this.loadPreset(id);
                if (!preset)
                    throw new Error('预设不存在或无法读取');
                beforeWrite?.();
                try {
                    await fs.writeText(`library/presets/${id}.json`, JSON.stringify({ ...preset, helperSettings: { ...preset.helperSettings, scripts: trees } }, null, 2) + '\n');
                }
                finally {
                    this.bumpAssetRev(`preset:${id}`);
                }
            }
            return this.getHelperScriptLibrary(current.target);
        });
    }
    /** 沙箱只选择库类型，资产身份始终从绑定中派生；绑定锁覆盖校验到资产落盘。 */
    helperScriptBinding(binding) {
        if (!binding?.storyId)
            throw new Error('会话未绑定可用剧情');
        if (!this.config.interactiveCards || binding.interactiveCards === false)
            throw new Error('交互卡已关闭');
        const revision = createHash('sha256').update(JSON.stringify([binding.cardId, binding.presetId, binding.storyId])).digest('hex');
        const target = (type) => {
            if (type === 'global')
                return { type };
            if (type === 'character')
                return { type, cardId: binding.cardId };
            if (type === 'preset' && binding.presetId)
                return { type, presetId: binding.presetId };
            throw new Error('未绑定目标脚本库');
        };
        return { binding, revision, target };
    }
    async getSessionHelperScripts(sessionId, storyId) {
        return withWorkspaceLock(this.paths.sessions, async () => {
            const selected = this.helperScriptBinding(await this.loadBindingNow(sessionId));
            if (selected.binding.storyId !== storyId)
                throw new Error('脚本剧情绑定已改变');
            // 绑定的预设被删除或文件损坏时，组装已回退默认预设（loadPreset 容错为 null）；脚本库同样按
            // 「没有预设脚本」处理。否则同一绑定下每条含 HTML 的回复渲染、脚本包加载与自动 MVU 收口
            // 都会抛「预设不存在」，直到用户重新选预设。显式的脚本编辑器路径仍保持严格报错。
            const presetId = selected.binding.presetId;
            const hasPreset = presetId !== null && await this.loadPreset(presetId) !== null;
            const types = ['global', ...(hasPreset ? ['preset'] : []), 'character'];
            const libraries = await Promise.all(types.map(async (type) => {
                const library = await this.getHelperScriptLibrary(selected.target(type));
                return { type, revision: library.revision, trees: library.trees };
            }));
            helperJson(libraries, 4 * 1024 * 1024);
            return { storyId, bindingRevision: selected.revision, libraries };
        });
    }
    async commitSessionHelperScripts(sessionId, request, beforeWrite) {
        return withWorkspaceLock(this.paths.sessions, async () => {
            const selected = this.helperScriptBinding(await this.loadBindingNow(sessionId));
            if (selected.binding.storyId !== request.storyId || selected.revision !== request.bindingRevision)
                throw new Error('脚本会话绑定已改变，请重新加载');
            const library = await this.saveHelperScriptLibrary(selected.target(request.type), request.revision, request.trees, () => beforeWrite?.(selected.binding));
            return { type: request.type, revision: library.revision, trees: library.trees };
        });
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
        // 编辑入口不能把损坏正文当作空表，否则下一次保存会永久清空剧情世界书。
        parseChatWorldbookFile(raw);
        return JSON.parse(raw);
    }
    invalidateChatLorebook(cardId, storyId) { assertValidCardId(cardId); this.bumpAssetRev('chatlore:' + cardId + ':' + storyId); }
    async saveChatLorebook(cardId, json, storyId, expectedRevision) {
        parseLorebook(json, { source: 'chat', sourceRef: 'chat-lorebook' });
        const { fs } = await this.plainWorkspace(cardId, storyId);
        return withWorkspaceLock(fs.root, async () => {
            const text = await fs.readText(CHAT_WORLDBOOK_PATH), store = parseChatWorldbookFile(text);
            if (expectedRevision !== undefined && jsonEditRevision(text === null ? { entries: {} } : JSON.parse(text)) !== expectedRevision) {
                throw new Error('聊天世界书已被另一窗口或卡面修改，请保留草稿并重新打开后再保存');
            }
            const id = store.active ?? (!store.books.has('main') ? 'main' : 'book-' + randomUUID()), previous = store.books.get(id);
            store.books.set(id, { ...previous, ...plainChatWorldbook(json) });
            store.active = id;
            const content = encodeChatWorldbooks(store);
            try {
                await fs.writeText(CHAT_WORLDBOOK_PATH, JSON.stringify(content, null, 2) + '\n');
            }
            finally {
                this.bumpAssetRev(`chatlore:${cardId}${storyId ? ':' + storyId : ''}`);
            }
            return jsonEditRevision(content);
        });
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
        const rev = this.assetRevision(`lore:${id}`);
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
    async saveLorebook(name, json, beforeWrite) {
        return (await this.saveLorebookSnapshot(name, json, undefined, beforeWrite)).name;
    }
    /** 编辑按实际文件 ID 核对版本并写回同一文件；导入与新建仍按内部名称分配身份。 */
    async saveLorebookSnapshot(name, json, expectedRevision, beforeWrite) {
        const fs = await this.rootFs();
        return withWorkspaceLock(fs.root, async () => {
            let id;
            let identity = name;
            if (expectedRevision !== undefined && expectedRevision !== null) {
                // 编辑器返回的 name 是文件定位信息，不能净化后转向另一文件，也不在删除后查找同名副本。
                if (typeof name !== 'string' || !name || name === '.' || name === '..' || this.assetFileId(name) !== name) {
                    throw new Error('非法的世界书文件 ID');
                }
                if (typeof expectedRevision !== 'string' || !expectedRevision) {
                    throw new Error('世界书已被另一窗口修改或删除，请保留草稿并重新打开后再保存');
                }
                const actual = (await this.assetFileIds(fs, 'library/lorebooks')).find(candidate => this.assetFileKey(candidate) === this.assetFileKey(name));
                if (!actual)
                    throw new Error('世界书已被另一窗口修改或删除，请保留草稿并重新打开后再保存');
                id = actual;
                const raw = await fs.readText(`library/lorebooks/${id}.json`);
                if (raw === null)
                    throw new Error('世界书已被另一窗口修改或删除，请保留草稿并重新打开后再保存');
                const previous = JSON.parse(raw);
                if (jsonEditRevision(previous) !== expectedRevision) {
                    throw new Error('世界书已被另一窗口修改或删除，请保留草稿并重新打开后再保存');
                }
                identity = stringField(previous, 'name') ?? id;
                const incomingName = stringField(json, 'name');
                if (incomingName !== null && incomingName !== identity)
                    throw new Error('世界书的内部名称不可修改，请保留原身份或另行导入新世界书');
            }
            else {
                // ST 面板导出可能没有 name；本地持久身份需补原始导入名，避免净化撞名的两本书混在一起。
                identity = stringField(json, 'name') ?? name;
                id = await this.resolveAssetWriteId(fs, 'library/lorebooks', name, (existing) => existing === identity);
                if (expectedRevision === null && await fs.readText(`library/lorebooks/${id}.json`) !== null) {
                    throw new Error('世界书已被另一窗口修改或删除，请保留草稿并重新打开后再保存');
                }
            }
            const content = stringField(json, 'name') === null && json !== null && typeof json === 'object' && !Array.isArray(json)
                ? { ...json, name: identity } : json;
            beforeWrite?.();
            try {
                await fs.writeText(`library/lorebooks/${id}.json`, JSON.stringify(content, null, 2) + '\n');
            }
            finally {
                this.bumpAssetRev(`lore:${id}`);
            }
            return { name: id, revision: jsonEditRevision(content) };
        });
    }
    async deleteLorebook(name, beforeWrite) {
        const id = this.assetFileId(name);
        const fs = await this.rootFs();
        await withWorkspaceLock(fs.root, async () => {
            beforeWrite?.();
            try {
                await fs.delete(`library/lorebooks/${id}.json`);
            }
            finally {
                this.bumpAssetRev(`lore:${id}`);
            }
        });
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
        const rev = this.assetRevision(`preset:${key}`);
        const cached = this.presetCache.get(key);
        if (cached && cached.rev === rev)
            return cached.value;
        const fs = await this.rootFs();
        const raw = await fs.readText(`library/presets/${key}.json`);
        let value = null;
        if (raw !== null) {
            try {
                value = parseStoredPreset(JSON.parse(raw));
            }
            catch {
                value = null;
            }
        }
        this.presetCache.set(key, { rev, value });
        return value;
    }
    /** 落盘并 bump 修订号，返回磁盘上的 id（identifier 含非法字符时与 preset.identifier 不同）。 */
    async savePreset(preset, options = {}) {
        return (await this.savePresetSnapshot(preset, options)).id;
    }
    async savePresetSnapshot(preset, options = {}) {
        preset = parseStoredPreset(preset);
        const fs = await this.rootFs();
        return withWorkspaceLock(fs.root, async () => {
            // 预设身份是 identifier（编辑器内不可改，name 可改）：改名是编辑不是冲突。
            let id;
            if (options.id !== undefined) {
                // 编辑器选中的文件是定位信息，不能净化后改指另一个文件，或在删除后另找同身份副本。
                if (typeof options.id !== 'string' || !options.id || this.assetFileId(options.id) !== options.id)
                    throw new Error('非法的预设文件 ID');
                if (typeof options.expectedRevision !== 'string' || !options.expectedRevision) {
                    throw new Error('明确保存预设文件时必须携带修订版本；预设已被另一窗口修改或删除，请保留草稿并重新打开后再保存');
                }
                const requestedId = options.id;
                const actual = (await this.assetFileIds(fs, 'library/presets')).find(candidate => this.assetFileKey(candidate) === this.assetFileKey(requestedId));
                if (!actual)
                    throw new Error('预设已被另一窗口修改或删除，请保留草稿并重新打开后再保存');
                id = actual;
            }
            else {
                id = await this.resolveAssetWriteId(fs, 'library/presets', preset.identifier, (existing) => existing === preset.identifier);
            }
            // 编辑严格读取实际文件；显式导入仍按文件替换，允许修复同身份的损坏预设。
            const raw = options.id !== undefined || options.preserveHelperSettings || options.expectedRevision !== undefined
                ? await fs.readText(`library/presets/${id}.json`) : null;
            const previous = raw === null ? null : parseStoredPreset(JSON.parse(raw));
            if (options.id !== undefined && previous?.identifier !== preset.identifier) {
                throw new Error('预设的 identifier 不可修改，请保留原身份或另行导入新预设');
            }
            if (options.expectedRevision !== undefined && (previous ? presetEditRevision(previous) : null) !== options.expectedRevision) {
                throw new Error('预设已被另一窗口修改或删除，请保留草稿并重新打开后再保存');
            }
            const value = previous && options.preserveHelperSettings ? { ...preset, helperSettings: previous.helperSettings } : preset;
            if (value.helperSettings !== undefined)
                value.helperSettings = helperScriptSettings(value.helperSettings);
            try {
                await fs.writeText(`library/presets/${id}.json`, JSON.stringify(value, null, 2) + '\n');
            }
            finally {
                this.bumpAssetRev(`preset:${id}`);
            }
            return { id, revision: presetEditRevision(value) };
        });
    }
    async deletePreset(id) {
        const safe = this.assetFileId(id);
        const fs = await this.rootFs();
        await withWorkspaceLock(fs.root, async () => {
            try {
                await fs.delete(`library/presets/${safe}.json`);
            }
            finally {
                this.bumpAssetRev(`preset:${safe}`);
            }
        });
    }
    // ── 人设 ─────────────────────────────────────────────────────────────────
    async listPersonas() {
        const fs = await this.rootFs();
        const files = (await fs.list('personas')).filter((f) => f.endsWith('.json'));
        // 并行读取：人设是设置面板与芯片的高频列表，串行 await 会线性放大 I/O 等待。
        const parsed = await Promise.all(files.map(async (file) => {
            try {
                return parsePersona(JSON.parse((await fs.readText(`personas/${file}`))));
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
        const rev = this.assetRevision(`persona:${key}`);
        const cached = this.personaCache.get(key);
        if (cached && cached.rev === rev)
            return cached.value;
        const fs = await this.rootFs();
        const raw = await fs.readText(`personas/${key}.json`);
        let value = null;
        if (raw !== null) {
            try {
                value = parsePersona(JSON.parse(raw));
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
    async savePersona(persona, expectedRevision) {
        persona = parsePersona(persona);
        const fs = await this.rootFs();
        return withWorkspaceLock(fs.root, async () => {
            // 人设身份是 id（客户端生成，编辑器内不可改，name 可改）：改名是编辑不是冲突。
            // 文件内的 id 是落盘时改写过的净化 id，故原始 id 与净化 id 都认作同一资产。
            const clean = this.assetFileId(persona.id);
            const id = await this.resolveAssetWriteId(fs, 'personas', persona.id, (existing) => existing === persona.id || existing === clean);
            if (expectedRevision !== undefined) {
                const raw = await fs.readText(`personas/${id}.json`);
                const existing = raw === null ? null : parsePersona(JSON.parse(raw));
                if ((existing === null ? null : personaEditRevision(existing)) !== expectedRevision) {
                    throw new Error('人设已被另一窗口修改或删除，请保留草稿，重新打开最新人设后再保存');
                }
            }
            // 修订号属于编辑协议；即使内部调用传来列表对象也不污染持久化的人设数据。
            const { revision: _revision, ...value } = persona;
            try {
                await fs.writeText(`personas/${id}.json`, JSON.stringify({ ...value, id }, null, 2) + '\n');
            }
            finally {
                this.bumpAssetRev(`persona:${id}`);
            }
            return id;
        });
    }
    async deletePersona(id) {
        const key = this.assetFileId(id);
        const fs = await this.rootFs();
        await withWorkspaceLock(fs.root, async () => {
            try {
                await fs.delete(`personas/${key}.json`);
            }
            finally {
                this.bumpAssetRev(`persona:${key}`);
            }
        });
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
    /** 编辑读取不使用热缓存的损坏容错：不能把损坏文件伪装成空列表并授权覆盖。 */
    async getRegexRulesSnapshot() {
        const fs = await this.rootFs();
        const raw = await fs.readText('regex/rules.json');
        const rules = raw === null ? [] : JSON.parse(raw);
        assertValidRegexRules(rules);
        return { rules, revision: regexEditRevision(rules) };
    }
    async saveRegexRules(rules, expectedRevision) {
        // 逐条结构校验：合法 JSON 但字段缺失的规则落盘后会在渲染/组装时才抛错，必须在写盘边界挡下。
        rules = structuredClone(rules);
        assertValidRegexRules(rules);
        const fs = await this.rootFs();
        return withWorkspaceLock(fs.root, async () => {
            if (expectedRevision !== undefined && (await this.getRegexRulesSnapshot()).revision !== expectedRevision) {
                throw new Error('正则规则已被另一窗口修改，请保留草稿，刷新最新规则后再保存');
            }
            try {
                await fs.writeText('regex/rules.json', JSON.stringify(rules, null, 2) + '\n');
            }
            finally {
                this.bumpAssetRev('regex:global');
            }
            return regexEditRevision(rules);
        });
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
    /** 作废卡级正则缓存：绕过写路径的同尺寸同刻度直写（如外部工具改文件）后手动调用；WAL 回滚不触及共享卡根，无需调用。 */
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
    async loadBinding(sessionId, strictRead = false) {
        await this.waitForBindingAdoption(sessionId);
        return this.loadBindingUnwaited(sessionId, strictRead);
    }
    /** 绑定接管须在工作区锁外等待；调用方随后可在 sessions 锁内复核，避免子分支等待父分支时互锁。 */
    async waitForBindingAdoption(sessionId) {
        // 宿主原生分支刚创建时绑定仍在准备；客户端与首轮读取须等它，不能先把子会话当成未绑定。
        const adoption = this.bindingAdoptions.get(sessionId);
        if (adoption)
            await adoption;
        else {
            // 上次失败不是合法未绑定。下一次独立读取只重试一回，并发读共享同一任务；本次失败直接抛出。
            const retry = this.bindingAdoptionRetries.get(sessionId);
            if (retry)
                await this.trackBindingAdoption(sessionId, retry);
        }
    }
    /** 不等待绑定接管的锁内复核，避免接管流程等待自己；写入比较用 strictRead 拒绝不确定的 I/O 结果。 */
    async loadBindingUnwaited(sessionId, strictRead = false) {
        return withWorkspaceLock(this.paths.sessions, () => this.loadBindingNow(sessionId, strictRead));
    }
    bindingAdoptions = new Map();
    bindingAdoptionRetries = new Map();
    /** 登记宿主原生分支的绑定接管；同步登记，使随后任何 loadBinding 都先等它结束。 */
    trackBindingAdoption(sessionId, work) {
        const pending = this.bindingAdoptions.get(sessionId);
        if (pending)
            return pending;
        this.bindingAdoptionRetries.delete(sessionId);
        const run = Promise.resolve().then(work);
        const tracked = run.then(value => {
            if (this.bindingAdoptions.get(sessionId) === tracked)
                this.bindingAdoptions.delete(sessionId);
            return value;
        }, error => {
            if (this.bindingAdoptions.get(sessionId) === tracked) {
                this.bindingAdoptions.delete(sessionId);
                this.bindingAdoptionRetries.set(sessionId, work);
            }
            throw error;
        });
        this.bindingAdoptions.set(sessionId, tracked);
        return tracked;
    }
    async loadBindingNow(sessionId, strictRead = false) {
        const parsed = await loadBinding(this.paths, sessionId, strictRead);
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
        // 绑定与剧情元数据均来自磁盘，不能只信任保存时的校验。否则手改/损坏的 storyId
        // 会让运行中的两个会话共享可变状态；自愈落盘和任何开层之前必须复核实际归属。
        const story = await readStory(join(this.paths.characters, next.cardId), next.storyId);
        if (story.sessionId !== sessionId)
            throw new Error('剧情状态属于另一会话，必须通过分支快照继承');
        if (next.cardId !== parsed.cardId || next.cardName !== parsed.cardName || next.personaId !== parsed.personaId || next.storyId !== parsed.storyId) {
            // 自愈是读路径上的写：loadBinding 是热路径且不走 enqueueSessionTask，
            // 从 loadBinding 读到落盘之间用户可能已经换了卡。落盘前复读一次比对，
            // 只有磁盘仍是我们读到的那份才写回；否则丢弃本次自愈（下次读会重新算），
            // 免得在途自愈把用户刚选的角色悄悄覆盖回旧绑定。
            const current = await loadBinding(this.paths, sessionId, strictRead);
            if (current && current.cardId === parsed.cardId && current.personaId === parsed.personaId) {
                await saveBinding(this.paths, next);
            }
        }
        return next;
    }
    async saveBinding(binding, beforePublish) {
        // schema 失败不能发生在剧情已经发布之后，否则一次非法表单也会遗留永久引用。
        binding = parseSessionBinding(binding);
        assertValidCardId(binding.cardId);
        return withWorkspaceLock(this.paths.sessions, async () => {
            await assertBindingFileIdentity(this.paths, binding.sessionId);
            const existing = await loadBinding(this.paths, binding.sessionId, true);
            const sameCard = existing !== null && (process.platform === 'win32'
                ? existing.cardId.toLowerCase() === binding.cardId.toLowerCase() : existing.cardId === binding.cardId);
            // 同一卡片的别名不改变持久化身份，后续计划、已开楼层与回执继续使用原绑定的 cardId。
            if (sameCard && existing)
                binding = { ...binding, cardId: existing.cardId };
            const cardRoot = join(this.paths.characters, binding.cardId);
            return withWorkspaceLock(cardRoot, async () => {
                const ws = await this.loadCharacter(binding.cardId);
                // service 在入队前的存在性检查不能代替这个锁内复核：永久删除可能在
                // 「service 检查通过 → saveBinding 拿到 sessions 锁」之间完成。若继续做快照，
                // 会在已删卡路径下反向创建没有 card.json 的孤儿 story 和新绑定。
                if (!ws)
                    throw new Error(`角色 ${binding.cardId} 不存在`);
                const existingStory = sameCard ? existing?.storyId : undefined;
                const requestedStory = binding.storyId ?? existingStory;
                if (await new WorkspaceFs(cardRoot, null).exists(CHARACTER_ARCHIVE_FILE)) {
                    // 已归档卡只允许原 session 在原 story 上改预设/人设/开场白下标等绑定字段。
                    // 新 session、换卡命中收纳卡、显式切到另一 story 均拒绝；不传 storyId 但能
                    // 从同一既有绑定确定唯一原 story 时，等价于更新原 story，不会新建。
                    if (!existing || !sameCard || !existingStory || requestedStory !== existingStory) {
                        throw new CharacterArchivedError();
                    }
                }
                let id = requestedStory;
                let createdStory = false;
                if (!id) {
                    id = newStoryId();
                    await snapshotStory({ cardRoot, sourceRoot: cardRoot, id, sessionId: binding.sessionId });
                    createdStory = true;
                }
                try {
                    const story = await readStory(cardRoot, id);
                    if (story.sessionId !== binding.sessionId)
                        throw new Error('剧情状态属于另一会话，必须通过分支快照继承');
                    const next = { ...binding, storyId: id, cardName: ws.card.name };
                    // 全部归属校验通过后才通知运行时；同步回调在实际发布之前取消旧请求，不能留下落盘后的异步发信窗口。
                    beforePublish?.(existing, next);
                    await saveBinding(this.paths, next);
                }
                catch (error) {
                    // 只清理本次创建、落盘后仍未绑定的剧情；原剧情与调用方预先准备的分支都保留。
                    if (createdStory)
                        await this.discardUnboundStory(binding.cardId, id, binding.sessionId);
                    throw error;
                }
            });
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
        this.appliedStanding.delete(sessionId);
        const prefix = `${sessionId}\0`;
        for (const key of [...this.standingPins.keys()]) {
            if (key.startsWith(prefix))
                this.standingPins.delete(key);
        }
    }
    /** 共享库资产的 Windows 别名共享修订；缓存与展示继续保留各自请求/实际文件拼写。 */
    assetRevisionKey(key) {
        return process.platform === 'win32' && /^(?:preset|lore|persona):/.test(key) ? key.toLowerCase() : key;
    }
    assetRevision(key) {
        return this.assetRevs.get(this.assetRevisionKey(key)) ?? 0;
    }
    bumpAssetRev(key) {
        this.assetRevs.set(this.assetRevisionKey(key), this.assetRevision(key) + 1);
    }
    /**
     * standing 指纹的资产修订标记（稳定顺序）：绑定预设 + 全局世界书 + 主世界书（库书或卡内嵌书）
     * + 卡 + 会话书 + 人设书，末尾再加一个 config 标记。
     * 编辑/删除经本类写方法 bump；运行期绕开 TavernState 手改文件不捕获（standingPins 进程内，重启即清）。
     * 资产键一律走 assetFileId：绑定里可能存着原始名，与写方法 bump 的键必须是同一个。
     */
    standingRevTags(binding, extra) {
        const presetKey = `preset:${this.assetFileId(binding.presetId ?? '')}`;
        const tags = [`${presetKey}=${this.assetRevision(presetKey)}`];
        for (const id of binding.lorebookIds) {
            const key = `lore:${this.assetFileId(id)}`;
            tags.push(`${key}=${this.assetRevision(key)}`);
        }
        if (!binding.characterLorebookId && binding.useEmbeddedLorebook === false)
            tags.push('character:disabled');
        for (const id of new Set(binding.characterLorebookIds ?? [])) {
            if (id === binding.characterLorebookId)
                continue;
            const key = `lore:${this.assetFileId(id)}`;
            tags.push(`character-additional:${key}=${this.assetRevision(key)}`);
        }
        const charKey = binding.characterLorebookId
            ? `lore:${this.assetFileId(binding.characterLorebookId)}`
            : `charlore:${binding.cardId}`;
        tags.push(`${charKey}=${this.assetRevision(charKey)}`);
        tags.push(`card:${binding.cardId}=${this.assetRevs.get(`card:${binding.cardId}`) ?? 0}`);
        const chatKey = `chatlore:${binding.cardId}${binding.storyId ? ':' + binding.storyId : ''}`;
        tags.push(`${chatKey}=${this.assetRevs.get(chatKey) ?? 0}`);
        if (extra?.personaLorebookId) {
            const key = `lore:${this.assetFileId(extra.personaLorebookId)}`;
            tags.push(`${key}=${this.assetRevision(key)}`);
        }
        // 设置也进指纹，否则改了设置整个进程生命周期都到不了模型（没有任何写方法会 bump 修订号）。
        // 只取真正决定 standing 字节的键：
        // - characterStrategy 决定多来源条目（含 standing 侧常驻）的落位顺序；
        // - useGroupScoring 决定 inclusion group 里哪条常驻条目胜出；
        // - sampling.maxTokens 决定 trimNonHistory 的裁剪线。
        // - prompts 决定预设 main/jailbreak 是否接收角色卡覆盖。
        // 其余世界书键（scanDepth / tokenBudget / contextPercent / 递归 / 大小写等）只影响 turn 层
        // 触发与计费——常驻条目激活不靠键、且豁免预算后不再被截断，改这些键不许白白打穿前缀缓存。
        // 注意：新增会影响 standing 字节的设置键时必须加进这里，否则改动永远到不了模型。
        tags.push(`config=${stableFingerprintHash({
            wiStrategy: this.worldInfoFor(binding).characterStrategy,
            wiScoring: this.worldInfoFor(binding).useGroupScoring,
            out: this.config.sampling.maxTokens,
            // cacheFirstLayout 只影响适配器投影位置，不改 standing 字节，不能并入指纹。
            prompts: { preferCharacterPrompt: this.config.prompts.preferCharacterPrompt,
                preferCharacterInstructions: this.config.prompts.preferCharacterInstructions },
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
