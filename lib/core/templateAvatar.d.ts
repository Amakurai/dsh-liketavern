/** 模板头像只携带有界的 PNG 图像块；剥离角色卡元数据和尾随数据，不接受脚本或外部地址。 */
export declare const TEMPLATE_AVATAR_BYTES: number;
export declare const TEMPLATE_AVATAR_URL_CHARS = 524310;
export declare function templateAvatarPng(input: Uint8Array): Uint8Array | null;
export declare function isTemplateAvatarUrl(value: unknown): value is string;
