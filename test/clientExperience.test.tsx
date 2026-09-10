/** 前端行为回归：真实 React 编辑器配模拟 remote，验证草稿保护、失败保留、多行开场白与剧情写入边界。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { act, create } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'
import { DraftScope, useDraftGuard } from '../src/client/drafts.js'
import { CharacterPicker } from '../src/client/characterPicker.js'
import { CharactersSection } from '../src/client/panel/characters.js'
import { VariableBackupEditor, StoryVariableSettings } from '../src/client/panel/cardData.js'
import { MemorySection } from '../src/client/panel/memory.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { TavernHeaderChip, defaultBinding } from '../src/client/chip.js'
import { TavernSeatChip } from '../src/client/seatChip.js'
import { Btn, CheckChips, ConfirmDialog, Dialog, IconBtn, Select } from '../src/client/util.js'
import type { CharacterDetail, CharacterSummary, TavernRemote } from '../src/client/types.js'

/** 仅替换宿主平台原语；被测组件的 hooks、草稿、remote 调用与状态更新都运行真实实现。 */
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (p: { children?: ReactNode }) => <button>{p.children}</button>,
  Modal: (p: { open: boolean; title: string; children?: ReactNode; footer?: ReactNode }) => p.open ? <div role="dialog" aria-label={p.title}>{p.children}{p.footer}</div> : null,
  Tooltip: (p: { children?: ReactNode }) => <>{p.children}</>,
  Toast: (p: { text: string }) => <span>{p.text}</span>,
  Menu: (p: { anchor?: ReactNode }) => <>{p.anchor}</>,
  IconChevronDownOutline14: () => null,
  IconSearchOutline16: () => null,
  IconUserOutline16: () => null,
  IconDownloadOutline16: () => null,
  IconTrashOutline16: () => null,
  IconEditOutline16: () => null,
  IconCopyOutline16: () => null,
}))

const mounted: ReactTestRenderer[] = []
async function render(node: ReactNode) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(node) })
  mounted.push(view)
  return view
}
function button(view: ReactTestRenderer, label: string) {
  return view.root.findAllByType(Btn).find((b) => b.props.children === label)!
}
function confirmation(view: ReactTestRenderer) {
  return view.root.findAllByType(ConfirmDialog).find((d) => d.props.open)!
}
const ok = <T,>(value: T) => ({ ok: true as const, value })
const summary = (cardId: string, name: string): CharacterSummary => ({ cardId, name, hasAvatar: false, hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0 })
function detail(cardId: string): CharacterDetail {
  return { ...summary(cardId, '灯塔守望者'), description: '守护海岸', personality: '', scenario: '', firstMes: '欢迎来到灯塔。',
    alternateGreetings: ['第一段\n第二段'], mesExample: '', systemPrompt: '', postHistoryInstructions: '', creatorNotes: '', creator: '', characterVersion: '', tags: [],
    spec: 'chara_card_v2', depthPrompt: null, extensions: {} }
}
beforeEach(() => setTavernLocale('zh'))
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()) })

function DraftEditor(props: { busy?: boolean }) {
  const [text, setText] = useState('')
  useDraftGuard(text !== '', props.busy)
  return <input value={text} onChange={(e) => setText(e.target.value)} />
}

describe('编辑草稿保护', () => {
  it('有草稿或保存中阻止浏览器意外刷新，卸载后解除保护', async () => {
    const events = new EventTarget()
    vi.stubGlobal('window', events)
    try {
      const view = await render(<DraftEditor />)
      const clean = new Event('beforeunload', { cancelable: true })
      events.dispatchEvent(clean)
      expect(clean.defaultPrevented).toBe(false)
      await act(async () => view.root.findByType('input').props.onChange({ target: { value: '待保存' } }))
      const dirty = new Event('beforeunload', { cancelable: true })
      events.dispatchEvent(dirty)
      expect(dirty.defaultPrevented).toBe(true)
      await act(async () => view.update(<DraftEditor busy />))
      await act(async () => view.unmount())
      const after = new Event('beforeunload', { cancelable: true })
      events.dispatchEvent(after)
      expect(after.defaultPrevented).toBe(false)
    } finally { vi.unstubAllGlobals() }
  })
  it('取消切页保留内容，明确放弃后才执行跳转', async () => {
    const leave = vi.fn()
    const view = await render(<DraftScope>{(request) => <><DraftEditor /><Btn onClick={() => request(leave)}>离开</Btn></>}</DraftScope>)
    await act(async () => view.root.findByType('input').props.onChange({ target: { value: '尚未保存' } }))
    await act(async () => button(view, '离开').props.onClick())
    expect(leave).not.toHaveBeenCalled()
    await act(async () => confirmation(view).props.onCancel())
    expect(view.root.findByType('input').props.value).toBe('尚未保存')
    await act(async () => button(view, '离开').props.onClick())
    await act(async () => confirmation(view).props.onConfirm())
    expect(leave).toHaveBeenCalledOnce()
  })

  it('保存期间不能卸载页面，干净的另一编辑器不会覆盖脏状态', async () => {
    const leave = vi.fn()
    const view = await render(<DraftScope>{(request) => <><DraftEditor busy /><DraftEditor /><Btn onClick={() => request(leave)}>离开</Btn></>}</DraftScope>)
    await act(async () => button(view, '离开').props.onClick())
    expect(leave).not.toHaveBeenCalled()
    expect(confirmation(view)).toBeUndefined()
  })

  it('多个编辑器独立汇报，干净的编辑器不会清除另一份草稿', async () => {
    const leave = vi.fn()
    const view = await render(<DraftScope>{(request) => <><DraftEditor /><DraftEditor /><Btn onClick={() => request(leave)}>离开</Btn></>}</DraftScope>)
    await act(async () => view.root.findAllByType('input')[0]!.props.onChange({ target: { value: '第一份草稿' } }))
    await act(async () => button(view, '离开').props.onClick())
    expect(leave).not.toHaveBeenCalled()
    expect(confirmation(view)).toBeDefined()
  })

  it('角色保存失败后保留草稿；多行开场白作为一条提交', async () => {
    const card = detail('draft-character')
    const saveCharacter = vi.fn(async (_request: unknown) => ({ ok: false, error: { code: 'IO', message: '模拟写入失败' } }))
    const remote = { listCharacters: async () => ok({ items: [summary(card.cardId, card.name)] }), getCharacterDetail: async () => ok(card),
      getAvatar: async () => ok({ dataUrl: null }), saveCharacter } as unknown as TavernRemote
    const view = await render(<CharactersSection remote={remote} />)
    await act(async () => view.root.findByProps({ className: 'dsh-tavern-charCard' }).props.onClick())
    const greeting = view.root.findAllByType('textarea').find((n) => n.props.value === '第一段\n第二段')!
    await act(async () => greeting.props.onChange({ target: { value: '新的第一段\n新的第二段' } }))
    await act(async () => button(view, '保存').props.onClick())
    expect(saveCharacter.mock.calls[0]?.[0]).toMatchObject({ alternateGreetings: ['新的第一段\n新的第二段'] })
    expect(view.root.findAllByType('textarea').some((n) => n.props.value === '新的第一段\n新的第二段')).toBe(true)
    await act(async () => view.root.findAllByType(Dialog).find((d) => d.props.width === 'xl')!.props.onClose())
    expect(confirmation(view)).toBeDefined()
  })

  it('保存成功后的 reload 往返窗口期内继续编辑，落地时不覆盖窗口期输入', async () => {
    // 复现竞态：save 成功 → busy 复位、表单解锁 → reload RPC 仍在飞行 → 用户继续键入 →
    // reload 落地。旧行为会 setDraft(loaded) 整体覆盖窗口期编辑并把 dirty 复位；现在必须保留草稿。
    const card = detail('reload-character')
    let serverCard = card
    const pendingReloads: Array<(value: ReturnType<typeof ok<CharacterDetail>>) => void> = []
    const getCharacterDetail = vi.fn(async () => new Promise<ReturnType<typeof ok<CharacterDetail>>>((resolve) => { pendingReloads.push(resolve) }))
    const saveCharacter = vi.fn(async (request: { alternateGreetings: string[] }) => {
      serverCard = { ...serverCard, alternateGreetings: request.alternateGreetings }
      return ok({ cardId: serverCard.cardId, name: serverCard.name })
    })
    const remote = { listCharacters: async () => ok({ items: [summary(card.cardId, card.name)] }), getCharacterDetail,
      getAvatar: async () => ok({ dataUrl: null }), saveCharacter } as unknown as TavernRemote
    const view = await render(<CharactersSection remote={remote} />)
    await act(async () => view.root.findByProps({ className: 'dsh-tavern-charCard' }).props.onClick())
    // 首次加载落地（冲刷全部挂起的详情请求，等待 loading → ready 状态更新）。
    const flushReloads = () => { for (const resolve of pendingReloads.splice(0)) resolve(ok(serverCard)) }
    const settle = async () => { await act(async () => { flushReloads(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }) }
    await settle()
    const byValue = (value: string) => view.root.findAllByType('textarea').find((n) => n.props.value === value)!
    await act(async () => byValue('第一段\n第二段').props.onChange({ target: { value: '保存的版本' } }))
    await act(async () => button(view, '保存').props.onClick())
    expect(saveCharacter).toHaveBeenCalledTimes(1)
    // busy 已随保存收尾复位；reload 仍挂起（loading 态），窗口期内继续键入。
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(pendingReloads.length).toBeGreaterThan(0)
    const fieldset = view.root.findByType('fieldset')
    expect(fieldset.props.disabled).toBe(false)
    await act(async () => byValue('保存的版本').props.onChange({ target: { value: '窗口期的新编辑' } }))
    await act(async () => { flushReloads() })
    await act(async () => {})
    // reload 落地：窗口期编辑保留，dirty 提示仍可见，不被静默覆盖。
    expect(view.root.findAllByType('textarea').some((n) => n.props.value === '窗口期的新编辑')).toBe(true)
    expect(JSON.stringify(view.toJSON())).toContain('未保存')
  })
})

describe('剧情上下文', () => {
  function remoteForStory() {
    const saveJournal = vi.fn(async (_request: unknown) => ok({}))
    const remote = {
      listCharacters: async () => ok({ items: [summary('card-a', '灯塔守望者')] }),
      listStories: async () => ok({ items: [{ id: 'story-a', sessionId: 'session-a', createdAt: '2026-09-05', migrated: false }] }),
      getMemories: vi.fn(async () => ok({ items: [] })), getWorldDeltas: async () => ok({ items: [] }),
      getJournal: async () => ok({ text: '旧笔记' }), saveJournal,
    }
    return { remote: remote as unknown as TavernRemote, saveJournal, getMemories: remote.getMemories }
  }
  it('从聊天进入后读取和保存均带原剧情 ID', async () => {
    const { remote, saveJournal, getMemories } = remoteForStory()
    const view = await render(<MemorySection remote={remote} initialContext={{ cardId: 'card-a', storyId: 'story-a' }} />)
    expect(getMemories).toHaveBeenCalledWith({ cardId: 'card-a', storyId: 'story-a' })
    const tabs = view.root.findAllByType('button')
    await act(async () => tabs.find((b) => b.props.children === '角色笔记')!.props.onClick())
    await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: '新笔记' } }))
    await act(async () => button(view, '保存笔记').props.onClick())
    expect(saveJournal).toHaveBeenCalledWith({ cardId: 'card-a', storyId: 'story-a', text: '新笔记' })
  })
  it('有草稿时取消切换初始状态，仍保持原剧情', async () => {
    const { remote } = remoteForStory()
    const view = await render(<MemorySection remote={remote} initialContext={{ cardId: 'card-a', storyId: 'story-a' }} />)
    await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: '待记录的事实' } }))
    await act(async () => view.root.findAllByType(Select)[1]!.props.onChange(''))
    await act(async () => confirmation(view).props.onCancel())
    expect(view.root.findAllByType(Select)[1]!.props.value).toBe('story-a')
    expect(view.root.findByType('textarea').props.value).toBe('待记录的事实')
  })

  it('单条记忆编辑时禁用剧情及分区切换，取消编辑也保护正文', async () => {
    const { remote } = remoteForStory()
    remote.getMemories = async () => ok({ items: [{ id: 'm-1', body: '灯塔已经修好', tags: [], keys: [], updated: '2026-09-05', archived: false }] }) as Awaited<ReturnType<TavernRemote['getMemories']>>
    const view = await render(<MemorySection remote={remote} initialContext={{ cardId: 'card-a', storyId: 'story-a' }} />)
    await act(async () => view.root.findAllByType(IconBtn).find((b) => b.props.label === '编辑')!.props.onClick())
    expect(view.root.findAllByType(Select).every((s) => s.props.disabled)).toBe(true)
    expect(view.root.findAllByType('button').filter((b) => b.props.className === 'dsh-tavern-chip').every((b) => b.props.disabled)).toBe(true)
    await act(async () => view.root.findAllByType('textarea').find((n) => n.props.value === '灯塔已经修好')!.props.onChange({ target: { value: '尚未写入的修订' } }))
    await act(async () => button(view, '取消').props.onClick())
    expect(confirmation(view)).toBeDefined()
  })
})

describe('角色选择', () => {
  it('搜索按名字匹配并只选择命中的角色', async () => {
    const onPick = vi.fn()
    const remote = { listCharacters: async () => ok({ items: [summary('a', '灯塔守望者'), summary('b', '森林旅人')] }) } as unknown as TavernRemote
    const view = await render(<CharacterPicker remote={remote} busy={false} error={null} onPick={onPick} onClose={() => {}} />)
    await act(async () => view.root.findByType('input').props.onChange({ target: { value: '森林' } }))
    const items = view.root.findAllByProps({ className: 'dsh-tavern-pickerItem' })
    expect(items).toHaveLength(1)
    await act(async () => items[0]!.props.onClick())
    expect(onPick).toHaveBeenCalledWith('b')
  })
})

/** 世界书绑定表单通过真实控件事件提交；主书关闭与附加书不混入全局选择。 */
it('会话绑定面板保存无主书与附加书，保留全局选择', async () => {
  vi.stubGlobal('window',new EventTarget())
  try {
    let binding={...defaultBinding('binding-controls','card-controls'),lorebookIds:['global-book'],worldInfo:{scanDepth:3}}
    const card=detail('card-controls')
    const setSessionBinding=vi.fn(async (request:{binding:typeof binding})=>{binding=request.binding;return ok({})})
    const remote={getSessionBinding:async()=>ok({binding}),getCharacterDetail:async()=>ok(card),getAvatar:async()=>ok({dataUrl:null}),
      listCharacters:async()=>ok({items:[summary(card.cardId,card.name)]}),listPresets:async()=>ok({items:[]}),listPersonas:async()=>ok({items:[]}),
      listLorebooks:async()=>ok({items:['global-book','extra-book']}),getContextUsage:async()=>ok({usage:null}),setSessionBinding} as unknown as TavernRemote
    const view=await render(<TavernHeaderChip remote={remote} sessionId="binding-controls" sessions={{open:()=>{}}} useSessions={select=>select({byId:{'binding-controls':{projectionValues:{agentPreset:'tavern'}}}})}/>)
    await act(async()=>view.root.findByType(TavernSeatChip).props.onClick())
    const main=view.root.findAllByType(Select).find(select=>select.props.options.some((option:{value:string})=>option.value==='@dsh/no-main-worldbook'))!
    await act(async()=>main.props.onChange('@dsh/no-main-worldbook'))
    await act(async()=>view.root.findAllByType(CheckChips).find(chips=>chips.props.ariaLabel==='附加角色世界书')!.props.onChange(['extra-book']))
    await act(async()=>button(view,'恢复跟随全局设置').props.onClick())
    await act(async()=>button(view,'保存绑定').props.onClick())
    expect(setSessionBinding).toHaveBeenCalledWith({binding:expect.objectContaining({characterLorebookId:null,useEmbeddedLorebook:false,characterLorebookIds:['extra-book'],lorebookIds:['global-book'],worldInfo:{}})})
    await act(async()=>view.unmount())
  } finally {vi.unstubAllGlobals()}
})

/** 绑定面板的写操作：传输层 reject 显示错误并解锁；请求在途时重复点击不会再发一次（换开场白会再建分支）。 */
it('会话绑定面板保存失败显示传输错误并解锁，换开场白在途时忽略重复点击', async () => {
  vi.stubGlobal('window',new EventTarget())
  try {
    const binding=defaultBinding('binding-busy','card-busy')
    const card=detail('card-busy')
    const pendingSwipe=Promise.withResolvers<{ok:true;value:{childSessionId:string;title:string}}>()
    const swipeGreeting=vi.fn(()=>pendingSwipe.promise)
    const opened:string[]=[]
    const remote={getSessionBinding:async()=>ok({binding,canSwipeGreeting:true}),getCharacterDetail:async()=>ok(card),getAvatar:async()=>ok({dataUrl:null}),
      listCharacters:async()=>ok({items:[summary(card.cardId,card.name)]}),listPresets:async()=>ok({items:[]}),listPersonas:async()=>ok({items:[]}),
      listLorebooks:async()=>ok({items:[]}),getContextUsage:async()=>ok({usage:null}),
      setSessionBinding:vi.fn(async()=>{throw new Error('连接中断')}),swipeGreeting} as unknown as TavernRemote
    const view=await render(<TavernHeaderChip remote={remote} sessionId="binding-busy" sessions={{open:(id)=>{opened.push(id)}}} useSessions={select=>select({byId:{'binding-busy':{projectionValues:{agentPreset:'tavern'}}}})}/>)
    await act(async()=>view.root.findByType(TavernSeatChip).props.onClick())
    await act(async()=>button(view,'保存绑定').props.onClick())
    expect(view.root.findByProps({role:'alert'}).children.join('')).toContain('连接中断')
    expect(button(view,'保存绑定').props.disabled).toBe(false)
    await act(async()=>button(view,'下一条开场白').props.onClick())
    expect(button(view,'下一条开场白').props.disabled).toBe(true)
    expect(button(view,'保存绑定').props.disabled).toBe(true)
    await act(async()=>button(view,'下一条开场白').props.onClick())
    expect(swipeGreeting).toHaveBeenCalledTimes(1)
    await act(async()=>pendingSwipe.resolve(ok({childSessionId:'child-1',title:'分支'})))
    expect(opened).toEqual(['child-1'])
    expect(button(view,'下一条开场白').props.disabled).toBe(false)
    await act(async()=>view.unmount())
  } finally {vi.unstubAllGlobals()}
})

/** 设置恢复使用选定剧情及宿主 seq，失败保留草稿；不重新挂载第三方角色卡。 */
describe('设置中的卡面变量管理',()=>{
  const snapshot={storyId:'story-one',historyRevision:'rev-one',currentMessageId:0,writable:true,messages:[],scopes:{'["chat",""]':{hp:1}}}
  it.each([true,false])('看似无变化的恢复先复核服务器，变量已改变时保留备份：%s',async changed=>{
    const text=JSON.stringify({version:1,scopes:snapshot.scopes})
    const getHelperSnapshot=vi.fn(async()=>ok({...snapshot,scopes:{'["chat",""]':{hp:changed?2:1}}}))
    const commitHelperVariables=vi.fn()
    const view=await render(<VariableBackupEditor remote={{getHelperSnapshot,commitHelperVariables} as unknown as TavernRemote} sessionId="session-one" messageId={17} snapshot={snapshot} onRefresh={()=>{}}/>)
    await act(async()=>view.root.findByType('textarea').props.onChange({target:{value:text}}))
    await act(async()=>button(view,'恢复卡内备份').props.onClick())
    await act(async()=>confirmation(view).props.onConfirm())
    expect(getHelperSnapshot).toHaveBeenCalledWith({sessionId:'session-one',messageId:17})
    expect(commitHelperVariables).not.toHaveBeenCalled()
    expect(view.root.findByType('textarea').props.value).toBe(changed?text:'')
    if(changed)expect(view.root.findByProps({role:'alert'}).children.join('')).toContain('剧情变量已改变')
  })
  it('恢复只在确认后提交，成功使用原值校验并清空草稿',async()=>{
    const commit=vi.fn(async()=>ok({...snapshot,scopes:{'["chat",""]':{hp:2}}}))
    const remote={commitHelperVariables:commit} as unknown as TavernRemote
    const view=await render(<VariableBackupEditor remote={remote} sessionId="session-one" messageId={17} snapshot={snapshot} onRefresh={()=>{}}/>)
    await act(async()=>view.root.findByType('textarea').props.onChange({target:{value:JSON.stringify({version:1,scopes:{'["chat",""]':{hp:2}}})}}))
    await act(async()=>button(view,'恢复卡内备份').props.onClick())
    expect(commit).not.toHaveBeenCalled()
    await act(async()=>confirmation(view).props.onConfirm())
    expect(commit).toHaveBeenCalledWith({sessionId:'session-one',messageId:17,storyId:'story-one',historyRevision:'rev-one',changes:[{key:'["chat",""]',before:{hp:1},value:{hp:2}}]})
    expect(view.root.findByType('textarea').props.value).toBe('')
  })
  it('保存冲突保留备份，刷新前保护草稿，取消刷新不丢输入',async()=>{
    const commit=vi.fn(async()=>({ok:false,error:{code:'conflict',message:'变量已经改变'}})),refresh=vi.fn()
    const text=JSON.stringify({version:1,scopes:{'["chat",""]':{hp:2}}})
    const view=await render(<VariableBackupEditor remote={{commitHelperVariables:commit} as unknown as TavernRemote} sessionId="session-one" messageId={17} snapshot={snapshot} onRefresh={refresh}/>)
    await act(async()=>view.root.findByType('textarea').props.onChange({target:{value:text}}))
    await act(async()=>button(view,'恢复卡内备份').props.onClick())
    await act(async()=>confirmation(view).props.onConfirm())
    expect(view.root.findByType('textarea').props.value).toBe(text)
    expect(view.root.findByProps({role:'alert'}).children.join('')).toContain('变量已经改变')
    await act(async()=>button(view,'刷新剧情数据').props.onClick())
    expect(refresh).not.toHaveBeenCalled()
    await act(async()=>confirmation(view).props.onCancel())
    expect(view.root.findByType('textarea').props.value).toBe(text)
  })
  it('读取最后一条角色消息的宿主 seq，并拒绝不同剧情的快照',async()=>{
    const get=vi.fn(async()=>ok({...snapshot,storyId:'wrong-story'}))
    const remote={getHelperEventState:async()=>ok({messages:[{seq:7,message_id:0,role:'assistant'},{seq:20,message_id:1,role:'user'},{seq:29,message_id:2,role:'assistant'}]}),getHelperSnapshot:get} as unknown as TavernRemote
    const view=await render(<StoryVariableSettings remote={remote} sessionId="session-one" storyId="story-one" cardId="card-one"/>)
    expect(get).toHaveBeenCalledWith({sessionId:'session-one',messageId:29})
    expect(view.root.findAllByType(VariableBackupEditor)).toHaveLength(0)
    expect(view.root.findByProps({role:'alert'}).children.join('')).toContain('剧情绑定已改变')
  })
})
