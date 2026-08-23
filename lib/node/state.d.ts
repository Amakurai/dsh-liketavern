import type { LlmResolvedModelInfo, LlmRuntime } from '@deepseek-ai/dsh-llm';
import { type MemoryEntry, type PromptPreset, type RegexRule, type WIEngineResult, type WITimerState, type WorldDelta, type WorldInfoEntry } from '../core/types.js';
import { applyCharacterPatch } from '../state/card.js';
import { MemoryStore } from '../state/memory.js';
import { Wal } from '../state/wal.js';
import { WorldDeltaStore } from '../state/worlddelta.js';
import { type CharacterWorkspace } from '../state/workspace.js';
import { WorkspaceFs } from '../state/workspaceFs.js';
import { type StandingPin } from '../core/standingPin.js';
import { type SessionBinding } from './bindings.js';
import type { TavernConfig } from './config.js';
import { type TavernPaths } from './paths.js';
export interface Persona {
    id: string;
    name: string;
    description: string;
    /** 头像文件名（personas/<id>.png），无则 null。 */
    avatar: string | null;
    /** 挂接的世界书库文件名；空/缺省 = 无人设书。 */
    lorebookId?: string | null;
}
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
    readonly currentTurns: Map<string, number>;
    /** 当前 turn 内的 step（pre-step / step/start 维护；turn 开始时为 1）。 */
    readonly currentSteps: Map<string, number>;
    /**
     * 步骤收口通知去重标记（sessionId → `turn:nextStep`）：工具执行时注入的【Tavern 步骤】
     * 通知按下一步号去重，防并行工具调用重复注入；turn/end 清除。
     */
    readonly stepNoticeMarks: Map<string, string>;
    /**
     * 会话 → 本轮 beginFloor 实际开在哪个 cardId 上（turn/start 记，turn/end 取走）。
     * 不变式：楼层必须由开层那张卡提交。turn 中途换绑/解绑后当前绑定已经是另一张卡，
     * 若按当前绑定提交，开层那张卡的 WorkspaceFs.floor 会永远悬着，之后的非会话写入被误记 WAL。
     */
    readonly openFloors: Map<string, string>;
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
    listCharacters(): Promise<import("../state/workspace.js").CharacterSummary[]>;
    loadCharacter(cardId: string): Promise<CharacterWorkspace | null>;
    /** 删除角色卡工作区、清掉指向它的会话绑定，并逐出缓存句柄。cascadeDeleteEmbeddedBook=false 时先把内嵌书抢救到世界书库。 */
    deleteCharacter(cardId: string): Promise<{
        salvagedLorebook: string | null;
    }>;
    /** 抢救内嵌书到世界书库时的去重文件名（与 saveLorebook 同一套净化规则）。 */
    private salvageLorebookName;
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
    getJournal(cardId: string): Promise<string>;
    saveJournal(cardId: string, text: string): Promise<void>;
    getChatLorebook(cardId: string): Promise<unknown>;
    saveChatLorebook(cardId: string, json: unknown): Promise<void>;
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
    /** 落盘并返回磁盘上的 id；id 被净化过时连同 JSON 里的 id 一起改写，避免文件名和内容各说各话。 */
    savePersona(persona: Persona): Promise<string>;
    deletePersona(id: string): Promise<void>;
    listRegexRules(): Promise<RegexRule[]>;
    saveRegexRules(rules: RegexRule[]): Promise<void>;
    /** 某会话生效的全部正则（全局 + 当前角色卡内嵌 + 当前预设内嵌）。 */
    rulesFor(binding: SessionBinding): Promise<RegexRule[]>;
    /**
     * 读会话绑定；若 cardId 对应工作区已删，按名字或「库里只剩一张卡」改写到新 ID。
     * 人设未绑定时，接到默认页或库里唯一一条，避免 {{user}} 落成 User。
     * 回收失败则删除绑定文件并返回 null，避免 UI 把文件夹 ID 当成角色名。
     */
    loadBinding(sessionId: string): Promise<SessionBinding | null>;
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
    loadTimers(cardId: string, sessionId: string): Promise<WITimerState>;
    saveTimers(cardId: string, sessionId: string, state: WITimerState): Promise<void>;
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
}
export type { MemoryEntry, WorldDelta };
