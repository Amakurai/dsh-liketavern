/**
 * 第一批编辑器面板实时缺陷与 UI/UX 回归测试（Regex / Lorebooks / LorebookEditor / Presets / Personas）：
 * - RegexSection：删除最后一条自定义规则保存后清脏态、清持久草稿不复活、toast 报 0 条、干净态禁用保存按钮；
 *   空 find 与非法正则语法（含坏标志、未闭合字符类、宏展开后的非法模式）内联标红且拦截保存；深度输入宽 112 并在 fieldRow 堆叠标签；预设附带头左齐蓝条。
 * - LorebooksSection / PresetsSection / PersonasSection：.dsh-tavern-tile 移除外层 role="button" 嵌套按钮，
 *   改用原生 button.dsh-tavern-tileTrigger（仅 phrasing 子节点）+ 平级 .dsh-tavern-tileActions，点击主区与操作钮互不干扰。
 * - LorebookEditor：全部 Toggle 开关暴露非空 aria-label/title；chat 世界书同名不重复渲染「本会话世界书 · 本会话世界书」；支持 hideCloseButton 避免弹窗内重复关闭钮。
 * - PresetsSection：已保存预设干净态禁用「保存预设」，编辑后启用，保存后复禁，新建空白预设保持可保存。
 */
import { createElement, Fragment, type ComponentProps, type ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PersistentEditor } from '../src/client/draftPersistence.js'
import { DraftScope } from '../src/client/drafts.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { LorebookEditor } from '../src/client/panel/lorebookEditor.js'
import { LorebooksSection } from '../src/client/panel/lorebooks.js'
import { PersonasSection } from '../src/client/panel/personas.js'
import { PresetsSection } from '../src/client/panel/presets.js'
import { RegexSection } from '../src/client/panel/regex.js'
import type { Envelope, TavernRemote } from '../src/client/types.js'
import { Btn, ConfirmDialog, Field, IconBtn, NullableNumInput, Toggle } from '../src/client/util.js'
import type { PromptPreset, RegexRule, WorldInfoEntry } from '../src/core/types.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => createElement('button', props),
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? createElement('div', { role: 'dialog' }, props.children, props.footer) : null,
  Tooltip: (props: { children?: ReactNode }) => createElement(Fragment, null, props.children),
  Toast: (props: { text: string }) => createElement('div', { role: 'status', 'data-toast': 'true' }, props.text),
  Menu: (props: { anchor?: ReactNode }) => createElement(Fragment, null, props.anchor),
  IconChevronDownOutlineMedium: () => null,
  IconDownloadOutlineMedium: () => null,
  IconEditOutlineMedium: () => null,
  IconFolderOpenOutlineMedium: () => null,
  IconListPenOutlineMedium: () => null,
  IconPlusOutlineMedium: () => null,
  IconSearchOutlineMedium: () => null,
  IconTrashOutlineMedium: () => null,
  IconUserOutlineMedium: () => null,
}))

const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })
const mounted: ReactTestRenderer[] = []

function textOf(node: ReactTestInstance | string | number | null | undefined): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return node.children.map((child) => textOf(child)).join('')
}

async function render(node: ReactNode): Promise<ReactTestRenderer> {
  let view!: ReactTestRenderer
  await act(async () => {
    view = create(node)
  })
  mounted.push(view)
  return view
}

function makeRule(overrides: Partial<RegexRule> = {}): RegexRule {
  return {
    id: 'rule-1',
    name: '测试规则',
    find: '/foo/g',
    replace: 'bar',
    enabled: true,
    scopes: ['output'],
    timing: ['render'],
    minDepth: null,
    maxDepth: null,
    substituteRegex: 0,
    source: 'user',
    ...overrides,
  }
}

function makeWorldEntry(overrides: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  return {
    key: 'chat:chat-lorebook:u1',
    uid: 'u1',
    source: 'chat',
    sourceRef: 'chat-lorebook',
    keys: ['灯塔'],
    secondaryKeys: [],
    selective: false,
    selectiveLogic: 0,
    comment: '港口守则',
    content: '海雾起时点灯',
    constant: false,
    enabled: true,
    order: 100,
    position: 0,
    depth: 4,
    role: 0,
    outletName: '',
    probability: 100,
    useProbability: true,
    caseSensitive: null,
    matchWholeWords: null,
    scanDepth: null,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    ignoreBudget: false,
    group: '',
    groupWeight: 100,
    groupOverride: false,
    automationId: '',
    ...overrides,
  }
}

/** 断言所有 .dsh-tavern-tile 都没有外层 role="button"、没有嵌套交互按钮、且主触发器内部只含 phrasing 元素（无 div）。 */
function assertNoNestedTileButtons(view: ReactTestRenderer, expectedTiles: number) {
  const tiles = view.root.findAllByProps({ className: 'dsh-tavern-tile' })
  expect(tiles).toHaveLength(expectedTiles)
  for (const tile of tiles) {
    expect(tile.props.role).toBeUndefined()
    expect(tile.props.tabIndex).toBeUndefined()
    expect(tile.props.onClick).toBeUndefined()
    const triggers = tile.findAllByProps({ className: 'dsh-tavern-tileTrigger' })
    expect(triggers).toHaveLength(1)
    const trigger = triggers[0]!
    expect(trigger.type).toBe('button')
    expect(trigger.props.type).toBe('button')
    // 按钮内部不得再嵌套 button、[role="button"] 或块级 div
    expect(trigger.findAll((node) => node !== trigger && (node.type === 'button' || node.props.role === 'button'))).toHaveLength(0)
    expect(trigger.findAll((node) => node.type === 'div')).toHaveLength(0)
    // 操作栏与主触发器同属 tile 的直接平级子区，不在 trigger 内部
    const actions = tile.findAllByProps({ className: 'dsh-tavern-tileActions' })
    expect(actions).toHaveLength(1)
    expect(trigger.findAllByProps({ className: 'dsh-tavern-tileActions' })).toHaveLength(0)
  }
}

let storage: Map<string, string>

beforeEach(() => {
  setTavernLocale('zh')
  storage = new Map([['dsh-tavern-editor-owner', 'audit-pass1-owner']])
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    },
  }))
})

afterEach(async () => {
  for (const view of mounted.splice(0)) {
    await act(async () => view.unmount())
  }
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('RegexSection 脏态清理、正则校验与布局修复', () => {
  it('删除最后一条规则并保存后上报 0 条、清除 dirty 与持久草稿且防抖期后不再复活草稿', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let serverRules: RegexRule[] = [makeRule()]
    let serverRev = 'rev-1'
    let storedDraft: unknown = null
    const saveEditorDraft = vi.fn(async ({ value }: { value: unknown }) => {
      storedDraft = structuredClone(value)
      return ok({ saved: true })
    })
    const deleteEditorDraft = vi.fn(async () => {
      storedDraft = null
      return ok({ deleted: true })
    })
    const saveRegexRules = vi.fn(async ({ rules }: { rules: RegexRule[]; expectedRevision?: string }) => {
      serverRules = structuredClone(rules)
      serverRev = 'rev-2'
      return ok({ count: rules.length, revision: serverRev })
    })
    const remote = {
      listRegexRules: vi.fn(async () => ok({ rules: structuredClone(serverRules), revision: serverRev })),
      saveRegexRules,
      listPresets: vi.fn(async () => ok({ items: [] })),
      getEditorDraft: vi.fn(async () => ok({ draft: storedDraft ? { value: storedDraft, updatedAt: new Date(0).toISOString() } : null })),
      saveEditorDraft,
      deleteEditorDraft,
    } as unknown as TavernRemote

    let latestDirty = false
    const view = await render(
      createElement(
        PersistentEditor,
        { remote, scope: 'panel-regex-delete-last' },
        createElement(DraftScope, {
          children: (_request, dirty) => {
            latestDirty = dirty
            return createElement(RegexSection, { remote })
          },
        }),
      ),
    )

    // 初始干净态：保存全部禁用
    const saveBtn = () => view.root.findAllByType(Btn).find((b) => b.props.children === t('regex.saveAll'))!
    expect(latestDirty).toBe(false)
    expect(saveBtn().props.disabled).toBe(true)

    // 删除最后一条规则 -> 变脏、保存启用，等待 600ms 触发草稿自动暂存
    const deleteBtn = view.root.findAllByType(IconBtn).find((b) => b.props.label === t('regex.deleteRule'))!
    await act(async () => { deleteBtn.props.onClick() })
    expect(latestDirty).toBe(true)
    expect(saveBtn().props.disabled).toBe(false)

    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(saveEditorDraft).toHaveBeenCalledTimes(1)
    expect(storedDraft).not.toBeNull()
    // 持久草稿中不应保存服务器基线 regex:savedRules
    expect((storedDraft as { fields: Record<string, unknown> }).fields).not.toHaveProperty('regex:savedRules')

    // 点击保存全部 -> 提交空列表、toast 显示 0 条、清除 dirty 与持久草稿
    await act(async () => { saveBtn().props.onClick() })
    expect(saveRegexRules).toHaveBeenCalledExactlyOnceWith({ rules: [], expectedRevision: 'rev-1' })
    expect(latestDirty).toBe(false)
    expect(saveBtn().props.disabled).toBe(true)
    expect(deleteEditorDraft).toHaveBeenCalledTimes(1)
    expect(storedDraft).toBeNull()
    const toastNode = view.root.findByProps({ 'data-toast': 'true' })
    expect(textOf(toastNode)).toBe(t('regex.saved', { count: 0 }))

    // 推进超过防抖时长（1200ms），不得因 setSavedRules/setRevision 重新复活草稿
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(saveEditorDraft).toHaveBeenCalledTimes(1)
    expect(storedDraft).toBeNull()
    expect(latestDirty).toBe(false)
    expect(view.root.findAllByProps({ className: 'dsh-tavern-ui dsh-tavern-draftStatus' })).toHaveLength(0)

    // 新增后放弃更改，防抖期后同样不复活草稿
    const newBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('regex.new'))!
    await act(async () => { newBtn.props.onClick() })
    expect(latestDirty).toBe(true)
    const discardBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('regex.discard'))!
    await act(async () => { discardBtn.props.onClick() })
    const confirmDialog = view.root.findAllByType(ConfirmDialog).find((d) => d.props.open)!
    await act(async () => { confirmDialog.props.onConfirm() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1200) })
    expect(latestDirty).toBe(false)
    expect(storedDraft).toBeNull()
    expect(saveEditorDraft).toHaveBeenCalledTimes(1)
  })

  it('校验非法正则语法与空 find（内联标红 + 拦截保存），并放行合法宏展开正则', async () => {
    const saveRegexRules = vi.fn(async ({ rules }: { rules: RegexRule[] }) => ok({ count: rules.length, revision: 'rev-2' }))
    const remote = {
      listRegexRules: vi.fn(async () => ok({ rules: [makeRule()], revision: 'rev-1' })),
      saveRegexRules,
      listPresets: vi.fn(async () => ok({ items: [] })),
    } as unknown as TavernRemote

    const view = await render(createElement(RegexSection, { remote }))
    const findInput = () =>
      view.root.findAllByType(Field).find((f) => f.props.label === t('regex.find'))!.findByType('input')
    const saveBtn = () => view.root.findAllByType(Btn).find((b) => b.props.children === t('regex.saveAll'))!

    // 1. 非法字面量 /[unclosed/g：内联立现 alert 与 aria-invalid，且拦截保存
    await act(async () => { findInput().props.onChange({ target: { value: '/[unclosed/g' } }) })
    expect(findInput().props['aria-invalid']).toBe(true)
    const alertsAfterBadSyntax = view.root.findAllByProps({ role: 'alert' }).map(textOf)
    expect(alertsAfterBadSyntax.some((msg) => msg.includes('语法无效'))).toBe(true)

    await act(async () => { saveBtn().props.onClick() })
    expect(saveRegexRules).not.toHaveBeenCalled()
    expect(view.root.findAllByProps({ role: 'alert' }).map(textOf).some((msg) => msg.includes('无法保存'))).toBe(true)

    // 2. 非法标志 /foo/xyz：同样拒绝
    await act(async () => { findInput().props.onChange({ target: { value: '/foo/xyz' } }) })
    await act(async () => { saveBtn().props.onClick() })
    expect(saveRegexRules).not.toHaveBeenCalled()

    // 3. 空 find：内联标红并拦截保存
    await act(async () => { findInput().props.onChange({ target: { value: '' } }) })
    expect(findInput().props['aria-invalid']).toBe(true)
    expect(view.root.findAllByProps({ role: 'alert' }).map(textOf).some((msg) => msg.includes(t('regex.error.emptyFind')))).toBe(true)
    await act(async () => { saveBtn().props.onClick() })
    expect(saveRegexRules).not.toHaveBeenCalled()

    // 4. 新建空规则直接点保存：拦截并在对应规则展示空表达式提示
    await act(async () => { findInput().props.onChange({ target: { value: '/valid/g' } }) })
    const newBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('regex.new'))!
    await act(async () => { newBtn.props.onClick() })
    await act(async () => { saveBtn().props.onClick() })
    expect(saveRegexRules).not.toHaveBeenCalled()
    expect(view.root.findAllByProps({ role: 'alert' }).map(textOf).some((msg) => msg.includes(t('regex.error.emptyFind')))).toBe(true)

    // 删除新增的空规则，改为带宏展开的合法正则 /\b{{char}}\b/gi，应放行保存
    const deleteBtns = view.root.findAllByType(IconBtn).filter((b) => b.props.label === t('regex.deleteRule'))
    await act(async () => { deleteBtns[1]!.props.onClick() })
    const macroSelect = view.root.findAllByType(Field).find((f) => f.props.label === t('regex.macroExpand'))!.findByType('button')
    expect(macroSelect).toBeDefined()
    // 先切 substituteRegex=2 再填含 {{char}} 的合法正则
    const fieldSelect = view.root.findAllByType(Field).find((f) => f.props.label === t('regex.macroExpand'))!
    const selectComp = fieldSelect.find((node) => typeof node.props.onChange === 'function' && Array.isArray(node.props.options))
    await act(async () => { selectComp.props.onChange('2') })
    await act(async () => { findInput().props.onChange({ target: { value: '/\\b{{char}}\\b/gi' } }) })
    expect(findInput().props['aria-invalid']).toBeUndefined()
    await act(async () => { saveBtn().props.onClick() })
    expect(saveRegexRules).toHaveBeenCalledTimes(1)
  })

  it('深度输入使用 112px 宽度与堆叠字段布局，且预设附带标题不再居中错位', async () => {
    setTavernLocale('en')
    const remote = {
      listRegexRules: vi.fn(async () => ok({ rules: [makeRule()], revision: 'rev-1' })),
      saveRegexRules: vi.fn(async () => ok({ count: 1, revision: 'rev-2' })),
      listPresets: vi.fn(async () => ok({ items: [] })),
    } as unknown as TavernRemote

    const view = await render(createElement(RegexSection, { remote }))
    const depthInputs = view.root.findAllByType(NullableNumInput)
    expect(depthInputs).toHaveLength(2)
    expect(depthInputs[0]!.props.width).toBe(112)
    expect(depthInputs[1]!.props.width).toBe(112)
    expect(depthInputs[0]!.findByType('input').props.placeholder).toBe('Unlimited')

    // 底部 minDepth / maxDepth / macroExpand 位于同一 .dsh-tavern-fieldRow 网格
    const fieldRows = view.root.findAllByProps({ className: 'dsh-tavern-fieldRow' })
    expect(fieldRows).toHaveLength(2)
    expect(fieldRows[1]!.findAllByType(Field).map((f) => f.props.label)).toEqual([
      t('regex.minDepth'),
      t('regex.maxDepth'),
      t('regex.macroExpand'),
    ])

    // 预设附带标题行不用 justifyContent: space-between，刷新按钮靠右对齐
    const presetHead = view.root.findByProps({ className: 'dsh-tavern-regexPresets' }).findByProps({ className: 'dsh-tavern-groupHead' })
    expect(presetHead.props.style?.justifyContent).toBeUndefined()
    const refreshWrapper = presetHead.findAllByType('span').find((s) => s.props.style?.marginLeft === 'auto')
    expect(refreshWrapper).toBeDefined()
    expect(refreshWrapper!.findByType(Btn).props.children).toBe(t('action.refresh'))
  })
})

describe('Lorebooks / Presets / Personas 卡片无嵌套交互按钮', () => {
  it('LorebooksSection（内嵌书与库文件）无嵌套按钮，点主区域打开且点操作钮独立生效', async () => {
    const getLorebook = vi.fn(async () => ok({ json: { entries: {} }, revision: 'lib-1' }))
    const getCharacterLorebook = vi.fn(async () => ok({ name: '角色内嵌书', json: { entries: {} }, entryCount: 1, revision: 'char-1' }))
    const remote = {
      listLorebooks: vi.fn(async () => ok({ items: ['世界设定集'] })),
      listCharacters: vi.fn(async () => ok({
        items: [{
          cardId: 'card-1',
          name: '守望者',
          hasAvatar: false,
          hasCharacterBook: true,
          characterBookName: '角色内嵌书',
          characterBookEntryCount: 1,
        }],
      })),
      getLorebook,
      getCharacterLorebook,
      deleteLorebook: vi.fn(async () => ok({ deleted: true })),
      deleteEmbeddedLorebook: vi.fn(async () => ok({ deleted: true })),
    } as unknown as TavernRemote

    const view = await render(createElement(LorebooksSection, { remote }))
    assertNoNestedTileButtons(view, 2)

    // 点击删除图标仅弹出确认框，不触发打开世界书
    const deleteBookBtn = view.root.findAllByType(IconBtn).find((b) => b.props.label === t('lorebooks.deleteBook'))!
    await act(async () => { deleteBookBtn.props.onClick() })
    expect(getLorebook).not.toHaveBeenCalled()
    expect(view.root.findAllByType(ConfirmDialog).some((d) => d.props.open)).toBe(true)
    await act(async () => { view.root.findAllByType(ConfirmDialog).find((d) => d.props.open)!.props.onCancel() })

    // 点击主触发器正常打开世界书编辑器
    const triggers = view.root.findAllByProps({ className: 'dsh-tavern-tileTrigger' })
    await act(async () => { triggers[0]!.props.onClick() })
    expect(getCharacterLorebook).toHaveBeenCalledExactlyOnceWith({ cardId: 'card-1' })
    expect(view.root.findByType(LorebookEditor).props.target).toEqual({ kind: 'character', cardId: 'card-1', name: '角色内嵌书' })
  })

  it('PresetsSection 无嵌套按钮，且保存按钮在干净态禁用、编辑后启用、新建空白预设保持可用', async () => {
    const preset: PromptPreset = { identifier: 'preset-a', name: '主力预设', entries: [] }
    const getPreset = vi.fn(async () => ok({ preset, revision: 'rev-1' }))
    const savePreset = vi.fn(async () => ok({ id: 'preset-a', revision: 'rev-2' }))
    const updateSettings = vi.fn(async () => ok({ settings: { defaults: { presetId: 'preset-a' } } }))
    const remote = {
      listPresets: vi.fn(async () => ok({ items: [{ id: 'preset-a', name: '主力预设', regexCount: 0 }] })),
      getSettings: vi.fn(async () => ok({ settings: { defaults: { presetId: null } } })),
      getPreset,
      savePreset,
      updateSettings,
    } as unknown as TavernRemote

    const view = await render(createElement(PresetsSection, { remote }))
    assertNoNestedTileButtons(view, 1)

    // 点击「设为默认」不误触发打开编辑器
    const setDefaultBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('presets.setAsDefault'))!
    await act(async () => { setDefaultBtn.props.onClick() })
    expect(updateSettings).toHaveBeenCalledOnce()
    expect(getPreset).not.toHaveBeenCalled()

    // 点击主触发器打开预设：干净态「保存预设」禁用
    const trigger = view.root.findByProps({ className: 'dsh-tavern-tileTrigger' })
    await act(async () => { trigger.props.onClick() })
    const saveBtn = () => view.root.findAllByType(Btn).find((b) => b.props.children === t('presets.save'))!
    expect(saveBtn().props.disabled).toBe(true)

    // 修改名称后启用保存，保存成功后重新禁用
    const nameInput = view.root.findAllByType('input').find((input) => input.props.value === '主力预设')!
    await act(async () => { nameInput.props.onChange({ target: { value: '主力预设 V2' } }) })
    expect(saveBtn().props.disabled).toBe(false)

    await act(async () => { saveBtn().props.onClick() })
    expect(savePreset).toHaveBeenCalledOnce()
    expect(saveBtn().props.disabled).toBe(true)

    // 关闭后点「新建预设」：空白新建预设应可直接保存
    const closeBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('action.close'))!
    await act(async () => { closeBtn.props.onClick() })
    const newBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('presets.new'))!
    await act(async () => { newBtn.props.onClick() })
    expect(saveBtn().props.disabled).toBe(false)
  })

  it('PersonasSection 无嵌套按钮，点主区域打开人设且点操作钮独立工作', async () => {
    const updateSettings = vi.fn(async () => ok({ settings: { defaults: { personaId: 'p-1' } } }))
    const remote = {
      listPersonas: vi.fn(async () => ok({ items: [{ id: 'p-1', name: '夜行侦探', description: '擅长推理', avatar: null, revision: 'r1' }] })),
      listLorebooks: vi.fn(async () => ok({ items: [] })),
      getSettings: vi.fn(async () => ok({ settings: { defaults: { personaId: null } } })),
      updateSettings,
    } as unknown as TavernRemote

    const view = await render(createElement(PersonasSection, { remote }))
    assertNoNestedTileButtons(view, 1)

    // 点「设为默认」不打开人设编辑表单
    const setDefaultBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('personas.setDefault'))!
    await act(async () => { setDefaultBtn.props.onClick() })
    expect(updateSettings).toHaveBeenCalledOnce()
    expect(view.root.findAllByType('fieldset')).toHaveLength(0)

    // 点主触发器打开人设编辑表单
    const trigger = view.root.findByProps({ className: 'dsh-tavern-tileTrigger' })
    await act(async () => { trigger.props.onClick() })
    expect(view.root.findAllByType('fieldset')).toHaveLength(1)
    expect(view.root.findByType('input').props.value).toBe('夜行侦探')
  })
})

describe('LorebookEditor 开关可访问性与聊天世界书去重标题', () => {
  it('全部 Toggle 开关均暴露非空 aria-label 与 title，聊天世界书不重复显示「本会话世界书 · 本会话世界书」', async () => {
    const view = await render(
      createElement(LorebookEditor, {
        target: { kind: 'chat', cardId: 'card-1', storyId: 'story-1', name: t('lorebookEditor.kind.chat') },
        entries: [makeWorldEntry()],
        revision: 'rev-1',
        onClose: () => {},
        onSaved: () => {},
        save: async () => ok({ saved: true, revision: 'rev-2' }),
      }),
    )

    // 1. 聊天世界书标题与元信息不重复「本会话世界书」
    const cardTitle = textOf(view.root.findByProps({ className: 'dsh-tavern-cardName' }))
    const editorMeta = textOf(view.root.findByProps({ className: 'dsh-tavern-editorMeta' }))
    expect(cardTitle).toBe('本会话世界书')
    expect(editorMeta).not.toContain('本会话世界书')
    expect(editorMeta).toContain('1 条')
    expect(editorMeta).toContain('启用 1')

    // 2. 展开高级选项，检查页面内所有 role="switch" 按钮均具备清晰可访问名称
    const advBtn = view.root.findAllByType(Btn).find((b) => b.props.children === t('lorebookEditor.form.advanced.show'))!
    await act(async () => { advBtn.props.onClick() })

    const toggles = view.root.findAllByType(Toggle)
    // 1 个行开关 + 3 个基础开关 + 4 个高级开关 = 8 个
    expect(toggles).toHaveLength(8)
    const switches = view.root.findAllByProps({ role: 'switch' })
    expect(switches).toHaveLength(8)
    for (const sw of switches) {
      expect(typeof sw.props['aria-label']).toBe('string')
      expect((sw.props['aria-label'] as string).trim().length).toBeGreaterThan(0)
      expect(sw.props.title).toBe(sw.props['aria-label'])
    }
  })

  it('hideCloseButton 为 true 时在干净态隐藏重复关闭/返回钮，有未保存改动时仍保留放弃入口', async () => {
    const view = await render(
      createElement(LorebookEditor, {
        target: { kind: 'chat', cardId: 'card-1', storyId: 'story-1', name: t('lorebookEditor.kind.chat') },
        entries: [makeWorldEntry()],
        revision: 'rev-1',
        hideCloseButton: true,
        onClose: () => {},
        onSaved: () => {},
        save: async () => ok({ saved: true, revision: 'rev-2' }),
      }),
    )
    const labels = () => view.root.findAllByType(Btn).map((b) => String(b.props.children))
    expect(labels()).not.toContain(t('action.close'))
    expect(labels()).not.toContain(t('lorebookEditor.back'))
    expect(labels()).not.toContain(t('lorebookEditor.backToList'))

    // 修改条目标题后进入脏态，底部显示「放弃并返回」以供放弃修改
    const commentInput = view.root.findAllByType('input').find((i) => i.props.placeholder === t('lorebookEditor.form.commentPlaceholder'))!
    await act(async () => { commentInput.props.onChange({ target: { value: '改动后' } }) })
    expect(labels()).toContain(t('lorebookEditor.discardAndBack'))
  })
})
