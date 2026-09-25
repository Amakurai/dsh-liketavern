/** 角色检索行为：真实资产列表保留作者与标签，管理页/选择器共用搜索口径并兼容旧列表，不扫描剧情正文。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CharacterPicker } from '../src/client/characterPicker.js'
import { CharactersSection } from '../src/client/panel/characters.js'
import { Btn, SearchInput } from '../src/client/util.js'
import { setTavernLocale } from '../src/client/i18n.js'
import type { CharacterDetail, CharacterSummary, TavernRemote } from '../src/client/types.js'
import { createBlankCard } from '../src/state/card.js'
import { archiveCharacter, importCard, listArchivedCharacters, listCharacters } from '../src/state/workspace.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Modal: (props: { open: boolean; children?: ReactNode }) => props.open ? <div>{props.children}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: () => null, Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
  IconArchiveOutlineMedium: () => null, IconDownloadOutlineMedium: () => null, IconRefreshOutlineMedium: () => null,
  IconTrashOutlineMedium: () => null, IconEditOutlineMedium: () => null, IconCopyOutlineMedium: () => null,
}))

const mounted: ReactTestRenderer[] = []
beforeEach(() => setTavernLocale('zh'))
afterEach(async () => {
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
})

it('活动与收纳列表读取已有角色的作者和标签，无作者标签的角色返回空值', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-character-search-'))
  try {
    const card = { ...createBlankCard('灯塔守望者'), creator: 'Harbor Studio', tags: ['悬疑', 'Sci-Fi'] }
    const { cardId } = await importCard(root, card)
    expect(await listCharacters(root)).toEqual([expect.objectContaining({ cardId, creator: card.creator, tags: card.tags })])
    await archiveCharacter(root, cardId)
    expect(await listCharacters(root)).toEqual([])
    expect(await listArchivedCharacters(root)).toEqual([expect.objectContaining({ cardId, creator: card.creator, tags: card.tags })])
    const blank = await importCard(root, createBlankCard('未分类角色'))
    expect(await listCharacters(root)).toEqual([expect.objectContaining({ cardId: blank.cardId, creator: '', tags: [] })])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([{ tags: undefined }, { tags: null }, { tags: 42 }, { tags: ['悬疑', 42, null] }])('旧磁盘卡的异常标签 $tags 不隐藏角色或泄漏坏字段给搜索框', async ({ tags }) => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-legacy-search-'))
  try {
    const { cardId } = await importCard(root, createBlankCard('旧角色'))
    const path = join(root, cardId, 'card.json')
    const stored = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...stored, creator: { legacy: true }, tags }))
    const expected = { cardId, name: '旧角色', creator: '', tags: Array.isArray(tags) ? ['悬疑'] : [] }
    expect(await listCharacters(root)).toEqual([expect.objectContaining(expected)])
    await archiveCharacter(root, cardId)
    expect(await listArchivedCharacters(root)).toEqual([expect.objectContaining(expected)])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(['management', 'picker'] as const)('%s 支持标签/作者/书名搜索，大小写和首尾空白不影响结果，清除恢复全部', async (surface) => {
  const items: CharacterSummary[] = Array.from({ length: 6 }, (_, index) => ({
    cardId: `search-card-${index}`, name: `角色${index}`, hasAvatar: false,
    hasCharacterBook: index === 0, characterBookName: index === 0 ? '灯塔档案' : null, characterBookEntryCount: index === 0 ? 1 : 0,
    ...(index === 0 ? { creator: 'Harbor Studio', tags: ['悬疑', 'Sci-Fi', 'a+b'] } : {}),
  }))
  const remote = {
    listCharacters: async () => ({ ok: true, value: { items } }),
    getAvatar: async () => ({ ok: true, value: { dataUrl: null } }),
  } as unknown as TavernRemote
  let view!: ReactTestRenderer
  await act(async () => {
    view = create(surface === 'management' ? <CharactersSection remote={remote} />
      : <CharacterPicker remote={remote} busy={false} error={null} onPick={() => {}} onClose={() => {}} />)
  })
  mounted.push(view)
  const cards = () => view.root.findAll((node) => typeof node.type === 'string'
    && typeof node.props.className === 'string'
    && node.props.className.split(' ').includes(surface === 'management' ? 'dsh-tavern-charCard' : 'dsh-tavern-pickerItem'))
  expect(cards()).toHaveLength(6)
  for (const query of ['悬疑', '  SCI-FI  ', 'harbor', '灯塔档案', 'a+b', '角色0']) {
    await act(async () => view.root.findByType(SearchInput).props.onChange(query))
    expect(cards(), query).toHaveLength(1)
    const name = surface === 'management' ? cards()[0]!.findByProps({ className: 'dsh-tavern-charCardName' }) : cards()[0]!.findByType('strong')
    expect(name.children.join('')).toBe('角色0')
  }
  await act(async () => view.root.findByType(SearchInput).props.onChange('未命中'))
  expect(cards()).toHaveLength(0)
  await act(async () => view.root.findByType(SearchInput).props.onChange(''))
  expect(cards()).toHaveLength(6)
})

it('角色详情读取失败时保留弹窗和重试入口，恢复后显示真实字段', async () => {
  const item: CharacterSummary = {
    cardId: 'detail-retry-card', name: '灯塔', hasAvatar: false,
    hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0,
  }
  const detail: CharacterDetail = {
    ...item, revision: 'revision', description: '海边守望者', personality: '', scenario: '', firstMes: '',
    alternateGreetings: [], mesExample: '', systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', creator: '',
    characterVersion: '', tags: [], spec: 'chara_card_v2', depthPrompt: null, extensions: {},
  }
  const getCharacterDetail = vi.fn()
    .mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: '角色详情暂时不可用' } })
    .mockResolvedValue({ ok: true, value: detail })
  const remote = {
    listCharacters: async () => ({ ok: true, value: { items: [item] } }),
    getCharacterDetail,
    getAvatar: async () => ({ ok: true, value: { dataUrl: null } }),
  } as unknown as TavernRemote
  let view!: ReactTestRenderer
  await act(async () => { view = create(<CharactersSection remote={remote} />) })
  mounted.push(view)
  const card = view.root.findByProps({ className: 'dsh-tavern-charCard' })
  await act(async () => card.props.onClick())
  expect(JSON.stringify(view.toJSON())).toContain('角色详情暂时不可用')
  const retry = view.root.findAllByType(Btn).find(button => button.props.children === '重试')
  expect(retry).toBeDefined()
  await act(async () => retry!.props.onClick())
  expect(getCharacterDetail).toHaveBeenCalledTimes(2)
  expect(view.root.findByProps({ value: '海边守望者' })).toBeDefined()
})
