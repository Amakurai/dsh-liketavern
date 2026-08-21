/**
 * typert 远端契约（手写，模仿 dsh-typert-generator 产物形态）。
 * host 侧经 ctx.typert.register(TYPERT_HOST) 注册；client 侧经 ctx.remote.$mount(TYPERT_REMOTE) 挂载。
 * 结果 schema 描述裸业务值；{ ok, value | error } 信封是 gateway 传输层约定，
 * 由 host invokeRpc / client invoke 自动生成，这里不能再包。
 * 复杂资产（卡片/预设/世界书 JSON）用宽松 schema，由存储层归一化时严格校验。
 */
import { z } from 'zod';
const anyValue = z.unknown();
const sessionIdField = { sessionId: z.string().min(1) };
const cardIdField = { cardId: z.string().min(1) };
const messageIdField = { messageId: z.string().min(1) };
/** method → [request shape, value schema, 简介] */
const METHODS = {
    // 角色
    listCharacters: { req: z.object({}), value: anyValue, summary: '列出全部角色卡' },
    inspectCharacter: {
        req: z.object({ name: z.string().min(1), dataBase64: z.string().min(1) }),
        value: anyValue,
        summary: '解析角色卡但不落盘（导入前预览内嵌世界书）',
    },
    importCharacter: {
        req: z.object({
            name: z.string().min(1),
            dataBase64: z.string().min(1),
            importWorldBook: z.boolean().optional(),
        }),
        value: anyValue,
        summary: '导入角色卡（PNG/JSON，base64）',
    },
    deleteCharacter: { req: z.object({ ...cardIdField }), value: anyValue, summary: '删除角色卡工作区' },
    getCharacterDetail: { req: z.object({ ...cardIdField }), value: anyValue, summary: '角色卡详情（归一化卡 + 开场白列表）' },
    saveCharacter: {
        req: z.object({
            ...cardIdField,
            name: z.string().optional(),
            description: z.string().optional(),
            personality: z.string().optional(),
            scenario: z.string().optional(),
            firstMes: z.string().optional(),
            alternateGreetings: z.array(z.string()).optional(),
            mesExample: z.string().optional(),
            systemPrompt: z.string().optional(),
            postHistoryInstructions: z.string().optional(),
            creatorNotes: z.string().optional(),
            creator: z.string().optional(),
            characterVersion: z.string().optional(),
            tags: z.array(z.string()).optional(),
            depthPrompt: z
                .object({
                prompt: z.string(),
                depth: z.number(),
                role: z.enum(['system', 'user', 'assistant']),
            })
                .nullable()
                .optional(),
        }),
        value: anyValue,
        summary: '保存角色卡正文（不改 cardId）',
    },
    createCharacter: { req: z.object({ name: z.string().min(1) }), value: anyValue, summary: '新建空白角色卡' },
    exportCharacter: { req: z.object({ ...cardIdField }), value: anyValue, summary: '导出角色卡 JSON 与 PNG' },
    // 预设
    listPresets: { req: z.object({}), value: anyValue, summary: '列出提示词预设' },
    importPreset: { req: z.object({ name: z.string().min(1), json: anyValue }), value: anyValue, summary: '导入 SillyTavern 预设 JSON' },
    savePreset: { req: z.object({ preset: anyValue }), value: anyValue, summary: '保存预设' },
    deletePreset: { req: z.object({ id: z.string().min(1) }), value: anyValue, summary: '删除预设' },
    getPreset: { req: z.object({ id: z.string().min(1) }), value: anyValue, summary: '读取预设' },
    // 世界书库
    listLorebooks: { req: z.object({}), value: anyValue, summary: '列出世界书' },
    getLorebook: { req: z.object({ name: z.string().min(1) }), value: anyValue, summary: '读取世界书原始 JSON' },
    importLorebook: { req: z.object({ name: z.string().min(1), json: anyValue }), value: anyValue, summary: '导入世界书 JSON' },
    saveLorebook: { req: z.object({ name: z.string().min(1), json: anyValue }), value: anyValue, summary: '保存世界书 JSON' },
    deleteLorebook: { req: z.object({ name: z.string().min(1) }), value: anyValue, summary: '删除世界书' },
    getCharacterLorebook: { req: z.object({ ...cardIdField }), value: anyValue, summary: '读取角色卡内嵌世界书' },
    saveCharacterLorebook: {
        req: z.object({ ...cardIdField, json: anyValue }),
        value: anyValue,
        summary: '保存角色卡内嵌世界书',
    },
    deleteEmbeddedLorebook: { req: z.object({ ...cardIdField }), value: anyValue, summary: '删除角色卡内嵌世界书（保留角色卡）' },
    getChatLorebook: { req: z.object({ ...cardIdField }), value: anyValue, summary: '读取会话世界书' },
    saveChatLorebook: { req: z.object({ ...cardIdField, json: anyValue }), value: anyValue, summary: '保存会话世界书' },
    getJournal: { req: z.object({ ...cardIdField }), value: anyValue, summary: '读取角色笔记 journal.md' },
    saveJournal: { req: z.object({ ...cardIdField, text: z.string() }), value: anyValue, summary: '保存角色笔记 journal.md' },
    // 人设
    listPersonas: { req: z.object({}), value: anyValue, summary: '列出人设' },
    savePersona: { req: z.object({ persona: anyValue }), value: anyValue, summary: '保存人设' },
    deletePersona: { req: z.object({ id: z.string().min(1) }), value: anyValue, summary: '删除人设' },
    // 正则
    listRegexRules: { req: z.object({}), value: anyValue, summary: '列出全局正则规则' },
    saveRegexRules: { req: z.object({ rules: z.array(anyValue) }), value: anyValue, summary: '保存全局正则规则' },
    // 会话绑定
    getSessionBinding: { req: z.object({ ...sessionIdField }), value: anyValue, summary: '读取会话绑定' },
    setSessionBinding: { req: z.object({ binding: anyValue }), value: anyValue, summary: '保存会话绑定' },
    clearSessionBinding: { req: z.object({ ...sessionIdField }), value: anyValue, summary: '清除会话角色卡绑定' },
    // 开场白
    ensureGreeting: { req: z.object({ ...sessionIdField }), value: anyValue, summary: '确保会话有开场白' },
    getGreetingSwipe: {
        req: z.object({ ...sessionIdField, ...messageIdField }),
        value: anyValue,
        summary: '开场白楼层的 swipe 下标（非开场白返回 null）',
    },
    renderOutputText: {
        req: z.object({ ...sessionIdField, text: z.string() }),
        value: anyValue,
        summary: '对展示文本应用 output/render 正则并抽出 HTML',
    },
    swipeGreeting: {
        req: z.object({ ...sessionIdField, index: z.number().int() }),
        value: anyValue,
        summary: '切换开场白变体（产生子会话）',
    },
    // 楼层（均按 assistant 消息 id 定位楼层；操作产生分支子会话，client 负责打开）
    regenerate: {
        req: z.object({ ...sessionIdField, messageId: z.string().min(1).optional() }),
        value: anyValue,
        summary: '重新生成指定楼层（缺省最后一轮），分支会话自动续跑',
    },
    rollbackToFloor: {
        req: z.object({ ...sessionIdField, ...messageIdField }),
        value: anyValue,
        summary: '回退到指定楼层（保留该层，丢弃其后），不自动续跑',
    },
    getFloorUserMessage: {
        req: z.object({ ...sessionIdField, ...messageIdField }),
        value: anyValue,
        summary: '读取指定楼层的首条用户消息（编辑预填用）',
    },
    editUserMessage: {
        req: z.object({ ...sessionIdField, ...messageIdField, text: z.string() }),
        value: anyValue,
        summary: '编辑指定楼层的用户消息并重跑（产生子会话）',
    },
    getFloorAssistantMessage: {
        req: z.object({ ...sessionIdField, ...messageIdField }),
        value: anyValue,
        summary: '读取指定楼层的 assistant 正文（编辑预填用）',
    },
    editAssistantMessage: {
        req: z.object({ ...sessionIdField, ...messageIdField, text: z.string().min(1) }),
        value: anyValue,
        summary: '编辑指定楼层的 assistant 正文（产生子会话，停在编辑后状态）',
    },
    continueFloor: {
        req: z.object({ ...sessionIdField, ...messageIdField }),
        value: anyValue,
        summary: '续写最后一层（被截断的）回复：不 fork，直接驱动画前会话',
    },
    getFloorSiblings: {
        req: z.object({ ...sessionIdField, ...messageIdField }),
        value: z.object({
            swipe: z
                .object({
                turn: z.number().int(),
                index: z.number().int(),
                total: z.number().int(),
                siblings: z.array(z.string()),
            })
                .nullable(),
        }),
        summary: '同一楼层分支会话的兄弟导航（‹ n/m ›；无兄弟时 swipe=null）',
    },
    impersonate: {
        req: z.object({ ...sessionIdField }),
        value: anyValue,
        summary: '以用户身份代写一句台词（不入会话日志，由前端填入输入）',
    },
    // 记忆
    getMemories: { req: z.object({ ...cardIdField }), value: anyValue, summary: '列出角色记忆' },
    saveMemory: {
        req: z.object({
            ...cardIdField,
            id: z.string().optional(),
            body: z.string().min(1),
            tags: z.array(z.string()).optional(),
            keys: z.array(z.string()).optional(),
        }),
        value: anyValue,
        summary: '新增或更新记忆',
    },
    deleteMemory: { req: z.object({ ...cardIdField, id: z.string().min(1) }), value: anyValue, summary: '删除记忆' },
    compressMemories: { req: z.object({ ...cardIdField }), value: anyValue, summary: '无损归并最旧一批记忆（减少条目数）' },
    // 世界状态
    getWorldDeltas: { req: z.object({ ...cardIdField }), value: anyValue, summary: '列出世界状态变化层' },
    revokeWorldDelta: { req: z.object({ ...cardIdField, id: z.string().min(1) }), value: anyValue, summary: '撤销一条变化' },
    addWorldDelta: {
        req: z.object({
            ...cardIdField,
            type: z.enum(['add', 'update', 'invalidate']),
            content: z.string().min(1),
            ref: z.string().nullable().optional(),
            keys: z.array(z.string()).optional(),
            order: z.number().optional(),
        }),
        value: anyValue,
        summary: '手动新增一条世界状态',
    },
    exportMergedLorebook: { req: z.object({ ...cardIdField }), value: anyValue, summary: '导出合并变化层后的世界书' },
    // 调试
    getTriggerLog: { req: z.object({ ...sessionIdField }), value: anyValue, summary: '最近一次组装的触发日志' },
    previewPrompt: { req: z.object({ ...sessionIdField }), value: anyValue, summary: '预览完整提示词序列' },
    getContextUsage: {
        req: z.object({ ...sessionIdField }),
        value: anyValue,
        summary: '读取会话上下文占用（token-meter 投影；宿主未挂投影时 usage=null）',
    },
    getDataInfo: { req: z.object({}), value: anyValue, summary: 'Tavern 数据目录路径' },
    getAvatar: { req: z.object({ ...cardIdField }), value: anyValue, summary: '角色头像 dataURL' },
    // 设置（采样参数与世界书全局设置等，落 dsh 设置命名空间 dsh-tavern）
    getSettings: { req: z.object({}), value: anyValue, summary: '读取 Tavern 设置' },
    updateSettings: { req: z.object({ patch: anyValue }), value: anyValue, summary: '合并更新 Tavern 设置' },
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
