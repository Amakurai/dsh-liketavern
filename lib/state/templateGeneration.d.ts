/** 模板生成恢复描述：有界 JSON 校验与紧凑冻结计划；重放文本只能交给隔离器，不当作宿主代码。 */
import { z } from 'zod';
import type { TemplateContext } from '../core/template.js';
import { type TemplateReplay } from '../core/templateReplay.js';
declare const generation: z.ZodDiscriminatedUnion<[z.ZodObject<{
    version: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    cardId: z.ZodString;
    storyId: z.ZodString;
    turn: z.ZodNumber;
    floor: z.ZodString;
    status: z.ZodLiteral<"prepared">;
    replay: z.ZodType<TemplateReplay, unknown, z.core.$ZodTypeInternals<TemplateReplay, unknown>>;
    plan: z.ZodObject<{
        standingKey: z.ZodString;
        standing: z.ZodString;
        turnContext: z.ZodString;
        messages: z.ZodArray<z.ZodObject<{
            role: z.ZodEnum<{
                system: "system";
                user: "user";
                assistant: "assistant";
            }>;
            content: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        history: z.ZodArray<z.ZodObject<{
            role: z.ZodEnum<{
                system: "system";
                user: "user";
                assistant: "assistant";
            }>;
            content: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
        }, z.core.$strict>>;
        logLines: z.ZodArray<z.ZodString>;
        userName: z.ZodString;
        personaDescription: z.ZodString;
        personaLorebookId: z.ZodNullable<z.ZodString>;
        wiBudget: z.ZodObject<{
            limit: z.ZodNumber;
            used: z.ZodNumber;
            overflowed: z.ZodBoolean;
        }, z.core.$strict>;
        sampling: z.ZodObject<{
            temperature: z.ZodNumber;
            topP: z.ZodNumber;
            maxTokens: z.ZodNullable<z.ZodNumber>;
            stop: z.ZodArray<z.ZodString>;
            presencePenalty: z.ZodNumber;
            frequencyPenalty: z.ZodNumber;
            thinking: z.ZodEnum<{
                disabled: "disabled";
                enabled: "enabled";
                low: "low";
                high: "high";
                max: "max";
            }>;
        }, z.core.$strict>;
        assembleLog: z.ZodArray<z.ZodObject<{
            kind: z.ZodEnum<{
                trim: "trim";
                "unknown-marker": "unknown-marker";
                "unknown-macro": "unknown-macro";
                "dropped-marker-content": "dropped-marker-content";
                "dropped-script": "dropped-script";
                "auto-marker": "auto-marker";
                "regex-error": "regex-error";
                "template-placement": "template-placement";
            }>;
            detail: z.ZodString;
        }, z.core.$strict>>;
        stats: z.ZodObject<{
            tokensBefore: z.ZodNumber;
            tokensAfter: z.ZodNumber;
            trimmedSections: z.ZodArray<z.ZodString>;
        }, z.core.$strict>;
    }, z.core.$strict>;
    regexRules: z.ZodOptional<z.ZodArray<z.ZodObject<{
        source: z.ZodString;
        flags: z.ZodString;
        replacement: z.ZodString;
        options: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]>>;
    }, z.core.$strict>>>;
    hasMessageRegex: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>, z.ZodObject<{
    version: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    cardId: z.ZodString;
    storyId: z.ZodString;
    turn: z.ZodNumber;
    floor: z.ZodString;
    status: z.ZodLiteral<"completed">;
}, z.core.$strict>, z.ZodObject<{
    version: z.ZodLiteral<1>;
    sessionId: z.ZodString;
    cardId: z.ZodString;
    storyId: z.ZodString;
    turn: z.ZodNumber;
    floor: z.ZodString;
    status: z.ZodLiteral<"terminated">;
}, z.core.$strict>], "status">;
export type TemplateGeneration = z.infer<typeof generation>;
export type PreparedTemplateGeneration = Extract<TemplateGeneration, {
    status: 'prepared';
}>;
export declare function parseTemplateReplay(value: unknown): TemplateReplay;
export declare function parseTemplateGeneration(value: unknown): TemplateGeneration;
/** 收口保留少量归属回执，删除大段闭包重放数据；中途重启也能幂等完成楼层提交。 */
export declare function closeTemplateGeneration(value: TemplateGeneration, status: 'completed' | 'terminated'): TemplateGeneration;
/** 最终回复选择标记与初始资产分别存一次；重建给隔离器的冻结上下文。 */
export declare function templateGenerationContext(value: PreparedTemplateGeneration): TemplateContext;
export {};
