/**
 * 跨层共享的纯值守卫与错误文本。
 *
 * 只放无依赖、无副作用的最小判定，供 core/state/node/client 共用，避免各文件各写一份
 * 后悄悄漂移。注入 iframe 的自包含函数（经 Function.toString 序列化）不得引用这里，
 * 它们必须保留内联副本。
 */
/** 非 null、非数组的对象（不检查原型）。 */
export declare function isRecord(value: unknown): value is Record<string, unknown>;
/** Error 取 message，其它值 String()；不截断、不加前缀。 */
export declare function describeError(error: unknown): string;
