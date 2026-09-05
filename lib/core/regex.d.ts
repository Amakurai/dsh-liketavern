/**
 * 正则引擎（纯函数），语义对齐 SillyTavern 正则扩展：
 * - find 允许 `/pattern/flags` 形式；裸源码 = 区分大小写、只替换首个匹配。
 * - replace 支持 $1..$9 / $<name> 捕获组、`{{match}}`（等价 $&）与 {{char}}/{{user}} 宏。
 * - find 中宏展开由规则 substituteRegex 控制：0=不展开 1=原样代入 2=转义代入
 *   （转义在展开之后逐个宏值做，否则 {{description}}/{{getvar}} 会把裸元字符注进 pattern）。
 * - replace 里宏展开出来的值会把 `$` 翻倍：宏值中的 `$&`/`$1` 是字面文本，
 *   不该被 String.replace 再解释一次（`{{match}}` 是唯一例外，见下）。
 * - trimStrings / trimStringsRegex：对齐 ST——替换代入捕获组（含 {{match}}/$0）前，
 *   从组值里删掉这些字面串/正则片段（先宏展开）。ST 现行引擎只实现 trimStrings；
 *   trimStringsRegex 由本插件按同位置语义补全（缺省全局匹配）。
 *   带 trim 的规则改走函数式手工代入（ST 同款，支持 $0），其余规则仍用原生 replace。
 *
 * 规则作用于三种文本（scope）与三个时机（timing）的组合点：
 * - 用户输入 input：发送前（send）
 * - 发送给模型的文本 prompt：组装前（assemble）/ 发送前（send）
 * - AI 输出 output：渲染前（render）
 *
 * 引擎只返回新字符串/新数组，绝不原地修改——「作用于 prompt 的规则不得改写
 * 会话中存储的原始消息」由调用方据此天然满足。
 *
 * 安全闸：规则直接在主事件循环执行，(a+)+$ 类灾难性回溯会冻结整个 host。
 * 编译前一律过保守静态检查（超长 pattern + 嵌套量词/交叠分支启发式，
 * 见 findUnsafeRegexConstruct）；被拒绝的规则跳过并把原因记入 errors。
 * 落盘规则文件（regex/rules.json）可被手改：形状非法（缺 find/scopes/timing）
 * 的规则同样跳过并记录，绝不让 .includes() 处炸在主循环里。
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
/**
 * 灾难性回溯启发式（保守口径）：命中的 pattern 在恶意输入上可能指数级回溯、冻结主进程。
 * 逐个扫描分组（正确跳过转义与字符类），组后紧跟可重复量词时：
 * - 组内含量词构造 → 嵌套量词，如 (a+)+ / (a*)* / (a{2})+；
 * - 组内顶层分支重复或互为前缀 → 交叠分支，如 (a|a)+ / (a|aa)+。
 * 已知误伤面（字符类里的量词字符已排除，但仍偏保守）：(cat|c)+ 这类前缀分支实际线性也会被拒。
 * 拒绝代价只是该规则跳过并记 error，可接受；放行代价是冻结整个 host，不可接受。
 * 返回命中构造的片段（写进 error 便于定位），无问题返回 null。
 * 世界书 /regex/ 键复用同一判定（worldbook.ts 的 compileKey）。
 */
export declare function findUnsafeRegexConstruct(source: string): string | null;
/** 顺序应用规则；单条规则编译/执行失败不中断后续规则，记入 errors。 */
export declare function applyRegexRules(text: string, rules: readonly RegexRule[], filter: RegexFilter, macroCtx: MacroContext): RegexApplyResult;
/**
 * 对消息数组按深度应用规则。depth 从 0（最新真实消息）计，跳过 dsh runtime-context 快照；
 * 规则的 minDepth/maxDepth（null = 不限）过滤作用区间。返回新数组。
 * RegExp 编译只做一次（prepareRegexRule），全部消息复用；替换串宏展开仍逐消息
 * （{{random}}/{{pick}} 每次代入重新掷骰）；depth/role 过滤按消息进行。
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
 * md/po 改写 scopes 后 roles 会跟着复核，绝不留下 scopes 与 roles 互斥的死规则。
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
 * HTML 文档和小部件片段抽进 iframe；围栏外 / </html> 之前的协议标签与之后的文字留给 Markdown。
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
