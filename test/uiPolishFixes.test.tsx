/**
 * UI/UX 体验修复回归：覆盖 overlay 写保护指引、即时偏好不触发草稿暂存、单状态条布局、
 * 角色导入预检语义按钮/置顶说明/三档徽标、提示词预览按钮加载态、世界书条目数与编辑器去重、人设首建收敛与 FileBtn 尺寸对齐。
 */
import type { ComponentProps, ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TavernPanel } from '../src/client/panel/index.js'
import { CharactersSection } from '../src/client/panel/characters.js'
import { LorebooksSection } from '../src/client/panel/lorebooks.js'
import { LorebookEditor } from '../src/client/panel/lorebookEditor.js'
import { PersonasSection } from '../src/client/panel/personas.js'
import { TavernHeaderChip, defaultBinding } from '../src/client/chip.js'
import { TavernSeatChip } from '../src/client/seatChip.js'
import { invalidateSessionBinding } from '../src/client/cache.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { setSpeakerHeader } from '../src/client/displayPrefs.js'
import { formatSettingsWriteError, isSettingsOverlayProtectedError } from '../src/client/settingsPatch.js'
import { ensureTavernStyles } from '../src/client/styles.js'
import { Btn, Dialog, FileBtn, Select, Tabs, Toggle } from '../src/client/util.js'
import { TavernConfigSchema, type TavernConfigRaw } from '../src/node/config.js'
import type { TavernRemote } from '../src/client/types.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'> & { size?: string; variant?: string }) => <button data-size={props.size} {...props} />,
  Modal: (props: { open: boolean; title?: string; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog" aria-label={props.title}><div data-body="">{props.children}</div><div data-footer="">{props.footer}</div></div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: () => null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  IconChevronDownOutlineMedium: () => null,
  IconSearchOutlineMedium: () => null,
  IconUserOutlineMedium: () => null,
  IconArchiveOutlineMedium: () => null,
  IconDownloadOutlineMedium: () => null,
  IconEditOutlineMedium: () => null,
  IconFolderOpenOutlineMedium: () => null,
  IconListPenOutlineMedium: () => null,
  IconPlusOutlineMedium: () => null,
  IconRefreshOutlineMedium: () => null,
  IconTrashOutlineMedium: () => null,
  IconCopyOutlineMedium: () => null,
}))
vi.mock('../src/client/helperScripts.js', () => ({ HelperScripts: () => null }))
vi.mock('../src/client/util.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/client/util.js')>(),
  fileToBase64: vi.fn(async (file: File) => Buffer.from(await file.arrayBuffer()).toString('base64')),
}))

const ok = <T,>(value: T) => ({ ok: true as const, value })
const mounted: ReactTestRenderer[] = []
async function render(node: ReactNode) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(node) })
  mounted.push(view)
  return view
}

beforeEach(() => {
  setTavernLocale('zh')
  setSpeakerHeader(false)
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    sessionStorage: { getItem: () => 'ui-polish-owner', setItem() {} },
  }))
})

afterEach(async () => {
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  setSpeakerHeader(false)
  vi.unstubAllGlobals()
})

describe('overlay 写保护错误格式化', () => {
  it('识别 home patch / command-line overlay 写保护并保留原错误，普通错误原样透传', () => {
    const raw = 'Configuration for "dsh-tavern" is overridden by a home patch or command-line overlay'
    expect(isSettingsOverlayProtectedError(raw)).toBe(true)
    expect(isSettingsOverlayProtectedError('连接中断')).toBe(false)
    setTavernLocale('zh')
    const zhMsg = formatSettingsWriteError(raw, t)
    expect(zhMsg).toContain('--patch')
    expect(zhMsg).toContain('只读保护')
    expect(zhMsg).toContain(raw)
    setTavernLocale('en')
    const enMsg = formatSettingsWriteError(raw, t)
    expect(enMsg).toContain('write-protected')
    expect(enMsg).toContain(raw)
    expect(formatSettingsWriteError('普通失败', t)).toBe('普通失败')
  })
})

describe('即时偏好与面板单状态条', () => {
  it('在 TavernPanel 切换语言与头像开关不触发 saveEditorDraft，不显示脏态/繁忙状态条', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let currentSettings: TavernConfigRaw = TavernConfigSchema({})
      const saveEditorDraft = vi.fn(async () => ok({ saved: true }))
      const updateSettings = vi.fn(async ({ patch }: { patch: Record<string, unknown> }) => {
        currentSettings = TavernConfigSchema({ ...currentSettings, ...patch })
        return ok({ settings: structuredClone(currentSettings) })
      })
      const remote = {
        getEditorDraft: vi.fn(async () => ok({ draft: null })),
        saveEditorDraft,
        deleteEditorDraft: vi.fn(async () => ok({ deleted: true })),
        listCharacters: async () => ok({ items: [] }),
        listArchivedCharacters: async () => ok({ items: [] }),
        getSettings: async () => ok({ settings: structuredClone(currentSettings) }),
        updateSettings,
        getDataInfo: async () => ok({ dataHome: 'test' }),
        listPresets: async () => ok({ items: [] }),
        listLorebooks: async () => ok({ items: [] }),
        listPersonas: async () => ok({ items: [] }),
      } as unknown as TavernRemote

      const view = await render(<TavernPanel remote={remote} />)
      const topTabs = view.root.findAllByType(Tabs).find((tabs) => tabs.props.label === t('settings.label'))!
      await act(async () => topTabs.props.onChange('sampling'))
      await act(async () => view.root.findByType(Select).props.onChange('en'))
      await act(async () => view.root.findByType(Toggle).props.onChange(true))
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })

      expect(updateSettings).toHaveBeenCalledTimes(2)
      expect(saveEditorDraft).not.toHaveBeenCalled()
      expect(view.root.findAllByProps({ className: 'dsh-tavern-draftStatus' })).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('角色卡导入预检弹窗', () => {
  it('明确区分仅导入角色卡/导入角色与世界书、说明固定在 footer 且三档状态均有语义徽标', async () => {
    const inspectCharacter = vi.fn(async () => ok({
      name: '灯塔守望者',
      hasCharacterBook: true,
      characterBookName: '港口志',
      entryCount: 3,
      compatibility: {
        findings: [
          { code: 'parent_access', status: 'unsupported', count: 1, locations: ['first_mes'] },
          { code: 'network', status: 'review', count: 1, locations: ['first_mes'] },
          { code: 'card_fields', status: 'supported', count: 2, locations: ['description', 'first_mes'] },
        ],
      },
    }))
    const remote = {
      listCharacters: async () => ok({ items: [] }),
      listArchivedCharacters: async () => ok({ items: [] }),
      inspectCharacter,
      importCharacter: vi.fn(async () => ok({ cardId: 'c1', name: '灯塔守望者' })),
      getAvatar: async () => ok({ dataUrl: null }),
    } as unknown as TavernRemote

    const view = await render(<CharactersSection remote={remote} />)
    const file = new File(['{}'], 'card.json', { type: 'application/json' })
    await act(async () => {
      view.root.findByType(FileBtn).props.onFile(file)
      await vi.waitFor(() => expect(inspectCharacter).toHaveBeenCalledOnce())
      for (let i = 0; i < 4; i++) await Promise.resolve()
    })

    const dialog = view.root.findAllByType(Dialog).find((d) => d.props.title === t('characters.importPreview.title'))!
    const footer = dialog.findByProps({ 'data-footer': '' })
    const footerNote = footer.findByProps({ className: 'dsh-tavern-compatibilityNote' })
    expect(footerNote.children.join('')).toBe(t('characters.importBook.skipNote'))
    const footerButtons = footer.findAllByType('button').map((b) => b.children.join(''))
    expect(footerButtons).toContain('仅导入角色卡')
    expect(footerButtons).toContain('导入角色与世界书')
    expect(dialog.findAllByProps({ className: 'dsh-tavern-compatBadge is-unsupported' })).toHaveLength(1)
    expect(dialog.findAllByProps({ className: 'dsh-tavern-compatBadge is-review' })).toHaveLength(1)
    expect(dialog.findAllByProps({ className: 'dsh-tavern-compatBadge is-supported' })).toHaveLength(1)
  })
})

describe('提示词预览按钮加载态', () => {
  it('previewPrompt 请求飞行期间按钮呈现加载态与 aria-busy，完成后恢复', async () => {
    const sessionId = 'session-preview-loading'
    invalidateSessionBinding(sessionId)
    const gate = Promise.withResolvers<Awaited<ReturnType<TavernRemote['previewPrompt']>>>()
    const previewPrompt = vi.fn(() => gate.promise)
    const binding = { ...defaultBinding(sessionId, 'card-1'), storyId: 'story-1' }
    const remote = {
      getSessionBinding: async () => ok({ binding, userName: '旅人', canSwipeGreeting: false, conversationStarted: true }),
      getCharacterDetail: async () => ok({ cardId: 'card-1', name: '灯塔', hasAvatar: false, hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0, revision: 'r1', description: '', personality: '', scenario: '', firstMes: '', alternateGreetings: [], mesExample: '', systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', creator: '', characterVersion: '', tags: [], spec: 'chara_card_v2', depthPrompt: null, extensions: {} }),
      getAvatar: async () => ok({ dataUrl: null }),
      listCharacters: async () => ok({ items: [] }),
      listArchivedCharacters: async () => ok({ items: [] }),
      listPresets: async () => ok({ items: [] }),
      listPersonas: async () => ok({ items: [] }),
      listLorebooks: async () => ok({ items: [] }),
      getContextUsage: async () => ok({ usage: null, staleTurnContext: null }),
      previewPrompt,
    } as unknown as TavernRemote

    const view = await render(
      <TavernHeaderChip
        remote={remote}
        sessionId={sessionId}
        sessions={{ open: vi.fn(), refresh: vi.fn(async () => {}) }}
        useSessions={(select) => select({ byId: { [sessionId]: { projectionValues: { agentPreset: 'tavern' } } } })}
      />,
    )
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })
    await act(async () => view.root.findByType(TavernSeatChip).props.onClick())
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })

    const previewBtn = () => view.root.findAllByType(Btn).find((b) =>
      b.props.children === t('binding.preview') || b.props['aria-busy'] === true)!
    await act(async () => previewBtn().props.onClick())
    expect(previewPrompt).toHaveBeenCalledOnce()
    expect(previewBtn().props['aria-busy']).toBe(true)
    expect(JSON.stringify(view.toJSON())).toContain(t('chip.preview.loading'))
    expect(view.root.findAllByProps({ className: 'dsh-tavern-spinner' })).toHaveLength(1)

    await act(async () => gate.resolve(ok({
      system: 'sys', messages: [], standing: '', turnContext: '', logLines: [],
      worldInfoBudget: { used: 0, limit: 100, overflowed: false },
      assembleBudget: { tokensBefore: 0, tokensAfter: 0, trimmedSections: [] },
      actualRequest: null,
      cacheUsage: { turns: [], total: { steps: 0, hitRate: null, uncachedInput: 0, cacheRead: 0, output: 0 } },
    })))
    expect(view.root.findAllByProps({ className: 'dsh-tavern-spinner' })).toHaveLength(0)
    expect(previewBtn().props.children).toBe(t('binding.preview'))
  })
})

describe('世界书、人设与 FileBtn 表单打磨', () => {
  it('会话世界书弹窗内不重复渲染标题，空条目且干净态不重复渲染底部操作条', async () => {
    const view = await render(
      <LorebookEditor
        target={{ kind: 'chat', cardId: 'c1', storyId: 's1', name: t('chip.chatLore.title') }}
        entries={[]}
        revision="r1"
        hideCloseButton
        onClose={() => {}}
        onSaved={() => {}}
        save={async () => ok({ saved: true, revision: 'r2' })}
      />,
    )
    expect(view.root.findAllByProps({ className: 'dsh-tavern-cardName' })).toHaveLength(0)
    expect(view.root.findAllByProps({ className: 'dsh-tavern-stickyBar' })).toHaveLength(0)
  })

  it('独立世界书导入后在列表展示条目数，且列表挂载不额外请求 getLorebook', async () => {
    let items: string[] = []
    const getLorebook = vi.fn()
    const remote = {
      listLorebooks: vi.fn(async () => ok({ items: [...items] })),
      listCharacters: async () => ok({ items: [] }),
      importLorebook: vi.fn(async () => { items = ['雾港志']; return ok({ name: '雾港志', entryCount: 4 }) }),
      getLorebook,
    } as unknown as TavernRemote

    const view = await render(<LorebooksSection remote={remote} />)
    expect(getLorebook).not.toHaveBeenCalled()
    const file = { name: '雾港志.json', text: async () => '{"entries":{}}' } as unknown as File
    await act(async () => view.root.findByType(FileBtn).props.onFile(file))
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })
    expect(JSON.stringify(view.toJSON())).toContain(t('lorebooks.libraryFileSubWithCount', { count: 4 }))
  })

  it('首建人设时隐藏空态，保存成功后收起编辑态展示新列表项', async () => {
    const stored: Array<{ id: string; name: string; description: string; avatar: null; revision: string }> = []
    const remote = {
      listPersonas: vi.fn(async () => ok({ items: [...stored] })),
      listLorebooks: async () => ok({ items: [] }),
      getSettings: async () => ok({ settings: TavernConfigSchema({}) }),
      savePersona: vi.fn(async ({ persona }: { persona: { id: string; name: string; description: string } }) => {
        stored.push({ id: persona.id, name: persona.name, description: persona.description, avatar: null, revision: 'rev-1' })
        return ok({ id: persona.id, revision: 'rev-1' })
      }),
    } as unknown as TavernRemote

    const view = await render(<PersonasSection remote={remote} />)
    expect(view.root.findAllByProps({ className: 'dsh-tavern-empty' })).toHaveLength(1)
    const newBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('personas.new'))!
    await act(async () => newBtn.props.onClick())
    expect(view.root.findAllByProps({ className: 'dsh-tavern-empty' })).toHaveLength(0)
    await act(async () => view.root.findByType('input').props.onChange({ target: { value: '雾港旅人' } }))
    const saveBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('action.save'))!
    await act(async () => saveBtn.props.onClick())
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })
    expect(view.root.findAllByType('fieldset')).toHaveLength(0)
    expect(JSON.stringify(view.toJSON())).toContain('雾港旅人')
  })

  it('FileBtn 支持 size="sm" 以对齐同排小号按钮', async () => {
    const view = await render(<FileBtn size="sm" accept=".json" onFile={() => {}}>导入</FileBtn>)
    expect(view.root.findByType('button').props['data-size']).toBe('sm')
  })
})

describe('移动端交互卡盒模型与 0.2.2+ 设置顶栏布局契约', () => {
  it('交互卡统一 content-box + calc(100% - 2px) 避免窄屏 1px 溢出滚动条，且 0.2.2+ 设置顶栏不绝对定位覆盖关闭钮', () => {
    let injectedCss = ''
    vi.stubGlobal('document', {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: (el: { textContent: string }) => { injectedCss = el.textContent } },
    })
    ensureTavernStyles()

    // D1: .dsh-tavern-speechHtml 全端统一 content-box + calc(100% - 2px)，<=560px 不切 border-box；.is-widget 无边框用 100%
    expect(injectedCss).toContain('.dsh-tavern-speechHtml{box-sizing:content-box;color-scheme:inherit;width:calc(100% - 2px);')
    expect(injectedCss).toContain('.dsh-tavern-speechHtml.is-widget{width:100%;')
    expect(injectedCss).not.toContain('.dsh-tavern-speechHtml{box-sizing:border-box;')

    // D2: 0.1.2 绝对定位接管严格限定于两子项壳（:has(>nav:first-child):has(>nav+div:last-child)），
    //     不作用于 0.2.2+ 四子项网格壳的 .actions（打开配置文件），且关闭按钮收窄为 >button:last-child。
    expect(injectedCss).not.toContain(':has(.dsh-tavern-panel)>nav+div>div:first-child{position:absolute')
    expect(injectedCss).not.toContain(':has(.dsh-tavern-panel)>nav+div>div:first-child>button{width:36px')
    expect(injectedCss).toContain(':has(>nav:first-child):has(>nav+div:last-child):has(.dsh-tavern-panel)>nav+div>div:first-child{')
    expect(injectedCss).toContain(':has(>nav+div+div):has(.dsh-tavern-panel)>nav+div{')
    expect(injectedCss).toContain(':has(>nav+div+div):has(.dsh-tavern-panel)>nav+div>button:last-child{')
  })
})
