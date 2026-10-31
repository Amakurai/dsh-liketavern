/** PNG 角色卡的既有文件预算：浏览器读取、remote 解码与状态解析共用，不能在前两层先分配无限输入。 */
export declare const MAX_CARD_PNG_BYTES: number;
/** 标准 Base64 每三字节占四字符；最后一组的余字节仍由解码后的 PNG 解析器复核。 */
export declare const MAX_CARD_PNG_BASE64_CHARS: number;
