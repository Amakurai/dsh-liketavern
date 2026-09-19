/** 角色管理与新会话选择器共用字面搜索；名称、书名、作者和每个标签分别匹配，不执行输入正则。 */
import type { CharacterSummary } from './types.js'

export function matchesCharacterSearch(card: CharacterSummary, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [card.name, card.characterBookName ?? '', card.creator ?? '', ...(card.tags ?? [])]
    .some((value) => value.toLowerCase().includes(needle))
}
