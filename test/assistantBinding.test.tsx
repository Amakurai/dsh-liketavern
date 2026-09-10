/**
 * assistant 楼层跟随绑定变更：绑定/解绑广播后已渲染的楼层切换排版，
 * 重拉期间沿用上次绑定，气泡不因短暂 loading 被卸载重建。
 */
import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { act, create } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BINDING_CHANGED_EVENT } from '../src/client/actions.js'
import { TavernAssistantNode } from '../src/client/assistant.js'
import { invalidateSessionBinding } from '../src/client/cache.js'
import { defaultBinding } from '../src/client/chip.js'
import { setTavernLocale } from '../src/client/i18n.js'
import type { CharacterDetail, SessionBinding, TavernRemote } from '../src/client/types.js'

const bubble = vi.hoisted(() => ({ mounts: 0 }))
vi.mock('../src/client/speech.js', () => ({
  SpeechBubble: (props: { cardId: string; interactiveCards?: boolean }) => {
    useEffect(() => { bubble.mounts += 1 }, [])
    return <div data-bubble={props.cardId} data-cards={props.interactiveCards === true ? 'on' : 'off'} />
  },
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Modal: () => null, Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null,
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  MarkdownText: (props: { text: string }) => <p data-native>{props.text}</p>,
  JsonBlock: () => null,
  IconChevronDownOutline14: () => null, IconSearchOutline16: () => null, IconUserOutline16: () => null,
}))

const ok = <T,>(value: T) => ({ ok: true as const, value })
const mounted: ReactTestRenderer[] = []
const detail: CharacterDetail = { cardId: 'card-a', name: '灯塔守望者', hasAvatar: false, hasCharacterBook: false, characterBookName: null, characterBookEntryCount: 0,
  description: '', personality: '', scenario: '', firstMes: '', alternateGreetings: [], mesExample: '', systemPrompt: '', postHistoryInstructions: '',
  creatorNotes: '', creator: '', characterVersion: '', tags: [], spec: 'chara_card_v2', depthPrompt: null, extensions: {} }
const node = { location: { kind: 'turn', turn: { status: 'closed', turn: 1 } }, data: { status: 'complete', blocks: [{ kind: 'text', text: '你好。' }], finalNode: { seq: 3 } } }

beforeEach(() => { setTavernLocale('zh'); bubble.mounts = 0; vi.stubGlobal('window', new EventTarget()) })
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()); vi.unstubAllGlobals() })

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
})
