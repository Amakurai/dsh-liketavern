/**
 * 会话绑定覆盖点：
 * - resolveStaleBinding：删除角色卡后 cardId 失效，按名字或「只剩一张卡」接回新工作区。
 * - parseSessionBinding（node/bindings）：全字段通过；必填缺失/类型错误抛错；
 *   interactiveCards（boolean | null）三态透传；cardId 目录名格式校验；未知字段丢弃。
 * - loadBinding/saveBinding 往返：写入侧拒绝坏数据；坏 JSON、缺字段、sessionId 不一致
 *   一律视为未绑定（返回 null），不再把「合法 JSON 但字段缺失」的数据交给使用点。
 * - listBindingReferencesForCard：永久删除预检保守识别部分损坏绑定，未知损坏、
 *   非普通文件、大小写扩展名与超限文件均 fail-closed。
 */
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveStaleBinding, type SessionBinding, type WalLineageEntry } from '../src/core/binding.js'
import { listBindingReferencesForCard, loadBinding, parseSessionBinding, saveBinding } from '../src/node/bindings.js'
import type { TavernPaths } from '../src/node/paths.js'

/** 手写全字段默认绑定（各用例用 overrides 覆盖）。 */
function makeBinding(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    sessionId: 's1',
    cardId: '测试角色-a1b2c3d4',
    cardName: '测试角色',
    presetId: null,
    personaId: null,
    lorebookIds: ['book.json'],
    characterLorebookId: null,
    interactiveCards: null,
    greetingIndex: 0,
    authorNote: '',
    injectJournal: false,
    walLineage: [{ sessionId: 's0', throughTurn: 2 }],
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('resolveStaleBinding', () => {
  const binding = {
    sessionId: 's1',
    cardId: '测试角色-oldhash',
    cardName: '测试角色',
    presetId: null as string | null,
  }

  it('cardId 仍在列表中则保留，并补上 cardName', () => {
    const live = [{ cardId: binding.cardId, name: '测试角色' }]
    const next = resolveStaleBinding({ sessionId: 's1', cardId: binding.cardId }, live)
    expect(next?.cardId).toBe(binding.cardId)
    expect(next?.cardName).toBe('测试角色')
  })

  it('cardId 已删时按 cardName 接到新 ID', () => {
    const next = resolveStaleBinding(binding, [{ cardId: '测试角色-a1b2c3d4', name: '测试角色' }])
    expect(next?.cardId).toBe('测试角色-a1b2c3d4')
    expect(next?.cardName).toBe('测试角色')
  })

  it('没有 cardName 但库里只剩一张卡时接到那张', () => {
    const next = resolveStaleBinding(
      { sessionId: 's1', cardId: 'deleted-id' },
      [{ cardId: 'only-one', name: '测试角色' }],
    )
    expect(next?.cardId).toBe('only-one')
    expect(next?.cardName).toBe('测试角色')
  })

  it('无法回收时返回 null（不要继续用文件夹 ID 当角色名）', () => {
    expect(
      resolveStaleBinding(binding, [
        { cardId: 'a', name: '甲' },
        { cardId: 'b', name: '乙' },
      ]),
    ).toBeNull()
    expect(resolveStaleBinding(binding, [])).toBeNull()
  })

  it('库里有多张同名卡时不按名接回（工作区/记忆/WAL 都按 cardId，接错会静默串卡）', () => {
    expect(
      resolveStaleBinding(binding, [
        { cardId: '测试角色-a1b2c3d4', name: '测试角色' },
        { cardId: '测试角色-e5f6a7b8', name: '测试角色' },
      ]),
    ).toBeNull()
  })
})

describe('parseSessionBinding', () => {
  it('全字段通过并原样返回', () => {
    const binding = makeBinding()
    expect(parseSessionBinding(binding)).toEqual(binding)
  })

  it('可缺字段缺省时为 undefined（旧文件可没有 cardName/authorNote/injectJournal/walLineage）', () => {
    const { cardName: _c, authorNote: _a, injectJournal: _i, walLineage: _w, ...minimal } = makeBinding()
    const parsed = parseSessionBinding(minimal)
    expect(parsed.sessionId).toBe('s1')
    expect(parsed.cardName).toBeUndefined()
    expect(parsed.authorNote).toBeUndefined()
    expect(parsed.injectJournal).toBeUndefined()
    expect(parsed.walLineage).toBeUndefined()
  })

  it('必填字段缺失即抛错', () => {
    const required = [
      'sessionId',
      'cardId',
      'presetId',
      'personaId',
      'lorebookIds',
      'characterLorebookId',
      'interactiveCards',
      'greetingIndex',
      'createdAt',
    ] as const
    for (const field of required) {
      const raw: Record<string, unknown> = { ...makeBinding() }
      delete raw[field]
      expect(() => parseSessionBinding(raw), field).toThrow()
    }
  })

  it('类型错误即抛错（含根输入不是对象）', () => {
    expect(() => parseSessionBinding(makeBinding({ greetingIndex: '0' as unknown as number }))).toThrow()
    expect(() => parseSessionBinding(makeBinding({ lorebookIds: 'book.json' as unknown as string[] }))).toThrow()
    expect(() => parseSessionBinding(makeBinding({ lorebookIds: ['ok', 1] as unknown as string[] }))).toThrow()
    expect(() => parseSessionBinding(makeBinding({ presetId: 1 as unknown as null }))).toThrow()
    expect(() => parseSessionBinding(makeBinding({ injectJournal: 'yes' as unknown as boolean }))).toThrow()
    expect(() => parseSessionBinding(null)).toThrow()
    expect(() => parseSessionBinding('s1')).toThrow()
    expect(() => parseSessionBinding([])).toThrow()
  })

  it('greetingIndex 与 walLineage.throughTurn 必须是非负整数', () => {
    expect(() => parseSessionBinding(makeBinding({ greetingIndex: -1 }))).toThrow()
    expect(() => parseSessionBinding(makeBinding({ greetingIndex: 0.5 }))).toThrow()
    expect(() => parseSessionBinding(makeBinding({ walLineage: [{ sessionId: 's0', throughTurn: -1 }] }))).toThrow()
    expect(() => parseSessionBinding(makeBinding({ walLineage: [{ sessionId: '', throughTurn: 1 }] }))).toThrow()
    expect(() => parseSessionBinding(makeBinding({ walLineage: [null as unknown as WalLineageEntry] }))).toThrow()
    expect(parseSessionBinding(makeBinding({ walLineage: [] })).walLineage).toEqual([])
  })

  it('interactiveCards（会话级交互卡开关）boolean | null 三态透传', () => {
    expect(parseSessionBinding(makeBinding({ interactiveCards: true })).interactiveCards).toBe(true)
    expect(parseSessionBinding(makeBinding({ interactiveCards: false })).interactiveCards).toBe(false)
    expect(parseSessionBinding(makeBinding({ interactiveCards: null })).interactiveCards).toBeNull()
    expect(() => parseSessionBinding(makeBinding({ interactiveCards: 'true' as unknown as boolean }))).toThrow()
  })

  it('cardId 必须是合法的单层目录名（复用 assertValidCardId）', () => {
    expect(() => parseSessionBinding(makeBinding({ cardId: '..' }))).toThrow()
    expect(() => parseSessionBinding(makeBinding({ cardId: 'a/b' }))).toThrow()
    expect(() => parseSessionBinding(makeBinding({ cardId: '.hidden' }))).toThrow()
    expect(parseSessionBinding(makeBinding({ cardId: '测试角色-a1b2c3d4' })).cardId).toBe('测试角色-a1b2c3d4')
  })

  it('未知字段丢弃（对齐 RPC schema 的 strip 行为）', () => {
    const parsed = parseSessionBinding({ ...makeBinding(), futureField: { x: 1 } })
    expect((parsed as Record<string, unknown>)['futureField']).toBeUndefined()
  })
})

describe('loadBinding / saveBinding 严格校验', () => {
  let root: string
  let paths: TavernPaths

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'binding-test-'))
    paths = {
      root,
      characters: join(root, 'characters'),
      lorebooks: join(root, 'library', 'lorebooks'),
      presets: join(root, 'library', 'presets'),
      personas: join(root, 'personas'),
      regexDir: join(root, 'regex'),
      sessions: join(root, 'sessions'),
    }
    await mkdir(paths.sessions, { recursive: true })
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('save → load 往返一致', async () => {
    const binding = makeBinding({ sessionId: 's-roundtrip' })
    await saveBinding(paths, binding)
    expect(await loadBinding(paths, 's-roundtrip')).toEqual(binding)
  })

  it('写入侧拒绝非法 cardId 与空 sessionId（坏数据不落盘）', async () => {
    await expect(saveBinding(paths, makeBinding({ cardId: '../escape' }))).rejects.toThrow()
    await expect(saveBinding(paths, makeBinding({ sessionId: '' }))).rejects.toThrow()
  })

  it('缺字段的合法 JSON 落盘后 load 视为未绑定（不再把坏数据交给使用点）', async () => {
    const raw: Record<string, unknown> = { ...makeBinding({ sessionId: 's-broken' }) }
    delete raw['lorebookIds']
    await writeFile(join(paths.sessions, 's-broken.json'), JSON.stringify(raw), 'utf8')
    expect(await loadBinding(paths, 's-broken')).toBeNull()
  })

  it('JSON 损坏、sessionId 不一致、文件不存在都视为未绑定', async () => {
    await writeFile(join(paths.sessions, 's-corrupt.json'), '{oops', 'utf8')
    expect(await loadBinding(paths, 's-corrupt')).toBeNull()
    await writeFile(join(paths.sessions, 's-file.json'), JSON.stringify(makeBinding({ sessionId: 's-other' })), 'utf8')
    expect(await loadBinding(paths, 's-file')).toBeNull()
    expect(await loadBinding(paths, 's-missing')).toBeNull()
  })

  it('引用扫描识别严格解码失败但 cardId 明确的文件', async () => {
    const cardId = '受保护角色-a1b2c3d4'
    await saveBinding(paths, makeBinding({ sessionId: 's-reference', cardId }))
    // 缺必填字段，loadBinding 会视为损坏，但 cardId 仍足以证明它是删除引用。
    await writeFile(join(paths.sessions, 's-partial.json'), JSON.stringify({ sessionId: 's-partial', cardId }), 'utf8')
    await writeFile(join(paths.sessions, 's-unrelated.json'), JSON.stringify({ sessionId: 's-unrelated', cardId: 'other-card' }), 'utf8')
    await writeFile(join(paths.sessions, 's-unreadable-json.json'), '{broken', 'utf8')

    const scan = await listBindingReferencesForCard(paths, cardId)
    expect(scan.sessionIds).toEqual(['s-partial', 's-reference'])
    expect(scan.corruptFiles).toEqual(expect.arrayContaining([
      's-broken.json',
      's-corrupt.json',
      's-file.json',
      's-partial.json',
      's-unreadable-json.json',
      's-unrelated.json',
    ]))
  })

  it('引用扫描拒绝非普通 JSON 与符号链接，且绝不读取链接的外部目标', async () => {
    const cardId = '链接保护角色-a1b2c3d4'
    const directoryName = '伪装目录.json'
    const linkName = '外部绑定.json'
    const external = join(root, 'external-binding.json')
    await mkdir(join(paths.sessions, directoryName))
    await writeFile(external, JSON.stringify(makeBinding({ sessionId: 'external-session', cardId })), 'utf8')

    try {
      await symlink(external, join(paths.sessions, linkName), 'file')
    } catch (error) {
      // Windows 未启用开发者模式时普通用户可能不能创建符号链接；目录边界仍照常验证。
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        const scan = await listBindingReferencesForCard(paths, cardId)
        expect(scan.corruptFiles).toContain(directoryName)
        return
      }
      throw error
    }

    const scan = await listBindingReferencesForCard(paths, cardId)
    expect(scan.corruptFiles).toEqual(expect.arrayContaining([directoryName, linkName]))
    // 若错误地跟随链接，外部 JSON 会把这个 sessionId 当成目标角色引用。
    expect(scan.sessionIds).not.toContain('external-session')
  })

  it('大小写扩展名与超限绑定都不能绕过永久删除预检', async () => {
    const cardId = '扩展名保护角色-a1b2c3d4'
    await writeFile(join(paths.sessions, 's-uppercase.JSON'), JSON.stringify(makeBinding({
      sessionId: 's-uppercase', cardId,
    })), 'utf8')
    const oversized = join(paths.sessions, 'oversized.json')
    await writeFile(oversized, '')
    await truncate(oversized, 1024 * 1024 + 1)

    const scan = await listBindingReferencesForCard(paths, cardId)
    expect(scan.sessionIds).toContain('s-uppercase')
    expect(scan.corruptFiles).toContain('oversized.json')
    // POSIX 上大小写不同的文件名与 sessionFile 不一致，会额外记为损坏；
    // Windows 上则是同一路径。两者都已通过 sessionIds 阻断删除。
    if (process.platform !== 'win32') expect(scan.corruptFiles).toContain('s-uppercase.JSON')
  })

  it('引用扫描按宿主文件系统区分角色 ID 大小写，损坏引用使用相同口径', async () => {
    const cardId = 'case-sensitive-card-a1b2c3d4'
    await saveBinding(paths, makeBinding({ sessionId: 's-card-case', cardId: cardId.toUpperCase() }))
    await writeFile(join(paths.sessions, 's-card-case-partial.json'), JSON.stringify({
      sessionId: 's-card-case-partial', cardId: cardId.toUpperCase(),
    }), 'utf8')

    const scan = await listBindingReferencesForCard(paths, cardId)
    expect(scan.sessionIds).toEqual(process.platform === 'win32' ? ['s-card-case', 's-card-case-partial'] : [])
    expect(scan.corruptFiles).toContain('s-card-case-partial.json')
  })
})

it('主书继承开关与附加书保存时严格校验，旧绑定缺省仍沿用内嵌书',async()=>{
  const {parseSessionBinding}=await import('../src/node/bindings.js')
  const base={sessionId:'s',cardId:'card-test1234',presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()}
  expect(parseSessionBinding(base).useEmbeddedLorebook).toBeUndefined()
  expect(parseSessionBinding({...base,useEmbeddedLorebook:false,characterLorebookIds:['one','one','two']})).toMatchObject({useEmbeddedLorebook:false,characterLorebookIds:['one','two']})
  expect(()=>parseSessionBinding({...base,useEmbeddedLorebook:'false'})).toThrow()
  expect(()=>parseSessionBinding({...base,characterLorebookIds:[1]})).toThrow()
})
