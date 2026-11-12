/**
 * 第三方资产 JSON 的宽松值转换兼容转出（实际实现收敛于 core/coerce.ts，供前后端共用）。
 */
export { toBool, toNum, toNumOrNull, toStr } from '../core/coerce.js'
