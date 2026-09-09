/**
 * 插件设置（settings namespace `dsh-tavern`）。
 * 用户层覆盖经 dsh-settings 持久化到 ~/.dsh/settings.yaml，UI 设置面板读写。
 */
import z from '@deepseek-ai/schemastery';
import { type SamplingSettings, type WorldInfoGlobalSettings } from '../core/types.js';
export declare const TAVERN_NS = "dsh-tavern";
export declare const TavernConfigSchema: z<Schemastery.ObjectS<{
    /** 前端界面语言（面板/芯片/英雄区/操作条等本插件 UI 文案）；auto（默认）跟随宿主界面语言，设置页可锁定中/英。 */
    locale: z<"auto" | "en" | "zh", "auto" | "en" | "zh">;
    sampling: z<Schemastery.ObjectS<{
        /** 0–2，默认 1（DeepSeek 官方）。thinking 模式下不生效。 */
        temperature: z<number, number>;
        /** 0–1，默认 1。当前 dsh 模型服务不透传（受平台限制项，见 README）。 */
        topP: z<number, number>;
        /** 单次生成最大 token；0 = 不设置（沿用 dsh 模型默认）。 */
        maxTokens: z<number, number>;
        /** 停止序列（DeepSeek 最多 16 个）。 */
        stop: z<string[], string[]>;
        /** DeepSeek 官方已废弃（传入无效），仅作记录。 */
        presencePenalty: z<number, number>;
        frequencyPenalty: z<number, number>;
        /** thinking 档位；绑定会话时按模型公布的 reasoning 档写入 reasoningEffort（disabled→off，low/high/max→公布才显式指定）。 */
        thinking: z<"disabled" | "enabled" | "low" | "high" | "max", "disabled" | "enabled" | "low" | "high" | "max">;
    }>, Schemastery.ObjectT<{
        /** 0–2，默认 1（DeepSeek 官方）。thinking 模式下不生效。 */
        temperature: z<number, number>;
        /** 0–1，默认 1。当前 dsh 模型服务不透传（受平台限制项，见 README）。 */
        topP: z<number, number>;
        /** 单次生成最大 token；0 = 不设置（沿用 dsh 模型默认）。 */
        maxTokens: z<number, number>;
        /** 停止序列（DeepSeek 最多 16 个）。 */
        stop: z<string[], string[]>;
        /** DeepSeek 官方已废弃（传入无效），仅作记录。 */
        presencePenalty: z<number, number>;
        frequencyPenalty: z<number, number>;
        /** thinking 档位；绑定会话时按模型公布的 reasoning 档写入 reasoningEffort（disabled→off，low/high/max→公布才显式指定）。 */
        thinking: z<"disabled" | "enabled" | "low" | "high" | "max", "disabled" | "enabled" | "low" | "high" | "max">;
    }>>;
    worldInfo: z<Schemastery.ObjectS<{
        scanDepth: z<number, number>;
        minActivations: z<number, number>;
        maxScanDepth: z<number, number>;
        contextPercent: z<number, number>;
        tokenBudget: z<number, number>;
        recursiveScan: z<boolean, boolean>;
        maxRecursionSteps: z<number, number>;
        caseSensitive: z<boolean, boolean>;
        /** 整词匹配对中文不友好，默认关（SillyTavern 出厂为开，差异见 README）。 */
        matchWholeWords: z<boolean, boolean>;
        includeNames: z<boolean, boolean>;
        overflowWarning: z<boolean, boolean>;
        characterStrategy: z<0 | 1 | 2, 0 | 1 | 2>;
        useGroupScoring: z<boolean, boolean>;
    }>, Schemastery.ObjectT<{
        scanDepth: z<number, number>;
        minActivations: z<number, number>;
        maxScanDepth: z<number, number>;
        contextPercent: z<number, number>;
        tokenBudget: z<number, number>;
        recursiveScan: z<boolean, boolean>;
        maxRecursionSteps: z<number, number>;
        caseSensitive: z<boolean, boolean>;
        /** 整词匹配对中文不友好，默认关（SillyTavern 出厂为开，差异见 README）。 */
        matchWholeWords: z<boolean, boolean>;
        includeNames: z<boolean, boolean>;
        overflowWarning: z<boolean, boolean>;
        characterStrategy: z<0 | 1 | 2, 0 | 1 | 2>;
        useGroupScoring: z<boolean, boolean>;
    }>>;
    memory: z<Schemastery.ObjectS<{
        /** 每角色记忆条数上限，超出触发压缩。 */
        maxEntries: z<number, number>;
        /** 每角色记忆 token 上限（估算），超出触发压缩。 */
        maxTokens: z<number, number>;
        /** 每轮检索注入的条数。 */
        retrievalTopK: z<number, number>;
        /** 每轮检索注入的 token 预算。 */
        retrievalTokenBudget: z<number, number>;
        /** 时间衰减半衰期（天）；0 = 不衰减。 */
        halfLifeDays: z<number, number>;
        /** 写入去重相似度阈值（BM25 分）。 */
        dedupScore: z<number, number>;
        /** 每次压缩合并的最旧条数。 */
        compressBatch: z<number, number>;
        /** 检索 query 取最近 N 条消息。 */
        queryMessages: z<number, number>;
    }>, Schemastery.ObjectT<{
        /** 每角色记忆条数上限，超出触发压缩。 */
        maxEntries: z<number, number>;
        /** 每角色记忆 token 上限（估算），超出触发压缩。 */
        maxTokens: z<number, number>;
        /** 每轮检索注入的条数。 */
        retrievalTopK: z<number, number>;
        /** 每轮检索注入的 token 预算。 */
        retrievalTokenBudget: z<number, number>;
        /** 时间衰减半衰期（天）；0 = 不衰减。 */
        halfLifeDays: z<number, number>;
        /** 写入去重相似度阈值（BM25 分）。 */
        dedupScore: z<number, number>;
        /** 每次压缩合并的最旧条数。 */
        compressBatch: z<number, number>;
        /** 检索 query 取最近 N 条消息。 */
        queryMessages: z<number, number>;
    }>>;
    defaults: z<Schemastery.ObjectS<{
        /** 点选角色时套用的备选角色卡；空串 = 不预填。新对话不会自动绑定。 */
        cardId: z<string, string>;
        /** 默认提示词预设 identifier；空串 = 内建默认预设。 */
        presetId: z<string, string>;
        personaId: z<string, string>;
        lorebookIds: z<string[], string[]>;
        /** 主世界书；空串 = 用卡内嵌书（若有）。 */
        characterLorebookId: z<string, string>;
    }>, Schemastery.ObjectT<{
        /** 点选角色时套用的备选角色卡；空串 = 不预填。新对话不会自动绑定。 */
        cardId: z<string, string>;
        /** 默认提示词预设 identifier；空串 = 内建默认预设。 */
        presetId: z<string, string>;
        personaId: z<string, string>;
        lorebookIds: z<string[], string[]>;
        /** 主世界书；空串 = 用卡内嵌书（若有）。 */
        characterLorebookId: z<string, string>;
    }>>;
    /** 交互卡全局开关（关闭则一律纯文本渲染）。 */
    interactiveCards: z<boolean, boolean>;
    /** 删除角色卡时连同其内嵌世界书一起删除；关闭则删卡前把内嵌书抢救到世界书库。 */
    cascadeDeleteEmbeddedBook: z<boolean, boolean>;
    /** 交互卡脚本信任的主机（放宽 connect-src 与 script-src；`*` = 全部放行。img/font 默认已放行 https）。 */
    cardNetworkWhitelist: z<string[], string[]>;
    /** 触发日志保留的最大条数（每会话最近一次组装的明细）。 */
    triggerLogMax: z<number, number>;
}>, Schemastery.ObjectT<{
    /** 前端界面语言（面板/芯片/英雄区/操作条等本插件 UI 文案）；auto（默认）跟随宿主界面语言，设置页可锁定中/英。 */
    locale: z<"auto" | "en" | "zh", "auto" | "en" | "zh">;
    sampling: z<Schemastery.ObjectS<{
        /** 0–2，默认 1（DeepSeek 官方）。thinking 模式下不生效。 */
        temperature: z<number, number>;
        /** 0–1，默认 1。当前 dsh 模型服务不透传（受平台限制项，见 README）。 */
        topP: z<number, number>;
        /** 单次生成最大 token；0 = 不设置（沿用 dsh 模型默认）。 */
        maxTokens: z<number, number>;
        /** 停止序列（DeepSeek 最多 16 个）。 */
        stop: z<string[], string[]>;
        /** DeepSeek 官方已废弃（传入无效），仅作记录。 */
        presencePenalty: z<number, number>;
        frequencyPenalty: z<number, number>;
        /** thinking 档位；绑定会话时按模型公布的 reasoning 档写入 reasoningEffort（disabled→off，low/high/max→公布才显式指定）。 */
        thinking: z<"disabled" | "enabled" | "low" | "high" | "max", "disabled" | "enabled" | "low" | "high" | "max">;
    }>, Schemastery.ObjectT<{
        /** 0–2，默认 1（DeepSeek 官方）。thinking 模式下不生效。 */
        temperature: z<number, number>;
        /** 0–1，默认 1。当前 dsh 模型服务不透传（受平台限制项，见 README）。 */
        topP: z<number, number>;
        /** 单次生成最大 token；0 = 不设置（沿用 dsh 模型默认）。 */
        maxTokens: z<number, number>;
        /** 停止序列（DeepSeek 最多 16 个）。 */
        stop: z<string[], string[]>;
        /** DeepSeek 官方已废弃（传入无效），仅作记录。 */
        presencePenalty: z<number, number>;
        frequencyPenalty: z<number, number>;
        /** thinking 档位；绑定会话时按模型公布的 reasoning 档写入 reasoningEffort（disabled→off，low/high/max→公布才显式指定）。 */
        thinking: z<"disabled" | "enabled" | "low" | "high" | "max", "disabled" | "enabled" | "low" | "high" | "max">;
    }>>;
    worldInfo: z<Schemastery.ObjectS<{
        scanDepth: z<number, number>;
        minActivations: z<number, number>;
        maxScanDepth: z<number, number>;
        contextPercent: z<number, number>;
        tokenBudget: z<number, number>;
        recursiveScan: z<boolean, boolean>;
        maxRecursionSteps: z<number, number>;
        caseSensitive: z<boolean, boolean>;
        /** 整词匹配对中文不友好，默认关（SillyTavern 出厂为开，差异见 README）。 */
        matchWholeWords: z<boolean, boolean>;
        includeNames: z<boolean, boolean>;
        overflowWarning: z<boolean, boolean>;
        characterStrategy: z<0 | 1 | 2, 0 | 1 | 2>;
        useGroupScoring: z<boolean, boolean>;
    }>, Schemastery.ObjectT<{
        scanDepth: z<number, number>;
        minActivations: z<number, number>;
        maxScanDepth: z<number, number>;
        contextPercent: z<number, number>;
        tokenBudget: z<number, number>;
        recursiveScan: z<boolean, boolean>;
        maxRecursionSteps: z<number, number>;
        caseSensitive: z<boolean, boolean>;
        /** 整词匹配对中文不友好，默认关（SillyTavern 出厂为开，差异见 README）。 */
        matchWholeWords: z<boolean, boolean>;
        includeNames: z<boolean, boolean>;
        overflowWarning: z<boolean, boolean>;
        characterStrategy: z<0 | 1 | 2, 0 | 1 | 2>;
        useGroupScoring: z<boolean, boolean>;
    }>>;
    memory: z<Schemastery.ObjectS<{
        /** 每角色记忆条数上限，超出触发压缩。 */
        maxEntries: z<number, number>;
        /** 每角色记忆 token 上限（估算），超出触发压缩。 */
        maxTokens: z<number, number>;
        /** 每轮检索注入的条数。 */
        retrievalTopK: z<number, number>;
        /** 每轮检索注入的 token 预算。 */
        retrievalTokenBudget: z<number, number>;
        /** 时间衰减半衰期（天）；0 = 不衰减。 */
        halfLifeDays: z<number, number>;
        /** 写入去重相似度阈值（BM25 分）。 */
        dedupScore: z<number, number>;
        /** 每次压缩合并的最旧条数。 */
        compressBatch: z<number, number>;
        /** 检索 query 取最近 N 条消息。 */
        queryMessages: z<number, number>;
    }>, Schemastery.ObjectT<{
        /** 每角色记忆条数上限，超出触发压缩。 */
        maxEntries: z<number, number>;
        /** 每角色记忆 token 上限（估算），超出触发压缩。 */
        maxTokens: z<number, number>;
        /** 每轮检索注入的条数。 */
        retrievalTopK: z<number, number>;
        /** 每轮检索注入的 token 预算。 */
        retrievalTokenBudget: z<number, number>;
        /** 时间衰减半衰期（天）；0 = 不衰减。 */
        halfLifeDays: z<number, number>;
        /** 写入去重相似度阈值（BM25 分）。 */
        dedupScore: z<number, number>;
        /** 每次压缩合并的最旧条数。 */
        compressBatch: z<number, number>;
        /** 检索 query 取最近 N 条消息。 */
        queryMessages: z<number, number>;
    }>>;
    defaults: z<Schemastery.ObjectS<{
        /** 点选角色时套用的备选角色卡；空串 = 不预填。新对话不会自动绑定。 */
        cardId: z<string, string>;
        /** 默认提示词预设 identifier；空串 = 内建默认预设。 */
        presetId: z<string, string>;
        personaId: z<string, string>;
        lorebookIds: z<string[], string[]>;
        /** 主世界书；空串 = 用卡内嵌书（若有）。 */
        characterLorebookId: z<string, string>;
    }>, Schemastery.ObjectT<{
        /** 点选角色时套用的备选角色卡；空串 = 不预填。新对话不会自动绑定。 */
        cardId: z<string, string>;
        /** 默认提示词预设 identifier；空串 = 内建默认预设。 */
        presetId: z<string, string>;
        personaId: z<string, string>;
        lorebookIds: z<string[], string[]>;
        /** 主世界书；空串 = 用卡内嵌书（若有）。 */
        characterLorebookId: z<string, string>;
    }>>;
    /** 交互卡全局开关（关闭则一律纯文本渲染）。 */
    interactiveCards: z<boolean, boolean>;
    /** 删除角色卡时连同其内嵌世界书一起删除；关闭则删卡前把内嵌书抢救到世界书库。 */
    cascadeDeleteEmbeddedBook: z<boolean, boolean>;
    /** 交互卡脚本信任的主机（放宽 connect-src 与 script-src；`*` = 全部放行。img/font 默认已放行 https）。 */
    cardNetworkWhitelist: z<string[], string[]>;
    /** 触发日志保留的最大条数（每会话最近一次组装的明细）。 */
    triggerLogMax: z<number, number>;
}>>;
export type TavernConfigRaw = ReturnType<typeof TavernConfigSchema>;
export interface TavernSessionDefaults {
    cardId: string;
    presetId: string;
    personaId: string;
    lorebookIds: string[];
    characterLorebookId: string;
}
export interface TavernConfig {
    locale: 'auto' | 'en' | 'zh';
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
