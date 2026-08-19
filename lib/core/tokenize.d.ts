/**
 * 检索分词与 token 粗估。
 * 纯函数、零依赖、毫秒级；供记忆检索（BM25）与预算估算共用。
 */
/**
 * 检索分词。
 * - CJK 段切滑窗 bigram：「我喜欢你」→ ['我喜', '喜欢', '欢你']；单字不成词（返回空）。
 * - ASCII 词整词保留并转小写。
 */
export declare function tokenize(text: string): string[];
/**
 * 确定性粗估 token 数：CJK 字符每个计 1，其余字符累计后 ÷4 向上取整，两部分相加。
 * 只用于预算分配，不追求与具体模型 tokenizer 对齐。
 */
export declare function estimateTokens(text: string): number;
/** 按估算 token 预算截断；超限时在末尾加省略标记。 */
export declare function clipToTokenBudget(text: string, budget: number): {
    text: string;
    truncated: boolean;
    tokens: number;
};
