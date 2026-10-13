/** 固定版本 emoji 构建优化：提取无快捷键匹配器的公共冒号前缀，保持每个分支的内容与优先级。 */
export function optimizeEmojiMatcherSource(source, version) {
  if (version !== '3.1.0') throw new Error('markdown-it-emoji 版本改变，必须重新审查匹配器等价性')
  const original = "  const scanRE = RegExp(names)\n  const replaceRE = RegExp(names, 'g')"
  const normalized = source.replaceAll('\r\n', '\n')
  if (normalized.split(original).length !== 2) throw new Error('markdown-it-emoji 匹配器构建位置改变，拒绝静默跳过优化')
  return normalized.replace(original, `  /*! Tavern build optimization for markdown-it-emoji 3.1.0 (MIT): factor the shared literal prefix without changing alternative order. */
  if (keys.length && Object.keys(shortcuts).length === 0) {
    names = ':(?:' + keys
      .map(name => ':' + name + ':')
      .sort().reverse()
      .map(name => quoteRE(name.slice(1)))
      .join('|') + ')'
  }
${original}`)
}
