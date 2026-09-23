/**
 * 角色工作区（workspace）单元测试。
 * 使用真实临时目录（WorkspaceFs wal 传 null）。
 * 覆盖：importCard 目录结构与文件内容、list/load/archive/restore/delete、cardId 路径边界、坏目录容错、
 * listCharacters 只探测 characters/<cardId>/card.json（深层垃圾/散落文件/缺 card.json 不影响列举）、
 * rebuildIndex 摘要与注入式 token 估算、WorkspaceFs 的 '..' 段级越界拒绝。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterCard } from '../src/core/types.js'
import {
  archiveCharacter,
  CHARACTER_ARCHIVE_FILE,
  deleteCharacter,
  importCard,
  isValidCardId,
  listArchivedCharacters,
  listCharacters,
  loadCharacter,
  newCardId,
  readCharacterArchiveMetadata,
  rebuildIndex,
  restoreCharacter,
  type WorkspaceIndex,
} from '../src/state/workspace.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { withWorkspaceLock } from '../src/state/workspaceLock.js'
import { cardToStJson, embedCardInPng, parseJsonCard, parsePngCard } from '../src/state/card.js'

let root: string
/** 角色库目录（与 node/paths.ts 的 paths.characters 对应）。 */
let charactersDir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'workspace-test-'))
  charactersDir = join(root, 'characters')
  await mkdir(charactersDir, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    spec: 'chara_card_v2',
    name: '测试角色 Test',
    description: '描述',
    personality: '性格',
    scenario: '场景',
    firstMes: '你好',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    creator: 'tester',
    characterVersion: '1',
    tags: ['tag1'],
    characterBook: { name: '本书', entries: [{ keys: ['剑'], content: '断剑重铸' }] },
    regexScripts: [{ scriptName: 's1', findRegex: '/foo/g', replaceString: 'bar', placement: [2] }],
    extensions: {},
    pngBytes: new Uint8Array([1, 2, 3, 254, 255]),
    raw: { spec: 'chara_card_v2', data: { name: '测试角色 Test' } },
    depthPrompt: null,
    ...overrides,
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function readJson(p: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>
}

describe('newCardId', () => {
  it('净化名 + 8 位 sha1 后缀；同名不同 ID', () => {
    const id = newCardId('测试角色 Test')
    expect(id).toMatch(/^测试角色-test-[0-9a-f]{8}$/)
    expect(newCardId('测试角色 Test')).not.toBe(id)
    expect(newCardId('!!!')).toMatch(/^card-[0-9a-f]{8}$/)
    expect(newCardId('A'.repeat(40) + ' 尾').split('-').slice(0, -1).join('-').length).toBeLessThanOrEqual(24)
  })

  it('cardId 只允许角色库下的单层安全目录名', () => {
    expect(isValidCardId('测试角色-a1b2c3d4')).toBe(true)
    expect(isValidCardId('legacy.card-1')).toBe(true)
    for (const id of ['', '.', '..', '../evil', 'a/b', 'a\\b', '.hidden', 'trailing.', 'a..b']) {
      expect(isValidCardId(id), id).toBe(false)
    }
  })

  it('cardId 拒绝 Windows 保留设备名（含带扩展段的形态）', () => {
    // RPC 直传 CON/NUL/COM1 等保留名（或 CON.card 形态）时，join 会解析为设备路径；
    // 生成 id 带 hash 后缀不会撞上，这里挡的是直传入口。
    for (const id of ['CON', 'con', 'NUL', 'PRN', 'AUX', 'COM1', 'LPT9', 'CON.card', 'com1.legacy']) {
      expect(isValidCardId(id), id).toBe(false)
    }
    // 正常名不受影响：保留名只出现在首段时才拒绝。
    expect(isValidCardId('console-hero-a1b2c3d4')).toBe(true)
    expect(isValidCardId('card-com1-a1b2c3d4')).toBe(true)
  })
})

describe('importCard', () => {
  it('产生完整目录结构与文件内容', async () => {
    const card = makeCard()
    const ws = await importCard(charactersDir, card)

    expect(ws.cardId).toMatch(/^测试角色-test-[0-9a-f]{8}$/)
    expect(ws.root).toBe(join(charactersDir, ws.cardId))
    expect(ws.card).toBe(card)

    // 目录结构（plan 3.12.1）
    for (const dir of ['assets', 'memory', 'memory/archive', 'state', 'state/wal']) {
      expect(await isDir(join(ws.root, dir)), dir).toBe(true)
    }

    // card.json：剔除 pngBytes、保留 raw
    const cardJson = await readJson(join(ws.root, 'card.json'))
    expect('pngBytes' in cardJson).toBe(false)
    expect(cardJson.name).toBe('测试角色 Test')
    expect(cardJson.raw).toEqual(card.raw)
    expect(cardJson.tags).toEqual(['tag1'])

    // card.png：二进制原样落盘（含 ≥0x80 字节）
    expect(new Uint8Array(await readFile(join(ws.root, 'card.png')))).toEqual(new Uint8Array([1, 2, 3, 254, 255]))

    // assets/character-book.json：{name, entries}
    expect(await readJson(join(ws.root, 'assets', 'character-book.json'))).toEqual({
      name: '本书',
      entries: [{ keys: ['剑'], content: '断剑重铸' }],
    })

    // assets/regex-scripts.json：展示向规则默认启用
    const rules = JSON.parse(await readFile(join(ws.root, 'assets', 'regex-scripts.json'), 'utf8')) as Array<
      Record<string, unknown>
    >
    expect(rules).toHaveLength(1)
    expect(rules[0]!.name).toBe('s1')
    expect(rules[0]!.enabled).toBe(true)
    expect(rules[0]!.source).toBe('card')
    expect(rules[0]!.scopes).toEqual(['output'])

    // 发布前已经重建索引，包含新建的空 journal.md。
    expect(await readFile(join(ws.root, 'journal.md'), 'utf8')).toBe('')
    const index = (await readJson(join(ws.root, 'index.json'))) as unknown as WorkspaceIndex
    expect(index.files).toEqual([{ path: 'journal.md', summary: '', tokens: 0 }])
    expect(typeof index.updatedAt).toBe('string')
  })

  it('无 pngBytes/characterBook 时不写对应文件，regex-scripts.json 为空数组', async () => {
    const ws = await importCard(charactersDir, makeCard({ pngBytes: null, characterBook: null, regexScripts: [] }))
    expect(await pathExists(join(ws.root, 'card.png'))).toBe(false)
    expect(await pathExists(join(ws.root, 'assets', 'character-book.json'))).toBe(false)
    expect(JSON.parse(await readFile(join(ws.root, 'assets', 'regex-scripts.json'), 'utf8'))).toEqual([])
    const listed = await listCharacters(charactersDir)
    expect(listed[0]).toMatchObject({ hasCharacterBook: false, characterBookEntryCount: 0 })
  })

  it('importWorldBook: false 跳过资产书，并清除 card 镜像与 raw 全部已识别落点', async () => {
    const book = (id: string) => ({ name: id, entries: [{ keys: [id], content: `${id}-content` }] })
    const card = parseJsonCard({
      spec: 'chara_card_v3',
      character_book: book('top-snake'),
      lorebook: JSON.stringify(book('top-alias')),
      characterBook: book('top-camel'),
      extensions: { character_book: book('top-ext-snake'), characterBook: book('top-ext-camel'), world: book('top-ext-world'), keepTop: true },
      data: {
        name: '跳过内嵌书',
        character_book: book('data-snake'),
        lorebook: book('data-alias'),
        characterBook: book('data-camel'),
        // data.world 只是 V3/厂商直接字段；data.extensions.lorebook 也不在 pickCharacterBook 的别名中。
        world: book('data-world-must-stay'),
        extensions: { character_book: book('data-ext-snake'), characterBook: book('data-ext-camel'), world: book('data-ext-world'),
          lorebook: book('data-ext-lorebook-must-stay'), keepData: true },
      },
    })
    const ws = await importCard(charactersDir, card, { importWorldBook: false })
    expect(await pathExists(join(ws.root, 'assets', 'character-book.json'))).toBe(false)
    expect(ws.card.characterBook).toBeNull()
    expect(ws.card.extensions).toEqual({ world: book('data-world-must-stay'), lorebook: book('data-ext-lorebook-must-stay'), keepData: true })
    const cardJson = await readJson(join(ws.root, 'card.json'))
    expect(cardJson.characterBook).toBeNull()
    expect(cardJson.extensions).toEqual({ world: book('data-world-must-stay'), lorebook: book('data-ext-lorebook-must-stay'), keepData: true })
    const raw = cardJson.raw as Record<string, unknown> & { data: Record<string, unknown> }
    for (const layer of [raw, raw.data]) {
      expect(layer).not.toHaveProperty('character_book')
      expect(layer).not.toHaveProperty('lorebook')
      expect(layer).not.toHaveProperty('characterBook')
    }
    // 被 data.extensions 遮蔽的顶层兼容落点也要按 skip 意图清理，避免其它读取器重新识别。
    expect(raw.extensions).toEqual({ keepTop: true })
    expect(raw.data.world).toEqual(book('data-world-must-stay'))
    expect(raw.data.extensions).toEqual({ lorebook: book('data-ext-lorebook-must-stay'), keepData: true })
    const loaded = await loadCharacter(charactersDir, ws.cardId)
    expect(loaded!.card.characterBook).toBeNull()
    expect(loaded!.card.raw).toEqual(raw)

    // 没有 data.extensions 时顶层 extensions 才是解析器实际来源；只清 world 等支持键，不误删 ext.lorebook。
    const fallback = parseJsonCard({ name: '顶层扩展书', extensions: {
      world: book('fallback-world'), lorebook: book('fallback-lorebook-must-stay'), keep: 1,
    } })
    const fallbackWs = await importCard(charactersDir, fallback, { importWorldBook: false })
    const fallbackRaw = (await readJson(join(fallbackWs.root, 'card.json'))).raw as { extensions: Record<string, unknown> }
    expect(fallbackRaw.extensions).toEqual({ lorebook: book('fallback-lorebook-must-stay'), keep: 1 })
  })

  it('importWorldBook: false 重嵌 PNG 卡元数据，磁盘 card.png 不残留内嵌书', async () => {
    const rawSource = {
      spec: 'chara_card_v3',
      spec_version: '3.7-vendor',
      vendor_meta: { exporter: 'vendor-x', untouched: true },
      data: {
        name: 'PNG 清洗卡',
        nickname: '清洗后仍保留',
        character_book: { name: '敏感设定', entries: [{ keys: ['secret'], content: '不得驻盘' }] },
      },
    }
    const source = parseJsonCard(rawSource)
    const originalPng = embedCardInPng(null, rawSource, source.spec)
    const pngCard = parsePngCard(originalPng)
    expect(pngCard.characterBook?.entries).toHaveLength(1)

    const ws = await importCard(charactersDir, pngCard, { importWorldBook: false })
    const savedPng = new Uint8Array(await readFile(join(ws.root, 'card.png')))
    const reparsed = parsePngCard(savedPng)
    expect(reparsed.characterBook).toBeNull()
    expect((reparsed.raw as { data: Record<string, unknown> }).data).not.toHaveProperty('character_book')
    expect((reparsed.raw as { data: Record<string, unknown> }).data.nickname).toBe('清洗后仍保留')
    expect((reparsed.raw as { spec_version: string }).spec_version).toBe('3.7-vendor')
    expect((reparsed.raw as { vendor_meta: unknown }).vendor_meta).toEqual(rawSource.vendor_meta)
    expect(savedPng).not.toEqual(originalPng)
    expect(await pathExists(join(ws.root, 'assets', 'character-book.json'))).toBe(false)
  })
})

describe('list/load/delete', () => {
  it('listCharacters 读取名称与头像存在性，容错跳过坏目录', async () => {
    const a = await importCard(charactersDir, makeCard({ name: 'Alpha' }))
    await importCard(charactersDir, makeCard({ name: 'Beta', pngBytes: null }))
    // 坏目录：无 card.json / card.json 损坏
    await mkdir(join(charactersDir, 'broken'), { recursive: true })
    await mkdir(join(charactersDir, 'bad'))
    await writeFile(join(charactersDir, 'bad', 'card.json'), 'not json{')

    const list = await listCharacters(charactersDir)
    expect(list).toHaveLength(2)
    const byName = new Map(list.map((c) => [c.name, c]))
    expect(byName.get('Alpha')).toMatchObject({
      cardId: a.cardId,
      hasAvatar: true,
      hasCharacterBook: true,
      characterBookName: '本书',
      characterBookEntryCount: 1,
    })
    expect(byName.get('Beta')).toMatchObject({ hasAvatar: false, hasCharacterBook: true })
  })

  it('只探测 characters/<cardId>/card.json：深层垃圾、嵌套伪卡、散落文件均不影响列举', async () => {
    const a = await importCard(charactersDir, makeCard({ name: 'Alpha' }))
    const b = await importCard(charactersDir, makeCard({ name: 'Beta', pngBytes: null }))

    // 卡工作区内堆积的深层数据：记忆归档、WAL 楼层文件
    await mkdir(join(a.root, 'memory', 'archive', '2025', '01'), { recursive: true })
    await writeFile(join(a.root, 'memory', 'archive', '2025', '01', 'old.md'), '归档记忆')
    await mkdir(join(a.root, 'state', 'wal', 'floor-1'), { recursive: true })
    await writeFile(join(a.root, 'state', 'wal', 'floor-1', '0001.jsonl'), '{}')
    // 深层伪装卡目录（含 card.json，但不在 characters/ 第一层，不得被列出）
    await mkdir(join(a.root, 'memory', 'fake-card'), { recursive: true })
    await writeFile(join(a.root, 'memory', 'fake-card', 'card.json'), JSON.stringify({ name: '幽灵卡' }))

    // characters/ 顶层散落文件与缺 card.json 的目录（其深层 card.json 不得被当成卡）
    await writeFile(join(charactersDir, 'notes.txt'), '杂物')
    await mkdir(join(charactersDir, 'orphan', 'deep'), { recursive: true })
    await writeFile(join(charactersDir, 'orphan', 'deep', 'card.json'), JSON.stringify({ name: '深层伪卡' }))

    const list = await listCharacters(charactersDir)
    expect(list.map((c) => c.name).sort()).toEqual(['Alpha', 'Beta'])
    expect(list.map((c) => c.cardId).sort()).toEqual([a.cardId, b.cardId].sort())
  })

  it('角色库目录不存在时返回空列表', async () => {
    expect(await listCharacters(join(root, 'never-created'))).toEqual([])
  })

  it('loadCharacter 读回卡片（pngBytes 恒为 null），缺失/损坏返回 null', async () => {
    const ws = await importCard(charactersDir, makeCard())
    const loaded = await loadCharacter(charactersDir, ws.cardId)
    expect(loaded).not.toBeNull()
    expect(loaded!.cardId).toBe(ws.cardId)
    expect(loaded!.root).toBe(ws.root)
    expect(loaded!.card.name).toBe('测试角色 Test')
    expect(loaded!.card.pngBytes).toBeNull()
    expect(loaded!.card.raw).toEqual(ws.card.raw)

    expect(await loadCharacter(charactersDir, 'missing')).toBeNull()
    await mkdir(join(charactersDir, 'bad'))
    await writeFile(join(charactersDir, 'bad', 'card.json'), '{broken')
    expect(await loadCharacter(charactersDir, 'bad')).toBeNull()
  })

  it('loadCharacter 从 extensions.depth_prompt 补回 depthPrompt（旧 card.json）', async () => {
    const ws = await importCard(charactersDir, makeCard())
    const cardJson = await readJson(join(ws.root, 'card.json'))
    delete cardJson.depthPrompt
    cardJson.extensions = { depth_prompt: { prompt: '旧深度提示', depth: 2, role: 'user' } }
    await writeFile(join(ws.root, 'card.json'), JSON.stringify(cardJson))
    const loaded = await loadCharacter(charactersDir, ws.cardId)
    expect(loaded!.card.depthPrompt).toEqual({ prompt: '旧深度提示', depth: 2, role: 'user' })
  })

  it('收纳只隐藏活动列表，保留卡目录并可原样恢复', async () => {
    const ws = await importCard(charactersDir, makeCard({ name: '待收纳角色' }))
    await writeFile(join(ws.root, 'memory', 'kept.md'), '必须保留的剧情资料')

    await archiveCharacter(charactersDir, ws.cardId)
    const first = await readCharacterArchiveMetadata(charactersDir, ws.cardId)
    expect(first?.version).toBe(1)
    expect(Number.isNaN(Date.parse(first!.archivedAt))).toBe(false)
    expect(await listCharacters(charactersDir)).toEqual([])
    expect(await listArchivedCharacters(charactersDir)).toEqual([
      expect.objectContaining({ cardId: ws.cardId, name: '待收纳角色', archivedAt: first!.archivedAt }),
    ])
    // loadCharacter 不受视图标记影响：历史会话仍能读卡，且重试不重置首次收纳时间。
    expect((await loadCharacter(charactersDir, ws.cardId))?.card.name).toBe('待收纳角色')
    expect(await archiveCharacter(charactersDir, ws.cardId)).toEqual(first)

    await restoreCharacter(charactersDir, ws.cardId)
    expect(await readCharacterArchiveMetadata(charactersDir, ws.cardId)).toBeNull()
    expect((await listCharacters(charactersDir)).map((item) => item.cardId)).toEqual([ws.cardId])
    expect(await listArchivedCharacters(charactersDir)).toEqual([])
    expect(await readFile(join(ws.root, 'memory', 'kept.md'), 'utf8')).toBe('必须保留的剧情资料')
    await expect(restoreCharacter(charactersDir, ws.cardId)).resolves.toBeUndefined()
  })

  it('损坏收纳标记仍留在收纳箱供恢复，不会让角色消失或回到活动列表', async () => {
    const ws = await importCard(charactersDir, makeCard({ name: '标记损坏' }))
    // JSON 语法合法但时间非法也是损坏标记，不得被当成有效删除凭证。
    await writeFile(join(ws.root, CHARACTER_ARCHIVE_FILE), JSON.stringify({ version: 1, archivedAt: 'not-a-date' }))
    await expect(readCharacterArchiveMetadata(charactersDir, ws.cardId)).rejects.toThrow(/收纳标记损坏/)
    expect(await listCharacters(charactersDir)).toEqual([])
    expect(await listArchivedCharacters(charactersDir)).toEqual([
      expect.objectContaining({ cardId: ws.cardId, archivedAt: expect.any(String) }),
    ])
    await restoreCharacter(charactersDir, ws.cardId)
    expect((await listCharacters(charactersDir))[0]?.cardId).toBe(ws.cardId)
  })

  it('收纳与恢复拒绝缺失卡和非法 cardId', async () => {
    await expect(archiveCharacter(charactersDir, 'missing')).rejects.toThrow(/不存在/)
    await expect(restoreCharacter(charactersDir, 'missing')).rejects.toThrow(/不存在/)
    await expect(archiveCharacter(charactersDir, '../evil')).rejects.toThrow(/非法的角色 ID/)
    await expect(restoreCharacter(charactersDir, '.')).rejects.toThrow(/非法的角色 ID/)
  })

  it('card.json 缺 characterBook 时从 assets/character-book.json 补回', async () => {
    const ws = await importCard(charactersDir, makeCard())
    const cardJson = await readJson(join(ws.root, 'card.json'))
    delete cardJson.characterBook
    await writeFile(join(ws.root, 'card.json'), JSON.stringify(cardJson))
    const loaded = await loadCharacter(charactersDir, ws.cardId)
    expect(loaded!.card.characterBook?.entries).toHaveLength(1)
    expect(loaded!.card.characterBook?.name).toBe('本书')
  })

  it('deleteCharacter 删除整目录；重复删除与非法 ID', async () => {
    const ws = await importCard(charactersDir, makeCard())
    await deleteCharacter(charactersDir, ws.cardId)
    expect(await pathExists(ws.root)).toBe(false)
    expect(await loadCharacter(charactersDir, ws.cardId)).toBeNull()
    await expect(deleteCharacter(charactersDir, ws.cardId)).resolves.toBeUndefined() // 幂等
    await expect(deleteCharacter(charactersDir, '../evil')).rejects.toThrow(/非法的角色 ID/)
  })

  it('拒绝 cardId="."，不得把整个角色库作为工作区读取或删除', async () => {
    const ws = await importCard(charactersDir, makeCard())
    await writeFile(join(charactersDir, 'card.json'), JSON.stringify({ name: '根目录伪卡片' }))

    expect(await loadCharacter(charactersDir, '.')).toBeNull()
    await expect(deleteCharacter(charactersDir, '.')).rejects.toThrow(/非法的角色 ID/)
    expect(await pathExists(charactersDir)).toBe(true)
    expect(await pathExists(ws.root)).toBe(true)
  })
})

describe('WorkspaceFs 路径边界', () => {
  it('拒绝任何 .. 段：出根与跨子树都不放行，正常嵌套路径不受影响', async () => {
    const ws = await importCard(charactersDir, makeCard())
    const fs = new WorkspaceFs(ws.root, null)

    // 出根
    await expect(fs.writeText('a/../../x.json', '{}')).rejects.toThrow(/工作区路径越界/)
    await expect(fs.readText('../card.json')).rejects.toThrow(/工作区路径越界/)
    // 不出根但跨子树：只看根目录前缀会放行，段级判定必须拦住
    await expect(fs.writeText('a/../b.json', '{}')).rejects.toThrow(/工作区路径越界/)
    await expect(fs.writeText('personas/../regex/rules.json', '[]')).rejects.toThrow(/工作区路径越界/)
    await expect(fs.delete('memory/../journal.md')).rejects.toThrow(/工作区路径越界/)
    // Windows 反斜杠同样按段拆
    await expect(fs.writeText('a\\..\\b.json', '{}')).rejects.toThrow(/工作区路径越界/)
    expect(await pathExists(join(ws.root, 'b.json'))).toBe(false)

    await fs.writeText('memory/deep/ok.md', '内容')
    expect(await readFile(join(ws.root, 'memory', 'deep', 'ok.md'), 'utf8')).toBe('内容')
    expect(await fs.readText('memory/deep/ok.md')).toBe('内容')
    expect(await fs.list('memory')).toContain('deep/ok.md')
  })
})

describe('rebuildIndex', () => {
  it('扫描 memory/*.md（不含 archive）、world-delta.jsonl、journal.md，生成摘要与 token 估算', async () => {
    const ws = await importCard(charactersDir, makeCard())
    const fs = new WorkspaceFs(ws.root, null)

    const factContent = '---\ncreated: 2026-01-01\ntags: [a]\n---\n\n第一位王女死于冬夜。\n第二行\n'
    const longContent = '长'.repeat(70) + '\n'
    await fs.writeText('memory/fact.md', factContent)
    await fs.writeText('memory/long.md', longContent)
    await fs.writeText('memory/empty.md', '')
    await fs.writeText('memory/archive/old.md', '已归档，不进清单')
    const deltaContent = '{"id":"1","type":"add"}\n{"id":"2","type":"update"}\n'
    await fs.writeText('state/world-delta.jsonl', deltaContent)
    await fs.writeText('journal.md', '序章\n\n雪落王城。\n')

    // 注入固定估算：token 数 = 字符数
    await rebuildIndex(fs, (t) => t.length)

    const index = JSON.parse(await readFile(join(ws.root, 'index.json'), 'utf8')) as WorkspaceIndex
    expect(typeof index.updatedAt).toBe('string')
    const byPath = new Map(index.files.map((f) => [f.path, f]))

    // memory 顶层 3 个 md（archive 排除）
    expect([...byPath.keys()].sort()).toEqual([
      'journal.md',
      'memory/empty.md',
      'memory/fact.md',
      'memory/long.md',
      'state/world-delta.jsonl',
    ])
    expect(byPath.get('memory/fact.md')).toEqual({
      path: 'memory/fact.md',
      summary: '第一位王女死于冬夜。', // 跳过 frontmatter 的首个非空行
      tokens: factContent.length,
    })
    expect(byPath.get('memory/long.md')!.summary).toBe('长'.repeat(60)) // 限 60 字
    expect(byPath.get('memory/empty.md')).toEqual({ path: 'memory/empty.md', summary: '', tokens: 0 })
    expect(byPath.get('state/world-delta.jsonl')).toEqual({
      path: 'state/world-delta.jsonl',
      summary: '2 条变化',
      tokens: deltaContent.length,
    })
    expect(byPath.get('journal.md')).toEqual({ path: 'journal.md', summary: '序章', tokens: '序章\n\n雪落王城。\n'.length })
  })

  it('journal.md 缺失时跳过该文件', async () => {
    const ws = await importCard(charactersDir, makeCard())
    const fs = new WorkspaceFs(ws.root, null)
    await fs.delete('journal.md')
    await rebuildIndex(fs, (t) => t.length)
    const index = JSON.parse(await readFile(join(ws.root, 'index.json'), 'utf8')) as WorkspaceIndex
    expect(index.files.map((f) => f.path)).toEqual([])
  })

  it('并发写入期间不扫描旧笔记，最终索引对应已提交的正文', async () => {
    const ws = await importCard(charactersDir, makeCard())
    const fs = new WorkspaceFs(ws.root, null)
    await fs.writeText('journal.md', '旧笔记')

    let entered!: () => void, allowWrite!: () => void, staleRead!: () => void, continueRead!: () => void
    const lockEntered = new Promise<void>(resolve => { entered = resolve })
    const writeGate = new Promise<void>(resolve => { allowWrite = resolve })
    const readOld = new Promise<void>(resolve => { staleRead = resolve })
    const readGate = new Promise<void>(resolve => { continueRead = resolve })
    const originalRead = fs.readText.bind(fs)
    const readSpy = vi.spyOn(fs, 'readText').mockImplementation(async path => {
      const value = await originalRead(path)
      if (path === 'journal.md' && value === '旧笔记') { staleRead(); await readGate }
      return value
    })
    const writer = withWorkspaceLock(ws.root, async () => {
      entered()
      await writeGate
      await fs.writeText('journal.md', '新笔记')
    })
    await lockEntered
    const listSpy = vi.spyOn(fs, 'list')
    const rebuilding = rebuildIndex(fs, text => text.length)
    try {
      // 未加锁的实现会立即扫描旧正文；等它读完后提交新正文，稳定复现旧索引覆盖。
      if (listSpy.mock.calls.length > 0) await readOld
      allowWrite()
      await writer
      continueRead()
      await rebuilding
      const index = JSON.parse(await fs.readText('index.json') ?? '{}') as WorkspaceIndex
      expect(index.files.find(file => file.path === 'journal.md')?.summary).toBe('新笔记')
    } finally {
      allowWrite()
      continueRead()
      listSpy.mockRestore()
      readSpy.mockRestore()
    }
  })
})


/** 审查修复回归：故障发生在哪个文件都只清理私有草稿，不影响已存在角色。 */
describe('审查修复回归：角色导入原子发布', () => {
  it.each(['card.json', 'card.png', 'assets/character-book.json', 'assets/regex-scripts.json', 'journal.md', 'index.json'])('写入 %s 失败不出现半成品，重试只新增一个完整角色', async failedPath => {
    const existing = await importCard(charactersDir, makeCard({ name: '原有角色' }))
    const before = await readFile(join(existing.root, 'card.json'), 'utf8')
    const original = WorkspaceFs.prototype.writeBytes
    const originalText = WorkspaceFs.prototype.writeText
    const fault = Object.assign(new Error('模拟 ENOSPC'), { code: 'ENOSPC' })
    const spy = vi.spyOn(WorkspaceFs.prototype, 'writeBytes').mockImplementation(async function(path, bytes) {
      if (path === failedPath) throw fault
      return original.call(this, path, bytes)
    })
    const textSpy = vi.spyOn(WorkspaceFs.prototype, 'writeText').mockImplementation(async function(path, text) {
      if (path === failedPath) throw fault
      return originalText.call(this, path, text)
    })
    try {
      await expect(importCard(charactersDir, makeCard({ name: '新角色' }))).rejects.toThrow('模拟 ENOSPC')
    } finally { spy.mockRestore(); textSpy.mockRestore() }
    expect((await listCharacters(charactersDir)).map(item => item.cardId)).toEqual([existing.cardId])
    expect(await readdir(charactersDir)).toEqual([existing.cardId])
    expect(await readFile(join(existing.root, 'card.json'), 'utf8')).toBe(before)
    const created = await importCard(charactersDir, makeCard({ name: '新角色' }))
    expect(await listCharacters(charactersDir)).toHaveLength(2)
    expect(await readFile(join(created.root, 'card.png'))).toEqual(Buffer.from(makeCard().pngBytes!))
    const index = JSON.parse(await readFile(join(created.root, 'index.json'), 'utf8'))
    expect(index.files).toEqual([{ path: 'journal.md', summary: '', tokens: 0 }])
  })
  it('索引还在准备时列表不可见，发布后才列出', async () => {
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const original = WorkspaceFs.prototype.writeText
    const spy = vi.spyOn(WorkspaceFs.prototype, 'writeText').mockImplementation(async function(path, bytes) {
      if (path === 'index.json') { started.resolve(); await release.promise }
      return original.call(this, path, bytes)
    })
    const pending = importCard(charactersDir, makeCard())
    try {
      await started.promise
      expect(await listCharacters(charactersDir)).toEqual([])
    } finally { release.resolve(); await pending; spy.mockRestore() }
    expect(await listCharacters(charactersDir)).toHaveLength(1)
  })
})
