/** 无人设时 {{user}} 的展示名（对齐 SillyTavern 缺省 User）。 */
export declare const DEFAULT_USER_NAME = "User";
/** 人设（personas/<id>.json）的纯数据形状。 */
export interface Persona {
    id: string;
    name: string;
    description: string;
    /** 头像文件名（personas/<id>.png），无则 null。 */
    avatar: string | null;
    /** 挂接的世界书库文件名；空/缺省 = 无人设书。 */
    lorebookId?: string | null;
}
/** 人设存储边界：合法 JSON 也要验证字段，避免坏资产进入列表、默认人设解析与提示词。 */
export declare function parsePersona(value: unknown): Persona;
/**
 * 绑定指定 > 默认页 > 库里只剩一条。
 * 绑定为空且库里有多条、默认也未选时返回 null（调用方回退展示名 User）。
 */
export declare function pickPersona<T>(bound: T | null, fallback: T | null, all: T[]): T | null;
