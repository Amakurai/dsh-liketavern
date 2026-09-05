/**
 * typert 远端契约（手写，模仿 dsh-typert-generator 产物形态）。
 * host 侧经 ctx.typert.register(TYPERT_HOST) 注册；client 侧经 ctx.remote.$mount(TYPERT_REMOTE) 挂载。
 * 结果 schema 描述裸业务值；{ ok, value | error } 信封是 gateway 传输层约定，
 * 由 host invokeRpc / client invoke 自动生成，这里不能再包。
 * 复杂资产（卡片/预设/世界书 JSON）用宽松 schema，由存储层归一化时严格校验。
 *
 * 刻意用 `zod/mini` 而不是经典 `zod`：本模块被 client 入口导入（TYPERT_REMOTE），
 * 经典 API 会往浏览器 bundle 里塞 ~530 KiB（占产物 59%），mini 只有 ~32 KiB。
 * gateway 两面都只调 `codec.schema.parse(value)`（client 侧 dsh-api-gateway/lib/client.js
 * 的 parseInput、host 侧 lib/index.js 的 decode），mini schema 保留 `.parse()`，校验行为不变。
 * 代价是链式方法要写成顶层函数式：`.min(1)` → `check(minLength(1))`、`.optional()` → `optional(...)`。
 */
import type { infer as Infer } from 'zod/mini';
import type { AssembledPrompt } from './core/assemble.js';
import type { SessionBinding } from './core/binding.js';
import type { GreetingFloorState } from './core/greetingLog.js';
import type { TemplateDisplayPart } from './core/templateDisplay.js';
import type { Persona } from './core/persona.js';
import type { SiblingSwipe } from './core/siblings.js';
import type { CharacterCard, ChatMessage, MemoryEntry, PromptPreset, RegexRule, WIEngineResult, WorldDelta } from './core/types.js';
import type { TavernConfigRaw } from './node/config.js';
import type { ForkResult } from './node/floors.js';
import type { CharacterSummary } from './state/workspace.js';
/** method → [request shape, value schema, 简介] */
export declare const METHODS: {
    getEditorDraft: {
        req: import("zod/mini").ZodMiniObject<{
            owner: import("zod/mini").ZodMiniString<string>;
            key: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    saveEditorDraft: {
        req: import("zod/mini").ZodMiniObject<{
            value: import("zod/mini").ZodMiniUnknown;
            owner: import("zod/mini").ZodMiniString<string>;
            key: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    deleteEditorDraft: {
        req: import("zod/mini").ZodMiniObject<{
            owner: import("zod/mini").ZodMiniString<string>;
            key: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    listStories: {
        req: import("zod/mini").ZodMiniObject<{
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    listCharacters: {
        req: import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    inspectCharacter: {
        req: import("zod/mini").ZodMiniObject<{
            name: import("zod/mini").ZodMiniString<string>;
            dataBase64: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    importCharacter: {
        req: import("zod/mini").ZodMiniObject<{
            name: import("zod/mini").ZodMiniString<string>;
            dataBase64: import("zod/mini").ZodMiniString<string>;
            importWorldBook: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniBoolean<boolean>>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    deleteCharacter: {
        req: import("zod/mini").ZodMiniObject<{
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getCharacterDetail: {
        req: import("zod/mini").ZodMiniObject<{
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    saveCharacter: {
        req: import("zod/mini").ZodMiniObject<{
            name: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            description: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            personality: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            scenario: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            firstMes: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            alternateGreetings: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
            mesExample: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            systemPrompt: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            postHistoryInstructions: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            creatorNotes: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            creator: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            characterVersion: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            tags: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
            depthPrompt: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniObject<{
                prompt: import("zod/mini").ZodMiniString<string>;
                depth: import("zod/mini").ZodMiniNumber<number>;
                role: import("zod/mini").ZodMiniEnum<{
                    system: "system";
                    user: "user";
                    assistant: "assistant";
                }>;
            }, import("zod/v4/core").$strip>>>;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    createCharacter: {
        req: import("zod/mini").ZodMiniObject<{
            name: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    exportCharacter: {
        req: import("zod/mini").ZodMiniObject<{
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    listPresets: {
        req: import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    importPreset: {
        req: import("zod/mini").ZodMiniObject<{
            name: import("zod/mini").ZodMiniString<string>;
            json: import("zod/mini").ZodMiniUnknown;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    savePreset: {
        req: import("zod/mini").ZodMiniObject<{
            preset: import("zod/mini").ZodMiniUnknown;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    deletePreset: {
        req: import("zod/mini").ZodMiniObject<{
            id: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getPreset: {
        req: import("zod/mini").ZodMiniObject<{
            id: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    listLorebooks: {
        req: import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getLorebook: {
        req: import("zod/mini").ZodMiniObject<{
            name: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    importLorebook: {
        req: import("zod/mini").ZodMiniObject<{
            name: import("zod/mini").ZodMiniString<string>;
            json: import("zod/mini").ZodMiniUnknown;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    saveLorebook: {
        req: import("zod/mini").ZodMiniObject<{
            name: import("zod/mini").ZodMiniString<string>;
            json: import("zod/mini").ZodMiniUnknown;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    deleteLorebook: {
        req: import("zod/mini").ZodMiniObject<{
            name: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getCharacterLorebook: {
        req: import("zod/mini").ZodMiniObject<{
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    saveCharacterLorebook: {
        req: import("zod/mini").ZodMiniObject<{
            json: import("zod/mini").ZodMiniUnknown;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    deleteEmbeddedLorebook: {
        req: import("zod/mini").ZodMiniObject<{
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getChatLorebook: {
        req: import("zod/mini").ZodMiniObject<{
            storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    saveChatLorebook: {
        req: import("zod/mini").ZodMiniObject<{
            json: import("zod/mini").ZodMiniUnknown;
            storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getJournal: {
        req: import("zod/mini").ZodMiniObject<{
            storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    saveJournal: {
        req: import("zod/mini").ZodMiniObject<{
            text: import("zod/mini").ZodMiniString<string>;
            storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    listPersonas: {
        req: import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    savePersona: {
        req: import("zod/mini").ZodMiniObject<{
            persona: import("zod/mini").ZodMiniObject<{
                id: import("zod/mini").ZodMiniString<string>;
                name: import("zod/mini").ZodMiniString<string>;
                description: import("zod/mini").ZodMiniString<string>;
                avatar: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>;
                lorebookId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>>;
            }, import("zod/v4/core").$strip>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    deletePersona: {
        req: import("zod/mini").ZodMiniObject<{
            id: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    listRegexRules: {
        req: import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    saveRegexRules: {
        req: import("zod/mini").ZodMiniObject<{
            rules: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniObject<{
                id: import("zod/mini").ZodMiniString<string>;
                name: import("zod/mini").ZodMiniString<string>;
                find: import("zod/mini").ZodMiniString<string>;
                replace: import("zod/mini").ZodMiniString<string>;
                enabled: import("zod/mini").ZodMiniBoolean<boolean>;
                scopes: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniEnum<{
                    input: "input";
                    output: "output";
                    prompt: "prompt";
                }>>;
                timing: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniEnum<{
                    assemble: "assemble";
                    send: "send";
                    render: "render";
                }>>;
                minDepth: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniNumber<number>>;
                maxDepth: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniNumber<number>>;
                substituteRegex: import("zod/mini").ZodMiniUnion<readonly [import("zod/mini").ZodMiniLiteral<0>, import("zod/mini").ZodMiniLiteral<1>, import("zod/mini").ZodMiniLiteral<2>]>;
                source: import("zod/mini").ZodMiniEnum<{
                    user: "user";
                    card: "card";
                    preset: "preset";
                }>;
                roles: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniEnum<{
                    system: "system";
                    user: "user";
                    assistant: "assistant";
                }>>>;
                trimStrings: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                trimStringsRegex: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
            }, import("zod/v4/core").$strip>>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getSessionBinding: {
        req: import("zod/mini").ZodMiniObject<{
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    setSessionBinding: {
        req: import("zod/mini").ZodMiniObject<{
            binding: import("zod/mini").ZodMiniObject<{
                sessionId: import("zod/mini").ZodMiniString<string>;
                cardId: import("zod/mini").ZodMiniString<string>;
                cardName: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                presetId: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>;
                personaId: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>;
                lorebookIds: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>;
                characterLorebookId: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>;
                interactiveCards: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniBoolean<boolean>>;
                greetingIndex: import("zod/mini").ZodMiniNumberFormat;
                authorNote: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                injectJournal: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniBoolean<boolean>>;
                walLineage: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniObject<{
                    sessionId: import("zod/mini").ZodMiniString<string>;
                    throughTurn: import("zod/mini").ZodMiniNumberFormat;
                }, import("zod/v4/core").$strip>>>;
                createdAt: import("zod/mini").ZodMiniString<string>;
            }, import("zod/v4/core").$strip>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    clearSessionBinding: {
        req: import("zod/mini").ZodMiniObject<{
            onlyIfBlank: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniBoolean<boolean>>;
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    ensureGreeting: {
        req: import("zod/mini").ZodMiniObject<{
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getGreetingSwipe: {
        req: import("zod/mini").ZodMiniObject<{
            messageId: import("zod/mini").ZodMiniString<string>;
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    renderOutputText: {
        req: import("zod/mini").ZodMiniObject<{
            text: import("zod/mini").ZodMiniString<string>;
            messageId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumberFormat>;
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    swipeGreeting: {
        req: import("zod/mini").ZodMiniObject<{
            index: import("zod/mini").ZodMiniNumberFormat;
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    regenerate: {
        req: import("zod/mini").ZodMiniObject<{
            messageId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            turn: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumberFormat>;
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    rollbackToFloor: {
        req: import("zod/mini").ZodMiniObject<{
            messageId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            turn: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumberFormat>;
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getFloorUserMessage: {
        req: import("zod/mini").ZodMiniObject<{
            messageId: import("zod/mini").ZodMiniString<string>;
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    editUserMessage: {
        req: import("zod/mini").ZodMiniObject<{
            text: import("zod/mini").ZodMiniString<string>;
            messageId: import("zod/mini").ZodMiniString<string>;
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getFloorAssistantMessage: {
        req: import("zod/mini").ZodMiniObject<{
            messageId: import("zod/mini").ZodMiniString<string>;
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    editAssistantMessage: {
        req: import("zod/mini").ZodMiniObject<{
            text: import("zod/mini").ZodMiniString<string>;
            messageId: import("zod/mini").ZodMiniString<string>;
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    continueFloor: {
        req: import("zod/mini").ZodMiniObject<{
            messageId: import("zod/mini").ZodMiniString<string>;
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getFloorSiblings: {
        req: import("zod/mini").ZodMiniObject<{
            messageId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            turn: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumberFormat>;
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniObject<{
            swipe: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniObject<{
                turn: import("zod/mini").ZodMiniNumberFormat;
                index: import("zod/mini").ZodMiniNumberFormat;
                total: import("zod/mini").ZodMiniNumberFormat;
                siblings: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>;
            }, import("zod/v4/core").$strip>>;
        }, import("zod/v4/core").$strip>;
        summary: string;
    };
    impersonate: {
        req: import("zod/mini").ZodMiniObject<{
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getMemories: {
        req: import("zod/mini").ZodMiniObject<{
            storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    saveMemory: {
        req: import("zod/mini").ZodMiniObject<{
            id: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            body: import("zod/mini").ZodMiniString<string>;
            tags: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
            keys: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
            storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    deleteMemory: {
        req: import("zod/mini").ZodMiniObject<{
            id: import("zod/mini").ZodMiniString<string>;
            storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    compressMemories: {
        req: import("zod/mini").ZodMiniObject<{
            storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getWorldDeltas: {
        req: import("zod/mini").ZodMiniObject<{
            storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    revokeWorldDelta: {
        req: import("zod/mini").ZodMiniObject<{
            id: import("zod/mini").ZodMiniString<string>;
            storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    addWorldDelta: {
        req: import("zod/mini").ZodMiniObject<{
            type: import("zod/mini").ZodMiniEnum<{
                update: "update";
                add: "add";
                invalidate: "invalidate";
            }>;
            content: import("zod/mini").ZodMiniString<string>;
            ref: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>>;
            keys: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
            order: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumber<number>>;
            storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    exportMergedLorebook: {
        req: import("zod/mini").ZodMiniObject<{
            storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getTriggerLog: {
        req: import("zod/mini").ZodMiniObject<{
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    previewPrompt: {
        req: import("zod/mini").ZodMiniObject<{
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getContextUsage: {
        req: import("zod/mini").ZodMiniObject<{
            sessionId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getDataInfo: {
        req: import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getAvatar: {
        req: import("zod/mini").ZodMiniObject<{
            cardId: import("zod/mini").ZodMiniString<string>;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    getSettings: {
        req: import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
    updateSettings: {
        req: import("zod/mini").ZodMiniObject<{
            patch: import("zod/mini").ZodMiniUnknown;
        }, import("zod/v4/core").$strip>;
        value: import("zod/mini").ZodMiniUnknown;
        summary: string;
    };
};
export type TavernServiceContract = {
    [K in keyof TavernMethodResults]: (request: TavernMethodRequests[K]) => TavernMethodResults[K] | Promise<TavernMethodResults[K]>;
};
export type TavernMethodRequests = {
    [K in keyof typeof METHODS]: Infer<typeof METHODS[K]['req']>;
};
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
    parts?: TemplateDisplayPart[];
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
    actualRequest: {
        text: string;
        truncated: boolean;
    } | null;
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
    getEditorDraft: {
        draft: {
            value: unknown;
            updatedAt: string;
        } | null;
    };
    saveEditorDraft: {
        saved: true;
    };
    deleteEditorDraft: {
        deleted: true;
    };
    listStories: {
        items: import('./state/story.js').StorySummary[];
    };
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
        conversationStarted: boolean;
    };
    setSessionBinding: {
        saved: boolean;
    };
    clearSessionBinding: {
        cleared: boolean;
    };
    ensureGreeting: {
        created: boolean;
        conversationStarted: boolean;
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
                schema: import("zod/mini").ZodMiniObject<{
                    owner: import("zod/mini").ZodMiniString<string>;
                    key: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    value: import("zod/mini").ZodMiniUnknown;
                    owner: import("zod/mini").ZodMiniString<string>;
                    key: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                    dataBase64: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                    dataBase64: import("zod/mini").ZodMiniString<string>;
                    importWorldBook: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniBoolean<boolean>>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    description: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    personality: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    scenario: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    firstMes: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    alternateGreetings: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                    mesExample: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    systemPrompt: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    postHistoryInstructions: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    creatorNotes: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    creator: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    characterVersion: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    tags: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                    depthPrompt: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniObject<{
                        prompt: import("zod/mini").ZodMiniString<string>;
                        depth: import("zod/mini").ZodMiniNumber<number>;
                        role: import("zod/mini").ZodMiniEnum<{
                            system: "system";
                            user: "user";
                            assistant: "assistant";
                        }>;
                    }, import("zod/v4/core").$strip>>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                    json: import("zod/mini").ZodMiniUnknown;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    preset: import("zod/mini").ZodMiniUnknown;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    id: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    id: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                    json: import("zod/mini").ZodMiniUnknown;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                    json: import("zod/mini").ZodMiniUnknown;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    json: import("zod/mini").ZodMiniUnknown;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    json: import("zod/mini").ZodMiniUnknown;
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    text: import("zod/mini").ZodMiniString<string>;
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    persona: import("zod/mini").ZodMiniObject<{
                        id: import("zod/mini").ZodMiniString<string>;
                        name: import("zod/mini").ZodMiniString<string>;
                        description: import("zod/mini").ZodMiniString<string>;
                        avatar: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>;
                        lorebookId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>>;
                    }, import("zod/v4/core").$strip>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    id: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    rules: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniObject<{
                        id: import("zod/mini").ZodMiniString<string>;
                        name: import("zod/mini").ZodMiniString<string>;
                        find: import("zod/mini").ZodMiniString<string>;
                        replace: import("zod/mini").ZodMiniString<string>;
                        enabled: import("zod/mini").ZodMiniBoolean<boolean>;
                        scopes: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniEnum<{
                            input: "input";
                            output: "output";
                            prompt: "prompt";
                        }>>;
                        timing: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniEnum<{
                            assemble: "assemble";
                            send: "send";
                            render: "render";
                        }>>;
                        minDepth: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniNumber<number>>;
                        maxDepth: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniNumber<number>>;
                        substituteRegex: import("zod/mini").ZodMiniUnion<readonly [import("zod/mini").ZodMiniLiteral<0>, import("zod/mini").ZodMiniLiteral<1>, import("zod/mini").ZodMiniLiteral<2>]>;
                        source: import("zod/mini").ZodMiniEnum<{
                            user: "user";
                            card: "card";
                            preset: "preset";
                        }>;
                        roles: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniEnum<{
                            system: "system";
                            user: "user";
                            assistant: "assistant";
                        }>>>;
                        trimStrings: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                        trimStringsRegex: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                    }, import("zod/v4/core").$strip>>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    binding: import("zod/mini").ZodMiniObject<{
                        sessionId: import("zod/mini").ZodMiniString<string>;
                        cardId: import("zod/mini").ZodMiniString<string>;
                        cardName: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                        storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                        presetId: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>;
                        personaId: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>;
                        lorebookIds: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>;
                        characterLorebookId: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>;
                        interactiveCards: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniBoolean<boolean>>;
                        greetingIndex: import("zod/mini").ZodMiniNumberFormat;
                        authorNote: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                        injectJournal: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniBoolean<boolean>>;
                        walLineage: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniObject<{
                            sessionId: import("zod/mini").ZodMiniString<string>;
                            throughTurn: import("zod/mini").ZodMiniNumberFormat;
                        }, import("zod/v4/core").$strip>>>;
                        createdAt: import("zod/mini").ZodMiniString<string>;
                    }, import("zod/v4/core").$strip>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    onlyIfBlank: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniBoolean<boolean>>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniString<string>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    text: import("zod/mini").ZodMiniString<string>;
                    messageId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumberFormat>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    index: import("zod/mini").ZodMiniNumberFormat;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    turn: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumberFormat>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    turn: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumberFormat>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniString<string>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    text: import("zod/mini").ZodMiniString<string>;
                    messageId: import("zod/mini").ZodMiniString<string>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniString<string>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    text: import("zod/mini").ZodMiniString<string>;
                    messageId: import("zod/mini").ZodMiniString<string>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniString<string>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    turn: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumberFormat>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    id: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    body: import("zod/mini").ZodMiniString<string>;
                    tags: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                    keys: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    id: import("zod/mini").ZodMiniString<string>;
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    id: import("zod/mini").ZodMiniString<string>;
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    type: import("zod/mini").ZodMiniEnum<{
                        update: "update";
                        add: "add";
                        invalidate: "invalidate";
                    }>;
                    content: import("zod/mini").ZodMiniString<string>;
                    ref: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>>;
                    keys: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                    order: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumber<number>>;
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    patch: import("zod/mini").ZodMiniUnknown;
                }, import("zod/v4/core").$strip>;
            };
        }[];
        result: {
            mode: "strict";
            typeSymbol: string;
            schema: import("zod/mini").ZodMiniUnknown | import("zod/mini").ZodMiniObject<{
                swipe: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniObject<{
                    turn: import("zod/mini").ZodMiniNumberFormat;
                    index: import("zod/mini").ZodMiniNumberFormat;
                    total: import("zod/mini").ZodMiniNumberFormat;
                    siblings: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>;
                }, import("zod/v4/core").$strip>>;
            }, import("zod/v4/core").$strip>;
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
                schema: import("zod/mini").ZodMiniObject<{
                    owner: import("zod/mini").ZodMiniString<string>;
                    key: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    value: import("zod/mini").ZodMiniUnknown;
                    owner: import("zod/mini").ZodMiniString<string>;
                    key: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                    dataBase64: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                    dataBase64: import("zod/mini").ZodMiniString<string>;
                    importWorldBook: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniBoolean<boolean>>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    description: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    personality: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    scenario: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    firstMes: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    alternateGreetings: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                    mesExample: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    systemPrompt: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    postHistoryInstructions: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    creatorNotes: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    creator: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    characterVersion: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    tags: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                    depthPrompt: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniObject<{
                        prompt: import("zod/mini").ZodMiniString<string>;
                        depth: import("zod/mini").ZodMiniNumber<number>;
                        role: import("zod/mini").ZodMiniEnum<{
                            system: "system";
                            user: "user";
                            assistant: "assistant";
                        }>;
                    }, import("zod/v4/core").$strip>>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                    json: import("zod/mini").ZodMiniUnknown;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    preset: import("zod/mini").ZodMiniUnknown;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    id: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    id: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                    json: import("zod/mini").ZodMiniUnknown;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                    json: import("zod/mini").ZodMiniUnknown;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    name: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    json: import("zod/mini").ZodMiniUnknown;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    json: import("zod/mini").ZodMiniUnknown;
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    text: import("zod/mini").ZodMiniString<string>;
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    persona: import("zod/mini").ZodMiniObject<{
                        id: import("zod/mini").ZodMiniString<string>;
                        name: import("zod/mini").ZodMiniString<string>;
                        description: import("zod/mini").ZodMiniString<string>;
                        avatar: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>;
                        lorebookId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>>;
                    }, import("zod/v4/core").$strip>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    id: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    rules: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniObject<{
                        id: import("zod/mini").ZodMiniString<string>;
                        name: import("zod/mini").ZodMiniString<string>;
                        find: import("zod/mini").ZodMiniString<string>;
                        replace: import("zod/mini").ZodMiniString<string>;
                        enabled: import("zod/mini").ZodMiniBoolean<boolean>;
                        scopes: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniEnum<{
                            input: "input";
                            output: "output";
                            prompt: "prompt";
                        }>>;
                        timing: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniEnum<{
                            assemble: "assemble";
                            send: "send";
                            render: "render";
                        }>>;
                        minDepth: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniNumber<number>>;
                        maxDepth: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniNumber<number>>;
                        substituteRegex: import("zod/mini").ZodMiniUnion<readonly [import("zod/mini").ZodMiniLiteral<0>, import("zod/mini").ZodMiniLiteral<1>, import("zod/mini").ZodMiniLiteral<2>]>;
                        source: import("zod/mini").ZodMiniEnum<{
                            user: "user";
                            card: "card";
                            preset: "preset";
                        }>;
                        roles: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniEnum<{
                            system: "system";
                            user: "user";
                            assistant: "assistant";
                        }>>>;
                        trimStrings: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                        trimStringsRegex: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                    }, import("zod/v4/core").$strip>>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    binding: import("zod/mini").ZodMiniObject<{
                        sessionId: import("zod/mini").ZodMiniString<string>;
                        cardId: import("zod/mini").ZodMiniString<string>;
                        cardName: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                        storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                        presetId: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>;
                        personaId: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>;
                        lorebookIds: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>;
                        characterLorebookId: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>;
                        interactiveCards: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniBoolean<boolean>>;
                        greetingIndex: import("zod/mini").ZodMiniNumberFormat;
                        authorNote: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                        injectJournal: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniBoolean<boolean>>;
                        walLineage: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniObject<{
                            sessionId: import("zod/mini").ZodMiniString<string>;
                            throughTurn: import("zod/mini").ZodMiniNumberFormat;
                        }, import("zod/v4/core").$strip>>>;
                        createdAt: import("zod/mini").ZodMiniString<string>;
                    }, import("zod/v4/core").$strip>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    onlyIfBlank: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniBoolean<boolean>>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniString<string>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    text: import("zod/mini").ZodMiniString<string>;
                    messageId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumberFormat>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    index: import("zod/mini").ZodMiniNumberFormat;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    turn: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumberFormat>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    turn: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumberFormat>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniString<string>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    text: import("zod/mini").ZodMiniString<string>;
                    messageId: import("zod/mini").ZodMiniString<string>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniString<string>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    text: import("zod/mini").ZodMiniString<string>;
                    messageId: import("zod/mini").ZodMiniString<string>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniString<string>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    messageId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    turn: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumberFormat>;
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    id: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    body: import("zod/mini").ZodMiniString<string>;
                    tags: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                    keys: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    id: import("zod/mini").ZodMiniString<string>;
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    id: import("zod/mini").ZodMiniString<string>;
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    type: import("zod/mini").ZodMiniEnum<{
                        update: "update";
                        add: "add";
                        invalidate: "invalidate";
                    }>;
                    content: import("zod/mini").ZodMiniString<string>;
                    ref: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniString<string>>>;
                    keys: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>>;
                    order: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniNumber<number>>;
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    storyId: import("zod/mini").ZodMiniOptional<import("zod/mini").ZodMiniString<string>>;
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    sessionId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    cardId: import("zod/mini").ZodMiniString<string>;
                }, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{}, import("zod/v4/core").$strip> | import("zod/mini").ZodMiniObject<{
                    patch: import("zod/mini").ZodMiniUnknown;
                }, import("zod/v4/core").$strip>;
            };
        }[];
        result: {
            mode: "strict";
            typeSymbol: string;
            schema: import("zod/mini").ZodMiniUnknown | import("zod/mini").ZodMiniObject<{
                swipe: import("zod/mini").ZodMiniNullable<import("zod/mini").ZodMiniObject<{
                    turn: import("zod/mini").ZodMiniNumberFormat;
                    index: import("zod/mini").ZodMiniNumberFormat;
                    total: import("zod/mini").ZodMiniNumberFormat;
                    siblings: import("zod/mini").ZodMiniArray<import("zod/mini").ZodMiniString<string>>;
                }, import("zod/v4/core").$strip>>;
            }, import("zod/v4/core").$strip>;
        };
    }[];
};
