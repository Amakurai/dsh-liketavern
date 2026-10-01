/**
 * 工作区资产路径消毒与预设目录。
 * 覆盖：文本路径白名单、越界/绝对路径/WAL/角色生命周期元数据/二进制拒绝、'.' 段折叠后再判定 WAL、
 * 预设目录令牌与按 identifier 取条目。
 */
import { describe, expect, it } from 'vitest'
import {
  ASSET_CATALOG_MAX,
  assetOutputTokens,
  budgetAssetFiles,
  budgetAssetIndex,
  budgetPresetCatalog,
  clipAssetJsonText,
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
    expect(resolveReadableAssetPath('.archive.json').ok).toBe(false)
    expect(resolveReadableAssetPath('card.png').ok).toBe(false)
    expect(resolveReadableAssetPath('journal.md:private.txt').ok).toBe(false)
    expect(resolveReadableAssetPath('memory/notes.md:private.txt').ok).toBe(false)
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

describe('完整 JSON 资产预算', () => {
  it('计入 pretty JSON 与控制字符转义，裁剪也不能切断代理对', () => {
    const text = '\u0000'.repeat(1000) + '灯塔'
    const clipped = clipAssetJsonText(text, 100)
    expect(clipped.truncated).toBe(true)
    expect(assetOutputTokens(clipped.text)).toBeLessThanOrEqual(100)
    expect(clipped.text).toContain('已截断')
    expect(clipAssetJsonText('🗝️'.repeat(100), 20).text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
  })

  it('超长路径整条省略，后续小文件仍可被找到，不返回假定位字段', () => {
    const paths = [`state/${'很长路径'.repeat(100)}.json`, 'journal.md', 'memory/m1.md']
    const result = budgetAssetFiles(paths, 200)
    expect(result.files).toEqual(paths.slice(1))
    expect(result).toMatchObject({ count: 3, omitted: 1, truncated: true })
    expect(result.tokensUsed).toBeLessThanOrEqual(200)
  })

  it('即使 token 预算充足，文件和预设目录也最多返回 200 条', () => {
    const paths = Array.from({ length: ASSET_CATALOG_MAX + 1 }, (_, i) => `memory/${i}.md`)
    const files = budgetAssetFiles(paths, 100000)
    const preset = defaultPreset(), entry = preset.entries[0]!
    preset.entries = paths.map((_, i) => ({ ...entry, identifier: String(i), content: '' }))
    const entries = budgetPresetCatalog(preset, 100000)
    expect(files.files).toHaveLength(200)
    expect(entries.entries).toHaveLength(200)
    expect(files).toMatchObject({ count: 201, omitted: 1, truncated: true })
    expect(entries).toMatchObject({ count: 201, omitted: 1, truncated: true })
  })

  it('预设定位字段过长整条省略，名称和预览显式裁剪，序列化总量仍有界', () => {
    const preset = defaultPreset(), entry = preset.entries[0]!
    preset.name = '\u0000'.repeat(10000)
    preset.entries = [{ ...entry, identifier: '定位'.repeat(250) },
      { ...entry, identifier: '长标记', markerId: '标记'.repeat(250) },
      { ...entry, identifier: 'valid', name: '巨大名称'.repeat(1000), content: '\u0000'.repeat(1000) }]
    const catalog = budgetPresetCatalog(preset, 600)
    expect(catalog).toMatchObject({ count: 3, omitted: 2, truncated: true, metadataTruncated: true })
    expect(catalog.entries).toHaveLength(1)
    expect(catalog.entries[0]).toMatchObject({ identifier: 'valid', truncated: true })
    expect(assetOutputTokens({ preset: catalog })).toBeLessThanOrEqual(600)
    expect(catalog.tokensUsed).toBe(assetOutputTokens({ preset: catalog }))
  })

  it('索引舍弃未知字段、坏类型、重复项与不可读路径，仅保留规范实际目录', () => {
    const index = budgetAssetIndex({ updatedAt: '私有附带字段', secret: '秘密', files: [
      { path: 'journal.md', summary: '港口', tokens: 2, secret: '秘密' },
      { path: './journal.md', summary: '重复条目', tokens: 2 },
      { path: 'missing.md', summary: '不存在', tokens: 1 },
      { path: 'state/wal/hidden.json', summary: 'WAL', tokens: 1 },
      { path: 'memory/m1.md', summary: '无效 token', tokens: NaN },
      { path: 'card.json', summary: '共享角色资产', tokens: 1 },
    ] }, ['journal.md', 'memory/m1.md', 'state/wal/hidden.json'], 400)
    expect(index?.files).toEqual([{ path: 'journal.md', summary: '港口', tokens: 2, truncated: false }])
    expect(index).toMatchObject({ count: 6, omitted: 5, truncated: true, metadataTruncated: true })
    expect(JSON.stringify(index)).not.toMatch(/秘密|私有|重复|不存在|WAL|共享角色/)
    expect(budgetAssetIndex(['任意 JSON'], [], 400)).toBeNull()
    expect(budgetAssetIndex({ files: '坏类型' }, [], 400)).toBeNull()
  })

  it('预算不足以容纳目录头时明确拒绝，不以空目录冒充完整成功', () => {
    expect(() => budgetAssetFiles(['journal.md'], 0)).toThrow('预算')
    expect(() => budgetPresetCatalog(defaultPreset(), 0)).toThrow('预算')
  })

  it('能装入整页的长定位字段原样保留，只有目录头真的超预算才省略预设 id', () => {
    const preset = defaultPreset(), identifier = '合法定位'.repeat(100), markerId = '合法标记'.repeat(100)
    preset.identifier = '预设定位'.repeat(100)
    preset.entries = [{ ...preset.entries[0]!, identifier, markerId, content: '短正文' }]
    const catalog = budgetPresetCatalog(preset, 2000)
    expect(catalog.id).toBe(preset.identifier)
    expect(catalog.entries).toContainEqual(expect.objectContaining({ identifier, markerId }))
    expect(catalog.omitted).toBe(0)
    expect(budgetPresetCatalog(preset, 300)).toMatchObject({ idOmitted: true, metadataTruncated: true })
    const path = `state/${'长路径'.repeat(130)}.md`
    expect(budgetAssetFiles([path], 900).files).toEqual([path])
    expect(budgetAssetIndex({ files: [{ path, summary: '短摘要', tokens: 3 }] }, [path], 900)?.files).toContainEqual({ path, summary: '短摘要', tokens: 3, truncated: false })
  })
})
