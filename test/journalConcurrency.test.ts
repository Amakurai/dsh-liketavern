/** 笔记编辑并发集成：真实文件系统与 TavernService 验证旧窗口、并发保存及剧情写入不能静默覆盖新正文。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'
import { TavernService } from '../src/node/service.js'
import { jsonEditRevision } from '../src/state/characterRevision.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string, state: TavernState, service: TavernService, cardId: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-journal-concurrency-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  cardId = (await state.createCharacter('笔记工厂角色')).cardId
  service = new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state, {} as TavernSettingsScope)
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

it('两个窗口读取相同笔记后，旧窗口不能覆盖另一窗口刚保存的正文', async () => {
  await state.saveJournal(cardId, '原始笔记')
  const first = await service.getJournal({ cardId }), second = await service.getJournal({ cardId })
  const initial = { cardId, text: '第一窗口已确认的新笔记', expectedRevision: jsonEditRevision(first.text) }
  await service.saveJournal(initial)
  const stale = { cardId, text: '第二窗口仍基于旧内容的修改', expectedRevision: jsonEditRevision(second.text) }
  await expect(service.saveJournal(stale)).rejects.toThrow(/笔记.*修改|版本|修订/)
  expect((await service.getJournal({ cardId })).text).toBe('第一窗口已确认的新笔记')
})

it('同版本并发保存只有一个成功，失败不会清除成功正文', async () => {
  const baseline = await service.getJournal({ cardId })
  const requests = ['并发笔记 A', '并发笔记 B'].map(text => ({ cardId, text, expectedRevision: jsonEditRevision(baseline.text) }))
  const results = await Promise.allSettled(requests.map(request => service.saveJournal(request)))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  const winner = results.findIndex(result => result.status === 'fulfilled')
  expect((await service.getJournal({ cardId })).text).toBe(requests[winner]!.text)
})

it('读后剧情工具改写笔记，编辑保存应拒绝并保留剧情中的新内容', async () => {
  const baseline = await service.getJournal({ cardId })
  const { fs } = await state.plainWorkspace(cardId)
  await fs.writeText('journal.md', '剧情中刚记录的新笔记')
  const stale = { cardId, text: '窗口中的旧稿', expectedRevision: jsonEditRevision(baseline.text) }
  await expect(service.saveJournal(stale)).rejects.toThrow(/笔记.*修改|版本|修订/)
  expect(await fs.readText('journal.md')).toBe('剧情中刚记录的新笔记')
})

it('缺少版本不能覆盖旧笔记，连空白笔记也必须先读取', async () => {
  await expect(service.saveJournal({ cardId, text: '缺少版本的写入' })).rejects.toThrow(/缺少.*版本/)
  expect((await service.getJournal({ cardId })).text).toBe('')
  await state.saveJournal(cardId, '需要保留的笔记')
  await expect(service.saveJournal({ cardId, text: '遗留窗口旧稿' })).rejects.toThrow(/缺少.*版本/)
  expect((await service.getJournal({ cardId })).text).toBe('需要保留的笔记')
})

it('正文落盘后索引失败，同一保存可重试收口并继续用新版本编辑', async () => {
  const initial = await service.getJournal({ cardId }), original = WorkspaceFs.prototype.writeText
  let failing = true
  vi.spyOn(WorkspaceFs.prototype, 'writeText').mockImplementation(async function (this: WorkspaceFs, path, text) {
    if (path === 'index.json' && failing) throw new Error('工厂索引写入失败')
    return original.call(this, path, text)
  })
  const request = { cardId, text: '正文已落盘的新笔记', expectedRevision: jsonEditRevision(initial.text) }
  await expect(service.saveJournal(request)).rejects.toThrow('工厂索引写入失败')
  expect((await service.getJournal({ cardId })).text).toBe(request.text)
  failing = false
  const saved = await service.saveJournal(request)
  const read = await service.getJournal({ cardId })
  expect(read.revision).toBe(saved.revision)
  expect(await service.saveJournal({ cardId, text: '下一次编辑', expectedRevision: saved.revision })).toEqual({ saved: true, revision: jsonEditRevision('下一次编辑') })
})

it('每个剧情与初始状态独立校验版本，面板保存不进入正在生成的楼层 WAL', async () => {
  await state.saveJournal(cardId, '新剧情初始笔记')
  const stories: string[] = []
  for (const sessionId of ['journal-story-a', 'journal-story-b']) {
    await state.saveBinding({ sessionId, cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null,
      interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    stories.push((await state.loadStoryBinding(sessionId))!.storyId!)
  }
  const first = { cardId, storyId: stories[0]! }, second = { cardId, storyId: stories[1]! }
  const firstRead = await service.getJournal(first), secondRead = await service.getJournal(second)
  const workspace = await state.storyWorkspace(cardId, first.storyId), floor = 'journal-story-a#t1'
  await workspace.wal.beginFloor(floor)
  state.openFloors.set('journal-story-a', { cardId, storyId: first.storyId, floor })
  await service.saveJournal({ ...first, text: '剧情 A 的手动笔记', expectedRevision: firstRead.revision })
  await service.saveJournal({ ...second, text: '剧情 B 的手动笔记', expectedRevision: secondRead.revision })
  await workspace.wal.commitFloor(floor)
  expect(await workspace.wal.rollbackFloor(floor, workspace.fs.root)).toEqual([])
  expect((await service.getJournal(first)).text).toBe('剧情 A 的手动笔记')
  expect((await service.getJournal(second)).text).toBe('剧情 B 的手动笔记')
  expect((await service.getJournal({ cardId })).text).toBe('新剧情初始笔记')
})

it('保存回执版本必须对应 UTF-8 文件中的实际正文', async () => {
  const initial = await service.getJournal({ cardId })
  const saved = await service.saveJournal({ cardId, text: '不可配对的代理项\ud800', expectedRevision: initial.revision })
  expect((await service.getJournal({ cardId })).revision).toBe(saved.revision)
})
