/** 角色管理与新会话选择器共用字面搜索；名称、书名、作者和每个标签分别匹配，不执行输入正则。 */
import type { CharacterSummary } from './types.js'

function matchesNeedle(card: CharacterSummary, needle: string): boolean {
  if (!needle) return true
  return [card.name, card.characterBookName ?? '', card.creator ?? '', ...(card.tags ?? [])]
    .some((value) => value.toLowerCase().includes(needle))
}

export function matchesCharacterSearch(card: CharacterSummary, query: string): boolean {
  return matchesNeedle(card, query.trim().toLowerCase())
}

/** 批量筛选只归一化一次查询，避免角色数放大重复的 trim/lowercase。 */
export function filterCharacters(cards: readonly CharacterSummary[], query: string): CharacterSummary[] {
  const needle = query.trim().toLowerCase()
  return cards.filter((card) => matchesNeedle(card, needle))
}
