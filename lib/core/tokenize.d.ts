/**
 * 检索分词与 token 粗估。
 * 纯函数、零依赖、毫秒级；供记忆检索（BM25）与预算估算共用。
 */
/**
 * 检索分词。
 * - 先做 NFKC 归一：全角字母数字、半角片假名、兼容表意字与对应的常规写法得到同一 token
 *   （`ＡＢＣ` → `abc`，`ｶﾞｲﾄﾞ` → `ガイド`）；只影响分词，不改调用方的原文。
 * - bigram 文字段切滑窗 bigram：「我喜欢你」→ ['我喜', '喜欢', '欢你']；单字不成词（返回空）。
 *   假名、谚文同理：「안녕하세요」→ ['안녕', '녕하', '하세', '세요']。
 * - 其余词整词保留并转小写：`Café` → `café`，`Привет` → `привет`。
 *   撇号后面的词尾不算词：`it's` → ['it']，`don't` → ['don']。
 */
export declare function tokenize(text: string): string[];
/** 一段文本的检索切分；各数组都保留重复，顺序同原文。 */
export interface TextTokens {
    /** tokenize 的结果：bigram 与整词。 */
    terms: string[];
    /**
     * bigram 文字（CJK/假名/谚文）里的每个字。bigram 表达不了单字词：
     * 「凛去哪了」与「凛的妹妹」没有共同 bigram，单独一个「樱」连一个 bigram 都切不出来。
     * 是否把某个字当作检索词由索引决定，这里只负责切分。
     */
    chars: string[];
    /**
     * 每段 bigram 文字的首字与尾字（单字成段时两者相同）。一个字紧挨着标点或别的文字出现，
     * 说明它在那一侧是词的边界；索引据此判断这个字是否独立成词。
     */
    initials: string[];
    finals: string[];
    /**
     * 在这段文本里单独成词的字：左右两侧都是边界——标点、空白、别的文字、段首段尾，或者一个虚词。
     * 「凛的妹妹叫樱，」里凛（句首 + 的）和樱（叫 + 逗号）是，妹不是；「去打听」里打不是，它只是「打听」的一部分。
     * 引出名字的字（姓、绰号、人称、唤作）后面跟一个字再跟标点时，那个字也算：「绰号鲸，」。
     * 保留重复，顺序同原文。
     */
    words: string[];
    /**
     * 至少一侧是边界的字（包含 words）。句子里当作词用的字几乎总有一侧挨着标点或虚词——
     * 主语在句首，宾语在句末或虚词前；而「几点开始」里的「开」两侧都是别的实字，只是「开始」的一部分。
     */
    sides: string[];
    /**
     * 左侧是边界的字、右侧是边界的字（sides 是两者的并集）。一个名字可能从没被两侧同时夹住，
     * 却在一处开头（「豆抓伤过」）、在另一处收尾（「流浪猫豆是」）。
     */
    lefts: string[];
    rights: string[];
    /**
     * 整段文本是否只由被虚词或标点隔开的单个字组成：没有整词，也没有两个相邻的非虚词字。
     * 「豆在哪」「药呢」「岚的腿」是，「豆今天吃了吗」不是。空文本也算。
     */
    lone: boolean;
}
/** 是否为 bigram 文字切出的 bigram（两个字都属于 CJK/假名/谚文）；整词文字的两字母词不算。 */
export declare function isBigramTerm(term: string): boolean;
/** 平假名、片假名及其音标扩展：单个假名不构成词。 */
export declare function isKana(char: string): boolean;
/** 同时切出检索词与单字；归一和分段规则与 tokenize 完全一致。 */
export declare function analyzeText(text: string): TextTokens;
/**
 * 确定性粗估 token 数：CJK 字符每个计 1，其余字符累计后 ÷4 向上取整，两部分相加。
 * 只用于预算分配，不追求与具体模型 tokenizer 对齐；口径固定，不跟随分词的 bigram 文字范围。
 */
export declare function estimateTokens(text: string): number;
/** 按估算 token 预算截断；超限时在末尾加省略标记。 */
export declare function clipToTokenBudget(text: string, budget: number): {
    text: string;
    truncated: boolean;
    tokens: number;
};
