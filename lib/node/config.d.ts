/**
 * 插件设置（settings namespace `dsh-tavern`）。
 * 用户层覆盖经 dsh-settings 的 volatile Config 持久化到当前 profile，UI 设置面板读写。
 */
import z from '@deepseek-ai/schemastery';
import { type SamplingSettings, type WorldInfoGlobalSettings } from '../core/types.js';
export declare const TAVERN_NS = "dsh-tavern";
export declare const TavernConfigSchema: z<Schemastery.ObjectS<NoInfer<{
    /** 前端界面语言（面板/芯片/英雄区/操作条等本插件 UI 文案）；auto（默认）跟随宿主界面语言，设置页可锁定中/英。 */
    locale: z<"auto" | "en" | "zh", "auto" | "en" | "zh", "defined">;
    prompts: z<Schemastery.ObjectS<NoInfer<{
        preferCharacterPrompt: z<boolean, boolean, "defined">;
        preferCharacterInstructions: z<boolean, boolean, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        preferCharacterPrompt: z<boolean, boolean, "defined">;
        preferCharacterInstructions: z<boolean, boolean, "defined">;
    }>>, "defined">;
    sampling: z<Schemastery.ObjectS<NoInfer<{
        /** 0–2，默认 1（DeepSeek 官方）。thinking 模式下不生效。 */
        temperature: z<number, number, "defined">;
        /** 0–1，默认 1。当前 dsh 模型服务不透传（受平台限制项，见 README）。 */
        topP: z<number, number, "defined">;
        /** 单次生成最大 token；0 = 不设置（沿用 dsh 模型默认）。 */
        maxTokens: z<number, number, "defined">;
        /** 停止序列（DeepSeek 最多 16 个）。 */
        stop: z<string[], string[], "defined">;
        /** DeepSeek 官方已废弃（传入无效），仅作记录。 */
        presencePenalty: z<number, number, "defined">;
        frequencyPenalty: z<number, number, "defined">;
        /** thinking 档位；绑定会话时按模型公布的 reasoning 档写入 reasoningEffort（disabled→off，low/high/max→公布才显式指定）。 */
        thinking: z<"disabled" | "enabled" | "low" | "high" | "max", "disabled" | "enabled" | "low" | "high" | "max", "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        /** 0–2，默认 1（DeepSeek 官方）。thinking 模式下不生效。 */
        temperature: z<number, number, "defined">;
        /** 0–1，默认 1。当前 dsh 模型服务不透传（受平台限制项，见 README）。 */
        topP: z<number, number, "defined">;
        /** 单次生成最大 token；0 = 不设置（沿用 dsh 模型默认）。 */
        maxTokens: z<number, number, "defined">;
        /** 停止序列（DeepSeek 最多 16 个）。 */
        stop: z<string[], string[], "defined">;
        /** DeepSeek 官方已废弃（传入无效），仅作记录。 */
        presencePenalty: z<number, number, "defined">;
        frequencyPenalty: z<number, number, "defined">;
        /** thinking 档位；绑定会话时按模型公布的 reasoning 档写入 reasoningEffort（disabled→off，low/high/max→公布才显式指定）。 */
        thinking: z<"disabled" | "enabled" | "low" | "high" | "max", "disabled" | "enabled" | "low" | "high" | "max", "defined">;
    }>>, "defined">;
    worldInfo: z<Schemastery.ObjectS<NoInfer<{
        scanDepth: z<number, number, "defined">;
        minActivations: z<number, number, "defined">;
        maxScanDepth: z<number, number, "defined">;
        contextPercent: z<number, number, "defined">;
        tokenBudget: z<number, number, "defined">;
        recursiveScan: z<boolean, boolean, "defined">;
        maxRecursionSteps: z<number, number, "defined">;
        caseSensitive: z<boolean, boolean, "defined">;
        /** 整词匹配对中文不友好，默认关（SillyTavern 出厂为开，差异见 README）。 */
        matchWholeWords: z<boolean, boolean, "defined">;
        includeNames: z<boolean, boolean, "defined">;
        overflowWarning: z<boolean, boolean, "defined">;
        characterStrategy: z<0 | 1 | 2, 0 | 1 | 2, "defined">;
        useGroupScoring: z<boolean, boolean, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        scanDepth: z<number, number, "defined">;
        minActivations: z<number, number, "defined">;
        maxScanDepth: z<number, number, "defined">;
        contextPercent: z<number, number, "defined">;
        tokenBudget: z<number, number, "defined">;
        recursiveScan: z<boolean, boolean, "defined">;
        maxRecursionSteps: z<number, number, "defined">;
        caseSensitive: z<boolean, boolean, "defined">;
        /** 整词匹配对中文不友好，默认关（SillyTavern 出厂为开，差异见 README）。 */
        matchWholeWords: z<boolean, boolean, "defined">;
        includeNames: z<boolean, boolean, "defined">;
        overflowWarning: z<boolean, boolean, "defined">;
        characterStrategy: z<0 | 1 | 2, 0 | 1 | 2, "defined">;
        useGroupScoring: z<boolean, boolean, "defined">;
    }>>, "defined">;
    memory: z<Schemastery.ObjectS<NoInfer<{
        /** 每角色记忆条数上限，超出触发压缩。 */
        maxEntries: z<number, number, "defined">;
        /** 每角色记忆 token 上限（估算），超出触发压缩。 */
        maxTokens: z<number, number, "defined">;
        /** 每轮检索注入的条数。 */
        retrievalTopK: z<number, number, "defined">;
        /** 每轮检索注入的 token 预算。 */
        retrievalTokenBudget: z<number, number, "defined">;
        /** 时间衰减半衰期（天）；0 = 不衰减。 */
        halfLifeDays: z<number, number, "defined">;
        /** 写入去重相似度阈值（BM25 分）。 */
        dedupScore: z<number, number, "defined">;
        /** 每次压缩合并的最旧条数。 */
        compressBatch: z<number, number, "defined">;
        /** 检索 query 取最近 N 条消息。 */
        queryMessages: z<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        /** 每角色记忆条数上限，超出触发压缩。 */
        maxEntries: z<number, number, "defined">;
        /** 每角色记忆 token 上限（估算），超出触发压缩。 */
        maxTokens: z<number, number, "defined">;
        /** 每轮检索注入的条数。 */
        retrievalTopK: z<number, number, "defined">;
        /** 每轮检索注入的 token 预算。 */
        retrievalTokenBudget: z<number, number, "defined">;
        /** 时间衰减半衰期（天）；0 = 不衰减。 */
        halfLifeDays: z<number, number, "defined">;
        /** 写入去重相似度阈值（BM25 分）。 */
        dedupScore: z<number, number, "defined">;
        /** 每次压缩合并的最旧条数。 */
        compressBatch: z<number, number, "defined">;
        /** 检索 query 取最近 N 条消息。 */
        queryMessages: z<number, number, "defined">;
    }>>, "defined">;
    defaults: z<Schemastery.ObjectS<NoInfer<{
        /** 点选角色时套用的备选角色卡；空串 = 不预填。新对话不会自动绑定。 */
        cardId: z<string, string, "defined">;
        /** 默认提示词预设 identifier；空串 = 内建默认预设。 */
        presetId: z<string, string, "defined">;
        personaId: z<string, string, "defined">;
        lorebookIds: z<string[], string[], "defined">;
        /** 主世界书；空串 = 用卡内嵌书（若有）。 */
        characterLorebookId: z<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        /** 点选角色时套用的备选角色卡；空串 = 不预填。新对话不会自动绑定。 */
        cardId: z<string, string, "defined">;
        /** 默认提示词预设 identifier；空串 = 内建默认预设。 */
        presetId: z<string, string, "defined">;
        personaId: z<string, string, "defined">;
        lorebookIds: z<string[], string[], "defined">;
        /** 主世界书；空串 = 用卡内嵌书（若有）。 */
        characterLorebookId: z<string, string, "defined">;
    }>>, "defined">;
    /** 交互卡全局开关（关闭则一律纯文本渲染）。 */
    interactiveCards: z<boolean, boolean, "defined">;
    /** 删除角色卡时连同其内嵌世界书一起删除；关闭则删卡前把内嵌书抢救到世界书库。 */
    cascadeDeleteEmbeddedBook: z<boolean, boolean, "defined">;
    /** 交互卡脚本信任的主机（放宽 connect-src 与 script-src；`*` = 全部放行。img/font 默认已放行 https）。 */
    cardNetworkWhitelist: z<string[], string[], "defined">;
    /** 触发日志保留的最大条数（每会话最近一次组装的明细）。 */
    triggerLogMax: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    /** 前端界面语言（面板/芯片/英雄区/操作条等本插件 UI 文案）；auto（默认）跟随宿主界面语言，设置页可锁定中/英。 */
    locale: z<"auto" | "en" | "zh", "auto" | "en" | "zh", "defined">;
    prompts: z<Schemastery.ObjectS<NoInfer<{
        preferCharacterPrompt: z<boolean, boolean, "defined">;
        preferCharacterInstructions: z<boolean, boolean, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        preferCharacterPrompt: z<boolean, boolean, "defined">;
        preferCharacterInstructions: z<boolean, boolean, "defined">;
    }>>, "defined">;
    sampling: z<Schemastery.ObjectS<NoInfer<{
        /** 0–2，默认 1（DeepSeek 官方）。thinking 模式下不生效。 */
        temperature: z<number, number, "defined">;
        /** 0–1，默认 1。当前 dsh 模型服务不透传（受平台限制项，见 README）。 */
        topP: z<number, number, "defined">;
        /** 单次生成最大 token；0 = 不设置（沿用 dsh 模型默认）。 */
        maxTokens: z<number, number, "defined">;
        /** 停止序列（DeepSeek 最多 16 个）。 */
        stop: z<string[], string[], "defined">;
        /** DeepSeek 官方已废弃（传入无效），仅作记录。 */
        presencePenalty: z<number, number, "defined">;
        frequencyPenalty: z<number, number, "defined">;
        /** thinking 档位；绑定会话时按模型公布的 reasoning 档写入 reasoningEffort（disabled→off，low/high/max→公布才显式指定）。 */
        thinking: z<"disabled" | "enabled" | "low" | "high" | "max", "disabled" | "enabled" | "low" | "high" | "max", "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        /** 0–2，默认 1（DeepSeek 官方）。thinking 模式下不生效。 */
        temperature: z<number, number, "defined">;
        /** 0–1，默认 1。当前 dsh 模型服务不透传（受平台限制项，见 README）。 */
        topP: z<number, number, "defined">;
        /** 单次生成最大 token；0 = 不设置（沿用 dsh 模型默认）。 */
        maxTokens: z<number, number, "defined">;
        /** 停止序列（DeepSeek 最多 16 个）。 */
        stop: z<string[], string[], "defined">;
        /** DeepSeek 官方已废弃（传入无效），仅作记录。 */
        presencePenalty: z<number, number, "defined">;
        frequencyPenalty: z<number, number, "defined">;
        /** thinking 档位；绑定会话时按模型公布的 reasoning 档写入 reasoningEffort（disabled→off，low/high/max→公布才显式指定）。 */
        thinking: z<"disabled" | "enabled" | "low" | "high" | "max", "disabled" | "enabled" | "low" | "high" | "max", "defined">;
    }>>, "defined">;
    worldInfo: z<Schemastery.ObjectS<NoInfer<{
        scanDepth: z<number, number, "defined">;
        minActivations: z<number, number, "defined">;
        maxScanDepth: z<number, number, "defined">;
        contextPercent: z<number, number, "defined">;
        tokenBudget: z<number, number, "defined">;
        recursiveScan: z<boolean, boolean, "defined">;
        maxRecursionSteps: z<number, number, "defined">;
        caseSensitive: z<boolean, boolean, "defined">;
        /** 整词匹配对中文不友好，默认关（SillyTavern 出厂为开，差异见 README）。 */
        matchWholeWords: z<boolean, boolean, "defined">;
        includeNames: z<boolean, boolean, "defined">;
        overflowWarning: z<boolean, boolean, "defined">;
        characterStrategy: z<0 | 1 | 2, 0 | 1 | 2, "defined">;
        useGroupScoring: z<boolean, boolean, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        scanDepth: z<number, number, "defined">;
        minActivations: z<number, number, "defined">;
        maxScanDepth: z<number, number, "defined">;
        contextPercent: z<number, number, "defined">;
        tokenBudget: z<number, number, "defined">;
        recursiveScan: z<boolean, boolean, "defined">;
        maxRecursionSteps: z<number, number, "defined">;
        caseSensitive: z<boolean, boolean, "defined">;
        /** 整词匹配对中文不友好，默认关（SillyTavern 出厂为开，差异见 README）。 */
        matchWholeWords: z<boolean, boolean, "defined">;
        includeNames: z<boolean, boolean, "defined">;
        overflowWarning: z<boolean, boolean, "defined">;
        characterStrategy: z<0 | 1 | 2, 0 | 1 | 2, "defined">;
        useGroupScoring: z<boolean, boolean, "defined">;
    }>>, "defined">;
    memory: z<Schemastery.ObjectS<NoInfer<{
        /** 每角色记忆条数上限，超出触发压缩。 */
        maxEntries: z<number, number, "defined">;
        /** 每角色记忆 token 上限（估算），超出触发压缩。 */
        maxTokens: z<number, number, "defined">;
        /** 每轮检索注入的条数。 */
        retrievalTopK: z<number, number, "defined">;
        /** 每轮检索注入的 token 预算。 */
        retrievalTokenBudget: z<number, number, "defined">;
        /** 时间衰减半衰期（天）；0 = 不衰减。 */
        halfLifeDays: z<number, number, "defined">;
        /** 写入去重相似度阈值（BM25 分）。 */
        dedupScore: z<number, number, "defined">;
        /** 每次压缩合并的最旧条数。 */
        compressBatch: z<number, number, "defined">;
        /** 检索 query 取最近 N 条消息。 */
        queryMessages: z<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        /** 每角色记忆条数上限，超出触发压缩。 */
        maxEntries: z<number, number, "defined">;
        /** 每角色记忆 token 上限（估算），超出触发压缩。 */
        maxTokens: z<number, number, "defined">;
        /** 每轮检索注入的条数。 */
        retrievalTopK: z<number, number, "defined">;
        /** 每轮检索注入的 token 预算。 */
        retrievalTokenBudget: z<number, number, "defined">;
        /** 时间衰减半衰期（天）；0 = 不衰减。 */
        halfLifeDays: z<number, number, "defined">;
        /** 写入去重相似度阈值（BM25 分）。 */
        dedupScore: z<number, number, "defined">;
        /** 每次压缩合并的最旧条数。 */
        compressBatch: z<number, number, "defined">;
        /** 检索 query 取最近 N 条消息。 */
        queryMessages: z<number, number, "defined">;
    }>>, "defined">;
    defaults: z<Schemastery.ObjectS<NoInfer<{
        /** 点选角色时套用的备选角色卡；空串 = 不预填。新对话不会自动绑定。 */
        cardId: z<string, string, "defined">;
        /** 默认提示词预设 identifier；空串 = 内建默认预设。 */
        presetId: z<string, string, "defined">;
        personaId: z<string, string, "defined">;
        lorebookIds: z<string[], string[], "defined">;
        /** 主世界书；空串 = 用卡内嵌书（若有）。 */
        characterLorebookId: z<string, string, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        /** 点选角色时套用的备选角色卡；空串 = 不预填。新对话不会自动绑定。 */
        cardId: z<string, string, "defined">;
        /** 默认提示词预设 identifier；空串 = 内建默认预设。 */
        presetId: z<string, string, "defined">;
        personaId: z<string, string, "defined">;
        lorebookIds: z<string[], string[], "defined">;
        /** 主世界书；空串 = 用卡内嵌书（若有）。 */
        characterLorebookId: z<string, string, "defined">;
    }>>, "defined">;
    /** 交互卡全局开关（关闭则一律纯文本渲染）。 */
    interactiveCards: z<boolean, boolean, "defined">;
    /** 删除角色卡时连同其内嵌世界书一起删除；关闭则删卡前把内嵌书抢救到世界书库。 */
    cascadeDeleteEmbeddedBook: z<boolean, boolean, "defined">;
    /** 交互卡脚本信任的主机（放宽 connect-src 与 script-src；`*` = 全部放行。img/font 默认已放行 https）。 */
    cardNetworkWhitelist: z<string[], string[], "defined">;
    /** 触发日志保留的最大条数（每会话最近一次组装的明细）。 */
    triggerLogMax: z<number, number, "defined">;
}>>, "plain">;
export type TavernConfigRaw = ReturnType<typeof TavernConfigSchema>;
/** 宿主 0.1.7 的配置表单读取 volatile 字段，保存到当前 profile 并即时更新。 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    locale: z<any, any, "volatile">;
    prompts: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        preferCharacterPrompt: z<boolean, boolean, "defined">;
        preferCharacterInstructions: z<boolean, boolean, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        preferCharacterPrompt: z<boolean, boolean, "defined">;
        preferCharacterInstructions: z<boolean, boolean, "defined">;
    }>>>, "volatile-defined">;
    sampling: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        /** 0–2，默认 1（DeepSeek 官方）。thinking 模式下不生效。 */
        temperature: z<number, number, "defined">;
        /** 0–1，默认 1。当前 dsh 模型服务不透传（受平台限制项，见 README）。 */
        topP: z<number, number, "defined">;
        /** 单次生成最大 token；0 = 不设置（沿用 dsh 模型默认）。 */
        maxTokens: z<number, number, "defined">;
        /** 停止序列（DeepSeek 最多 16 个）。 */
        stop: z<string[], string[], "defined">;
        /** DeepSeek 官方已废弃（传入无效），仅作记录。 */
        presencePenalty: z<number, number, "defined">;
        frequencyPenalty: z<number, number, "defined">;
        /** thinking 档位；绑定会话时按模型公布的 reasoning 档写入 reasoningEffort（disabled→off，low/high/max→公布才显式指定）。 */
        thinking: z<"disabled" | "enabled" | "low" | "high" | "max", "disabled" | "enabled" | "low" | "high" | "max", "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        /** 0–2，默认 1（DeepSeek 官方）。thinking 模式下不生效。 */
        temperature: z<number, number, "defined">;
        /** 0–1，默认 1。当前 dsh 模型服务不透传（受平台限制项，见 README）。 */
        topP: z<number, number, "defined">;
        /** 单次生成最大 token；0 = 不设置（沿用 dsh 模型默认）。 */
        maxTokens: z<number, number, "defined">;
        /** 停止序列（DeepSeek 最多 16 个）。 */
        stop: z<string[], string[], "defined">;
        /** DeepSeek 官方已废弃（传入无效），仅作记录。 */
        presencePenalty: z<number, number, "defined">;
        frequencyPenalty: z<number, number, "defined">;
        /** thinking 档位；绑定会话时按模型公布的 reasoning 档写入 reasoningEffort（disabled→off，low/high/max→公布才显式指定）。 */
        thinking: z<"disabled" | "enabled" | "low" | "high" | "max", "disabled" | "enabled" | "low" | "high" | "max", "defined">;
    }>>>, "volatile-defined">;
    worldInfo: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        scanDepth: z<number, number, "defined">;
        minActivations: z<number, number, "defined">;
        maxScanDepth: z<number, number, "defined">;
        contextPercent: z<number, number, "defined">;
        tokenBudget: z<number, number, "defined">;
        recursiveScan: z<boolean, boolean, "defined">;
        maxRecursionSteps: z<number, number, "defined">;
        caseSensitive: z<boolean, boolean, "defined">;
        /** 整词匹配对中文不友好，默认关（SillyTavern 出厂为开，差异见 README）。 */
        matchWholeWords: z<boolean, boolean, "defined">;
        includeNames: z<boolean, boolean, "defined">;
        overflowWarning: z<boolean, boolean, "defined">;
        characterStrategy: z<0 | 1 | 2, 0 | 1 | 2, "defined">;
        useGroupScoring: z<boolean, boolean, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        scanDepth: z<number, number, "defined">;
        minActivations: z<number, number, "defined">;
        maxScanDepth: z<number, number, "defined">;
        contextPercent: z<number, number, "defined">;
        tokenBudget: z<number, number, "defined">;
        recursiveScan: z<boolean, boolean, "defined">;
        maxRecursionSteps: z<number, number, "defined">;
        caseSensitive: z<boolean, boolean, "defined">;
        /** 整词匹配对中文不友好，默认关（SillyTavern 出厂为开，差异见 README）。 */
        matchWholeWords: z<boolean, boolean, "defined">;
        includeNames: z<boolean, boolean, "defined">;
        overflowWarning: z<boolean, boolean, "defined">;
        characterStrategy: z<0 | 1 | 2, 0 | 1 | 2, "defined">;
        useGroupScoring: z<boolean, boolean, "defined">;
    }>>>, "volatile-defined">;
    memory: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        /** 每角色记忆条数上限，超出触发压缩。 */
        maxEntries: z<number, number, "defined">;
        /** 每角色记忆 token 上限（估算），超出触发压缩。 */
        maxTokens: z<number, number, "defined">;
        /** 每轮检索注入的条数。 */
        retrievalTopK: z<number, number, "defined">;
        /** 每轮检索注入的 token 预算。 */
        retrievalTokenBudget: z<number, number, "defined">;
        /** 时间衰减半衰期（天）；0 = 不衰减。 */
        halfLifeDays: z<number, number, "defined">;
        /** 写入去重相似度阈值（BM25 分）。 */
        dedupScore: z<number, number, "defined">;
        /** 每次压缩合并的最旧条数。 */
        compressBatch: z<number, number, "defined">;
        /** 检索 query 取最近 N 条消息。 */
        queryMessages: z<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        /** 每角色记忆条数上限，超出触发压缩。 */
        maxEntries: z<number, number, "defined">;
        /** 每角色记忆 token 上限（估算），超出触发压缩。 */
        maxTokens: z<number, number, "defined">;
        /** 每轮检索注入的条数。 */
        retrievalTopK: z<number, number, "defined">;
        /** 每轮检索注入的 token 预算。 */
        retrievalTokenBudget: z<number, number, "defined">;
        /** 时间衰减半衰期（天）；0 = 不衰减。 */
        halfLifeDays: z<number, number, "defined">;
        /** 写入去重相似度阈值（BM25 分）。 */
        dedupScore: z<number, number, "defined">;
        /** 每次压缩合并的最旧条数。 */
        compressBatch: z<number, number, "defined">;
        /** 检索 query 取最近 N 条消息。 */
        queryMessages: z<number, number, "defined">;
    }>>>, "volatile-defined">;
    defaults: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        /** 点选角色时套用的备选角色卡；空串 = 不预填。新对话不会自动绑定。 */
        cardId: z<string, string, "defined">;
        /** 默认提示词预设 identifier；空串 = 内建默认预设。 */
        presetId: z<string, string, "defined">;
        personaId: z<string, string, "defined">;
        lorebookIds: z<string[], string[], "defined">;
        /** 主世界书；空串 = 用卡内嵌书（若有）。 */
        characterLorebookId: z<string, string, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        /** 点选角色时套用的备选角色卡；空串 = 不预填。新对话不会自动绑定。 */
        cardId: z<string, string, "defined">;
        /** 默认提示词预设 identifier；空串 = 内建默认预设。 */
        presetId: z<string, string, "defined">;
        personaId: z<string, string, "defined">;
        lorebookIds: z<string[], string[], "defined">;
        /** 主世界书；空串 = 用卡内嵌书（若有）。 */
        characterLorebookId: z<string, string, "defined">;
    }>>>, "volatile-defined">;
    interactiveCards: z<boolean, boolean, "volatile-defined">;
    cascadeDeleteEmbeddedBook: z<boolean, boolean, "volatile-defined">;
    cardNetworkWhitelist: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    triggerLogMax: z<number, number, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    locale: z<any, any, "volatile">;
    prompts: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        preferCharacterPrompt: z<boolean, boolean, "defined">;
        preferCharacterInstructions: z<boolean, boolean, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        preferCharacterPrompt: z<boolean, boolean, "defined">;
        preferCharacterInstructions: z<boolean, boolean, "defined">;
    }>>>, "volatile-defined">;
    sampling: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        /** 0–2，默认 1（DeepSeek 官方）。thinking 模式下不生效。 */
        temperature: z<number, number, "defined">;
        /** 0–1，默认 1。当前 dsh 模型服务不透传（受平台限制项，见 README）。 */
        topP: z<number, number, "defined">;
        /** 单次生成最大 token；0 = 不设置（沿用 dsh 模型默认）。 */
        maxTokens: z<number, number, "defined">;
        /** 停止序列（DeepSeek 最多 16 个）。 */
        stop: z<string[], string[], "defined">;
        /** DeepSeek 官方已废弃（传入无效），仅作记录。 */
        presencePenalty: z<number, number, "defined">;
        frequencyPenalty: z<number, number, "defined">;
        /** thinking 档位；绑定会话时按模型公布的 reasoning 档写入 reasoningEffort（disabled→off，low/high/max→公布才显式指定）。 */
        thinking: z<"disabled" | "enabled" | "low" | "high" | "max", "disabled" | "enabled" | "low" | "high" | "max", "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        /** 0–2，默认 1（DeepSeek 官方）。thinking 模式下不生效。 */
        temperature: z<number, number, "defined">;
        /** 0–1，默认 1。当前 dsh 模型服务不透传（受平台限制项，见 README）。 */
        topP: z<number, number, "defined">;
        /** 单次生成最大 token；0 = 不设置（沿用 dsh 模型默认）。 */
        maxTokens: z<number, number, "defined">;
        /** 停止序列（DeepSeek 最多 16 个）。 */
        stop: z<string[], string[], "defined">;
        /** DeepSeek 官方已废弃（传入无效），仅作记录。 */
        presencePenalty: z<number, number, "defined">;
        frequencyPenalty: z<number, number, "defined">;
        /** thinking 档位；绑定会话时按模型公布的 reasoning 档写入 reasoningEffort（disabled→off，low/high/max→公布才显式指定）。 */
        thinking: z<"disabled" | "enabled" | "low" | "high" | "max", "disabled" | "enabled" | "low" | "high" | "max", "defined">;
    }>>>, "volatile-defined">;
    worldInfo: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        scanDepth: z<number, number, "defined">;
        minActivations: z<number, number, "defined">;
        maxScanDepth: z<number, number, "defined">;
        contextPercent: z<number, number, "defined">;
        tokenBudget: z<number, number, "defined">;
        recursiveScan: z<boolean, boolean, "defined">;
        maxRecursionSteps: z<number, number, "defined">;
        caseSensitive: z<boolean, boolean, "defined">;
        /** 整词匹配对中文不友好，默认关（SillyTavern 出厂为开，差异见 README）。 */
        matchWholeWords: z<boolean, boolean, "defined">;
        includeNames: z<boolean, boolean, "defined">;
        overflowWarning: z<boolean, boolean, "defined">;
        characterStrategy: z<0 | 1 | 2, 0 | 1 | 2, "defined">;
        useGroupScoring: z<boolean, boolean, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        scanDepth: z<number, number, "defined">;
        minActivations: z<number, number, "defined">;
        maxScanDepth: z<number, number, "defined">;
        contextPercent: z<number, number, "defined">;
        tokenBudget: z<number, number, "defined">;
        recursiveScan: z<boolean, boolean, "defined">;
        maxRecursionSteps: z<number, number, "defined">;
        caseSensitive: z<boolean, boolean, "defined">;
        /** 整词匹配对中文不友好，默认关（SillyTavern 出厂为开，差异见 README）。 */
        matchWholeWords: z<boolean, boolean, "defined">;
        includeNames: z<boolean, boolean, "defined">;
        overflowWarning: z<boolean, boolean, "defined">;
        characterStrategy: z<0 | 1 | 2, 0 | 1 | 2, "defined">;
        useGroupScoring: z<boolean, boolean, "defined">;
    }>>>, "volatile-defined">;
    memory: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        /** 每角色记忆条数上限，超出触发压缩。 */
        maxEntries: z<number, number, "defined">;
        /** 每角色记忆 token 上限（估算），超出触发压缩。 */
        maxTokens: z<number, number, "defined">;
        /** 每轮检索注入的条数。 */
        retrievalTopK: z<number, number, "defined">;
        /** 每轮检索注入的 token 预算。 */
        retrievalTokenBudget: z<number, number, "defined">;
        /** 时间衰减半衰期（天）；0 = 不衰减。 */
        halfLifeDays: z<number, number, "defined">;
        /** 写入去重相似度阈值（BM25 分）。 */
        dedupScore: z<number, number, "defined">;
        /** 每次压缩合并的最旧条数。 */
        compressBatch: z<number, number, "defined">;
        /** 检索 query 取最近 N 条消息。 */
        queryMessages: z<number, number, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        /** 每角色记忆条数上限，超出触发压缩。 */
        maxEntries: z<number, number, "defined">;
        /** 每角色记忆 token 上限（估算），超出触发压缩。 */
        maxTokens: z<number, number, "defined">;
        /** 每轮检索注入的条数。 */
        retrievalTopK: z<number, number, "defined">;
        /** 每轮检索注入的 token 预算。 */
        retrievalTokenBudget: z<number, number, "defined">;
        /** 时间衰减半衰期（天）；0 = 不衰减。 */
        halfLifeDays: z<number, number, "defined">;
        /** 写入去重相似度阈值（BM25 分）。 */
        dedupScore: z<number, number, "defined">;
        /** 每次压缩合并的最旧条数。 */
        compressBatch: z<number, number, "defined">;
        /** 检索 query 取最近 N 条消息。 */
        queryMessages: z<number, number, "defined">;
    }>>>, "volatile-defined">;
    defaults: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        /** 点选角色时套用的备选角色卡；空串 = 不预填。新对话不会自动绑定。 */
        cardId: z<string, string, "defined">;
        /** 默认提示词预设 identifier；空串 = 内建默认预设。 */
        presetId: z<string, string, "defined">;
        personaId: z<string, string, "defined">;
        lorebookIds: z<string[], string[], "defined">;
        /** 主世界书；空串 = 用卡内嵌书（若有）。 */
        characterLorebookId: z<string, string, "defined">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        /** 点选角色时套用的备选角色卡；空串 = 不预填。新对话不会自动绑定。 */
        cardId: z<string, string, "defined">;
        /** 默认提示词预设 identifier；空串 = 内建默认预设。 */
        presetId: z<string, string, "defined">;
        personaId: z<string, string, "defined">;
        lorebookIds: z<string[], string[], "defined">;
        /** 主世界书；空串 = 用卡内嵌书（若有）。 */
        characterLorebookId: z<string, string, "defined">;
    }>>>, "volatile-defined">;
    interactiveCards: z<boolean, boolean, "volatile-defined">;
    cascadeDeleteEmbeddedBook: z<boolean, boolean, "volatile-defined">;
    cardNetworkWhitelist: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    triggerLogMax: z<number, number, "volatile-defined">;
}>>, "plain">;
/** 业务服务只读当前值并通过宿主表单写入，不保留失效的旧 SettingsScope。 */
export interface TavernSettingsScope {
    get(): TavernConfigRaw;
    update(patch: object): Promise<void>;
}
/** 全局卡级覆盖偏好；当前轮冻结计划不因设置保存而重算。 */
export interface TavernPromptPreferences {
    preferCharacterPrompt: boolean;
    preferCharacterInstructions: boolean;
}
export interface TavernSessionDefaults {
    cardId: string;
    presetId: string;
    personaId: string;
    lorebookIds: string[];
    characterLorebookId: string;
}
export interface TavernConfig {
    locale: 'auto' | 'en' | 'zh';
    prompts: TavernPromptPreferences;
    sampling: SamplingSettings;
    worldInfo: WorldInfoGlobalSettings;
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
    defaults: TavernSessionDefaults;
    interactiveCards: boolean;
    cascadeDeleteEmbeddedBook: boolean;
    cardNetworkWhitelist: string[];
    triggerLogMax: number;
}
/** schemastery 解析结果 → 运行时配置（maxTokens 0 → null）。 */
export declare function resolveConfig(raw: unknown): TavernConfig;
