/**
 * 可重放提示词布局：仅保存已求值的插件片段及真实历史锚点，不保存或替换宿主历史正文。
 * 布局在每轮首次组装后冻结；适配器将它投影到当前 Message[]，不重新求值宏、模板或世界书。
 */
import { isSyntheticUserText } from './dshPrompt.js';
import { z } from 'zod';
const AnchorSchema = z.object({ inputIndex: z.number().int().nonnegative(), messageId: z.string().min(1).max(4096).optional(),
    role: z.enum(['system', 'user', 'assistant']), chat: z.boolean() }).strict();
const PlacementSchema = z.union([
    z.object({ kind: z.enum(['before-history', 'after-history']), anchor: AnchorSchema.optional(), order: z.number().finite().optional() }).strict(),
    z.object({ kind: z.literal('depth'), depth: z.number().int().nonnegative(), order: z.number().finite(), previous: AnchorSchema.optional(), next: AnchorSchema.optional() }).strict(),
    z.object({ kind: z.literal('history-relative'), anchor: AnchorSchema, side: z.enum(['before', 'after']) }).strict(),
    z.object({ kind: z.literal('entry-relative'), entryKey: z.string().min(1).max(4096), side: z.enum(['before', 'after']) }).strict(),
]);
/** 持久化边界共用同一结构校验；旧记录应由调用方将整个 layout 字段设为可选。 */
export const PromptLayoutSchema = z.object({
    version: z.literal(1), history: z.array(AnchorSchema).max(100000),
    entries: z.array(z.object({ key: z.string().min(1).max(4096), role: z.enum(['system', 'user', 'assistant']), content: z.string().max(1024 * 1024),
        sourceKeys: z.array(z.string().max(4096)).max(16384), turnLocal: z.boolean(), placement: PlacementSchema,
        compatibilityFallback: z.literal(true).optional() }).strict()).max(16384),
}).strict().superRefine((layout, ctx) => {
    const keys = new Set();
    for (const entry of layout.entries) {
        if (keys.has(entry.key))
            ctx.addIssue({ code: 'custom', message: '提示词布局条目 key 重复' });
        keys.add(entry.key);
    }
    for (const entry of layout.entries)
        if (entry.placement.kind === 'entry-relative' && !keys.has(entry.placement.entryKey)) {
            ctx.addIssue({ code: 'custom', message: '提示词布局引用了不存在的条目' });
        }
});
export function parsePromptLayout(value) { return PromptLayoutSchema.parse(value); }
/** 正则与模板可改模拟正文，但锚点身份始终取原始输入的对应项。 */
export function promptHistoryAnchors(history, messageIds, chatFlags) {
    if (messageIds && messageIds.length !== history.length)
        throw new Error('提示词历史锚点数量与历史不一致');
    if (chatFlags && chatFlags.length !== history.length)
        throw new Error('提示词聊天标志数量与历史不一致');
    const seen = new Set();
    return history.map((message, inputIndex) => {
        const messageId = messageIds?.[inputIndex];
        if (messageId !== undefined) {
            if (!messageId.trim() || seen.has(messageId))
                throw new Error('提示词历史锚点 ID 为空或重复');
            seen.add(messageId);
        }
        return {
            inputIndex, ...(messageId === undefined ? {} : { messageId }), role: message.role,
            chat: (chatFlags?.[inputIndex] ?? true) && (message.role === 'assistant' || (message.role === 'user' && !isSyntheticUserText(message.content))),
        };
    });
}
/** depth 只数本轮首次组装时的真实聊天；后续工具步骤不移动已冻结的边界。 */
export function promptDepthPlacement(history, depth, order) {
    const chat = history.filter(anchor => anchor.chat);
    const at = Math.max(0, chat.length - depth);
    const previous = chat[at - 1];
    const next = chat[at];
    return { kind: 'depth', depth, order, ...(previous ? { previous: { ...previous } } : {}), ...(next ? { next: { ...next } } : {}) };
}
/** 拷贝所有可变元数据，防止后面的模拟预算裁剪或调用方改写污染可持久化快照。 */
export function createPromptLayout(history, fragments) {
    return {
        version: 1,
        history: history.map(anchor => ({ ...anchor })),
        entries: fragments.filter(fragment => fragment.content.trim()).map((fragment, index) => {
            const placement = fragment.placement;
            return {
                ...fragment, key: `entry:${index}`, sourceKeys: [...fragment.sourceKeys],
                placement: placement.kind === 'entry-relative' ? { ...placement } : placement.kind === 'depth'
                    ? { ...placement, ...(placement.previous ? { previous: { ...placement.previous } } : {}), ...(placement.next ? { next: { ...placement.next } } : {}) }
                    : { ...placement, ...(placement.anchor ? { anchor: { ...placement.anchor } } : {}) },
            };
        }),
    };
}
