import type { LlmResolvedModelInfo, LlmRuntime } from '@deepseek-ai/dsh-llm';
import { type MemoryEntry, type PromptPreset, type RegexRule, type WIEngineResult, type WITimerState, type WorldDelta, type WorldInfoEntry } from '../core/types.js';
import { applyCharacterPatch } from '../state/card.js';
import { MemoryStore } from '../state/memory.js';
import type { PipelineResult } from './pipeline.js';
import { Wal } from '../state/wal.js';
import { WorldDeltaStore } from '../state/worlddelta.js';
import { type CharacterWorkspace } from '../state/workspace.js';
import { WorkspaceFs } from '../state/workspaceFs.js';
import { type Persona } from '../core/persona.js';
import { type StandingPin } from '../core/standingPin.js';
import { type SessionBinding } from './bindings.js';
import type { TavernConfig } from './config.js';
import { type TavernPaths } from './paths.js';
export type { Persona } from '../core/persona.js';
interface WorkspaceHandle {
    fs: WorkspaceFs;
    wal: Wal;
    memory: MemoryStore;
    deltas: WorldDeltaStore;
}
export declare class TavernState {
    readonly paths: TavernPaths;
    private readonly getConfig;
    private readonly workspaces;
    readonly triggerLogs: Map<string, {
        at: string;
        lines: string[];
    }>;
    /** 会话当前 turn 号（session/event 的 turn/start 维护；WI/记忆检索按 turn 缓存）。 */
    readonly requestDiagnostics: Map<string, {
        text: string;
        truncated: boolean;
    }>;
    readonly turnPlans: Map<string, {
        turn: number;
        cardId: string;
        storyId?: string;
        result: PipelineResult;
    }>;
    readonly currentTurns: Map<string, number>;
    /** 当前 turn 内的 step（pre-step / step/start 维护；turn 开始时为 1）。 */
    readonly currentSteps: Map<string, number>;
    /**
     * 步骤收口通知去重标记（sessionId → `turn:nextStep`）：工具执行时注入的【Tavern 步骤】
     * 通知按下一步号去重，防并行工具调用重复注入；turn/end 清除。
     */
    readonly stepNoticeMarks: Map<string, string>;
    /**
     * 会话 → 本轮 beginFloor 实际开的楼层（turn/start 记，turn/end 取走）。
     * 同一张卡的并发会话各有独立楼层（`sessionId#tN`），turn 内写入经
     * `WorkspaceFs.withFloor(entry.floor)` 派生实例隔离，互不覆盖（问题1修复）。
     * 不变式：楼层必须由开层那张卡提交。turn 中途换绑/解绑后当前绑定已经是另一张卡，
     * 若按当前绑定提交，开层那张卡的楼层会永远悬在未提交状态；工具写路径也凭
     * entry.cardId 与当前绑定比对，不一致即拒绝写入（见 tools.ts resolveCtx）。
     */
    readonly openFloors: Map<string, {
        cardId: string;
        storyId?: string;
        floor: string;
    }>;
    /**
     * 每 turn 一次的 WI/记忆/变化层评估缓存（turn/end 清除）。
     * lastCharMessage / journalText 同轮冻结：第 1 步之后 history 会多出 assistant 文本、
     * journal.md 可能被面板编辑，二者若随步变化会让含 {{lastcharmessage}} 的 turn 侧条目
     * 或 journal 段字节漂移，宿主快照按字节去重即失效——同轮后续步复用第 1 步的值。
     */
    readonly wiCache: Map<string, {
        turn: number;
        wi: WIEngineResult;
        memories: string[];
        deltas: WorldDelta[];
        lastCharMessage: string;
        journalText: string;
    }>;
    /** 已入 inbox 尚未入日志的用户输入文本（agent/inbox/inserted 维护；turn/end 清除）。 */
    readonly pendingInputs: Map<string, string[]>;
    /** 会话 standing 钉死（键 = 会话 × 生成场景；绑定指纹不变则复用第一次写入的字节）。 */
    readonly standingPins: Map<string, StandingPin>;
    /** standing 依赖资产的进程内修订号：经本类写方法编辑/删除即 bump，standing 指纹随内容变化失效重算。 */
    private readonly assetRevs;
    /**
     * 库资产解析缓存（热路径读盘放大治理）：key 与 assetRevs 的修订号键对应，
     * 写方法 bump 修订号时 tag 变化即失效。绕开 TavernState 手改文件不会被捕获
     * （与 standing 钉死同一语义，重启即清）。返回值视为只读，调用方不得原地修改。
     */
    private readonly presetCache;
    private readonly loreCache;
    private readonly cardCache;
    private readonly personaCache;
    /** 全局正则规则解析缓存（rulesFor 每 step 调一次；saveRegexRules bump `regex:global`）。 */
    private globalRegexCache;
    /**
     * 卡级正则解析缓存（assets/regex-scripts.json），按 mtime+size 的 stat 指纹失效。
     * 为什么不用 assetRevs 修订号：该文件的写入点都绕开本类写方法——导入走 workspace.ts 的
     * plainFs 直写，楼层 WAL 回滚更是绕过一切写方法把旧内容直接写回磁盘；指纹两条路径都能
     * 捕获（同 MemoryStore 的指纹缓存思路）。同尺寸且同 mtime 刻度的极端回滚指纹兜不住，
     * 由 floors.ts 回滚后手动调 invalidateCardRegex 兜底。
     */
    private readonly cardRegexCache;
    /** 模型元数据进程内缓存：resolveModelInfo 每步被调（reasoningEffort / 上下文窗口），带 TTL 防配置热更后拿到旧值。 */
    private readonly modelInfoCache;
    /** 待异步压缩的角色工作区（memory_write 超容量时标记；idle 期 runMaintenance 消费，见 memoryMaintenance.ts）。 */
    readonly pendingMemoryCompress: Set<string>;
    /**
     * 会话事件副作用串行队列。session/event 与 inbox 回调本身不能阻塞平台事件派发，
     * 但 beginFloor / 开场白 / commitFloor / idle maintenance 必须保持事件发生顺序。
     */
    private readonly sessionTaskTails;
    constructor(paths: TavernPaths, getConfig: () => TavernConfig);
    init(): Promise<void>;
    get config(): TavernConfig;
    /**
     * 把一个副作用接到同会话队尾；前一任务失败不会毒死后续队列，调用方仍会收到本次异常。
     * 不同会话互不等待，避免把全局运行时退化成单线程。
     */
    enqueueSessionTask<T>(sessionId: string, task: () => Promise<T> | T): Promise<T>;
    /** 等待调用时已经排入该会话的副作用完成。 */
    waitForSessionTasks(sessionId: string): Promise<void>;
    workspace(cardId: string): Promise<WorkspaceHandle>;
    /** 资产初始状态与独立剧情状态共用文件面；storyId 缺省仅供初始状态面板及旧数据迁移。 */
    storyWorkspace(cardId: string, storyId?: string): Promise<WorkspaceHandle>;
    discardUnboundStory(cardId: string, storyId: string, sessionId: string): Promise<void>;
    listStories(cardId: string): Promise<import("../state/story.js").StorySummary[]>;
    /** 准备子剧情，在副本内撤销未继承楼层；准备失败不改变源剧情，也不发布半成品。 */
    forkStory(binding: SessionBinding, sessionId: string, prepare: (fs: WorkspaceFs) => Promise<void>): Promise<string>;
    listCharacters(): Promise<import("../state/workspace.js").CharacterSummary[]>;
    loadCharacter(cardId: string): Promise<CharacterWorkspace | null>;
    /** 删除角色卡工作区、清掉指向它的会话绑定，并逐出缓存句柄。cascadeDeleteEmbeddedBook=false 时先把内嵌书抢救到世界书库。 */
    deleteCharacter(cardId: string): Promise<{
        salvagedLorebook: string | null;
    }>;
    /** 抢救内嵌书到世界书库时的去重文件名（与 saveLorebook 同一套净化规则）。 */
    private salvageLorebookName;
    /** 占用探测：base 被占用时顺次试 -2/-3…（至多 99），再不行退回时间戳后缀。 */
    private probeAvailableAssetId;
    /**
     * assetFileId 多对一净化的冲突检测（问题5修复）：不同显示名可能净化成同一文件 id
     * （「主线 设定」/「主线?设定」→「主线_设定」），后保存者会静默覆盖前者。
     * 落盘前若目标 id 文件已存在且文件内资产身份与本次不同（sameAsset 判定），
     * 另起 -2/-3 后缀，返回实际落盘 id。同身份再保存是编辑（含改名：预设/人设的
     * 身份是 identifier/id，显示名可改），原 id 照常覆盖。
     */
    private resolveAssetWriteId;
    /** 删除角色卡内嵌世界书（assets/character-book.json + card.json 的 characterBook 置空）。非楼层写入，不记 WAL。 */
    deleteCharacterLorebook(cardId: string): Promise<void>;
    /** 导入角色卡（PNG/JSON 字节），落盘工作区并初始化索引。 */
    importCharacter(fileName: string, bytes: Uint8Array, opts?: {
        importWorldBook?: boolean;
    }): Promise<CharacterWorkspace>;
    /**
     * 读取角色卡内嵌世界书原文（card.characterBook 优先，否则 assets/character-book.json）。
     * 供组装管线、工具与设置面板共用，避免只认 library/lorebooks 而漏掉卡内书。
     */
    loadCharacterLorebookRaw(cardId: string): Promise<{
        name: string;
        json: unknown;
        entryCount: number;
    } | null>;
    saveCharacterLorebook(cardId: string, json: unknown): Promise<{
        name: string;
        entryCount: number;
    }>;
    saveCharacter(cardId: string, patch: Parameters<typeof applyCharacterPatch>[1]): Promise<{
        cardId: string;
        name: string;
    }>;
    createCharacter(name: string): Promise<CharacterWorkspace>;
    exportCharacter(cardId: string): Promise<{
        json: unknown;
        pngBase64: string;
        name: string;
    }>;
    getJournal(cardId: string, storyId?: string): Promise<string>;
    saveJournal(cardId: string, text: string, storyId?: string): Promise<void>;
    getChatLorebook(cardId: string, storyId?: string): Promise<unknown>;
    saveChatLorebook(cardId: string, json: unknown, storyId?: string): Promise<void>;
    listLorebooks(): Promise<string[]>;
    /** 读取世界书原始 JSON（供设置面板编辑）；不存在或损坏返回 null。 */
    loadLorebookJson(name: string): Promise<unknown | null>;
    loadLorebookEntries(name: string, source: WorldInfoEntry['source']): Promise<WorldInfoEntry[]>;
    /** 落盘并 bump 修订号，返回磁盘上的 id：调用方（服务层/客户端）之后要按这个 id 打开，不能用原始名。 */
    saveLorebook(name: string, json: unknown): Promise<string>;
    deleteLorebook(name: string): Promise<void>;
    listPresets(): Promise<string[]>;
    listPresetSummaries(): Promise<Array<{
        id: string;
        name: string;
        regexCount: number;
    }>>;
    loadPreset(id: string): Promise<PromptPreset | null>;
    /** 落盘并 bump 修订号，返回磁盘上的 id（identifier 含非法字符时与 preset.identifier 不同）。 */
    savePreset(preset: PromptPreset): Promise<string>;
    deletePreset(id: string): Promise<void>;
    listPersonas(): Promise<Persona[]>;
    loadPersona(id: string | null): Promise<Persona | null>;
    /**
     * 本会话实际用人设：绑定指定 > 默认页 > 库里只剩一条。
     * 只建了人设、没在芯片/默认页勾选时，{{user}} 仍应展开成人设名而不是 User。
     */
    resolvePersona(personaId: string | null): Promise<Persona | null>;
    /** 落盘并返回磁盘上的 id；id 被净化过（含冲突后缀）时连同 JSON 里的 id 一起改写，避免文件名和内容各说各话。 */
    savePersona(persona: Persona): Promise<string>;
    deletePersona(id: string): Promise<void>;
    listRegexRules(): Promise<RegexRule[]>;
    saveRegexRules(rules: RegexRule[]): Promise<void>;
    /** 某会话生效的全部正则（全局 + 当前角色卡内嵌 + 当前预设内嵌）。 */
    rulesFor(binding: SessionBinding): Promise<RegexRule[]>;
    /** 作废卡级正则缓存：WAL 回滚绕过写路径直写磁盘，由 floors.ts 回滚后调用（见 cardRegexCache）。 */
    invalidateCardRegex(cardId: string): void;
    /**
     * 卡级正则（assets/regex-scripts.json）带 stat 指纹缓存的读取。
     * rulesFor 每 step 调一次；缓存把每步的全文读 + 解析降成一次 stat。
     */
    private cardRegexRules;
    /**
     * 读会话绑定；若 cardId 对应工作区已删，按名字或「库里只剩一张卡」改写到新 ID。
     * 人设未绑定时，接到默认页或库里唯一一条，避免 {{user}} 落成 User。
     * 回收失败则删除绑定文件并返回 null，避免 UI 把文件夹 ID 当成角色名。
     */
    loadBinding(sessionId: string): Promise<SessionBinding | null>;
    private loadBindingNow;
    saveBinding(binding: SessionBinding): Promise<void>;
    /**
     * 绑定不变时复用第一次 standing，避免组装抖动打穿 KV。钉位按会话 × 生成场景（standingPinKey）。
     * 返回 `reused` 供调用方记观测日志（[standing:pin] hit/recompute）。
     */
    pinStanding(sessionId: string, generationType: string, fingerprint: string, computed: string): {
        text: string;
        reused: boolean;
    };
    /**
     * 组装失败兜底用：只读地取本会话同场景已钉死的 standing，且仅当钉位属于同一张卡才返回。
     * 宁可穿旧同卡钉位也不回退 UNBOUND_STANDING——换段文案会把整个 system 前缀打穿成 0% 缓存。
     * 指纹第三段是 cardId（standingFingerprint 布局），\0 分隔不会出现在字段值里。
     */
    peekStanding(sessionId: string, generationType: string, cardId: string): string | undefined;
    /** 清掉会话全部场景的 standing 钉位（换绑/回收绑定时）。 */
    private clearStandingPins;
    private bumpAssetRev;
    /**
     * standing 指纹的资产修订标记（稳定顺序）：绑定预设 + 全局世界书 + 主世界书（库书或卡内嵌书）
     * + 卡 + 会话书 + 人设书，末尾再加一个 config 标记。
     * 编辑/删除经本类写方法 bump；运行期绕开 TavernState 手改文件不捕获（standingPins 进程内，重启即清）。
     * 资产键一律走 assetFileId：绑定里可能存着原始名，与写方法 bump 的键必须是同一个。
     */
    standingRevTags(binding: SessionBinding, extra?: {
        personaLorebookId?: string | null;
    }): string[];
    /**
     * 模型元数据解析缓存：同 provider+model 复用一次解析结果（含 reasoning 档与上下文窗口），
     * TTL 过期重解析（provider 配置热更后不再拿旧窗口）。失败不缓存（删掉条目让下次重试）；
     * signal 只作用于首次真实解析。
     */
    resolveModelInfoCached(llm: LlmRuntime, provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /** 清掉会话绑定文件；空白新对话复用旧会话时用来去掉上次留下的角色卡。 */
    clearBinding(sessionId: string): Promise<void>;
    loadTimers(cardId: string, sessionId: string, storyId?: string): Promise<WITimerState>;
    saveTimers(cardId: string, sessionId: string, state: WITimerState, floor?: string | null, storyId?: string): Promise<void>;
    recordTriggerLog(sessionId: string, lines: string[]): void;
    /**
     * 库资产（世界书 / 预设 / 人设）显示名 → 磁盘文件 id。
     * 写盘路径、删除路径、读取路径和修订号键必须共用这一个 id：
     * 曾经出现过「按净化名写文件、按原始名 bump 修订号」，绑定里存的是净化名，
     * standing 指纹于是一直读一个没人 bump 的键，编辑世界书后钉死永不失效。
     */
    private assetFileId;
    private rootFsPromise;
    /** 数据目录根的 WorkspaceFs（library/personas/regex 等，非角色工作区，无 WAL）。 */
    private rootFs;
    /**
     * 面板/服务层非会话写入专用的角色工作区文件面：floor 恒为 null，绝不记 WAL。
     * 共享句柄 workspace(cardId).fs 不再携带楼层（楼层由 withFloor 派生实例持有），
     * 生成进行中用户在面板的编辑若复用楼层实例，会被记进当前楼层 WAL，回退楼层时把编辑静默改回旧值。
     * turn 流程内的工具写路径仍走 withFloor 派生实例（快照必须进 WAL），这里只供非会话写路径使用。
     */
    private plainFs;
    /**
     * 面板/服务层写路径专用的工作区句柄：floor 恒为 null 的文件面（绝不记 WAL），
     * memory/deltas 建在这个无楼层文件面上。供 service 面板写路径使用；
     * turn 流程内的写路径仍走 workspace(cardId) + withFloor(openFloors 的 entry.floor)。
     */
    plainWorkspace(cardId: string, storyId?: string): Promise<{
        fs: WorkspaceFs;
        memory: MemoryStore;
        deltas: WorldDeltaStore;
    }>;
}
export type { MemoryEntry, WorldDelta };
