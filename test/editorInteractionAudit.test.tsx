/** 编辑交互回归：模拟世界书请求乱序与正则刷新失败，验证选中目标、保存基线和继续编辑的保护。 */
import { useState, type ReactNode } from 'react'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DraftScope } from '../src/client/drafts.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { LorebooksSection } from '../src/client/panel/lorebooks.js'
import { LorebookEditor } from '../src/client/panel/lorebookEditor.js'
import { RegexSection } from '../src/client/panel/regex.js'
import { Btn, ConfirmDialog } from '../src/client/util.js'
import type { Envelope, TavernRemote } from '../src/client/types.js'
import type { RegexRule } from '../src/core/types.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null,
  IconChevronDownOutline14: () => null, IconSearchOutline16: () => null, IconUserOutline16: () => null,
  IconDownloadOutline16: () => null, IconEditOutline16: () => null, IconFolderOpenOutline16: () => null,
  IconTrashOutline16: () => null, IconPlusOutline16: () => null,
}))

const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })
const fail = (message: string) => ({ ok: false as const, error: { code: 'test', message } })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const mounted: ReactTestRenderer[] = []
async function render(node: ReactNode) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(node) })
  mounted.push(view)
  return view
}
function button(view: ReactTestRenderer, label: string) {
  return view.root.findAllByType(Btn).find((item) => item.props.children === label)!
}
async function click(view: ReactTestRenderer, label: string) {
  await act(async () => button(view, label).props.onClick())
}
beforeEach(() => setTavernLocale('zh'))
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()) })

describe('世界书打开请求', () => {
  function fixture() {
    const first = deferred<Envelope<{ json: unknown }>>()
    const second = deferred<Envelope<{ name: string; json: unknown; entryCount: number }>>()
    const remote = {
      listLorebooks: async () => ok({ items: ['港口'] }),
      listCharacters: async () => ok({ items: [{ cardId: 'lighthouse', name: '守望者', hasAvatar: false,
        hasCharacterBook: true, characterBookName: '灯塔', characterBookEntryCount: 0 }] }),
      getLorebook: vi.fn(() => first.promise), getCharacterLorebook: vi.fn(() => second.promise),
    } as unknown as TavernRemote
    return { remote, first, second }
  }
  async function open(view: ReactTestRenderer, name: string) {
    const tile = view.root.findAllByProps({ className: 'dsh-tavern-tile' }).find((item) =>
      item.findByProps({ className: 'dsh-tavern-tileName' }).children.join('') === name)!
    await act(async () => tile.props.onClick())
  }

  it('先点库文件再点内嵌书，旧请求迟到不切回旧书或丢弃已编辑的条目', async () => {
    const f = fixture(), view = await render(<LorebooksSection remote={f.remote} />)
    await open(view, '港口')
    await open(view, '灯塔')
    await act(async () => f.second.resolve(ok({ name: '灯塔', json: { entries: {} }, entryCount: 0 })))
    await click(view, '新建条目')
    const input = view.root.findAllByType('input').find((item) => item.props.placeholder === '给自己看的名字，例如「主角身世」')!
    await act(async () => input.props.onChange({ target: { value: '未保存的灯塔设定' } }))
    await act(async () => f.first.resolve(ok({ json: { entries: {} } })))
    expect(view.root.findByType(LorebookEditor).props.target).toEqual({ kind: 'character', cardId: 'lighthouse', name: '灯塔' })
    expect(view.root.findAllByType('input').some((item) => item.props.value === '未保存的灯塔设定')).toBe(true)
  })

  it('旧请求先完成时仍等待最后选择，不提前打开错误的书', async () => {
    const f = fixture(), view = await render(<LorebooksSection remote={f.remote} />)
    await open(view, '港口')
    await open(view, '灯塔')
    await act(async () => f.first.resolve(ok({ json: { entries: {} } })))
    expect(view.root.findAllByType(LorebookEditor)).toHaveLength(0)
    await act(async () => f.second.resolve(ok({ name: '灯塔', json: { entries: {} }, entryCount: 0 })))
    expect(view.root.findByType(LorebookEditor).props.target.name).toBe('灯塔')
  })

  it('最新请求失败后显示该错误，旧请求失败不会覆盖错误或阻止重试', async () => {
    const f = fixture(), view = await render(<LorebooksSection remote={f.remote} />)
    await open(view, '港口')
    await open(view, '灯塔')
    await act(async () => f.second.resolve(fail('灯塔读取失败')))
    await act(async () => f.first.reject(new Error('过时的港口错误')))
    expect(JSON.stringify(view.toJSON())).toContain('灯塔读取失败')
    expect(JSON.stringify(view.toJSON())).not.toContain('过时的港口错误')
    remoteRetry(f.remote)
    await open(view, '灯塔')
    expect(view.root.findByType(LorebookEditor).props.target.name).toBe('灯塔')
  })

  it('取消加载后迟到结果不再打开编辑器，重新选择可正常读取', async () => {
    const f = fixture(), view = await render(<LorebooksSection remote={f.remote} />)
    await open(view, '港口')
    expect(JSON.stringify(view.toJSON())).toContain('正在打开「港口」')
    await click(view, '取消')
    await act(async () => f.first.resolve(ok({ json: { entries: {} } })))
    expect(view.root.findAllByType(LorebookEditor)).toHaveLength(0)
    expect(JSON.stringify(view.toJSON())).not.toContain('正在打开')
    remoteRetry(f.remote)
    await open(view, '灯塔')
    expect(view.root.findByType(LorebookEditor).props.target.name).toBe('灯塔')
  })

  /** 真实文件系统与 remote 适配器集成：迟到读取之后保存，只修改最后点选的内嵌书。 */
  it('乱序打开后保存写入正确的书文件，原库文件保持原样', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tavern-editor-interaction-'))
    try {
      const libraryPath = join(directory, 'library.json'), embeddedPath = join(directory, 'embedded.json')
      const original = JSON.stringify({ entries: {} })
      await writeFile(libraryPath, original, 'utf8')
      await writeFile(embeddedPath, original, 'utf8')
      const f = fixture(), gate = deferred<void>(), libraryReady = deferred<void>(), embeddedReady = deferred<void>(), savedReady = deferred<void>()
      f.remote.getLorebook = async () => {
        await gate.promise
        const json: unknown = JSON.parse(await readFile(libraryPath, 'utf8'))
        libraryReady.resolve()
        return ok({ json })
      }
      f.remote.getCharacterLorebook = async () => {
        const json: unknown = JSON.parse(await readFile(embeddedPath, 'utf8'))
        embeddedReady.resolve()
        return ok({ name: '灯塔', entryCount: 0, json })
      }
      f.remote.saveCharacterLorebook = vi.fn(async ({ cardId, json }) => {
        expect(cardId).toBe('lighthouse')
        await writeFile(embeddedPath, JSON.stringify(json), 'utf8')
        savedReady.resolve()
        return ok({ name: '灯塔', entryCount: 1 })
      })
      const view = await render(<LorebooksSection remote={f.remote} />)
      await open(view, '港口')
      await open(view, '灯塔')
      await act(async () => embeddedReady.promise)
      await click(view, '新建条目')
      const input = view.root.findAllByType('input').find((item) => item.props.placeholder === '给自己看的名字，例如「主角身世」')!
      await act(async () => input.props.onChange({ target: { value: '只属于灯塔的设定' } }))
      await act(async () => { gate.resolve(); await libraryReady.promise })
      expect(view.root.findByType(LorebookEditor).props.target.name).toBe('灯塔')
      await click(view, '保存')
      await act(async () => savedReady.promise)
      expect(f.remote.saveCharacterLorebook).toHaveBeenCalledOnce()
      expect(await readFile(libraryPath, 'utf8')).toBe(original)
      expect(await readFile(embeddedPath, 'utf8')).toContain('只属于灯塔的设定')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  function remoteRetry(remote: TavernRemote) {
    vi.mocked(remote.getCharacterLorebook).mockResolvedValueOnce(ok({ name: '灯塔', json: { entries: {} }, entryCount: 0 }))
  }
})

/** 手写规则与延迟 remote；通过真实 DraftScope 的离开确认判断编辑状态。 */
function rule(name: string): RegexRule {
  return { id: 'rule-a', name, find: 'old', replace: 'new', enabled: true, scopes: ['output'],
    timing: ['render'], minDepth: null, maxDepth: null, substituteRegex: 0, source: 'user' }
}
function RegexHarness(props: { remote: TavernRemote }) {
  const [left, setLeft] = useState(false)
  return left ? <span>已离开正则页</span> : <DraftScope>{(request) => <>
    <Btn onClick={() => request(() => setLeft(true))}>离开正则页</Btn>
    <RegexSection remote={props.remote} />
  </>}</DraftScope>
}
function regexFixture() {
  let rules = [rule('初始规则')]
  const listRegexRules = vi.fn(async () => ok({ rules: structuredClone(rules) }))
  const saveRegexRules = vi.fn(async (request: { rules: RegexRule[] }) => {
    rules = structuredClone(request.rules)
    return ok({ count: rules.length })
  })
  const remote = { listRegexRules, saveRegexRules, listPresets: async () => ok({ items: [] }) } as unknown as TavernRemote
  return { remote, listRegexRules, saveRegexRules, setServer: (next: RegexRule[]) => { rules = next } }
}
async function renameRule(view: ReactTestRenderer, name: string) {
  await act(async () => view.root.findAllByType('input')[0]!.props.onChange({ target: { value: name } }))
}

describe('正则刷新与保存', () => {
  it('保存后从服务器刷新新版本，刷新结果应是干净基线', async () => {
    const f = regexFixture(), view = await render(<RegexHarness remote={f.remote} />)
    await renameRule(view, '已保存规则')
    await click(view, '保存全部')
    f.setServer([rule('外部更新规则')])
    await click(view, '放弃更改并刷新')
    expect(view.root.findAllByType('input')[0]!.props.value).toBe('外部更新规则')
    await click(view, '离开正则页')
    expect(JSON.stringify(view.toJSON())).toContain('已离开正则页')
    expect(view.root.findAllByType(ConfirmDialog).some((dialog) => dialog.props.open)).toBe(false)
  })

  it('保存尚未完成时不能刷新旧服务器内容；允许的新输入仍作为草稿保留', async () => {
    const f = regexFixture(), view = await render(<RegexHarness remote={f.remote} />)
    const pending = deferred<Envelope<{ count: number }>>()
    f.saveRegexRules.mockImplementationOnce(() => pending.promise)
    await renameRule(view, '本次提交')
    await click(view, '保存全部')
    expect(button(view, '放弃更改并刷新').props.disabled).toBe(true)
    await click(view, '放弃更改并刷新')
    expect(f.listRegexRules).toHaveBeenCalledTimes(1)
    await renameRule(view, '保存期间继续编辑')
    await act(async () => pending.resolve(ok({ count: 1 })))
    expect(view.root.findAllByType('input')[0]!.props.value).toBe('保存期间继续编辑')
    await click(view, '离开正则页')
    expect(view.root.findAllByType(ConfirmDialog).some((dialog) => dialog.props.open)).toBe(true)
  })

  it('第一次读取失败时可以就地重试，不必切换整个面板', async () => {
    const f = regexFixture()
    f.listRegexRules.mockResolvedValueOnce(fail('规则读取失败'))
    const view = await render(<RegexHarness remote={f.remote} />)
    expect(JSON.stringify(view.toJSON())).toContain('规则读取失败')
    expect(button(view, '重试')).toBeDefined()
    await click(view, '重试')
    expect(view.root.findAllByType('input')[0]!.props.value).toBe('初始规则')
  })

  it('预设详情读取失败明确显示错误，重试后列出实际存在的预设正则', async () => {
    const f = regexFixture()
    f.remote.listPresets = async () => ok({ items: [{ id: 'preset-a', name: '展示预设', regexCount: 1 }] })
    f.remote.getPreset = vi.fn(async () => fail('预设暂时不可读'))
    const view = await render(<RegexHarness remote={f.remote} />)
    expect(JSON.stringify(view.toJSON())).toContain('预设暂时不可读')
    expect(JSON.stringify(view.toJSON())).not.toContain('没有预设携带正则')
    vi.mocked(f.remote.getPreset).mockResolvedValueOnce(ok({ preset: { identifier: 'preset-a', name: '展示预设', entries: [],
      regexScripts: [{ id: 'script-a', scriptName: '状态栏规则', findRegex: 'status', replaceString: '' }] } }))
    await click(view, '重试')
    expect(JSON.stringify(view.toJSON())).toContain('状态栏规则')
    expect(JSON.stringify(view.toJSON())).not.toContain('预设暂时不可读')
  })
})
