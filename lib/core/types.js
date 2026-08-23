/**
 * dsh-tavern 核心共享类型。
 * 本文件是所有纯函数模块与存储/集成层之间的契约，字段命名尽量对齐 SillyTavern。
 */
// ---------------------------------------------------------------------------
// 世界书（World Info）
// ---------------------------------------------------------------------------
/** 次级键选择逻辑。数值与 SillyTavern selectiveLogic 对齐。 */
export const WISelectiveLogic = {
    AndAny: 0,
    NotAll: 1,
    NotAny: 2,
    AndAll: 3,
};
/** 插入位置。数值与 SillyTavern world_info_position 对齐。 */
export const WIPosition = {
    BeforeCharDefs: 0,
    AfterCharDefs: 1,
    AuthorNoteTop: 2,
    AuthorNoteBottom: 3,
    AtDepth: 4,
    BeforeExampleMessages: 5,
    AfterExampleMessages: 6,
    Outlet: 7,
};
/** @D 注入的 role。数值与 SillyTavern 对齐：0 system / 1 user / 2 assistant。 */
export const WIRole = { System: 0, User: 1, Assistant: 2 };
export const DEFAULT_WI_SETTINGS = {
    scanDepth: 2,
    contextPercent: 25,
    tokenBudget: 8192,
    recursiveScan: true,
    maxRecursionSteps: 0,
    caseSensitive: false,
    matchWholeWords: false,
    includeNames: true,
    overflowWarning: true,
    characterStrategy: 1,
    useGroupScoring: false,
};
export const EMPTY_TIMER_STATE = { stickyLeft: {}, cooldownLeft: {} };
// ---------------------------------------------------------------------------
// 预设（Prompt Manager）
// ---------------------------------------------------------------------------
export const Marker = {
    ChatHistory: 'chatHistory',
    WorldInfoBefore: 'worldInfoBefore',
    WorldInfoAfter: 'worldInfoAfter',
    CharDescription: 'charDescription',
    CharPersonality: 'charPersonality',
    Scenario: 'scenario',
    DialogueExamples: 'dialogueExamples',
    PersonaDescription: 'personaDescription',
    /** 本插件新增：检索记忆注入点。 */
    AgentMemory: 'agentMemory',
    /** 本插件新增：世界状态变化层注入点。 */
    WorldState: 'worldState',
};
export const DEFAULT_SAMPLING = {
    temperature: 1,
    topP: 1,
    maxTokens: null,
    stop: [],
    presencePenalty: 0,
    frequencyPenalty: 0,
    thinking: 'enabled',
};
