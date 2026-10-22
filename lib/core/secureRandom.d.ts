/**
 * 非安全上下文的随机 ID 与摘要回退。
 *
 * `crypto.randomUUID` 与 `crypto.subtle` 只在安全上下文（HTTPS、localhost）存在；
 * 用手机经局域网 `http://192.168.x.x` 打开 dsh web 时二者都是 undefined，直接调用会让
 * 气泡渲染与 MVU 回执校验整段抛错。`crypto.getRandomValues` 不受安全上下文限制，
 * 用它拼出 v4 UUID；SHA-256 在缺 subtle 时走下方纯 JS 实现，结果与 Node createHash 一致。
 */
/** RFC 4122 v4 UUID：优先原生实现，缺失时用 getRandomValues 组装。 */
export declare function randomUuid(): string;
/** 纯 JS SHA-256（FIPS 180-4），输出小写十六进制。 */
export declare function sha256HexSync(data: Uint8Array): string;
/** UTF-8 文本的 SHA-256 十六进制摘要：有 subtle 用原生实现，否则回退纯 JS。 */
export declare function sha256Hex(text: string): Promise<string>;
