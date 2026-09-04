import type { ZodMiniType } from 'zod/mini';
import type { AssembledPrompt } from './core/assemble.js';
import type { SessionBinding } from './core/binding.js';
import type { GreetingFloorState } from './core/greetingLog.js';
import type { Persona } from './core/persona.js';
import type { SiblingSwipe } from './core/siblings.js';
import type { CharacterCard, ChatMessage, MemoryEntry, PromptPreset, RegexRule, WIEngineResult, WorldDelta } from './core/types.js';
import type { TavernConfigRaw } from './node/config.js';
import type { ForkResult } from './node/floors.js';
import type { CharacterSummary } from './state/workspace.js';
/** inspectCharacter 的导入前预览（不落盘）。 */
export interface CharacterInspect {
    name: string;
    hasAvatar: boolean;
    hasCharacterBook: boolean;
    characterBookName: string | null;
    entryCount: number;
}
/** getCharacterDetail 的角色卡详情（归一化卡的扁平字段 + 世界书/头像元信息）。 */
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
    spec: CharacterCard['spec'];
    hasCharacterBook: boolean;
    characterBookName: string | null;
    characterBookEntryCount: number;
    hasAvatar: boolean;
    depthPrompt: CharacterCard['depthPrompt'];
    extensions: CharacterCard['extensions'];
}
/** listPresets 的预设摘要。 */
export interface PresetSummary {
    id: string;
    name: string;
    regexCount: number;
}
/** renderOutputText：展示文本经 output/render 正则与 HTML 抽取后的形态。 */
export interface RenderedOutput {
    text: string;
    html: string | null;
    htmls: string[];
    interactiveCards: boolean;
    whitelist: string[];
    greetings: string[];
    greetingIndex: number;
    canSwipeGreeting: boolean;
}
/** previewPrompt 的完整提示词预览（仅预览通道，live 插不进会话日志中间）。 */
export interface PromptPreview {
    standing: string;
    turnContext: string;
    system: string;
    messages: ChatMessage[];
    logLines: string[];
    worldInfoBudget: WIEngineResult['budget'];
    assembleBudget: AssembledPrompt['stats'];
}
/** getContextUsage 的 token-meter 投影快照；宿主未挂投影时整体为 null。 */
export interface ContextUsage {
    surfaceTokens: number;
    pressureTokens: number | null;
    contextWindow: number | null;
    percent: number | null;
    systemTokens: number | null;
    toolsTokens: number | null;
    messageTokens: number | null;
}
/** 方法名 → 裸业务结果类型。加/改 remote 方法时必须与 METHODS、service 实现、client 镜像同步。 */
export interface TavernMethodResults {
    listCharacters: {
        items: CharacterSummary[];
    };
    inspectCharacter: CharacterInspect;
    importCharacter: {
        cardId: string;
        name: string;
    };
    deleteCharacter: {
        deleted: boolean;
        salvagedLorebook: string | null;
    };
    getCharacterDetail: CharacterDetail;
    saveCharacter: {
        cardId: string;
        name: string;
    };
    createCharacter: {
        cardId: string;
        name: string;
    };
    exportCharacter: {
        json: unknown;
        pngBase64: string;
        name: string;
    };
    getAvatar: {
        dataUrl: string | null;
    };
    listPresets: {
        items: PresetSummary[];
    };
    importPreset: {
        id: string;
        warnings: string[];
    };
    savePreset: {
        id: string;
    };
    deletePreset: {
        deleted: boolean;
    };
    getPreset: {
        preset: PromptPreset;
    };
    listLorebooks: {
        items: string[];
    };
    getLorebook: {
        json: unknown;
    };
    importLorebook: {
        name: string;
        entryCount: number;
    };
    saveLorebook: {
        name: string;
    };
    deleteLorebook: {
        deleted: boolean;
    };
    getCharacterLorebook: {
        name: string;
        json: unknown;
        entryCount: number;
    };
    saveCharacterLorebook: {
        name: string;
        entryCount: number;
    };
    deleteEmbeddedLorebook: {
        deleted: boolean;
    };
    getChatLorebook: {
        json: unknown;
    };
    saveChatLorebook: {
        saved: boolean;
    };
    getJournal: {
        text: string;
    };
    saveJournal: {
        saved: boolean;
    };
    listPersonas: {
        items: Persona[];
    };
    savePersona: {
        id: string;
    };
    deletePersona: {
        deleted: boolean;
    };
    listRegexRules: {
        rules: RegexRule[];
    };
    saveRegexRules: {
        count: number;
    };
    getSessionBinding: {
        binding: SessionBinding | null;
        userName: string;
        canSwipeGreeting: boolean;
    };
    setSessionBinding: {
        saved: boolean;
    };
    clearSessionBinding: {
        cleared: boolean;
    };
    ensureGreeting: {
        created: boolean;
    };
    getGreetingSwipe: GreetingFloorState;
    renderOutputText: RenderedOutput;
    swipeGreeting: {
        childSessionId: string;
        index: number;
        title: string;
    };
    regenerate: ForkResult;
    rollbackToFloor: ForkResult;
    getFloorUserMessage: {
        turn: number;
        text: string;
    };
    editUserMessage: ForkResult;
    getFloorAssistantMessage: {
        turn: number;
        text: string;
    };
    editAssistantMessage: ForkResult;
    continueFloor: {
        continued: boolean;
    };
    getFloorSiblings: {
        swipe: (SiblingSwipe & {
            turn: number;
        }) | null;
    };
    impersonate: {
        text: string;
    };
    getMemories: {
        items: MemoryEntry[];
    };
    saveMemory: {
        id: string;
    };
    deleteMemory: {
        deleted: boolean;
    };
    compressMemories: {
        merged: number;
    };
    getWorldDeltas: {
        items: WorldDelta[];
    };
    revokeWorldDelta: {
        revoked: boolean;
    };
    addWorldDelta: {
        id: string;
    };
    exportMergedLorebook: {
        json: unknown;
    };
    getTriggerLog: {
        log: {
            at: string;
            lines: string[];
        } | null;
    };
    previewPrompt: PromptPreview;
    getContextUsage: {
        usage: ContextUsage | null;
    };
    getDataInfo: {
        dataHome: string;
    };
    getSettings: {
        settings: TavernConfigRaw;
    };
    updateSettings: {
        settings: TavernConfigRaw;
    };
}
/** host 侧贡献：注册进 ctx.typert（gateway 以 strict codec 校验出入参）。 */
export declare const TYPERT_HOST: {
    package: string;
    face: "host";
    schemas: unknown[];
    invocations: {
        id: string;
        service: string;
        namespace: string;
        method: string;
        invocation: {
            kind: "direct";
        };
        parameters: {
            name: string;
            wire: string;
            source: "json";
            codec: {
                mode: "strict";
                typeSymbol: string;
                schema: ZodMiniType<unknown, unknown, import("zod/v4/core").$ZodTypeInternals<unknown, unknown>>;
            };
        }[];
        result: {
            mode: "strict";
            typeSymbol: string;
            schema: ZodMiniType<unknown, unknown, import("zod/v4/core").$ZodTypeInternals<unknown, unknown>>;
        };
    }[];
    model: {
        services: {
            description: string;
            summary: string;
            tags: string[];
            jsDoc: string;
            key: string;
            exportName: string;
            members: {
                kind: string;
                name: string;
                signature: string;
                summary: string;
                jsDoc: string;
            }[];
            types: unknown[];
        }[];
        events: unknown[];
        objects: unknown[];
    };
};
/** client 侧贡献：ctx.remote.$mount(TYPERT_REMOTE) 后以 ctx.remote.tavern.<method>(request) 调用。 */
export declare const TYPERT_REMOTE: {
    package: string;
    descriptors: {
        id: string;
        service: string;
        namespace: string;
        method: string;
        invocation: {
            kind: "direct";
        };
        parameters: {
            name: string;
            wire: string;
            source: "json";
            codec: {
                mode: "strict";
                typeSymbol: string;
                schema: ZodMiniType<unknown, unknown, import("zod/v4/core").$ZodTypeInternals<unknown, unknown>>;
            };
        }[];
        result: {
            mode: "strict";
            typeSymbol: string;
            schema: ZodMiniType<unknown, unknown, import("zod/v4/core").$ZodTypeInternals<unknown, unknown>>;
        };
    }[];
};
