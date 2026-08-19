/**
 * client 侧共享类型：remote 方法签名（与 src/remote.ts / src/node/service.ts 对齐）、
 * 以及插件入口所需的最小 cordis Context 形状（宿主经 declaration merging 注入的
 * slots/remote/locale 服务在此以结构化类型描述，避免依赖宿主包的类型）。
 */
import type { MemoryEntry, PromptPreset, RegexRule, WorldDelta } from '../core/types.js';
export type Envelope<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
    };
};
export interface CharacterSummary {
    cardId: string;
    name: string;
    hasAvatar: boolean;
    hasCharacterBook?: boolean;
    characterBookName?: string | null;
    characterBookEntryCount?: number;
}
/** getCharacterDetail 返回（service.ts 的扁平结构 + extensions）。 */
export interface CharacterDetail {
    cardId: string;
    name: string;
    description: string;
    personality: string;
    scenario: string;
    firstMes: string;
    alternateGreetings: string[];
    mesExample: string;
    systemPrompt: string;
    postHistoryInstructions: string;
    creatorNotes: string;
    creator: string;
    characterVersion: string;
    tags: string[];
    spec: string;
    hasCharacterBook: boolean;
    characterBookName?: string | null;
    characterBookEntryCount?: number;
    hasAvatar: boolean;
    extensions?: Record<string, unknown>;
}
export interface PresetSummary {
    id: string;
    name: string;
    regexCount: number;
}
export interface Persona {
    id: string;
    name: string;
    description: string;
    avatar: string | null;
}
export interface SessionBinding {
    sessionId: string;
    cardId: string;
    cardName?: string;
    presetId: string | null;
    personaId: string | null;
    lorebookIds: string[];
    characterLorebookId: string | null;
    interactiveCards: boolean | null;
    greetingIndex: number;
    /** host 持久化的 fork WAL 祖先边界；客户端原样保留，不提供编辑入口。 */
    walLineage?: Array<{
        sessionId: string;
        throughTurn: number;
    }>;
    createdAt: string;
}
export interface CharacterInspect {
    name: string;
    hasAvatar: boolean;
    hasCharacterBook: boolean;
    characterBookName: string | null;
    entryCount: number;
}
/** 设置命名空间 dsh-tavern 的原始（schemastery 解析后）形状；maxTokens 为数字，0 = 不限。 */
export interface TavernSettings {
    sampling: {
        temperature: number;
        topP: number;
        maxTokens: number;
        stop: string[];
        presencePenalty: number;
        frequencyPenalty: number;
        thinking: 'enabled' | 'disabled';
    };
    worldInfo: {
        scanDepth: number;
        contextPercent: number;
        tokenBudget: number;
        recursiveScan: boolean;
        maxRecursionSteps: number;
        caseSensitive: boolean;
        matchWholeWords: boolean;
        includeNames: boolean;
        overflowWarning: boolean;
        characterStrategy: 0 | 1 | 2;
    };
    memory: {
        maxEntries: number;
        maxTokens: number;
        retrievalTopK: number;
        retrievalTokenBudget: number;
        halfLifeDays: number;
        dedupScore: number;
        compressBatch: number;
        queryMessages: number;
    };
    defaults: {
        cardId: string;
        presetId: string;
        personaId: string;
        lorebookIds: string[];
        characterLorebookId: string;
    };
    interactiveCards: boolean;
    cascadeDeleteEmbeddedBook: boolean;
    cardNetworkWhitelist: string[];
    triggerLogMax: number;
}
export declare const EMPTY_SESSION_DEFAULTS: TavernSettings['defaults'];
export interface TavernRemote {
    listCharacters(req: Record<string, never>): Promise<Envelope<{
        items: CharacterSummary[];
    }>>;
    inspectCharacter(req: {
        name: string;
        dataBase64: string;
    }): Promise<Envelope<CharacterInspect>>;
    importCharacter(req: {
        name: string;
        dataBase64: string;
        importWorldBook?: boolean;
    }): Promise<Envelope<{
        cardId: string;
        name: string;
    }>>;
    deleteCharacter(req: {
        cardId: string;
    }): Promise<Envelope<{
        deleted: boolean;
        salvagedLorebook: string | null;
    }>>;
    getCharacterDetail(req: {
        cardId: string;
    }): Promise<Envelope<CharacterDetail>>;
    getAvatar(req: {
        cardId: string;
    }): Promise<Envelope<{
        dataUrl: string | null;
    }>>;
    listPresets(req: Record<string, never>): Promise<Envelope<{
        items: PresetSummary[];
    }>>;
    getPreset(req: {
        id: string;
    }): Promise<Envelope<{
        preset: PromptPreset;
    }>>;
    savePreset(req: {
        preset: PromptPreset;
    }): Promise<Envelope<{
        id: string;
    }>>;
    deletePreset(req: {
        id: string;
    }): Promise<Envelope<{
        deleted: boolean;
    }>>;
    importPreset(req: {
        name: string;
        json: unknown;
    }): Promise<Envelope<{
        id: string;
        warnings: unknown[];
    }>>;
    listLorebooks(req: Record<string, never>): Promise<Envelope<{
        items: string[];
    }>>;
    getLorebook(req: {
        name: string;
    }): Promise<Envelope<{
        json: unknown;
    }>>;
    importLorebook(req: {
        name: string;
        json: unknown;
    }): Promise<Envelope<{
        name: string;
        entryCount: number;
    }>>;
    saveLorebook(req: {
        name: string;
        json: unknown;
    }): Promise<Envelope<{
        name: string;
    }>>;
    deleteLorebook(req: {
        name: string;
    }): Promise<Envelope<{
        deleted: boolean;
    }>>;
    getCharacterLorebook(req: {
        cardId: string;
    }): Promise<Envelope<{
        name: string;
        json: unknown;
        entryCount: number;
    }>>;
    saveCharacterLorebook(req: {
        cardId: string;
        json: unknown;
    }): Promise<Envelope<{
        name: string;
        entryCount: number;
    }>>;
    deleteEmbeddedLorebook(req: {
        cardId: string;
    }): Promise<Envelope<{
        deleted: boolean;
    }>>;
    listPersonas(req: Record<string, never>): Promise<Envelope<{
        items: Persona[];
    }>>;
    savePersona(req: {
        persona: Persona;
    }): Promise<Envelope<{
        id: string;
    }>>;
    deletePersona(req: {
        id: string;
    }): Promise<Envelope<{
        deleted: boolean;
    }>>;
    listRegexRules(req: Record<string, never>): Promise<Envelope<{
        rules: RegexRule[];
    }>>;
    saveRegexRules(req: {
        rules: RegexRule[];
    }): Promise<Envelope<{
        count: number;
    }>>;
    getSessionBinding(req: {
        sessionId: string;
    }): Promise<Envelope<{
        binding: SessionBinding | null;
        userName: string;
        canSwipeGreeting?: boolean;
    }>>;
    setSessionBinding(req: {
        binding: SessionBinding;
    }): Promise<Envelope<{
        saved: boolean;
    }>>;
    clearSessionBinding(req: {
        sessionId: string;
    }): Promise<Envelope<{
        cleared: boolean;
    }>>;
    ensureGreeting(req: {
        sessionId: string;
    }): Promise<Envelope<{
        created: boolean;
    }>>;
    getGreetingSwipe(req: {
        sessionId: string;
        messageId: string;
    }): Promise<Envelope<{
        swipe: {
            index: number;
            total: number;
        } | null;
        isGreeting?: boolean;
        started?: boolean;
    }>>;
    swipeGreeting(req: {
        sessionId: string;
        index: number;
    }): Promise<Envelope<{
        childSessionId: string;
        index: number;
    }>>;
    renderOutputText(req: {
        sessionId: string;
        text: string;
    }): Promise<Envelope<{
        text: string;
        html: string | null;
        htmls?: string[];
        interactiveCards: boolean;
        whitelist: string[];
        greetings: string[];
        greetingIndex: number;
        canSwipeGreeting?: boolean;
    }>>;
    regenerate(req: {
        sessionId: string;
        messageId?: string;
    }): Promise<Envelope<{
        childSessionId: string;
    }>>;
    rollbackToFloor(req: {
        sessionId: string;
        messageId: string;
    }): Promise<Envelope<{
        childSessionId: string;
    }>>;
    getFloorUserMessage(req: {
        sessionId: string;
        messageId: string;
    }): Promise<Envelope<{
        turn: number;
        text: string;
    }>>;
    editUserMessage(req: {
        sessionId: string;
        messageId: string;
        text: string;
    }): Promise<Envelope<{
        childSessionId: string;
    }>>;
    getMemories(req: {
        cardId: string;
    }): Promise<Envelope<{
        items: MemoryEntry[];
    }>>;
    saveMemory(req: {
        cardId: string;
        id?: string;
        body: string;
        tags?: string[];
        keys?: string[];
    }): Promise<Envelope<{
        id: string;
    }>>;
    deleteMemory(req: {
        cardId: string;
        id: string;
    }): Promise<Envelope<{
        deleted: boolean;
    }>>;
    compressMemories(req: {
        cardId: string;
    }): Promise<Envelope<{
        merged: number;
    }>>;
    getWorldDeltas(req: {
        cardId: string;
    }): Promise<Envelope<{
        items: WorldDelta[];
    }>>;
    revokeWorldDelta(req: {
        cardId: string;
        id: string;
    }): Promise<Envelope<{
        revoked: boolean;
    }>>;
    exportMergedLorebook(req: {
        cardId: string;
    }): Promise<Envelope<{
        json: unknown;
    }>>;
    getTriggerLog(req: {
        sessionId: string;
    }): Promise<Envelope<{
        log: {
            at: string;
            lines: string[];
        } | null;
    }>>;
    previewPrompt(req: {
        sessionId: string;
    }): Promise<Envelope<{
        system: string;
        messages: unknown[];
        logLines: string[];
    }>>;
    getSettings(req: Record<string, never>): Promise<Envelope<{
        settings: TavernSettings;
    }>>;
    updateSettings(req: {
        patch: Record<string, unknown>;
    }): Promise<Envelope<{
        settings: TavernSettings;
    }>>;
}
export interface SlotsLike {
    register(options: Record<string, unknown>, component: unknown): () => void;
    /** 等待 slot 声明可用后再注册（参照 ui-message-feedback）；声明崩塌时自动重挂。 */
    inject?(name: string, factory: () => (() => void) | void): () => void;
}
export interface LocaleLike {
    register(ns: string, dicts: {
        zh: Record<string, string>;
        en: Record<string, string>;
    }): () => void;
}
/** 插件入口所见的最小 Context。 */
export interface ClientContext {
    remote: {
        $mount(remote: unknown): Promise<unknown>;
    } & Record<string, unknown>;
    slots: SlotsLike;
    locale: LocaleLike;
    /** dsh-client-runtime 的会话运行时：open 跳转；refresh 把 fork 子会话拉进列表后再 open。 */
    sessions: {
        open(id: string): void;
        refresh?: () => Promise<void>;
        /** 会话列表快照 store（含 current / agentPreset）；seatWatch 与 assistant-step 显隐据此判断。 */
        list: {
            getSnapshot(): {
                current: string | undefined;
                byId: Record<string, {
                    agentPreset?: string;
                } | undefined>;
            };
            subscribe(fn: () => void): () => void;
        };
    };
    /** 工作区运行时：startSession 即侧边栏「新对话」动作（复用/创建空白会话并打开）。 */
    workspaces: {
        startSession(workspaceId?: string): void;
    };
    effect(fn: () => void | (() => void), label?: string): void;
    /** cordis reflect.get：不做 inject 检查，用于读取自行 $mount 的 remote.<ns> 子服务。 */
    get(name: string): unknown;
    on?(event: string, listener: (...args: unknown[]) => void): void;
}
