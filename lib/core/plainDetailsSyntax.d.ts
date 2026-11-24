/**
 * 纯文本/Markdown `<details>` 语法与标签词表共享内核：
 * 统一承载标准 HTML/SVG/MathML 元素表、机读标签表、`<summary>`（含未闭合退化）扫描、
 * 引用块去壳与代码安全闭合定位，避免 `htmlFragment`、`displaySanitize` 与 `plainDetails`
 * 各自维护口径导致相邻折叠块拆分漂移或循环依赖。
 */
import { markdownCodeScanner } from './markdownCode.js';
export declare const DISPLAY_META_TAGS: readonly ["initvar", "UpdateVariable", "JSONPatch", "Analysis", "think", "thinking", "StatusPlaceHolderImpl"];
/** 是否为展示层应隐藏的机读块标签名（忽略大小写）。 */
export declare function isDisplayMetaTagName(name: string): boolean;
/** 是否为标准 HTML / SVG / MathML 元素名（忽略大小写）。 */
export declare function isKnownHtmlElementName(name: string): boolean;
export declare const MAX_PLAIN_DETAILS_CHARS: number;
export declare const MAX_PLAIN_DETAILS_DEPTH = 8;
export declare const MAX_PLAIN_DETAILS_BLOCKS = 64;
export declare const DETAILS_OPEN_RE: RegExp;
export declare const DETAILS_CLOSE_RE: RegExp;
export declare const SUMMARY_CANDIDATE_RE: RegExp;
export declare const SUMMARY_OPEN_RE: RegExp;
export declare const BR_CANDIDATE_RE: RegExp;
export declare const BR_PLAIN_RE: RegExp;
export declare const HR_CANDIDATE_RE: RegExp;
export declare const HR_PLAIN_RE: RegExp;
export declare const AUTOLINK_CANDIDATE_RE: RegExp;
export declare const BODY_TAG_RE: RegExp;
export declare const CUSTOM_ELEMENT_NAME_RE: RegExp;
export declare const RESIDUAL_TAG_RE: RegExp;
export declare function decodeSummaryEntities(text: string): string;
export declare function skipIgnorableHtml(text: string, start: number): number | null;
/** 剥离 HTML 缩进习惯产生的公共前导空白，避免被 CommonMark 误识别为四空格缩进代码块。 */
export declare function dedentCommonIndent(text: string): string;
export declare function isAutolinkToken(token: string): boolean;
/**
 * 扫描 `<summary>` 内容：
 * - 正常闭合 `<summary>…</summary>` 放行闭合注释、自动链接、行内代码与安全泛型；
 * - 未闭合 `<summary>`（#31）在首个空行、独立/行尾 `<br>` 或无歧义正文块起点切分摘要与正文，
 *   并跳过正文代码跨度/围栏内的 `</summary>` 与 `<!--`，全程 O(n) 扫描。
 */
export declare function scanPlainSummary(text: string, summaryStart: number): {
    summary: string;
    bodyStart: number;
    hasCodeSyntax: boolean;
} | null;
/**
 * 剥离包裹整块 `<details>` 的外层引用块前缀（如 `> <details>\n> <summary>...</summary>\n> 正文\n> </details>`）。
 * 只有当 `</details>` 所在行自身带有引用前缀、且内部每个非空行都共享至少同层前缀时才剥离，
 * 绝不误伤正文内部的引用行（如 `#28` 的 `<details>...>契约者: 希尔薇\n</details>`）。
 */
export declare function unwrapBlockquotedDetails(html: string): string;
/**
 * 代码区间仅在不跨越未配对 `<details>`/`</details>` HTML 边界且围栏已闭合时才允许跳过，
 * 防止反引号或未闭合围栏跨过 `</details>` 将相邻 `<script>` 或第二个折叠块吞入同一代码块。
 */
export declare function detailsSafeCodeEnd(text: string, at: number, code: ReturnType<typeof markdownCodeScanner>): number | null;
export declare function findMatchingDetailsClose(text: string, start: number, code: ReturnType<typeof markdownCodeScanner>): {
    closeStart: number;
    closeEnd: number;
} | null;
/** 在单行内扫描自定义伪标签的结束 `>`，跳过 `="..."`/`='...'` 属性引号内的 `>` 与 `<`。 */
export declare function scanCustomTagTokenEnd(line: string, start: number): number;
/** 按 CommonMark 四列制表位剥离多层引用块前缀并判定剩余缩进是否达到 4 列缩进代码。 */
export declare function scanBlockquoteAndIndent(line: string): {
    quotePrefixEnd: number;
    contentStart: number;
    indentedCode: boolean;
};
/** 判定单个尖括号记号是否为非标准 HTML、非自动链接的自定义伪标签，返回小写标签名。 */
export declare function customTagName(token: string): string | null;
/** 扫描单行是否仅由行首自定义伪标签组成，返回提取出的标签名列表；不匹配返回 `null`。 */
export declare function extractStandaloneCustomTagLine(line: string): {
    quotePrefixEnd: number;
    names: string[];
} | null;
/**
 * 清理会触发 CommonMark Type 7 HTML 块并吞掉后续围栏的行首自定义伪标签，
 * 以及与这些已确认伪标签同行混写的配对残余；跳过缩进代码、自动链接与标准 HTML 元素。
 */
export declare function stripCustomTags(text: string, extraNames?: ReadonlySet<string>): string;
/** 收起未转换成 HTML 的协议开闭标签，留下内部正文；跳过标准 HTML 与大写 URI/邮箱自动链接。 */
export declare function stripProtocolTags(text: string): string;
/** 检测净化后的纯折叠块 Markdown 片段中是否仍残留未允许标签。 */
export declare function hasResidualTag(text: string): boolean;
/**
 * 共享纯 `<details>` 正文扫描器：`plainDetails` 解析与 `isPlainDetailsStructure` 校验复用同一套
 * 注释剥离、`<br>`/`<hr>` 归一化、嵌套折叠与标签边界检查，杜绝两端口径漂移。
 */
export declare function scanPlainDetailsBody(body: string, onMarkdown: (raw: string) => boolean, onNestedDetails: (nestedStart: number, code: ReturnType<typeof markdownCodeScanner>) => number | null): boolean;
/** 定位从 `start` 开始的单个纯 `<details>` 候选块的匹配 `</details>` 结束下标（支持摘要与正文代码安全跳过）。 */
export declare function findPlainDetailsCloseEnd(text: string, start: number, code: ReturnType<typeof markdownCodeScanner>): number | null;
/**
 * 供 `htmlFragment` 拆分阶段复用：与 `parsePlainDetailsBlocks` 同口径判定单段 `<details>`
 * 是否可走原生折叠，避免无空行未闭合 `<summary>`、自定义元素或非常见 HTML 标签的邻块
 * 被错误并入纯折叠段而拖进 iframe。
 */
export declare function isPlainDetailsStructure(html: string): boolean;
