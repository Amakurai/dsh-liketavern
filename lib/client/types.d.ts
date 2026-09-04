/**
 * client 侧共享类型：remote 方法签名（结果类型一律索引 src/remote.ts 的 TavernMethodResults，
 * 与 src/node/service.ts 的实现共用单一来源）、以及插件入口所需的最小 cordis Context 形状
 * （宿主经 declaration merging 注入的 slots/remote/locale 服务在此以结构化类型描述，避免依赖宿主包的类型）。
 */
import type { PromptPreset, RegexRule } from '../core/types.js';
import type { Persona } from '../core/persona.js';
import type { SessionBinding } from '../core/binding.js';
import type { TavernMethodResults } from '../remote.js';
export type { CharacterSummary } from '../state/workspace.js';
export type { Persona } from '../core/persona.js';
export type { SessionBinding } from '../core/binding.js';
export type { CharacterDetail, CharacterInspect, PresetSummary } from '../remote.js';
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
/** 设置命名空间 dsh-tavern 的原始（schemastery 解析后）形状；单一来源是 host 侧 TavernConfigRaw；maxTokens 为数字，0 = 不限。 */
export type TavernSettings = TavernMethodResults['getSettings']['settings'];
export declare const EMPTY_SESSION_DEFAULTS: TavernSettings['defaults'];
/**
 * remote 调用镜像：请求形状按方法声明（与 remote.ts 的 req schema 对应），
 * 结果一律索引 TavernMethodResults——service 改返回形状时这里自动跟随，消费点编译报错。
 */
export interface TavernRemote {
    listCharacters(req: Record<string, never>): Promise<Envelope<TavernMethodResults['listCharacters']>>;
    inspectCharacter(req: {
        name: string;
        dataBase64: string;
    }): Promise<Envelope<TavernMethodResults['inspectCharacter']>>;
    importCharacter(req: {
        name: string;
        dataBase64: string;
        importWorldBook?: boolean;
    }): Promise<Envelope<TavernMethodResults['importCharacter']>>;
    deleteCharacter(req: {
        cardId: string;
    }): Promise<Envelope<TavernMethodResults['deleteCharacter']>>;
    getCharacterDetail(req: {
        cardId: string;
    }): Promise<Envelope<TavernMethodResults['getCharacterDetail']>>;
    saveCharacter(req: {
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
    }): Promise<Envelope<TavernMethodResults['saveCharacter']>>;
    createCharacter(req: {
        name: string;
    }): Promise<Envelope<TavernMethodResults['createCharacter']>>;
    exportCharacter(req: {
        cardId: string;
    }): Promise<Envelope<TavernMethodResults['exportCharacter']>>;
    getAvatar(req: {
        cardId: string;
    }): Promise<Envelope<TavernMethodResults['getAvatar']>>;
    listPresets(req: Record<string, never>): Promise<Envelope<TavernMethodResults['listPresets']>>;
    getPreset(req: {
        id: string;
    }): Promise<Envelope<TavernMethodResults['getPreset']>>;
    savePreset(req: {
        preset: PromptPreset;
    }): Promise<Envelope<TavernMethodResults['savePreset']>>;
    deletePreset(req: {
        id: string;
    }): Promise<Envelope<TavernMethodResults['deletePreset']>>;
    importPreset(req: {
        name: string;
        json: unknown;
    }): Promise<Envelope<TavernMethodResults['importPreset']>>;
    listLorebooks(req: Record<string, never>): Promise<Envelope<TavernMethodResults['listLorebooks']>>;
    getLorebook(req: {
        name: string;
    }): Promise<Envelope<TavernMethodResults['getLorebook']>>;
    importLorebook(req: {
        name: string;
        json: unknown;
    }): Promise<Envelope<TavernMethodResults['importLorebook']>>;
    saveLorebook(req: {
        name: string;
        json: unknown;
    }): Promise<Envelope<TavernMethodResults['saveLorebook']>>;
    deleteLorebook(req: {
        name: string;
    }): Promise<Envelope<TavernMethodResults['deleteLorebook']>>;
    getCharacterLorebook(req: {
        cardId: string;
    }): Promise<Envelope<TavernMethodResults['getCharacterLorebook']>>;
    saveCharacterLorebook(req: {
        cardId: string;
        json: unknown;
    }): Promise<Envelope<TavernMethodResults['saveCharacterLorebook']>>;
    deleteEmbeddedLorebook(req: {
        cardId: string;
    }): Promise<Envelope<TavernMethodResults['deleteEmbeddedLorebook']>>;
    getChatLorebook(req: {
        cardId: string;
    }): Promise<Envelope<TavernMethodResults['getChatLorebook']>>;
    saveChatLorebook(req: {
        cardId: string;
        json: unknown;
    }): Promise<Envelope<TavernMethodResults['saveChatLorebook']>>;
    getJournal(req: {
        cardId: string;
    }): Promise<Envelope<TavernMethodResults['getJournal']>>;
    saveJournal(req: {
        cardId: string;
        text: string;
    }): Promise<Envelope<TavernMethodResults['saveJournal']>>;
    listPersonas(req: Record<string, never>): Promise<Envelope<TavernMethodResults['listPersonas']>>;
    savePersona(req: {
        persona: Persona;
    }): Promise<Envelope<TavernMethodResults['savePersona']>>;
    deletePersona(req: {
        id: string;
    }): Promise<Envelope<TavernMethodResults['deletePersona']>>;
    listRegexRules(req: Record<string, never>): Promise<Envelope<TavernMethodResults['listRegexRules']>>;
    saveRegexRules(req: {
        rules: RegexRule[];
    }): Promise<Envelope<TavernMethodResults['saveRegexRules']>>;
    getSessionBinding(req: {
        sessionId: string;
    }): Promise<Envelope<TavernMethodResults['getSessionBinding']>>;
    setSessionBinding(req: {
        binding: SessionBinding;
    }): Promise<Envelope<TavernMethodResults['setSessionBinding']>>;
    clearSessionBinding(req: {
        sessionId: string;
    }): Promise<Envelope<TavernMethodResults['clearSessionBinding']>>;
    ensureGreeting(req: {
        sessionId: string;
    }): Promise<Envelope<TavernMethodResults['ensureGreeting']>>;
    getGreetingSwipe(req: {
        sessionId: string;
        messageId: string;
    }): Promise<Envelope<TavernMethodResults['getGreetingSwipe']>>;
    swipeGreeting(req: {
        sessionId: string;
        index: number;
    }): Promise<Envelope<TavernMethodResults['swipeGreeting']>>;
    renderOutputText(req: {
        sessionId: string;
        text: string;
    }): Promise<Envelope<TavernMethodResults['renderOutputText']>>;
    regenerate(req: {
        sessionId: string;
        messageId?: string;
        turn?: number;
    }): Promise<Envelope<TavernMethodResults['regenerate']>>;
    rollbackToFloor(req: {
        sessionId: string;
        messageId?: string;
        turn?: number;
    }): Promise<Envelope<TavernMethodResults['rollbackToFloor']>>;
    getFloorUserMessage(req: {
        sessionId: string;
        messageId: string;
    }): Promise<Envelope<TavernMethodResults['getFloorUserMessage']>>;
    editUserMessage(req: {
        sessionId: string;
        messageId: string;
        text: string;
    }): Promise<Envelope<TavernMethodResults['editUserMessage']>>;
    getFloorAssistantMessage(req: {
        sessionId: string;
        messageId: string;
    }): Promise<Envelope<TavernMethodResults['getFloorAssistantMessage']>>;
    editAssistantMessage(req: {
        sessionId: string;
        messageId: string;
        text: string;
    }): Promise<Envelope<TavernMethodResults['editAssistantMessage']>>;
    continueFloor(req: {
        sessionId: string;
        messageId: string;
    }): Promise<Envelope<TavernMethodResults['continueFloor']>>;
    getFloorSiblings(req: {
        sessionId: string;
        messageId?: string;
        turn?: number;
    }): Promise<Envelope<TavernMethodResults['getFloorSiblings']>>;
    impersonate(req: {
        sessionId: string;
    }): Promise<Envelope<TavernMethodResults['impersonate']>>;
    getMemories(req: {
        cardId: string;
    }): Promise<Envelope<TavernMethodResults['getMemories']>>;
    saveMemory(req: {
        cardId: string;
        id?: string;
        body: string;
        tags?: string[];
        keys?: string[];
    }): Promise<Envelope<TavernMethodResults['saveMemory']>>;
    deleteMemory(req: {
        cardId: string;
        id: string;
    }): Promise<Envelope<TavernMethodResults['deleteMemory']>>;
    compressMemories(req: {
        cardId: string;
    }): Promise<Envelope<TavernMethodResults['compressMemories']>>;
    getWorldDeltas(req: {
        cardId: string;
    }): Promise<Envelope<TavernMethodResults['getWorldDeltas']>>;
    revokeWorldDelta(req: {
        cardId: string;
        id: string;
    }): Promise<Envelope<TavernMethodResults['revokeWorldDelta']>>;
    addWorldDelta(req: {
        cardId: string;
        type: 'add' | 'update' | 'invalidate';
        content: string;
        ref?: string | null;
        keys?: string[];
        order?: number;
    }): Promise<Envelope<TavernMethodResults['addWorldDelta']>>;
    exportMergedLorebook(req: {
        cardId: string;
    }): Promise<Envelope<TavernMethodResults['exportMergedLorebook']>>;
    getTriggerLog(req: {
        sessionId: string;
    }): Promise<Envelope<TavernMethodResults['getTriggerLog']>>;
    /** 上下文占用（token-meter 投影）；宿主未挂投影/会话不在线时 usage=null。 */
    getContextUsage(req: {
        sessionId: string;
    }): Promise<Envelope<TavernMethodResults['getContextUsage']>>;
    getDataInfo(req: Record<string, never>): Promise<Envelope<TavernMethodResults['getDataInfo']>>;
    previewPrompt(req: {
        sessionId: string;
    }): Promise<Envelope<TavernMethodResults['previewPrompt']>>;
    getSettings(req: Record<string, never>): Promise<Envelope<TavernMethodResults['getSettings']>>;
    updateSettings(req: {
        patch: Record<string, unknown>;
    }): Promise<Envelope<TavernMethodResults['updateSettings']>>;
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
    /** 宿主界面语言快照（0.1.2 的 LocaleRuntime）；auto 档据此跟随。 */
    getSnapshot?(): {
        active: string;
    };
    subscribe?(fn: () => void): () => void;
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
        /** 会话列表快照 store（含 current；预设 id 在 projectionValues.agentPreset）；seatWatch 与 assistant-step 显隐据此判断。 */
        list: {
            getSnapshot(): {
                current: string | undefined;
                byId: Record<string, {
                    projectionValues?: {
                        agentPreset?: string | null;
                    };
                } | undefined>;
            };
            subscribe(fn: () => void): () => void;
        };
        /** 宿主 ISessions 的命名路径（scope → sessionOf → rename）；旧宿主缺省时跳过改名。 */
        scope?(id: string): unknown;
        sessionOf?(ctx: unknown): {
            rename(title: string): Promise<unknown>;
        } | undefined;
    };
    /** 工作区运行时；「新对话」动作 0.1.2 起迁到 uiWorkspace 服务（seatWatch 经 ctx.get 读取）。 */
    workspaces: {
        startSession?(workspaceId?: string): void;
    };
    effect(fn: () => void | (() => void), label?: string): void;
    /** cordis reflect.get：不做 inject 检查，用于读取自行 $mount 的 remote.<ns> 子服务。 */
    get(name: string): unknown;
    on?(event: string, listener: (...args: unknown[]) => void): void;
}
