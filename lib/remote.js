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
import { array, boolean, enum as enum_, int, literal, minimum, minLength, nullable, number, object, optional, string, union, unknown } from 'zod/mini';
/** 非空字符串（原 `z.string().min(1)`）。 */
const nonEmpty = () => string().check(minLength(1));
/** 楼层 turn 号：正整数（原 `z.number().int().min(1)`）。 */
const turnNumber = () => int().check(minimum(1));
/**
 * 会话绑定（setSessionBinding）。字段全集与 node/bindings.ts 的 parseSessionBinding 一致：
 * service 落盘前会再过一次 parseSessionBinding，两边校验规则必须同步改。
 */
const sessionBinding = () => object({
    sessionId: nonEmpty(),
    cardId: nonEmpty(),
    cardName: optional(string()),
    presetId: nullable(string()),
    personaId: nullable(string()),
    lorebookIds: array(string()),
    characterLorebookId: nullable(string()),
    interactiveCards: nullable(boolean()),
    greetingIndex: int().check(minimum(0)),
    authorNote: optional(string()),
    injectJournal: optional(boolean()),
    walLineage: optional(array(object({ sessionId: nonEmpty(), throughTurn: int().check(minimum(0)) }))),
    createdAt: nonEmpty(),
});
/** 人设（savePersona）：纯数据形状，字段全集见 core/persona.ts 的 Persona。 */
const persona = () => object({
    id: nonEmpty(),
    name: string(),
    description: string(),
    avatar: nullable(string()),
    lorebookId: optional(nullable(string())),
});
/** 全局正则规则（saveRegexRules）：纯数据形状，字段全集见 core/types.ts 的 RegexRule。 */
const regexRule = () => object({
    id: nonEmpty(),
    name: string(),
    find: string(),
    replace: string(),
    enabled: boolean(),
    scopes: array(enum_(['input', 'output', 'prompt'])),
    timing: array(enum_(['assemble', 'send', 'render'])),
    minDepth: nullable(number()),
    maxDepth: nullable(number()),
    substituteRegex: union([literal(0), literal(1), literal(2)]),
    source: enum_(['user', 'card', 'preset']),
    roles: optional(array(enum_(['system', 'user', 'assistant']))),
    trimStrings: optional(array(string())),
    trimStringsRegex: optional(array(string())),
});
const anyValue = unknown();
const sessionIdField = { sessionId: nonEmpty() };
const cardIdField = { cardId: nonEmpty() };
const messageIdField = { messageId: nonEmpty() };
/** method → [request shape, value schema, 简介] */
const METHODS = {
    // 角色
    listCharacters: { req: object({}), value: anyValue, summary: '列出全部角色卡' },
    inspectCharacter: {
        // dataBase64：卡文件字节（PNG/JSON），传输层只判非空；V1/V2/V3 结构由 state/card 的 normalizeCard 归一化校验。
        req: object({ name: nonEmpty(), dataBase64: nonEmpty() }),
        value: anyValue,
        summary: '解析角色卡但不落盘（导入前预览内嵌世界书）',
    },
    importCharacter: {
        // dataBase64：同 inspectCharacter，卡结构由 state/card 归一化校验。
        req: object({
            name: nonEmpty(),
            dataBase64: nonEmpty(),
            importWorldBook: optional(boolean()),
        }),
        value: anyValue,
        summary: '导入角色卡（PNG/JSON，base64）',
    },
    deleteCharacter: { req: object({ ...cardIdField }), value: anyValue, summary: '删除角色卡工作区' },
    getCharacterDetail: { req: object({ ...cardIdField }), value: anyValue, summary: '角色卡详情（归一化卡 + 开场白列表）' },
    saveCharacter: {
        req: object({
            ...cardIdField,
            name: optional(string()),
            description: optional(string()),
            personality: optional(string()),
            scenario: optional(string()),
            firstMes: optional(string()),
            alternateGreetings: optional(array(string())),
            mesExample: optional(string()),
            systemPrompt: optional(string()),
            postHistoryInstructions: optional(string()),
            creatorNotes: optional(string()),
            creator: optional(string()),
            characterVersion: optional(string()),
            tags: optional(array(string())),
            depthPrompt: optional(nullable(object({
                prompt: string(),
                depth: number(),
                role: enum_(['system', 'user', 'assistant']),
            }))),
        }),
        value: anyValue,
        summary: '保存角色卡正文（不改 cardId）',
    },
    createCharacter: { req: object({ name: nonEmpty() }), value: anyValue, summary: '新建空白角色卡' },
    exportCharacter: { req: object({ ...cardIdField }), value: anyValue, summary: '导出角色卡 JSON 与 PNG' },
    // 预设
    listPresets: { req: object({}), value: anyValue, summary: '列出提示词预设' },
    importPreset: {
        // json：ST 预设 JSON，字段随 ST 版本演进，宽松传输，由 state/presetStore 归一化时严格校验。
        req: object({ name: nonEmpty(), json: anyValue }),
        value: anyValue,
        summary: '导入 SillyTavern 预设 JSON',
    },
    // preset：同上，宽松传输，state/presetStore 归一化时严格校验。
    savePreset: { req: object({ preset: anyValue }), value: anyValue, summary: '保存预设' },
    deletePreset: { req: object({ id: nonEmpty() }), value: anyValue, summary: '删除预设' },
    getPreset: { req: object({ id: nonEmpty() }), value: anyValue, summary: '读取预设' },
    // 世界书库
    listLorebooks: { req: object({}), value: anyValue, summary: '列出世界书' },
    getLorebook: { req: object({ name: nonEmpty() }), value: anyValue, summary: '读取世界书原始 JSON' },
    // json：世界书原始 JSON（ST 导出形态多样），宽松传输，由 state/lorebook 归一化时严格校验。
    importLorebook: { req: object({ name: nonEmpty(), json: anyValue }), value: anyValue, summary: '导入世界书 JSON' },
    saveLorebook: { req: object({ name: nonEmpty(), json: anyValue }), value: anyValue, summary: '保存世界书 JSON' },
    deleteLorebook: { req: object({ name: nonEmpty() }), value: anyValue, summary: '删除世界书' },
    getCharacterLorebook: { req: object({ ...cardIdField }), value: anyValue, summary: '读取角色卡内嵌世界书' },
    saveCharacterLorebook: {
        // json：卡内嵌世界书，宽松传输，state/card 的 normalizeBook 归一化时严格校验。
        req: object({ ...cardIdField, json: anyValue }),
        value: anyValue,
        summary: '保存角色卡内嵌世界书',
    },
    deleteEmbeddedLorebook: { req: object({ ...cardIdField }), value: anyValue, summary: '删除角色卡内嵌世界书（保留角色卡）' },
    getChatLorebook: { req: object({ ...cardIdField }), value: anyValue, summary: '读取会话世界书' },
    // json：会话世界书，宽松传输，state/lorebook 归一化时严格校验。
    saveChatLorebook: { req: object({ ...cardIdField, json: anyValue }), value: anyValue, summary: '保存会话世界书' },
    getJournal: { req: object({ ...cardIdField }), value: anyValue, summary: '读取角色笔记 journal.md' },
    saveJournal: { req: object({ ...cardIdField, text: string() }), value: anyValue, summary: '保存角色笔记 journal.md' },
    // 人设
    listPersonas: { req: object({}), value: anyValue, summary: '列出人设' },
    savePersona: { req: object({ persona: persona() }), value: anyValue, summary: '保存人设' },
    deletePersona: { req: object({ id: nonEmpty() }), value: anyValue, summary: '删除人设' },
    // 正则
    listRegexRules: { req: object({}), value: anyValue, summary: '列出全局正则规则' },
    saveRegexRules: { req: object({ rules: array(regexRule()) }), value: anyValue, summary: '保存全局正则规则' },
    // 会话绑定
    getSessionBinding: { req: object({ ...sessionIdField }), value: anyValue, summary: '读取会话绑定' },
    setSessionBinding: { req: object({ binding: sessionBinding() }), value: anyValue, summary: '保存会话绑定' },
    clearSessionBinding: { req: object({ ...sessionIdField }), value: anyValue, summary: '清除会话角色卡绑定' },
    // 开场白
    ensureGreeting: { req: object({ ...sessionIdField }), value: anyValue, summary: '确保会话有开场白' },
    getGreetingSwipe: {
        req: object({ ...sessionIdField, ...messageIdField }),
        value: anyValue,
        summary: '开场白楼层的 swipe 下标（非开场白返回 null）',
    },
    renderOutputText: {
        req: object({ ...sessionIdField, text: string() }),
        value: anyValue,
        summary: '对展示文本应用 output/render 正则并抽出 HTML',
    },
    swipeGreeting: {
        req: object({ ...sessionIdField, index: int().check(minimum(0)) }),
        value: anyValue,
        summary: '切换开场白变体（产生子会话）',
    },
    // 楼层（按 assistant 消息 id 定位楼层；被中断的楼层没有 finalized 消息、宿主 slot 不挂，
    // 操作条由 chat.node 渲染侧补挂并以 turn 定位，故 regenerate/rollbackToFloor/getFloorSiblings
    // 额外接受 turn 号；操作产生分支子会话，client 负责打开）
    regenerate: {
        req: object({ ...sessionIdField, messageId: optional(nonEmpty()), turn: optional(turnNumber()) }),
        value: anyValue,
        summary: '重新生成指定楼层（缺省最后一轮），分支会话自动续跑',
    },
    rollbackToFloor: {
        req: object({ ...sessionIdField, messageId: optional(nonEmpty()), turn: optional(turnNumber()) }),
        value: anyValue,
        summary: '回退到指定楼层（保留该层，丢弃其后），不自动续跑；messageId 与 turn 至少给其一',
    },
    getFloorUserMessage: {
        req: object({ ...sessionIdField, ...messageIdField }),
        value: anyValue,
        summary: '读取指定楼层的首条用户消息（编辑预填用）',
    },
    editUserMessage: {
        req: object({ ...sessionIdField, ...messageIdField, text: nonEmpty() }),
        value: anyValue,
        summary: '编辑指定楼层的用户消息并重跑（产生子会话）',
    },
    getFloorAssistantMessage: {
        req: object({ ...sessionIdField, ...messageIdField }),
        value: anyValue,
        summary: '读取指定楼层的 assistant 正文（编辑预填用）',
    },
    editAssistantMessage: {
        req: object({ ...sessionIdField, ...messageIdField, text: nonEmpty() }),
        value: anyValue,
        summary: '编辑指定楼层的 assistant 正文（产生子会话，停在编辑后状态）',
    },
    continueFloor: {
        req: object({ ...sessionIdField, ...messageIdField }),
        value: anyValue,
        summary: '续写最后一层（被截断的）回复：不 fork，直接驱动画前会话',
    },
    getFloorSiblings: {
        req: object({ ...sessionIdField, messageId: optional(nonEmpty()), turn: optional(turnNumber()) }),
        value: object({
            swipe: nullable(object({
                turn: int(),
                index: int(),
                total: int(),
                siblings: array(string()),
            })),
        }),
        summary: '同一楼层分支会话的兄弟导航（‹ n/m ›；无兄弟时 swipe=null）',
    },
    impersonate: {
        req: object({ ...sessionIdField }),
        value: anyValue,
        summary: '以用户身份代写一句台词（不入会话日志，由前端填入输入）',
    },
    // 记忆
    getMemories: { req: object({ ...cardIdField }), value: anyValue, summary: '列出角色记忆' },
    saveMemory: {
        req: object({
            ...cardIdField,
            id: optional(nonEmpty()),
            body: nonEmpty(),
            tags: optional(array(string())),
            keys: optional(array(string())),
        }),
        value: anyValue,
        summary: '新增或更新记忆',
    },
    deleteMemory: { req: object({ ...cardIdField, id: nonEmpty() }), value: anyValue, summary: '删除记忆' },
    compressMemories: { req: object({ ...cardIdField }), value: anyValue, summary: '无损归并最旧一批记忆（减少条目数）' },
    // 世界状态
    getWorldDeltas: { req: object({ ...cardIdField }), value: anyValue, summary: '列出世界状态变化层' },
    revokeWorldDelta: { req: object({ ...cardIdField, id: nonEmpty() }), value: anyValue, summary: '撤销一条变化' },
    addWorldDelta: {
        req: object({
            ...cardIdField,
            type: enum_(['add', 'update', 'invalidate']),
            content: nonEmpty(),
            ref: optional(nullable(string())),
            keys: optional(array(string())),
            order: optional(number()),
        }),
        value: anyValue,
        summary: '手动新增一条世界状态',
    },
    exportMergedLorebook: { req: object({ ...cardIdField }), value: anyValue, summary: '导出合并变化层后的世界书' },
    // 调试
    getTriggerLog: { req: object({ ...sessionIdField }), value: anyValue, summary: '最近一次组装的触发日志' },
    previewPrompt: { req: object({ ...sessionIdField }), value: anyValue, summary: '预览完整提示词序列' },
    getContextUsage: {
        req: object({ ...sessionIdField }),
        value: anyValue,
        summary: '读取会话上下文占用（token-meter 投影；宿主未挂投影时 usage=null）',
    },
    getDataInfo: { req: object({}), value: anyValue, summary: 'Tavern 数据目录路径' },
    getAvatar: { req: object({ ...cardIdField }), value: anyValue, summary: '角色头像 dataURL' },
    // 设置（采样参数与世界书全局设置等，落 dsh 设置命名空间 dsh-tavern）
    getSettings: { req: object({}), value: anyValue, summary: '读取 Tavern 设置' },
    // patch：设置深补丁（嵌套 Partial，难用 zod 精确刻画），宽松传输，由 schemastery（node/config）校验合并。
    updateSettings: { req: object({ patch: anyValue }), value: anyValue, summary: '合并更新 Tavern 设置' },
};
function descriptor(method, def) {
    return {
        id: `dsh-liketavern#tavern/${method}`,
        service: 'tavern',
        namespace: 'tavern',
        method,
        invocation: { kind: 'direct' },
        parameters: [
            {
                name: 'request',
                wire: 'request',
                source: 'json',
                codec: { mode: 'strict', typeSymbol: `dsh-liketavern/types#${method}Request`, schema: def.req },
            },
        ],
        result: { mode: 'strict', typeSymbol: `dsh-liketavern/types#${method}Result`, schema: def.value },
    };
}
const descriptors = Object.entries(METHODS).map(([method, def]) => descriptor(method, def));
/** host 侧贡献：注册进 ctx.typert（gateway 以 strict codec 校验出入参）。 */
export const TYPERT_HOST = {
    package: 'dsh-liketavern',
    face: 'host',
    schemas: [],
    invocations: descriptors,
    model: {
        services: [
            {
                description: 'Tavern 角色扮演服务：角色卡、世界书、预设、记忆、世界状态、楼层操作与提示词预览。',
                summary: 'SillyTavern 兼容角色扮演服务。',
                tags: [],
                jsDoc: '/** Tavern service: cards, lorebooks, presets, memories, world deltas, floor ops. */',
                key: 'tavern',
                exportName: 'TavernService',
                members: Object.entries(METHODS).map(([method, def]) => ({
                    kind: 'method',
                    name: method,
                    signature: `async ${method}(request): Promise<Envelope>`,
                    summary: def.summary,
                    jsDoc: `/** ${def.summary} */`,
                })),
                types: [],
            },
        ],
        events: [],
        objects: [],
    },
};
/** client 侧贡献：ctx.remote.$mount(TYPERT_REMOTE) 后以 ctx.remote.tavern.<method>(request) 调用。 */
export const TYPERT_REMOTE = {
    package: 'dsh-liketavern',
    descriptors,
};
