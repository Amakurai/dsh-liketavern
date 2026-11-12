/**
 * 第三方资产 JSON 的纯函数宽松值转换（世界书、预设、角色卡导入共用）。
 *
 * 只收录各解析器中逐字相同的转换：字符串仅接受 string/number/boolean，数字接受有限数
 * 与可解析的非空字符串，布尔兼容 0/1 与 "true"/"false"。角色卡会把对象 JSON 化的 toStr、
 * 对空串处理不同的 toStrArr 语义不同，保留在各自模块，不能并入这里。
 */
/** 宽松字符串：string 原样，number/boolean 转字符串，其它一律空串。 */
export declare function toStr(value: unknown): string;
/** 宽松数字：有限 number 或可解析为有限数的非空字符串，否则返回 fallback。 */
export declare function toNum(value: unknown, fallback: number): number;
/** 可空数字：null/undefined/空白串及非法值回落 null；可选兼容旧格式布尔（true → 1，false → null）。 */
export declare function toNumOrNull(value: unknown, options?: {
    booleanOne?: boolean;
}): number | null;
/** 宽松布尔：数字非零为真，"true"/"1"/"false"/"0"/"" 按字面，null/undefined 用 fallback。 */
export declare function toBool(value: unknown, fallback: boolean): boolean;
