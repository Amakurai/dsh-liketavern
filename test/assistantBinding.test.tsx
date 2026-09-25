/**
 * assistant 楼层跟随绑定变更：绑定/解绑广播后已渲染的楼层切换排版，
 * 重拉与暂时失败沿用上次绑定，失败可就地重试且不能把旧会话身份带到新会话。
 */
import type { ComponentProps, ReactNode } from 'react'
import { useEffect } from 'react'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, create } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BINDING_CHANGED_EVENT } from '../src/client/actions.js'
import { TavernAssistantNode } from '../src/client/assistant.js'
import { CHARACTER_CHANGED_EVENT, invalidateCharacter, invalidateSessionBinding } from '../src/client/cache.js'
import { defaultBinding } from '../src/client/chip.js'
import { setTavernLocale } from '../src/client/i18n.js'
import type { CharacterDetail, SessionBinding, TavernRemote } from '../src/client/types.js'

const bubble = vi.hoisted(() => ({ mounts: 0, props: undefined as Record<string, unknown> | undefined }))
vi.mock('../src/client/speech.js', () => ({
  SpeechBubble: (props: { cardId: string; characterRevision?:string; bindingRevision?:string; interactiveCards?: boolean; fileMentions?: unknown; media?: ReactNode }) => {
    bubble.props = props
    useEffect(() => { bubble.mounts += 1 }, [])
    return <div data-bubble={props.cardId} data-cards={props.interactiveCards === true ? 'on' : 'off'}>{props.media}</div>
  },
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: () => null, Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  MarkdownText: (props: { text: string }) => <p data-native>{props.text}</p>,
  JsonBlock: () => null,
  IconChevronDownOutlineMedium: () => null, IconSearchOutlineMedium: () => null, IconUserOutlineMedium: () => null,
}))

const ok = <T,>(value: T) => ({ ok: true as const, value })
const mounted: ReactTestRenderer[] = []
const detail: CharacterDetail = { cardId: 'card-a', name: '灯塔守望者', hasAvatar: false, hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0,
  description: '', personality: '', scenario: '', firstMes: '', alternateGreetings: [], mesExample: '', systemPrompt: '', postHistoryInstructions: '',
  creatorNotes: '', creator: '', characterVersion: '', tags: [], spec: 'chara_card_v2', depthPrompt: null, extensions: {} }
const node = { location: { kind: 'turn', turn: { status: 'closed', turn: 1 } }, data: { status: 'complete', blocks: [{ kind: 'text', text: '你好。' }], finalNode: { seq: 3 } } }

beforeEach(() => { setTavernLocale('zh'); bubble.mounts = 0; bubble.props = undefined; vi.stubGlobal('window', new EventTarget()) })
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()); vi.unstubAllGlobals(); vi.useRealTimers() })

function environment(sessionId: string) {
  let binding: SessionBinding | null = null
  const getSessionBinding = vi.fn(async () => ok({ binding }))
  const remote = { getSessionBinding, getCharacterDetail: async () => ok(detail) } as unknown as TavernRemote
  const change = async (next: SessionBinding | null) => {
    binding = next
    invalidateSessionBinding(sessionId)
    await act(async () => { window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId })) })
  }
  return { remote, getSessionBinding, change }
}

async function render(remote: TavernRemote, sessionId: string) {
  let view!: ReactTestRenderer
  const useSessions = (select: (state: unknown) => unknown) => select({ byId: { [sessionId]: { projectionValues: { agentPreset: 'tavern' } } } })
  await act(async () => { view = create(<TavernAssistantNode remote={remote} sessionId={sessionId} node={node} useSessions={useSessions as never} />) })
  mounted.push(view)
  return view
}

describe('assistant 楼层绑定刷新', () => {
  it('首次读取失败显示正文与恢复入口，原地重试后恢复角色气泡', async () => {
    const sessionId = 'assistant-binding-first-failure'
    const binding = defaultBinding(sessionId, 'card-first-failure')
    const getSessionBinding = vi.fn().mockRejectedValueOnce(new Error('连接暂时断开')).mockResolvedValue(ok({ binding }))
    const remote = { getSessionBinding, getCharacterDetail: async () => ok(detail) } as unknown as TavernRemote
    const view = await render(remote, sessionId)
    expect(view.root.findAllByProps({ 'data-native': true })).toHaveLength(1)
    expect(JSON.stringify(view.toJSON())).toContain('角色卡信息暂时无法加载：连接暂时断开')
    expect(view.root.findByType('button').props.children).toBe('重新加载角色卡')
    await act(async () => view.root.findByType('button').props.onClick({ stopPropagation() {} }))
    expect(view.root.findByProps({ 'data-bubble': binding.cardId })).toBeDefined()
    expect(getSessionBinding).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(view.toJSON())).not.toContain('连接暂时断开')
  })

  it('已有角色卡在刷新失败与重试期间保持挂载，明确解绑后才退出角色气泡', async () => {
    const sessionId = 'assistant-binding-refresh-failure'
    const binding = defaultBinding(sessionId, 'card-refresh-failure')
    const retry = Promise.withResolvers<ReturnType<typeof ok<{ binding: SessionBinding | null }>>>()
    const getSessionBinding = vi.fn().mockResolvedValueOnce(ok({ binding }))
      .mockResolvedValueOnce({ ok: false, error: { message: '服务暂时不可用' } }).mockImplementationOnce(() => retry.promise)
      .mockResolvedValue(ok({ binding: null }))
    const remote = { getSessionBinding, getCharacterDetail: async () => ok(detail) } as unknown as TavernRemote
    const view = await render(remote, sessionId)
    invalidateSessionBinding(sessionId)
    await act(async () => window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId })))
    expect(view.root.findByProps({ 'data-bubble': binding.cardId })).toBeDefined()
    expect(JSON.stringify(view.toJSON())).toContain('服务暂时不可用')
    expect(bubble.mounts).toBe(1)
    await act(async () => view.root.findByType('button').props.onClick({ stopPropagation() {} }))
    expect(view.root.findByProps({ 'data-bubble': binding.cardId })).toBeDefined()
    await act(async () => retry.resolve(ok({ binding })))
    expect(bubble.mounts).toBe(1)
    expect(view.root.findAllByType('button')).toHaveLength(0)
    invalidateSessionBinding(sessionId)
    await act(async () => window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId })))
    expect(view.root.findAll((instance) => typeof instance.props['data-bubble'] === 'string')).toHaveLength(0)
    expect(view.root.findAllByProps({ 'data-native': true })).toHaveLength(1)
  })

  it('读取超时可以重试，旧请求晚到不能替换已恢复的角色卡', async () => {
    vi.useFakeTimers()
    const sessionId = 'assistant-binding-timeout'
    const binding = defaultBinding(sessionId, 'card-timeout')
    const pending = Promise.withResolvers<ReturnType<typeof ok<{ binding: SessionBinding | null }>>>()
    const getSessionBinding = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(ok({ binding }))
    const remote = { getSessionBinding, getCharacterDetail: async () => ok(detail) } as unknown as TavernRemote
    const view = await render(remote, sessionId)
    await act(async () => vi.advanceTimersByTime(20_000))
    expect(view.root.findAllByProps({ 'data-native': true })).toHaveLength(1)
    expect(view.root.findByType('button').props.children).toBe('重新加载角色卡')
    await act(async () => view.root.findByType('button').props.onClick({ stopPropagation() {} }))
    expect(view.root.findByProps({ 'data-bubble': binding.cardId })).toBeDefined()
    await act(async () => pending.resolve(ok({ binding: defaultBinding(sessionId, 'obsolete-card') })))
    expect(view.root.findByProps({ 'data-bubble': binding.cardId })).toBeDefined()
    expect(getSessionBinding).toHaveBeenCalledTimes(2)
    expect(bubble.mounts).toBe(1)
  })

  it('切换会话后读取失败不借用旧角色，切到普通会话不显示恢复入口', async () => {
    const firstId = 'assistant-binding-switch-error-first', secondId = 'assistant-binding-switch-error-second'
    const binding = defaultBinding(firstId, 'card-switch-error')
    const getSessionBinding = vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId === firstId
      ? ok({ binding }) : { ok: false as const, error: { message: '新会话读取失败' } })
    const remote = { getSessionBinding, getCharacterDetail: async () => ok(detail) } as unknown as TavernRemote
    const useSessions = (select: (state: unknown) => unknown) => select({ byId: {
      [firstId]: { projectionValues: { agentPreset: 'tavern' } }, [secondId]: { projectionValues: { agentPreset: 'tavern' } },
    } })
    const component = (sessionId: string) => <TavernAssistantNode remote={remote} sessionId={sessionId} node={node} useSessions={useSessions as never} />
    let view!: ReactTestRenderer
    await act(async () => { view = create(component(firstId)) })
    mounted.push(view)
    expect(view.root.findByProps({ 'data-bubble': binding.cardId })).toBeDefined()
    await act(async () => view.update(component(secondId)))
    expect(view.root.findAll((instance) => typeof instance.props['data-bubble'] === 'string')).toHaveLength(0)
    expect(JSON.stringify(view.toJSON())).toContain('新会话读取失败')
    await act(async () => view.update(component('ordinary-session')))
    expect(view.root.findAllByType('button')).toHaveLength(0)
    expect(JSON.stringify(view.toJSON())).not.toContain('新会话读取失败')
    expect(getSessionBinding).toHaveBeenCalledTimes(2)
  })

  /** 真实绑定文件配延迟 remote：复用宿主楼层组件时，新会话不能暂借旧角色身份。 */
  it('切换会话后等待自己的绑定，旧会话刷新迟到也不能恢复旧角色气泡', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tavern-assistant-binding-'))
    const firstId = 'assistant-switch-first', secondId = 'assistant-switch-second'
    const firstBinding = defaultBinding(firstId, 'switch-card-first')
    const secondBinding = defaultBinding(secondId, 'switch-card-second')
    const firstReload = Promise.withResolvers<void>(), secondRead = Promise.withResolvers<void>()
    let view: ReactTestRenderer | undefined
    try {
      await writeFile(join(root, `${firstId}.json`), JSON.stringify(firstBinding))
      await writeFile(join(root, `${secondId}.json`), JSON.stringify(secondBinding))
      const getSessionBinding = vi.fn(async ({ sessionId }: { sessionId: string }) => {
        if (sessionId === secondId) await secondRead.promise
        const binding = JSON.parse(await readFile(join(root, `${sessionId}.json`), 'utf8')) as SessionBinding
        return ok({ binding })
      })
      const remote = { getSessionBinding, getCharacterDetail: async ({ cardId }: { cardId: string }) => ok({ ...detail, cardId }) } as unknown as TavernRemote
      const useSessions = (select: (state: unknown) => unknown) => select({ byId: Object.fromEntries(
        [firstId, secondId].map(id => [id, { projectionValues: { agentPreset: 'tavern' } }]),
      ) })
      const component = (sessionId: string) => <TavernAssistantNode remote={remote} sessionId={sessionId} node={node} useSessions={useSessions as never} />
      await act(async () => { view = create(component(firstId)); await vi.waitFor(() => expect(getSessionBinding.mock.settledResults.at(-1)?.type).toBe('fulfilled')) })
      expect(view!.root.findByProps({ 'data-bubble': firstBinding.cardId })).toBeDefined()
      await act(async () => view!.update(component(secondId)))
      // 第一帧也不能给 lastBinding 写入“新 sessionId + 旧绑定”，否则整个等待期都会串角色。
      expect(view!.root.findAll((instance) => typeof instance.props['data-bubble'] === 'string')).toHaveLength(0)
      await act(async () => { secondRead.resolve(); await vi.waitFor(() => expect(getSessionBinding.mock.settledResults.at(-1)?.type).toBe('fulfilled')) })
      expect(view!.root.findByProps({ 'data-bubble': secondBinding.cardId })).toBeDefined()

      await act(async () => view!.update(component(firstId)))
      getSessionBinding.mockImplementationOnce(async () => { await firstReload.promise; return ok({ binding: firstBinding }) })
      invalidateSessionBinding(firstId)
      await act(async () => window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: firstId })))
      await act(async () => view!.update(component(secondId)))
      expect(view!.root.findByProps({ 'data-bubble': secondBinding.cardId })).toBeDefined()
      await act(async () => firstReload.resolve())
      expect(view!.root.findByProps({ 'data-bubble': secondBinding.cardId })).toBeDefined()
    } finally {
      firstReload.resolve(); secondRead.resolve()
      if (view) await act(async () => view!.unmount())
      invalidateSessionBinding(firstId); invalidateSessionBinding(secondId)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('无绑定时按原生排版，绑定广播后切换为角色气泡，解绑后回到原生排版', async () => {
    const sessionId = 'assistant-binding-1'
    const env = environment(sessionId)
    const view = await render(env.remote, sessionId)
    expect(view.root.findAllByProps({ 'data-native': true })).toHaveLength(1)
    expect(view.root.findAll((instance) => typeof instance.props['data-bubble'] === 'string')).toHaveLength(0)
    await env.change({ ...defaultBinding(sessionId, 'card-a'), interactiveCards: true })
    expect(view.root.findAll((instance) => typeof instance.props['data-bubble'] === 'string')).toHaveLength(1)
    expect(view.root.findByProps({ 'data-bubble': 'card-a' }).props['data-cards']).toBe('on')
    await env.change(null)
    expect(view.root.findAll((instance) => typeof instance.props['data-bubble'] === 'string')).toHaveLength(0)
    expect(view.root.findAllByProps({ 'data-native': true })).toHaveLength(1)
  })

  it('修改互动卡开关时气泡原地更新而不重新挂载，其它会话的广播被忽略', async () => {
    const sessionId = 'assistant-binding-2'
    const env = environment(sessionId)
    const view = await render(env.remote, sessionId)
    await env.change({ ...defaultBinding(sessionId, 'card-a'), interactiveCards: false })
    expect(view.root.findByProps({ 'data-bubble': 'card-a' }).props['data-cards']).toBe('off')
    expect(bubble.mounts).toBe(1)
    const pending = Promise.withResolvers<{ ok: true; value: { binding: SessionBinding | null } }>()
    env.getSessionBinding.mockImplementationOnce(() => pending.promise)
    invalidateSessionBinding(sessionId)
    await act(async () => { window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId })) })
    // 重拉尚未返回：仍显示上次绑定的气泡
    expect(view.root.findByProps({ 'data-bubble': 'card-a' }).props['data-cards']).toBe('off')
    await act(async () => { pending.resolve(ok({ binding: { ...defaultBinding(sessionId, 'card-a'), interactiveCards: true } })) })
    expect(view.root.findByProps({ 'data-bubble': 'card-a' }).props['data-cards']).toBe('on')
    expect(bubble.mounts).toBe(1)
    const calls = env.getSessionBinding.mock.calls.length
    await act(async () => { window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: 'other-session' })) })
    expect(env.getSessionBinding.mock.calls.length).toBe(calls)
  })

  it('同一卡切换剧情或人设时更新显示绑定修订且不重挂气泡', async () => {
    const sessionId = 'assistant-display-binding-revision'
    const env = environment(sessionId)
    const view = await render(env.remote, sessionId)
    await env.change({ ...defaultBinding(sessionId, 'card-a'), storyId: 'story-a', personaId: 'persona-a' })
    const first = bubble.props?.bindingRevision
    await env.change({ ...defaultBinding(sessionId, 'card-a'), storyId: 'story-b', personaId: 'persona-b' })
    expect(bubble.props?.bindingRevision).not.toBe(first)
    const second = bubble.props?.bindingRevision
    await env.change({ ...defaultBinding(sessionId, 'card-a'), storyId: 'story-b', personaId: 'persona-b', helperMvu: true })
    expect(bubble.props?.bindingRevision).not.toBe(second)
    expect(view.root.findByProps({ 'data-bubble': 'card-a' })).toBeDefined()
    expect(bubble.mounts).toBe(1)
  })

  it('绑定后的角色气泡沿用宿主核验的文件链接解析结果', async () => {
    const sessionId = 'assistant-file-mentions'
    const env = environment(sessionId)
    const mentions = { resolve: vi.fn() }
    const resolver = vi.fn(() => mentions as never)
    const openFile = vi.fn()
    const useTurnData = vi.fn(() => ({ closing: { finalNode: { seq: 3 } } }))
    const useSessions = (select: (state: unknown) => unknown) => select({ byId: {
      [sessionId]: { projectionValues: { agentPreset: 'tavern' } },
    } })
    let view!: ReactTestRenderer
    await act(async () => { view = create(<TavernAssistantNode remote={env.remote} sessionId={sessionId} node={node}
      useSessions={useSessions as never} useTurnData={useTurnData} openFile={openFile} fileMentions={resolver} />) })
    mounted.push(view)
    await env.change(defaultBinding(sessionId, 'card-a'))
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ seq: 3, openFile }))
    expect(bubble.props?.fileMentions).toBe(mentions)
  })

  it('角色详情加载失败时保留正文与明确重试，恢复后更新角色名', async () => {
    const sessionId = 'assistant-detail-retry', cardId = 'assistant-detail-retry-card'
    const env = environment(sessionId)
    const getCharacterDetail = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: '角色详情连接失败' } })
      .mockResolvedValue({ ok: true, value: { ...detail, cardId, name: '恢复后的角色' } })
    const remote = { ...env.remote, getCharacterDetail } as TavernRemote
    invalidateCharacter(cardId)
    const view = await render(remote, sessionId)
    await env.change(defaultBinding(sessionId, cardId))
    expect(view.root.findByProps({ 'data-bubble': cardId })).toBeDefined()
    expect(JSON.stringify(view.toJSON())).toContain('角色详情连接失败')
    const retry = view.root.findAllByType('button').find(button => button.props.children === '重新加载角色卡')
    expect(retry).toBeDefined()
    await act(async () => retry!.props.onClick({ stopPropagation() {} }))
    expect(getCharacterDetail).toHaveBeenCalledTimes(2)
    expect(bubble.props?.name).toBe('恢复后的角色')
    invalidateCharacter(cardId)
  })

  it('文本与图片混合的绑定消息仍走角色气泡，并保留宿主图片渲染器', async () => {
    const sessionId = 'assistant-card-with-images'
    const env = environment(sessionId)
    const mixedNode = { ...node, data: { ...node.data, blocks: [
      { kind: 'text', text: '<div>角色卡正文</div>' },
      { kind: 'image', attachment: { id: 'image-1' } },
    ] } }
    const renderMessageImages = vi.fn(() => <div data-owner-images="true" />)
    const useSessions = (select: (state: unknown) => unknown) => select({ byId: {
      [sessionId]: { projectionValues: { agentPreset: 'tavern' } },
    } })
    let view!: ReactTestRenderer
    await act(async () => { view = create(<TavernAssistantNode remote={env.remote} sessionId={sessionId} node={mixedNode}
      useSessions={useSessions as never} renderMessageImages={renderMessageImages} />) })
    mounted.push(view)
    await env.change(defaultBinding(sessionId, 'card-a'))
    expect(view.root.findByProps({ 'data-bubble': 'card-a' })).toBeDefined()
    expect(bubble.props?.rawText).toBe('<div>角色卡正文</div>')
    expect(view.root.findByProps({ 'data-owner-images': 'true' })).toBeDefined()
    expect(renderMessageImages).toHaveBeenLastCalledWith({ images: [{ attachment: { id: 'image-1' } }], align: 'start' })
  })

  it('图片夹在两段正文之间时回退宿主保序渲染，不把图片错误挪到末尾', async () => {
    const sessionId = 'assistant-interleaved-images'
    const env = environment(sessionId)
    const mixedNode = { ...node, data: { ...node.data, blocks: [
      { kind: 'text', text: '图片前' },
      { kind: 'image', attachment: { id: 'image-middle' } },
      { kind: 'text', text: '图片后' },
    ] } }
    const renderMessageImages = vi.fn(({ images }: { images: Array<{ attachment: { id: string } }> }) => <div data-owner-images={images[0]!.attachment.id} />)
    const useSessions = (select: (state: unknown) => unknown) => select({ byId: {
      [sessionId]: { projectionValues: { agentPreset: 'tavern' } },
    } })
    let view!: ReactTestRenderer
    await act(async () => { view = create(<TavernAssistantNode remote={env.remote} sessionId={sessionId} node={mixedNode}
      useSessions={useSessions as never} renderMessageImages={renderMessageImages as never} />) })
    mounted.push(view)
    await env.change(defaultBinding(sessionId, 'card-a'))
    expect(view.root.findAllByProps({ 'data-bubble': 'card-a' })).toHaveLength(0)
    const ordered = view.root.findAll(node => node.type === 'p' || node.props['data-owner-images'])
    expect(ordered.map(item => item.type === 'p' ? item.props.children : item.props['data-owner-images'])).toEqual([
      '图片前', 'image-middle', '图片后',
    ])
  })

  it.each([
    ['图片后的思考块', [{ kind: 'text', text: '正文' }, { kind: 'image', attachment: { id: 'image-tail' } }, { kind: 'reasoning', text: '后置思考' }]],
    ['宿主未知块', [{ kind: 'text', text: '正文' }, { kind: 'future-block', block: { value: 1 } }, { kind: 'image', attachment: { id: 'image-tail' } }]],
  ])('%s 回退宿主块渲染，不被角色气泡重排或吞掉', async (_label, blocks) => {
    const sessionId = `assistant-native-blocks-${_label}`
    const env = environment(sessionId)
    const mixedNode = { ...node, data: { ...node.data, blocks } }
    const renderMessageImages = vi.fn(() => <div data-owner-images="tail" />)
    const useSessions = (select: (state: unknown) => unknown) => select({ byId: {
      [sessionId]: { projectionValues: { agentPreset: 'tavern' } },
    } })
    let view!: ReactTestRenderer
    await act(async () => { view = create(<TavernAssistantNode remote={env.remote} sessionId={sessionId} node={mixedNode}
      useSessions={useSessions as never} renderMessageImages={renderMessageImages} />) })
    mounted.push(view)
    await env.change(defaultBinding(sessionId, 'card-a'))
    expect(view.root.findAllByProps({ 'data-bubble': 'card-a' })).toHaveLength(0)
    expect(view.root.findByProps({ 'data-owner-images': 'tail' })).toBeDefined()
  })

  it('同页保存角色卡后，已挂载气泡主动刷新角色详情', async () => {
    const sessionId = 'assistant-character-changed', cardId = 'assistant-live-card'
    const env = environment(sessionId)
    let current = { ...detail, cardId, revision: 'revision-1', name: '保存前名称' }
    const getCharacterDetail = vi.fn(async () => ok(current))
    const remote = { ...env.remote, getCharacterDetail } as TavernRemote
    invalidateCharacter(cardId)
    const view = await render(remote, sessionId)
    await env.change(defaultBinding(sessionId, cardId))
    expect(bubble.props?.name).toBe('保存前名称')

    current = { ...current, revision: 'revision-2', name: '保存后名称' }
    invalidateCharacter(cardId)
    await act(async () => window.dispatchEvent(new CustomEvent(CHARACTER_CHANGED_EVENT, { detail: cardId })))
    expect(getCharacterDetail).toHaveBeenCalledTimes(2)
    expect(bubble.props?.name).toBe('保存后名称')
    expect(bubble.props?.characterRevision).toBe('revision-2')
    expect(view.root.findByProps({ 'data-bubble': cardId })).toBeDefined()
    invalidateCharacter(cardId)
  })
})
