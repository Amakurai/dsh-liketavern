import type { LlmResolvedModelInfo, LlmRuntime } from '@deepseek-ai/dsh-llm';
import { type MemoryEntry, type PromptPreset, type RegexRule, type WIEngineResult, type WITimerState, type WorldDelta, type WorldInfoEntry } from '../core/types.js';
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
    /** 每 turn 一次的 WI/记忆/变化层评估缓存（turn/end 清除）。 */
    readonly wiCache: Map<string, {
        turn: number;
        wi: WIEngineResult;
        memories: string[];
        deltas: WorldDelta[];
    }>;
    /** 已入 inbox 尚未入日志的用户输入文本（agent/inbox/inserted 维护；turn/end 清除）。 */
    readonly pendingInputs: Map<string, string[]>;
    /** 会话 standing 钉死（绑定指纹不变则复用第一次写入的字节）。 */
    readonly standingPins: Map<string, StandingPin>;
    /** standing 依赖资产的进程内修订号：经本类写方法编辑/删除即 bump，standing 指纹随内容变化失效重算。 */
    private readonly assetRevs;
    /** 模型元数据进程内缓存：resolveModelInfo 每步被调（reasoningEffort / 上下文窗口），适配器目录运行期不变。 */
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
    listLorebooks(): Promise<string[]>;
    /** 读取世界书原始 JSON（供设置面板编辑）；不存在或损坏返回 null。 */
    loadLorebookJson(name: string): Promise<unknown | null>;
    loadLorebookEntries(name: string, source: WorldInfoEntry['source']): Promise<WorldInfoEntry[]>;
    saveLorebook(name: string, json: unknown): Promise<void>;
    deleteLorebook(name: string): Promise<void>;
    listPresets(): Promise<string[]>;
    listPresetSummaries(): Promise<Array<{
        id: string;
        name: string;
        regexCount: number;
    }>>;
    loadPreset(id: string): Promise<PromptPreset | null>;
    savePreset(preset: PromptPreset): Promise<void>;
    deletePreset(id: string): Promise<void>;
    listPersonas(): Promise<Persona[]>;
    loadPersona(id: string | null): Promise<Persona | null>;
    /**
     * 本会话实际用人设：绑定指定 > 默认页 > 库里只剩一条。
     * 只建了人设、没在芯片/默认页勾选时，{{user}} 仍应展开成人设名而不是 User。
     */
    resolvePersona(personaId: string | null): Promise<Persona | null>;
    savePersona(persona: Persona): Promise<void>;
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
    /** 绑定不变时复用第一次 standing，避免组装抖动打穿 KV。 */
    pinStanding(sessionId: string, fingerprint: string, computed: string): string;
    private bumpAssetRev;
    /**
     * standing 指纹的资产修订标记（稳定顺序）：绑定预设 + 全局世界书 + 主世界书（库书或卡内嵌书）。
     * 编辑/删除经本类写方法 bump；运行期绕开 TavernState 手改文件不捕获（standingPins 进程内，重启即清）。
     */
    standingRevTags(binding: SessionBinding): string[];
    /**
     * 模型元数据解析缓存：同 provider+model 复用一次解析结果（含 reasoning 档与上下文窗口）。
     * 失败不缓存（删掉条目让下次重试）；signal 只作用于首次真实解析。
     */
    resolveModelInfoCached(llm: LlmRuntime, provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    /** 清掉会话绑定文件；空白新对话复用旧会话时用来去掉上次留下的角色卡。 */
    clearBinding(sessionId: string): Promise<void>;
    loadTimers(cardId: string, sessionId: string): Promise<WITimerState>;
    saveTimers(cardId: string, sessionId: string, state: WITimerState): Promise<void>;
    recordTriggerLog(sessionId: string, lines: string[]): void;
    private rootFsPromise;
    /** 数据目录根的 WorkspaceFs（library/personas/regex 等，非角色工作区，无 WAL）。 */
    private rootFs;
}
export type { MemoryEntry, WorldDelta };
