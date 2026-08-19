/**
 * 工作区资产路径消毒与预设目录。
 */
import { describe, expect, it } from 'vitest'
import {
  findPresetEntry,
  isPresetCatalogToken,
  listPresetCatalog,
  resolveReadableAssetPath,
} from '../src/core/assetRead.js'
import { defaultPreset } from '../src/core/assemble.js'

describe('resolveReadableAssetPath', () => {
  it('接受工作区内文本路径', () => {
    expect(resolveReadableAssetPath('journal.md')).toEqual({ ok: true, path: 'journal.md' })
    expect(resolveReadableAssetPath('./memory/a.md')).toEqual({ ok: true, path: 'memory/a.md' })
    expect(resolveReadableAssetPath('assets/character-book.json')).toEqual({ ok: true, path: 'assets/character-book.json' })
  })

  it('拒绝越界、WAL 与二进制', () => {
    expect(resolveReadableAssetPath('../x.md').ok).toBe(false)
    expect(resolveReadableAssetPath('C:\\abs.md').ok).toBe(false)
    expect(resolveReadableAssetPath('/etc/passwd').ok).toBe(false)
    expect(resolveReadableAssetPath('state/wal/1.json').ok).toBe(false)
    expect(resolveReadableAssetPath('card.png').ok).toBe(false)
  })
})

describe('preset catalog', () => {
  it('list/* 视为目录令牌', () => {
    expect(isPresetCatalogToken('list')).toBe(true)
    expect(isPresetCatalogToken('*')).toBe(true)
    expect(isPresetCatalogToken('main')).toBe(false)
  })

  it('能列出并按 identifier 找到条目（含未启用）', () => {
    const preset = defaultPreset()
    const catalog = listPresetCatalog(preset)
    expect(catalog.some((e) => e.identifier === 'main')).toBe(true)
    expect(findPresetEntry(preset, 'main')?.name).toBeTruthy()
    expect(findPresetEntry(preset, 'no-such')).toBeUndefined()
  })
})
