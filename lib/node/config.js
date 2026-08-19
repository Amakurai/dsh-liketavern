/**
 * 插件设置（settings namespace `dsh-tavern`）。
 * 用户层覆盖经 dsh-settings 持久化到 ~/.dsh/settings.yaml，UI 设置面板读写。
 */
import z from '@deepseek-ai/schemastery';
import { DEFAULT_SAMPLING, DEFAULT_WI_SETTINGS } from '../core/types.js';
export const TAVERN_NS = 'dsh-tavern';
const SamplingSchema = z.object({
    /** 0–2，默认 1（DeepSeek 官方）。thinking 模式下不生效。 */
    temperature: z.number().min(0).max(2).default(DEFAULT_SAMPLING.temperature),
    /** 0–1，默认 1。当前 dsh 模型服务不透传（受平台限制项，见 README）。 */
    topP: z.number().min(0).max(1).default(DEFAULT_SAMPLING.topP),
    /** 单次生成最大 token；0 = 不设置（沿用 dsh 模型默认）。 */
    maxTokens: z.number().min(0).default(0),
    /** 停止序列（DeepSeek 最多 16 个）。 */
    stop: z.array(String).default(DEFAULT_SAMPLING.stop),
    /** DeepSeek 官方已废弃（传入无效），仅作记录。 */
    presencePenalty: z.number().min(-2).max(2).default(DEFAULT_SAMPLING.presencePenalty),
    frequencyPenalty: z.number().min(-2).max(2).default(DEFAULT_SAMPLING.frequencyPenalty),
    /** thinking 开关；绑定会话时按模型公布的 reasoning 档写入 reasoningEffort（关→off）。 */
    thinking: z.union([z.const('enabled'), z.const('disabled')]).default(DEFAULT_SAMPLING.thinking),
}).default({
    temperature: DEFAULT_SAMPLING.temperature,
    topP: DEFAULT_SAMPLING.topP,
    maxTokens: 0,
    stop: [],
    presencePenalty: DEFAULT_SAMPLING.presencePenalty,
    frequencyPenalty: DEFAULT_SAMPLING.frequencyPenalty,
    thinking: DEFAULT_SAMPLING.thinking,
});
const WorldInfoSchema = z.object({
    scanDepth: z.number().min(0).default(DEFAULT_WI_SETTINGS.scanDepth),
    contextPercent: z.number().min(0).max(100).default(DEFAULT_WI_SETTINGS.contextPercent),
    tokenBudget: z.number().min(0).default(DEFAULT_WI_SETTINGS.tokenBudget),
    recursiveScan: z.boolean().default(DEFAULT_WI_SETTINGS.recursiveScan),
    maxRecursionSteps: z.number().min(0).default(DEFAULT_WI_SETTINGS.maxRecursionSteps),
    caseSensitive: z.boolean().default(DEFAULT_WI_SETTINGS.caseSensitive),
    /** 整词匹配对中文不友好，默认关（SillyTavern 出厂为开，差异见 README）。 */
    matchWholeWords: z.boolean().default(DEFAULT_WI_SETTINGS.matchWholeWords),
    includeNames: z.boolean().default(DEFAULT_WI_SETTINGS.includeNames),
    overflowWarning: z.boolean().default(DEFAULT_WI_SETTINGS.overflowWarning),
    characterStrategy: z.union([z.const(0), z.const(1), z.const(2)]).default(DEFAULT_WI_SETTINGS.characterStrategy),
}).default({ ...DEFAULT_WI_SETTINGS });
const SessionDefaultsSchema = z.object({
    /** 点选角色时套用的备选角色卡；空串 = 不预填。新对话不会自动绑定。 */
    cardId: z.string().default(''),
    /** 默认提示词预设 identifier；空串 = 内建默认预设。 */
    presetId: z.string().default(''),
    personaId: z.string().default(''),
    lorebookIds: z.array(String).default([]),
    /** 主世界书；空串 = 用卡内嵌书（若有）。 */
    characterLorebookId: z.string().default(''),
}).default({
    cardId: '',
    presetId: '',
    personaId: '',
    lorebookIds: [],
    characterLorebookId: '',
});
const MemorySchema = z.object({
    /** 每角色记忆条数上限，超出触发压缩。 */
    maxEntries: z.number().min(1).default(200),
    /** 每角色记忆 token 上限（估算），超出触发压缩。 */
    maxTokens: z.number().min(0).default(20000),
    /** 每轮检索注入的条数。 */
    retrievalTopK: z.number().min(0).default(5),
    /** 每轮检索注入的 token 预算。 */
    retrievalTokenBudget: z.number().min(0).default(1200),
    /** 时间衰减半衰期（天）；0 = 不衰减。 */
    halfLifeDays: z.number().min(0).default(30),
    /** 写入去重相似度阈值（BM25 分）。 */
    dedupScore: z.number().min(0).default(4),
    /** 每次压缩合并的最旧条数。 */
    compressBatch: z.number().min(2).default(20),
    /** 检索 query 取最近 N 条消息。 */
    queryMessages: z.number().min(1).default(4),
}).default({
    maxEntries: 200,
    maxTokens: 20000,
    retrievalTopK: 5,
    retrievalTokenBudget: 1200,
    halfLifeDays: 30,
    dedupScore: 4,
    compressBatch: 20,
    queryMessages: 4,
});
export const TavernConfigSchema = z.object({
    sampling: SamplingSchema,
    worldInfo: WorldInfoSchema,
    memory: MemorySchema,
    defaults: SessionDefaultsSchema,
    /** 交互卡全局开关（关闭则一律纯文本渲染）。 */
    interactiveCards: z.boolean().default(true),
    /** 删除角色卡时连同其内嵌世界书一起删除；关闭则删卡前把内嵌书抢救到世界书库。 */
    cascadeDeleteEmbeddedBook: z.boolean().default(true),
    /** 交互卡脚本信任的主机（放宽 connect-src 与 script-src；`*` = 全部放行。img/font 默认已放行 https）。 */
    cardNetworkWhitelist: z.array(String).default([]),
    /** 触发日志保留的最大条数（每会话最近一次组装的明细）。 */
    triggerLogMax: z.number().min(10).default(200),
});
/** schemastery 解析结果 → 运行时配置（maxTokens 0 → null）。 */
export function resolveConfig(raw) {
    const value = TavernConfigSchema(raw);
    return {
        sampling: {
            ...value.sampling,
            maxTokens: value.sampling.maxTokens > 0 ? value.sampling.maxTokens : null,
        },
        worldInfo: { ...value.worldInfo },
        memory: { ...value.memory },
        defaults: {
            cardId: value.defaults.cardId,
            presetId: value.defaults.presetId,
            personaId: value.defaults.personaId,
            lorebookIds: [...value.defaults.lorebookIds],
            characterLorebookId: value.defaults.characterLorebookId,
        },
        interactiveCards: value.interactiveCards,
        cascadeDeleteEmbeddedBook: value.cascadeDeleteEmbeddedBook,
        cardNetworkWhitelist: [...value.cardNetworkWhitelist],
        triggerLogMax: value.triggerLogMax,
    };
}
