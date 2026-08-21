/**
 * TavernService：remote 方法实现（薄壳，组合 state/floors/pipeline）。
 *
 * 平台约定：方法返回裸业务值，失败抛错（FloorError.message 原样透出给 client）。
 * { ok, value | error } 信封由 typert gateway（host invokeRpc / client invoke）生成，
 * 这里不要再包一层（双层信封会让 client 的 r.value.xxx 全部读到 undefined）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SettingsScope } from '@deepseek-ai/dsh-settings';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { PromptPreset, RegexRule } from '../core/types.js';
import type { SessionBinding } from './bindings.js';
import type { TavernConfigRaw } from './config.js';
import type { Persona, TavernState } from './state.js';
export declare class TavernService extends TypertRemoteService {
    /** 运行时中枢（agent 面插件经 ctx.tavern 访问）。 */
    readonly state: TavernState;
    private readonly settingsScope;
    constructor(ctx: Context, 
    /** 运行时中枢（agent 面插件经 ctx.tavern 访问）。 */
    state: TavernState, settingsScope: SettingsScope<TavernConfigRaw>);
    getSettings(_request: Record<string, never>): unknown;
    updateSettings(request: {
        patch: object;
    }): Promise<unknown>;
    listCharacters(_request: Record<string, never>): Promise<unknown>;
    inspectCharacter(request: {
        name: string;
        dataBase64: string;
    }): Promise<unknown>;
    importCharacter(request: {
        name: string;
        dataBase64: string;
        importWorldBook?: boolean;
    }): Promise<unknown>;
    deleteCharacter(request: {
        cardId: string;
    }): Promise<unknown>;
    getCharacterDetail(request: {
        cardId: string;
    }): Promise<unknown>;
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
    }): Promise<unknown>;
    createCharacter(request: {
        name: string;
    }): Promise<unknown>;
    exportCharacter(request: {
        cardId: string;
    }): Promise<unknown>;
    listPresets(_request: Record<string, never>): Promise<unknown>;
    importPreset(request: {
        name: string;
        json: unknown;
    }): Promise<unknown>;
    savePreset(request: {
        preset: PromptPreset;
    }): Promise<unknown>;
    deletePreset(request: {
        id: string;
    }): Promise<unknown>;
    getPreset(request: {
        id: string;
    }): Promise<unknown>;
    listLorebooks(_request: Record<string, never>): Promise<unknown>;
    getLorebook(request: {
        name: string;
    }): Promise<unknown>;
    importLorebook(request: {
        name: string;
        json: unknown;
    }): Promise<unknown>;
    saveLorebook(request: {
        name: string;
        json: unknown;
    }): Promise<unknown>;
    deleteLorebook(request: {
        name: string;
    }): Promise<unknown>;
    getCharacterLorebook(request: {
        cardId: string;
    }): Promise<unknown>;
    saveCharacterLorebook(request: {
        cardId: string;
        json: unknown;
    }): Promise<unknown>;
    deleteEmbeddedLorebook(request: {
        cardId: string;
    }): Promise<unknown>;
    getChatLorebook(request: {
        cardId: string;
    }): Promise<unknown>;
    saveChatLorebook(request: {
        cardId: string;
        json: unknown;
    }): Promise<unknown>;
    getJournal(request: {
        cardId: string;
    }): Promise<unknown>;
    saveJournal(request: {
        cardId: string;
        text: string;
    }): Promise<unknown>;
    listPersonas(_request: Record<string, never>): Promise<unknown>;
    savePersona(request: {
        persona: Persona;
    }): Promise<unknown>;
    deletePersona(request: {
        id: string;
    }): Promise<unknown>;
    listRegexRules(_request: Record<string, never>): Promise<unknown>;
    saveRegexRules(request: {
        rules: RegexRule[];
    }): Promise<unknown>;
    getSessionBinding(request: {
        sessionId: string;
    }): Promise<unknown>;
    setSessionBinding(request: {
        binding: SessionBinding;
    }): Promise<unknown>;
    clearSessionBinding(request: {
        sessionId: string;
    }): Promise<unknown>;
    ensureGreeting(request: {
        sessionId: string;
    }): Promise<unknown>;
    swipeGreeting(request: {
        sessionId: string;
        index: number;
    }): Promise<unknown>;
    getGreetingSwipe(request: {
        sessionId: string;
        messageId: string;
    }): Promise<unknown>;
    /** 分支兄弟导航是只读查询：等排队中的楼层任务落定即可，不进串行队列。 */
    getFloorSiblings(request: {
        sessionId: string;
        messageId: string;
    }): Promise<unknown>;
    renderOutputText(request: {
        sessionId: string;
        text: string;
    }): Promise<unknown>;
    regenerate(request: {
        sessionId: string;
        messageId?: string;
    }): Promise<unknown>;
    rollbackToFloor(request: {
        sessionId: string;
        messageId: string;
    }): Promise<unknown>;
    getFloorUserMessage(request: {
        sessionId: string;
        messageId: string;
    }): Promise<unknown>;
    editUserMessage(request: {
        sessionId: string;
        messageId: string;
        text: string;
    }): Promise<unknown>;
    getFloorAssistantMessage(request: {
        sessionId: string;
        messageId: string;
    }): Promise<unknown>;
    editAssistantMessage(request: {
        sessionId: string;
        messageId: string;
        text: string;
    }): Promise<unknown>;
    continueFloor(request: {
        sessionId: string;
        messageId: string;
    }): Promise<unknown>;
    /** impersonate 是带外一次性调用，不进会话串行队列（不改会话状态）。 */
    impersonate(request: {
        sessionId: string;
    }): Promise<unknown>;
    getMemories(request: {
        cardId: string;
    }): Promise<unknown>;
    saveMemory(request: {
        cardId: string;
        id?: string;
        body: string;
        tags?: string[];
        keys?: string[];
    }): Promise<unknown>;
    deleteMemory(request: {
        cardId: string;
        id: string;
    }): Promise<unknown>;
    /** 无 LLM 的确定性归并：原文逐条保留，只减少条目数，不宣称减少 token。 */
    compressMemories(request: {
        cardId: string;
    }): Promise<unknown>;
    getWorldDeltas(request: {
        cardId: string;
    }): Promise<unknown>;
    revokeWorldDelta(request: {
        cardId: string;
        id: string;
    }): Promise<unknown>;
    addWorldDelta(request: {
        cardId: string;
        type: 'add' | 'update' | 'invalidate';
        content: string;
        ref?: string | null;
        keys?: string[];
        order?: number;
    }): Promise<unknown>;
    exportMergedLorebook(request: {
        cardId: string;
    }): Promise<unknown>;
    getTriggerLog(request: {
        sessionId: string;
    }): unknown;
    previewPrompt(request: {
        sessionId: string;
    }): Promise<unknown>;
    getAvatar(request: {
        cardId: string;
    }): Promise<unknown>;
    private floorDeps;
}
export declare function createTavernService(ctx: Context, state: TavernState, settingsScope: SettingsScope<TavernConfigRaw>): TavernService;
