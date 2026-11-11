/**
 * 原型污染安全的字段写入。
 *
 * 第三方 JSON（角色卡、编辑草稿）里的 `__proto__` 等键若用普通赋值写进 `{}`，会走
 * Object.prototype 上的 setter：字段本身静默丢失，目标对象的原型还会被外来对象替换。
 * 污染键清单与写入方式只在这里定义一份，避免安全相关副本各自漂移。
 * 注入 iframe 的自包含函数不得引用本模块，它们保留内联副本。
 */
/** 卡 JSON / 草稿中可能出现的原型污染键。 */
export const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** 污染键必须落成自有数据属性（defineProperty），其余键保持普通赋值。 */
export function setOwnField(target, key, value) {
    if (POLLUTION_KEYS.has(key)) {
        Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
        return;
    }
    target[key] = value;
}
