/**
 * 正则引擎（纯函数），语义对齐 SillyTavern 正则扩展：
 * - find 允许 `/pattern/flags` 形式；裸源码 = 区分大小写、只替换首个匹配。
 * - replace 支持 $1..$9 / $<name> 捕获组、`{{match}}`（等价 $&）与 {{char}}/{{user}} 宏。
 * - find 中宏展开由规则 substituteRegex 控制：0=不展开 1=原样代入 2=转义代入。
 *
 * 规则作用于三种文本（scope）与三个时机（timing）的组合点：
 * - 用户输入 input：发送前（send）
 * - 发送给模型的文本 prompt：组装前（assemble）/ 发送前（send）
 * - AI 输出 output：渲染前（render）
 *
 * 引擎只返回新字符串/新数组，绝不原地修改——「作用于 prompt 的规则不得改写
 * 会话中存储的原始消息」由调用方据此天然满足。
 */
import { type MacroContext } from './macros.js';
import type { CardRegexScript, ChatMessage, RegexRule, RegexScope, RegexTiming } from './types.js';
export type { MacroContext };
export interface RegexFilter {
    scope: RegexScope;
    timing: RegexTiming;
}
export interface RegexApplyResult {
    text: string;
    /** 实际命中的规则 id（按应用顺序）。 */
    applied: string[];
    errors: Array<{
        ruleId: string;
        message: string;
    }>;
}
/** 顺序应用规则；单条规则编译/执行失败不中断后续规则，记入 errors。 */
export declare function applyRegexRules(text: string, rules: readonly RegexRule[], filter: RegexFilter, macroCtx: MacroContext): RegexApplyResult;
/**
 * 对消息数组按深度应用规则。depth 从 0（最新真实消息）计，跳过 dsh runtime-context 快照；
 * 规则的 minDepth/maxDepth（null = 不限）过滤作用区间。返回新数组。
 */
export declare function applyRegexToMessages(messages: readonly ChatMessage[], rules: readonly RegexRule[], filter: RegexFilter, macroCtx: MacroContext): {
    messages: ChatMessage[];
    applied: string[];
    errors: RegexApplyResult['errors'];
};
/**
 * 归一化 ST regex_scripts。
 *
 * placement：1 USER_INPUT → input/send + 仅 user；2 AI_OUTPUT → output/render + 仅 assistant；
 * 5 WORLD_INFO → prompt/assemble。其余 placement 忽略。
 * markdownOnly → 仅展示；promptOnly → 仅入模；两者同时勾选 → 展示 + 入模（社区预设常用）。
 *
 * 启用策略：
 * - card：展示向默认开，改 prompt/input 默认关（避免导入即改写发给模型的文本）
 * - preset：跟脚本 `disabled` 走（预设正则是作者意图的一部分）
 */
export declare function compileRegexScripts(scripts: readonly CardRegexScript[], options: {
    source: 'card' | 'preset';
    sourceRef: string;
}): RegexRule[];
/** 角色卡内嵌正则：展示向默认开，prompt/input 默认关。 */
export declare function compileCardRegexScripts(scripts: readonly CardRegexScript[], cardId: string): RegexRule[];
/** 预设内嵌正则：跟脚本 disabled 走。 */
export declare function compilePresetRegexScripts(scripts: readonly CardRegexScript[], presetId: string): RegexRule[];
/**
 * 正则替换后的展示文本常是「整页 HTML 封面」或「小部件 HTML + 后面的正文」。
 * 只把 HTML 文档抽进 iframe，围栏外 / </html> 之后的文字留给 Markdown，否则切条目会只剩前端。
 */
export declare function splitRenderedHtml(text: string): {
    html: string | null;
    rest: string;
};
/**
 * 连续抽出多段 HTML 文档（开场白可被多条正则各换成一页）。
 * 正文只留不含完整 HTML 文档的剩余，避免第二段源码进 Markdown。
 */
export declare function collectRenderedHtml(text: string): {
    htmls: string[];
    rest: string;
};
/** 从正则替换后的展示文本里抽出完整 HTML（含 ```text/html 围栏）。 */
export declare function extractRenderedHtml(text: string): string | null;
