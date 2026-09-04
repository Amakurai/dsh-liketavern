/**
 * 角色工作区（workspace）单元测试。
 * 使用真实临时目录（WorkspaceFs wal 传 null）。
 * 覆盖：importCard 目录结构与文件内容、list/load/delete、cardId 路径边界、坏目录容错、
 * listCharacters 只探测 characters/<cardId>/card.json（深层垃圾/散落文件/缺 card.json 不影响列举）、
 * rebuildIndex 摘要与注入式 token 估算、WorkspaceFs 的 '..' 段级越界拒绝。
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CharacterCard } from '../src/core/types.js'
import {
  deleteCharacter,
  importCard,
  isValidCardId,
  listCharacters,
  loadCharacter,
  newCardId,
  rebuildIndex,
  type WorkspaceIndex,
} from '../src/state/workspace.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

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

    // journal.md 空文件、index.json 初始空清单
    expect(await readFile(join(ws.root, 'journal.md'), 'utf8')).toBe('')
    const index = (await readJson(join(ws.root, 'index.json'))) as unknown as WorkspaceIndex
    expect(index.files).toEqual([])
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

  it('importWorldBook: false 跳过内嵌世界书落盘，card.json 里 characterBook 为空', async () => {
    const ws = await importCard(charactersDir, makeCard(), { importWorldBook: false })
    expect(await pathExists(join(ws.root, 'assets', 'character-book.json'))).toBe(false)
    expect(ws.card.characterBook).toBeNull()
    const cardJson = await readJson(join(ws.root, 'card.json'))
    expect(cardJson.characterBook).toBeNull()
    const loaded = await loadCharacter(charactersDir, ws.cardId)
    expect(loaded!.card.characterBook).toBeNull()
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
})
