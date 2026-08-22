/**
 * 工作区资产路径消毒与预设目录。
 * 覆盖：文本路径白名单、越界/绝对路径/WAL/二进制拒绝、'.' 段折叠后再判定 WAL、
 * 预设目录令牌与按 identifier 取条目。
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

  it("'.' 段折叠后再判定 WAL，绕不过前缀检查", () => {
    // WorkspaceFs.abs 会把 '.' 段折掉，若判定发生在折叠前，WAL 快照就会被读回给模型
    expect(resolveReadableAssetPath('state/./wal/x.jsonl').ok).toBe(false)
    expect(resolveReadableAssetPath('./state/./wal/meta.json').ok).toBe(false)
    expect(resolveReadableAssetPath('state/wal/./x.jsonl').ok).toBe(false)
    expect(resolveReadableAssetPath('state\\.\\wal\\x.jsonl').ok).toBe(false)
    // 合法路径返回折叠后的规范形式
    expect(resolveReadableAssetPath('./memory/a.md')).toEqual({ ok: true, path: 'memory/a.md' })
    expect(resolveReadableAssetPath('memory/./sub/a.md')).toEqual({ ok: true, path: 'memory/sub/a.md' })
    // 折叠后为空的纯 '.' 路径不合法
    expect(resolveReadableAssetPath('.').ok).toBe(false)
    expect(resolveReadableAssetPath('./.').ok).toBe(false)
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
