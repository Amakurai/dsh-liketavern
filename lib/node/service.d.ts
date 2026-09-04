/**
 * TavernService：remote 方法实现（薄壳，组合 state/floors/pipeline）。
 *
 * 平台约定：方法返回裸业务值，失败抛错（FloorError.message 原样透出给 client）。
 * { ok, value | error } 信封由 typert gateway（host invokeRpc / client invoke）生成，
 * 这里不要再包一层（双层信封会让 client 的 r.value.xxx 全部读到 undefined）。
 * 每个方法的返回注解指向 ../remote.ts 的 TavernMethodResults——结果形状的单一来源，
 * client 镜像（client/types.ts）索引同一张表，两面形状漂移会立刻编译报错。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SettingsScope } from '@deepseek-ai/dsh-settings';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { PromptPreset, RegexRule } from '../core/types.js';
import type { SessionBinding } from './bindings.js';
import type { TavernConfigRaw } from './config.js';
import type { Persona, TavernState } from './state.js';
import type { TavernMethodResults } from '../remote.js';
export declare class TavernService extends TypertRemoteService {
    /** 运行时中枢（agent 面插件经 ctx.tavern 访问）。 */
    readonly state: TavernState;
    private readonly settingsScope;
    constructor(ctx: Context, 
    /** 运行时中枢（agent 面插件经 ctx.tavern 访问）。 */
    state: TavernState, settingsScope: SettingsScope<TavernConfigRaw>);
    getSettings(_request: Record<string, never>): TavernMethodResults['getSettings'];
    updateSettings(request: {
        patch: object;
    }): Promise<TavernMethodResults['updateSettings']>;
    listCharacters(_request: Record<string, never>): Promise<TavernMethodResults['listCharacters']>;
    inspectCharacter(request: {
        name: string;
        dataBase64: string;
    }): Promise<TavernMethodResults['inspectCharacter']>;
    importCharacter(request: {
        name: string;
        dataBase64: string;
        importWorldBook?: boolean;
    }): Promise<TavernMethodResults['importCharacter']>;
    deleteCharacter(request: {
        cardId: string;
    }): Promise<TavernMethodResults['deleteCharacter']>;
    getCharacterDetail(request: {
        cardId: string;
    }): Promise<TavernMethodResults['getCharacterDetail']>;
    saveCharacter(request: {
        cardId: string;
        name?: string;
        description?: string;
        personality?: string;
        scenario?: string;
        firstMes?: string;
        alternateGreetings?: string[];
        mesExample?: string;
        systemPrompt?: string;
        postHistoryInstructions?: string;
        creatorNotes?: string;
        creator?: string;
        characterVersion?: string;
        tags?: string[];
        depthPrompt?: {
            prompt: string;
            depth: number;
            role: 'system' | 'user' | 'assistant';
        } | null;
    }): Promise<TavernMethodResults['saveCharacter']>;
    createCharacter(request: {
        name: string;
    }): Promise<TavernMethodResults['createCharacter']>;
    exportCharacter(request: {
        cardId: string;
    }): Promise<TavernMethodResults['exportCharacter']>;
    listPresets(_request: Record<string, never>): Promise<TavernMethodResults['listPresets']>;
    importPreset(request: {
        name: string;
        json: unknown;
    }): Promise<TavernMethodResults['importPreset']>;
    savePreset(request: {
        preset: PromptPreset;
    }): Promise<TavernMethodResults['savePreset']>;
    deletePreset(request: {
        id: string;
    }): Promise<TavernMethodResults['deletePreset']>;
    getPreset(request: {
        id: string;
    }): Promise<TavernMethodResults['getPreset']>;
    listLorebooks(_request: Record<string, never>): Promise<TavernMethodResults['listLorebooks']>;
    getLorebook(request: {
        name: string;
    }): Promise<TavernMethodResults['getLorebook']>;
    importLorebook(request: {
        name: string;
        json: unknown;
    }): Promise<TavernMethodResults['importLorebook']>;
    saveLorebook(request: {
        name: string;
        json: unknown;
    }): Promise<TavernMethodResults['saveLorebook']>;
    deleteLorebook(request: {
        name: string;
    }): Promise<TavernMethodResults['deleteLorebook']>;
    getCharacterLorebook(request: {
        cardId: string;
    }): Promise<TavernMethodResults['getCharacterLorebook']>;
    saveCharacterLorebook(request: {
        cardId: string;
        json: unknown;
    }): Promise<TavernMethodResults['saveCharacterLorebook']>;
    deleteEmbeddedLorebook(request: {
        cardId: string;
    }): Promise<TavernMethodResults['deleteEmbeddedLorebook']>;
    getChatLorebook(request: {
        cardId: string;
    }): Promise<TavernMethodResults['getChatLorebook']>;
    saveChatLorebook(request: {
        cardId: string;
        json: unknown;
    }): Promise<TavernMethodResults['saveChatLorebook']>;
    getJournal(request: {
        cardId: string;
    }): Promise<TavernMethodResults['getJournal']>;
    saveJournal(request: {
        cardId: string;
        text: string;
    }): Promise<TavernMethodResults['saveJournal']>;
    listPersonas(_request: Record<string, never>): Promise<TavernMethodResults['listPersonas']>;
    savePersona(request: {
        persona: Persona;
    }): Promise<TavernMethodResults['savePersona']>;
    deletePersona(request: {
        id: string;
    }): Promise<TavernMethodResults['deletePersona']>;
    listRegexRules(_request: Record<string, never>): Promise<TavernMethodResults['listRegexRules']>;
    saveRegexRules(request: {
        rules: RegexRule[];
    }): Promise<TavernMethodResults['saveRegexRules']>;
    getSessionBinding(request: {
        sessionId: string;
    }): Promise<TavernMethodResults['getSessionBinding']>;
    setSessionBinding(request: {
        binding: SessionBinding;
    }): Promise<TavernMethodResults['setSessionBinding']>;
    clearSessionBinding(request: {
        sessionId: string;
    }): Promise<TavernMethodResults['clearSessionBinding']>;
    ensureGreeting(request: {
        sessionId: string;
    }): Promise<TavernMethodResults['ensureGreeting']>;
    swipeGreeting(request: {
        sessionId: string;
        index: number;
    }): Promise<TavernMethodResults['swipeGreeting']>;
    getGreetingSwipe(request: {
        sessionId: string;
        messageId: string;
    }): Promise<TavernMethodResults['getGreetingSwipe']>;
    /** 分支兄弟导航是只读查询：等排队中的楼层任务落定即可，不进串行队列。 */
    getFloorSiblings(request: {
        sessionId: string;
        messageId?: string;
        turn?: number;
    }): Promise<TavernMethodResults['getFloorSiblings']>;
    renderOutputText(request: {
        sessionId: string;
        text: string;
    }): Promise<TavernMethodResults['renderOutputText']>;
    regenerate(request: {
        sessionId: string;
        messageId?: string;
        turn?: number;
    }): Promise<TavernMethodResults['regenerate']>;
    rollbackToFloor(request: {
        sessionId: string;
        messageId?: string;
        turn?: number;
    }): Promise<TavernMethodResults['rollbackToFloor']>;
    getFloorUserMessage(request: {
        sessionId: string;
        messageId: string;
    }): Promise<TavernMethodResults['getFloorUserMessage']>;
    editUserMessage(request: {
        sessionId: string;
        messageId: string;
        text: string;
    }): Promise<TavernMethodResults['editUserMessage']>;
    getFloorAssistantMessage(request: {
        sessionId: string;
        messageId: string;
    }): Promise<TavernMethodResults['getFloorAssistantMessage']>;
    editAssistantMessage(request: {
        sessionId: string;
        messageId: string;
        text: string;
    }): Promise<TavernMethodResults['editAssistantMessage']>;
    continueFloor(request: {
        sessionId: string;
        messageId: string;
    }): Promise<TavernMethodResults['continueFloor']>;
    /** impersonate 是带外一次性调用，不进会话串行队列（不改会话状态）。 */
    impersonate(request: {
        sessionId: string;
    }): Promise<TavernMethodResults['impersonate']>;
    getMemories(request: {
        cardId: string;
    }): Promise<TavernMethodResults['getMemories']>;
    saveMemory(request: {
        cardId: string;
        id?: string;
        body: string;
        tags?: string[];
        keys?: string[];
    }): Promise<TavernMethodResults['saveMemory']>;
    deleteMemory(request: {
        cardId: string;
        id: string;
    }): Promise<TavernMethodResults['deleteMemory']>;
    /** 无 LLM 的确定性归并：原文逐条保留，只减少条目数，不宣称减少 token。 */
    compressMemories(request: {
        cardId: string;
    }): Promise<TavernMethodResults['compressMemories']>;
    getWorldDeltas(request: {
        cardId: string;
    }): Promise<TavernMethodResults['getWorldDeltas']>;
    revokeWorldDelta(request: {
        cardId: string;
        id: string;
    }): Promise<TavernMethodResults['revokeWorldDelta']>;
    addWorldDelta(request: {
        cardId: string;
        type: 'add' | 'update' | 'invalidate';
        content: string;
        ref?: string | null;
        keys?: string[];
        order?: number;
    }): Promise<TavernMethodResults['addWorldDelta']>;
    exportMergedLorebook(request: {
        cardId: string;
    }): Promise<TavernMethodResults['exportMergedLorebook']>;
    getTriggerLog(request: {
        sessionId: string;
    }): TavernMethodResults['getTriggerLog'];
    previewPrompt(request: {
        sessionId: string;
    }): Promise<TavernMethodResults['previewPrompt']>;
    /**
     * 上下文占用（宿主 rc.2 起 sessionProjections.stateOf 只读 token-meter 投影）。
     * 会话不在线、宿主未挂投影或尚无数据时 usage=null，调用方按未知处理。
     */
    getContextUsage(request: {
        sessionId: string;
    }): TavernMethodResults['getContextUsage'];
    /** Tavern 数据目录（$DSH_HOME/dsh-tavern），设置面板展示用。 */
    getDataInfo(_request: Record<string, never>): TavernMethodResults['getDataInfo'];
    getAvatar(request: {
        cardId: string;
    }): Promise<TavernMethodResults['getAvatar']>;
    private floorDeps;
}
export declare function createTavernService(ctx: Context, state: TavernState, settingsScope: SettingsScope<TavernConfigRaw>): TavernService;
