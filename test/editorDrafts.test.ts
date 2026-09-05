/**
 * 编辑器草稿契约与真实文件系统测试：使用手写内容验证重启恢复、作用域隔离、
 * 路径/JSON 边界、损坏与超限拒绝，以及并发写读删除的完整顺序；不访问真实用户数据。
 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { METHODS } from '../src/remote.js'
import { resolveConfig, type TavernConfigRaw } from '../src/node/config.js'
import { EDITOR_DRAFT_MAX_BYTES, deleteEditorDraft, getEditorDraft, saveEditorDraft } from '../src/node/editorDrafts.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'

let root: string
const owner = 'test-browser-owner'
const key = 'character:example:details'
const request = { owner, key }

function filename(draftOwner = owner, draftKey = key): string {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  return join(root, 'editor-drafts', hash(draftOwner), `${hash(draftKey)}.json`)
}

function service(): TavernService {
  const state = new TavernState({
    root, characters: join(root, 'characters'), lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'), personas: join(root, 'personas'),
    regexDir: join(root, 'regex'), sessions: join(root, 'sessions'),
  }, () => resolveConfig({}))
  const ctx = { reflect: { provide: () => {} } } as unknown as Context
  return new TavernService(ctx, state, {} as SettingsScope<TavernConfigRaw>)
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tavern-editor-drafts-test-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('编辑草稿独立存储', () => {
  it('remote 返回裸结果，重建 service 后恢复原草稿，删除幂等且只创建独立草稿目录', async () => {
    expect(await service().getEditorDraft(request)).toEqual({ draft: null })
    const value = { version: 1, text: '第一行\n第二行', enabled: false, nested: [{ name: '测试', value: null }] }
    expect(await service().saveEditorDraft({ ...request, value })).toEqual({ saved: true })
    const restored = await service().getEditorDraft(request)
    expect(restored.draft?.value).toEqual(value)
    expect(new Date(restored.draft!.updatedAt).toISOString()).toBe(restored.draft!.updatedAt)
    expect(await readdir(root)).toEqual(['editor-drafts'])
    expect(await service().deleteEditorDraft(request)).toEqual({ deleted: true })
    expect(await service().deleteEditorDraft(request)).toEqual({ deleted: true })
    expect(await service().getEditorDraft(request)).toEqual({ draft: null })
  })

  it('不同 owner、角色和剧情 key 相互隔离；带路径字符的 key 只生成哈希文件名', async () => {
    const scopes = [
      { owner, key: '../../characters/card.json' },
      { owner: 'another-browser', key: '../../characters/card.json' },
      { owner, key: 'memory:card:story-one' },
      { owner, key: 'memory:card:story-two' },
    ]
    await Promise.all(scopes.map((scope, index) => service().saveEditorDraft({ ...scope, value: { text: `draft-${index}` } })))
    for (const [index, scope] of scopes.entries()) {
      expect((await service().getEditorDraft(scope)).draft?.value).toEqual({ text: `draft-${index}` })
      expect(JSON.parse(await readFile(filename(scope.owner, scope.key), 'utf8')).value).toEqual({ text: `draft-${index}` })
    }
    expect(await readdir(root)).toEqual(['editor-drafts'])
    await service().deleteEditorDraft(scopes[0]!)
    expect((await service().getEditorDraft(scopes[1]!)).draft?.value).toEqual({ text: 'draft-1' })
  })

  it('请求验参拒绝非法 owner/key，服务直接调用同样拒绝且不创建文件', async () => {
    for (const invalidOwner of ['../escape', '/absolute/path', 'C:\\outside', 'tiny', 'x'.repeat(81)]) {
      expect(() => METHODS.saveEditorDraft.req.parse({ owner: invalidOwner, key, value: {} })).toThrow()
      await expect(saveEditorDraft(root, invalidOwner, key, {})).rejects.toThrow('浏览器标识')
      await expect(getEditorDraft(root, invalidOwner, key)).rejects.toThrow('浏览器标识')
      await expect(deleteEditorDraft(root, invalidOwner, key)).rejects.toThrow('浏览器标识')
    }
    for (const invalidKey of ['', 'x'.repeat(301), '\0']) {
      await expect(service().saveEditorDraft({ owner, key: invalidKey, value: {} })).rejects.toThrow('编辑器标识')
      await expect(service().getEditorDraft({ owner, key: invalidKey })).rejects.toThrow('编辑器标识')
    }
    expect(await readdir(root)).toEqual([])
  })

  it('只接受普通 JSON 对象，拒绝循环、污染字段、访问器及会被静默转换的数据', async () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    let getterCalls = 0
    const accessor = Object.defineProperty({}, 'text', { enumerable: true, get() { getterCalls++; return 'unexpected' } })
    const extraArray = Object.assign(['one'], { extra: 'ignored' })
    const values: unknown[] = [null, [], 'text', new Date(), { missing: undefined }, { number: NaN },
      { number: Infinity }, { bigint: 1n }, { callback: () => '' }, { symbol: Symbol('x') },
      { nested: JSON.parse('{"__proto__":{"polluted":true}}') }, { constructor: {} }, { nested: { prototype: {} } },
      { date: new Date() }, { hole: new Array(1) }, { extra: extraArray }, accessor, cycle,
      { [Symbol('hidden')]: 'ignored' }, Object.defineProperty({}, 'hidden', { value: 'ignored' }),
    ]
    for (const value of values) await expect(service().saveEditorDraft({ ...request, value })).rejects.toThrow('编辑草稿无效')
    expect(getterCalls).toBe(0)
    expect(await readdir(root)).toEqual([])
    await service().saveEditorDraft({ ...request, value: Object.assign(Object.create(null) as object, { text: 'plain' }) })
    expect((await service().getEditorDraft(request)).draft?.value).toEqual({ text: 'plain' })
  })

  it('超量和过深正文失败后保留原草稿，字节预算包含 UTF-8 与 JSON 转义', async () => {
    await saveEditorDraft(root, owner, key, { text: 'original' })
    let nested: object = {}
    for (let index = 0; index < 150; index++) nested = { next: nested }
    for (const value of [{ text: '汉'.repeat(EDITOR_DRAFT_MAX_BYTES / 2) },
      { text: '\n'.repeat(EDITOR_DRAFT_MAX_BYTES / 2) }, nested]) {
      await expect(saveEditorDraft(root, owner, key, value)).rejects.toThrow('编辑草稿无效')
      expect((await getEditorDraft(root, owner, key))?.value).toEqual({ text: 'original' })
    }
    expect((await readdir(join(filename(), '..'))).every((name) => name.endsWith('.json'))).toBe(true)
  })

  it('损坏、超量、污染和错误版本的磁盘数据明确失败，允许显式删除损坏草稿', async () => {
    await saveEditorDraft(root, owner, key, {})
    const now = new Date().toISOString()
    for (const contents of ['{broken', 'x'.repeat(EDITOR_DRAFT_MAX_BYTES + 1),
      JSON.stringify({ version: 2, updatedAt: now, value: {} }),
      JSON.stringify({ version: 1, updatedAt: 'yesterday', value: {} }),
      `{"version":1,"updatedAt":"${now}","value":{"nested":{"__proto__":{}}}}`]) {
      await writeFile(filename(), contents)
      await expect(service().getEditorDraft(request)).rejects.toThrow('编辑草稿无效')
    }
    await expect(service().deleteEditorDraft(request)).resolves.toEqual({ deleted: true })
    expect((await service().getEditorDraft(request)).draft).toBeNull()
  })

  it('同 key 并发写读删除按调用顺序串行，读不到部分 JSON，失败不阻塞后续操作', async () => {
    const operations: Promise<unknown>[] = []
    for (let index = 0; index < 20; index++) {
      operations.push(service().saveEditorDraft({ ...request, value: { index, text: 'content'.repeat(index + 1) } }))
      operations.push(service().getEditorDraft(request).then((result) => {
        expect(result.draft?.value).toEqual({ index, text: 'content'.repeat(index + 1) })
      }))
      if (index % 4 === 0) {
        operations.push(service().deleteEditorDraft(request))
        operations.push(service().getEditorDraft(request).then((result) => expect(result.draft).toBeNull()))
      }
    }
    await Promise.all(operations)
    await expect(service().saveEditorDraft({ ...request, value: null })).rejects.toThrow()
    await service().saveEditorDraft({ ...request, value: { final: true } })
    expect((await service().getEditorDraft(request)).draft?.value).toEqual({ final: true })
  })

  it('排队前冻结内容，调用方后续修改对象不会改变已提交草稿', async () => {
    const value = { text: 'captured', nested: { enabled: true } }
    const pending = saveEditorDraft(root, owner, key, value)
    value.text = 'changed'
    value.nested.enabled = false
    await pending
    expect((await getEditorDraft(root, owner, key))?.value).toEqual({ text: 'captured', nested: { enabled: true } })
  })
})
