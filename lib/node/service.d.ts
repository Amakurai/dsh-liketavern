/**
 * TavernService：remote 方法实现（薄壳，组合 state/floors/pipeline）。
 *
 * 平台约定：方法返回裸业务值，失败抛错（FloorError.message 原样透出给 client）。
 * { ok, value | error } 信封由 typert gateway（host invokeRpc / client invoke）生成，
 * 这里不要再包一层（双层信封会让 client 的 r.value.xxx 全部读到 undefined）。
 * 每个方法的返回注解指向 ../remote.ts 的 TavernMethodResults——结果形状的单一来源，
 * client 镜像（client/types.ts）索引同一张表，两面形状漂移会立刻编译报错。
 */
import type { TavernServiceContract } from '../remote.js';
import type { Context } from '@deepseek-ai/cordis';
import type { SettingsScope } from '@deepseek-ai/dsh-settings';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { RegexRule } from '../core/types.js';
import type { TavernConfigRaw } from './config.js';
import type { Persona, TavernState } from './state.js';
import type { TavernMethodResults } from '../remote.js';
export declare class TavernService extends TypertRemoteService implements TavernServiceContract {
    /** 运行时中枢（agent 面插件经 ctx.tavern 访问）。 */
    readonly state: TavernState;
    private readonly settingsScope;
    constructor(ctx: Context, 
    /** 运行时中枢（agent 面插件经 ctx.tavern 访问）。 */
    state: TavernState, settingsScope: SettingsScope<TavernConfigRaw>);
    /**
     * 头像 dataURL 进程内缓存：getAvatar 每次调用都全文读盘 + Base64 编码整图，
     * 与会话头/英雄区的渲染频率不匹配。指纹用 WorkspaceFs.stat('card.png') 的
     * mtimeMs+size——与 state.ts 卡级正则指纹缓存同一思路：一次 stat 不读数据，
     * 且能捕获绕开写方法直写磁盘的路径（WAL 回滚 / 外部换图）。
     */
    private readonly avatarCache;
    getEditorDraft(request: {
        owner: string;
        key: string;
    }): Promise<TavernMethodResults['getEditorDraft']>;
    saveEditorDraft(request: {
        owner: string;
        key: string;
        value: unknown;
    }): Promise<TavernMethodResults['saveEditorDraft']>;
    deleteEditorDraft(request: {
        owner: string;
        key: string;
    }): Promise<TavernMethodResults['deleteEditorDraft']>;
    getSettings(_request: Record<string, never>): TavernMethodResults['getSettings'];
    updateSettings(request: {
        patch: unknown;
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
        preset: unknown;
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
        storyId?: string;
    }): Promise<TavernMethodResults['getChatLorebook']>;
    saveChatLorebook(request: {
        cardId: string;
        storyId?: string;
        json: unknown;
    }): Promise<TavernMethodResults['saveChatLorebook']>;
    getJournal(request: {
        cardId: string;
        storyId?: string;
    }): Promise<TavernMethodResults['getJournal']>;
    saveJournal(request: {
        cardId: string;
        storyId?: string;
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
    /** 以已提交日志判定是否进入对话，避免客户端 blank 镜像滞后时误清绑定。 */
    private conversationStarted;
    getSessionBinding(request: {
        sessionId: string;
    }): Promise<TavernMethodResults['getSessionBinding']>;
    setSessionBinding(request: {
        binding: unknown;
    }): Promise<TavernMethodResults['setSessionBinding']>;
    clearSessionBinding(request: {
        sessionId: string;
        onlyIfBlank?: boolean;
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
    listStories(request: {
        cardId: string;
    }): Promise<TavernMethodResults['listStories']>;
    getMemories(request: {
        cardId: string;
        storyId?: string;
    }): Promise<TavernMethodResults['getMemories']>;
    saveMemory(request: {
        cardId: string;
        storyId?: string;
        id?: string;
        body: string;
        tags?: string[];
        keys?: string[];
    }): Promise<TavernMethodResults['saveMemory']>;
    deleteMemory(request: {
        cardId: string;
        storyId?: string;
        id: string;
    }): Promise<TavernMethodResults['deleteMemory']>;
    /** 无 LLM 的确定性归并：原文逐条保留，只减少条目数，不宣称减少 token。 */
    compressMemories(request: {
        cardId: string;
        storyId?: string;
    }): Promise<TavernMethodResults['compressMemories']>;
    getWorldDeltas(request: {
        cardId: string;
        storyId?: string;
    }): Promise<TavernMethodResults['getWorldDeltas']>;
    revokeWorldDelta(request: {
        cardId: string;
        storyId?: string;
        id: string;
    }): Promise<TavernMethodResults['revokeWorldDelta']>;
    addWorldDelta(request: {
        cardId: string;
        storyId?: string;
        type: 'add' | 'update' | 'invalidate';
        content: string;
        ref?: string | null;
        keys?: string[];
        order?: number;
    }): Promise<TavernMethodResults['addWorldDelta']>;
    exportMergedLorebook(request: {
        cardId: string;
        storyId?: string;
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
