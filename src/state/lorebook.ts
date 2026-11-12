/**
 * 世界书 JSON ⇄ 归一化 WorldInfoEntry 兼容转出（纯函数实现收敛于 core/lorebookFormat.ts，消除 client -> state 跨层引用）。
 */
export {
  MAX_LOREBOOK_CONTENT_CHARS,
  MAX_LOREBOOK_ENTRIES,
  entryUid,
  exportCharacterBook,
  exportLorebook,
  isSpecCharacterBook,
  mergeDeltasForExport,
  parseLorebook,
  type ParseLorebookOptions,
} from '../core/lorebookFormat.js'
