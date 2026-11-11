/**
 * 卡面 srcDoc 内联脚本的 JSON 编码。
 *
 * 宿主侧把数据写进 `<script>` 文本时，`<` 必须转义，否则正文里的 `</script>` 会提前
 * 关闭容器；U+2028/U+2029 在旧 JS 字符串字面量中是行终止符，同样转义。这是 XSS 防线，
 * 只保留这一份实现。注入 iframe 的自包含函数不得引用本模块。
 */

/** JSON.stringify 后转义 `<`、U+2028、U+2029，结果可直接嵌入内联脚本。 */
export function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}
