/** 模板生成恢复描述：有界 JSON 校验与紧凑冻结计划；重放文本只能交给隔离器，不当作宿主代码。 */
import { z } from 'zod';
import { parseTemplateScopes, validateTemplateJson } from '../core/template.js';
import { TEMPLATE_REPLAY_LIMIT, templateReplayGenerationContext } from '../core/templateReplay.js';
import { parseTemplateStickyState } from '../core/templateSticky.js';
import { parseTemplateMessageVariables, parseTemplateMessageIdentities } from '../core/templateMessageVariables.js';
import { isTemplateAvatarUrl, TEMPLATE_AVATAR_URL_CHARS } from '../core/templateAvatar.js';
import { parseTemplateHelperMvu } from '../core/templateHelperMvu.js';
const text = z.string(), number = z.number().finite(), bool = z.boolean();
const role = z.enum(['system', 'user', 'assistant']);
const scope = z.unknown().transform(value => parseTemplateScopes(value));
const messageVariables = z.unknown().transform(value => parseTemplateMessageVariables(value));
const identities = z.array(z.object({ messageId: text, hostMessageId: z.number().int().nonnegative().optional(), swipeId: z.literal(0) }).strict());
const avatar = z.string().max(TEMPLATE_AVATAR_URL_CHARS).refine(isTemplateAvatarUrl);
const chat = z.object({ role, content: text, name: text.optional() }).strict();
const entry = z.object({ key: text, uid: text, source: z.enum(['chat', 'persona', 'character', 'global', 'delta']), sourceRef: text,
    keys: z.array(text), secondaryKeys: z.array(text), selective: bool, selectiveLogic: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    comment: text, content: text, constant: bool, enabled: bool, order: number, position: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]),
    depth: number, role: z.union([z.literal(0), z.literal(1), z.literal(2)]), outletName: text, probability: number, useProbability: bool,
    caseSensitive: bool.nullable(), matchWholeWords: bool.nullable(), useGroupScoring: bool.nullable().optional(), scanDepth: number.nullable(), excludeRecursion: bool, preventRecursion: bool,
    delayUntilRecursion: number, sticky: number.nullable(), cooldown: number.nullable(), delay: number.nullable(), ignoreBudget: bool,
    group: text, groupWeight: number, groupOverride: bool, automationId: text, templateCondition: text.optional(), templatePreload: bool.optional(),
    templateOnlyPreload: bool.optional(), templateDontActivate: bool.optional(), templatePreprocessing: bool.optional(), templateIframe: text.optional(), templateMessageFormatting: bool.optional(),
    deltaType: z.enum(['update', 'add', 'invalidate']).optional(), deltaRef: text.nullable().optional() }).strict();
const regex = z.object({ source: text, flags: text, replacement: text, options: z.record(text, z.union([text, number, bool, z.null()])) }).strict();
const context = z.object({ variables: scope, char: text, user: text, card: z.record(text, z.unknown()), entries: z.array(entry),
    presets: z.array(z.object({ identifier: text, name: text, content: text }).passthrough()), history: z.array(chat), now: number, seed: number, phase: z.enum(['generate', 'render']),
    sessionId: text.optional(), cardId: text.optional(), generationType: text.optional(), model: text.optional(),
    charAvatar: avatar.optional(), userAvatar: avatar.optional(), historyIdentities: identities.optional(), messageVariables: messageVariables.optional(),
    helperMvu: z.unknown().transform(value => value).optional(),
    renderMessages: z.array(z.object({ index: z.number().int().nonnegative(), role, name: text.optional(), swipeId: z.number().int().nonnegative(), hostMessageId: z.number().int().nonnegative().optional() }).strict()).optional(),
    regexRules: z.array(regex).optional(), hasMessageRegex: bool.optional() }).strict().superRefine((value, ctx) => {
    try {
        if (value.historyIdentities)
            parseTemplateMessageIdentities(value.historyIdentities, value.history.length);
        if (value.helperMvu !== undefined)
            parseTemplateHelperMvu(value.helperMvu, value.historyIdentities ?? []);
        if (value.messageVariables) {
            const ids = new Set(value.historyIdentities?.map(item => item.messageId) ?? value.history.map((_, index) => `preview:${index}`));
            if (Object.keys(value.messageVariables.snapshots).some(id => !ids.has(id)))
                throw new Error('模板恢复包含不可见消息变量');
        }
    }
    catch (error) {
        ctx.addIssue({ code: 'custom', message: String(error) });
    }
});
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const stickyState = z.unknown().transform(parseTemplateStickyState);
const metadata = z.object({ index: z.number().int().nonnegative(), role, name: text.optional(), swipeId: z.number().int().nonnegative(), hostMessageId: z.number().int().nonnegative().optional() }).strict();
const replay = z.object({ version: z.literal(2), context: context.refine(value => value.phase === 'generate'), variables: scope, messageVariablesHash: hash,
    bootstrap: z.object({ state: stickyState, preload: z.enum(['preserve', 'refresh']) }).strict().optional(),
    operations: z.array(z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('render'), text, data: z.record(text, z.unknown()), source: text.optional(), hash }).strict(),
        z.object({ kind: z.literal('regex'), text, stage: z.enum(['generate', 'message', 'after']), meta: z.object({ role, worldinfo: bool, depth: number }).strict(), hash }).strict(),
        z.object({ kind: z.literal('variables'), hash }).strict(), z.object({ kind: z.literal('outlets'), text, hash }).strict(),
        z.object({ kind: z.literal('deferOutlets'), value: bool, hash }).strict(),
        z.object({ kind: z.literal('phase'), context, refreshPreload: bool, hash }).strict(),
        z.object({ kind: z.literal('message'), metadata: metadata.nullable(), hash }).strict(),
        z.object({ kind: z.literal('format'), text, hash }).strict(),
        z.object({ kind: z.literal('messageVariables'), hash }).strict(),
        z.object({ kind: z.literal('sticky'), action: z.enum(['begin', 'finish', 'restore']), state: stickyState.optional(), hash }).strict(),
    ])).max(4096) }).strict();
const plan = z.object({ standingKey: text, standing: text, turnContext: text, messages: z.array(chat), history: z.array(chat), logLines: z.array(text),
    userName: text, personaDescription: text, personaLorebookId: text.nullable(), wiBudget: z.object({ limit: number, used: number, overflowed: bool }).strict(),
    sampling: z.object({ temperature: number, topP: number, maxTokens: number.nullable(), stop: z.array(text), presencePenalty: number, frequencyPenalty: number,
        thinking: z.enum(['enabled', 'disabled', 'low', 'high', 'max']) }).strict(),
    assembleLog: z.array(z.object({ kind: z.enum(['unknown-marker', 'unknown-macro', 'dropped-marker-content', 'dropped-script', 'auto-marker', 'regex-error', 'trim', 'template-placement']), detail: text }).strict()),
    stats: z.object({ tokensBefore: number, tokensAfter: number, trimmedSections: z.array(text) }).strict(),
}).strict();
const identity = z.object({ version: z.literal(1), sessionId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.-]+$/),
    cardId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_一-龥-]+(?:\.[A-Za-z0-9_一-龥-]+)*$/),
    storyId: z.string().regex(/^(?:story-[a-f0-9-]{36}|legacy-[a-f0-9]{32})$/), turn: z.number().int().nonnegative(), floor: text });
const generation = z.discriminatedUnion('status', [
    identity.extend({ status: z.literal('prepared'), replay, plan, regexRules: z.array(regex).optional(), hasMessageRegex: bool.optional() }).strict(),
    identity.extend({ status: z.literal('completed') }).strict(), identity.extend({ status: z.literal('terminated') }).strict(),
]);
export function parseTemplateReplay(value) {
    validateTemplateJson(value);
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 2)
        throw new Error('模板重放版本不兼容，需要完成或回滚旧版本楼层');
    if (JSON.stringify(value).length > TEMPLATE_REPLAY_LIMIT)
        throw new Error('模板重放快照超过 4 MiB 上限');
    return replay.parse(value);
}
export function parseTemplateGeneration(value) {
    validateTemplateJson(value);
    if (value && typeof value === 'object' && !Array.isArray(value) && value.status === 'prepared'
        && value.replay && typeof value.replay === 'object' && !Array.isArray(value.replay) && value.replay.version !== 2)
        throw new Error('模板重放版本不兼容，需要完成或回滚旧版本楼层');
    const parsed = generation.parse(value);
    if (parsed.floor !== `${parsed.sessionId}#t${parsed.turn}`)
        throw new Error('模板恢复楼层与会话轮次不一致');
    if (parsed.status === 'prepared') {
        if (JSON.stringify(parsed.replay).length > TEMPLATE_REPLAY_LIMIT)
            throw new Error('模板重放快照超过 4 MiB 上限');
        const current = templateReplayGenerationContext(parsed.replay);
        if (current.sessionId !== parsed.sessionId || current.cardId !== parsed.cardId)
            throw new Error('模板重放来源与剧情绑定不一致');
    }
    return parsed;
}
/** 收口保留少量归属回执，删除大段闭包重放数据；中途重启也能幂等完成楼层提交。 */
export function closeTemplateGeneration(value, status) {
    return { version: 1, status, sessionId: value.sessionId, cardId: value.cardId, storyId: value.storyId, turn: value.turn, floor: value.floor };
}
/** 最终回复选择标记与初始资产分别存一次；重建给隔离器的冻结上下文。 */
export function templateGenerationContext(value) {
    return { ...templateReplayGenerationContext(value.replay), regexRules: value.regexRules, hasMessageRegex: value.hasMessageRegex };
}
