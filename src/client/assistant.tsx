/**
 * 接管 conversation.chat.node / assistant-step：仅 Tavern 会话用「头像 + 正文」排版，
 * 并套 output/render 正则（标记换成 HTML 封面时进 iframe）。
 *
 * 本组件只在当前会话为 Tavern 时才会被登记（见 client/index.tsx）。若仍被挂到
 * 非 Tavern 会话上（切换瞬间），立刻交回空树之外的原生 Markdown 回退，避免挡住 dsh。
 */
import { Fragment, useEffect, useMemo, useRef } from 'react'
import type { ReactNode, ComponentProps } from 'react'
import { JsonBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { stripDisplayMeta } from '../core/displaySanitize.js'
import { CHARACTER_CHANGED_EVENT, cachedCharacterDetail, cachedSessionBinding, invalidateCharacter, invalidateSessionBinding } from './cache.js'
import { useMarkdownLabels, useT } from './i18n.js'
import { isTavernSession, type UseSessions } from './mode.js'
import { openChildSession } from './openChild.js'
import { BINDING_CHANGED_EVENT, TavernInterruptedFloorActions } from './actions.js'
import { SpeechBubble } from './speech.js'
import type { SessionBinding, TavernRemote } from './types.js'
import { Btn, Err, useLoader } from './util.js'

interface AssistantBlock {
  kind: string
  text?: string
  attachment?: unknown
  block?: unknown
}

interface AssistantNode {
  location?: { kind?: string; turn?: { status?: string; turn?: number } }
  data: {
    status: string
    blocks: AssistantBlock[]
    finalNode?: { seq?: number }
  }
}

/** 同一卡片内会改变 output/render、宏或剧情 helper 身份的绑定字段。 */
function displayBindingRevision(binding: SessionBinding): string {
  return JSON.stringify([
    binding.storyId,
    binding.presetId,
    binding.personaId,
    binding.interactiveCards,
    binding.helperMvu === true,
    binding.lorebookIds,
    binding.characterLorebookId,
    binding.useEmbeddedLorebook !== false,
    binding.characterLorebookIds ?? [],
    binding.worldInfo ?? null,
    binding.greetingIndex,
  ])
}

/** 宿主 owner props 里的图片渲染器（rc.2 起替代 loadImage，见 conversation.chat.node 契约）。 */
type RenderMessageImages = (owner: {
  images: readonly { attachment: unknown }[]
  align: 'start' | 'end'
}) => ReactNode

/** fileMentions 的入参（宿主 AssistantNodeView 同款：turn-tail owner）。 */
interface TurnTailOwner {
  turn: { status?: string }
  seq: number
  openFile?: (path: string) => void
}

/**
 * 宿主只允许最终 turn-tail 上已经核验过的路径变成文件链接。角色气泡和原生回退
 * 必须共用同一份解析结果，否则绑定角色后同一句 Markdown 会突然失去文件跳转能力。
 */
function useResolvedFileMentions(
  node: AssistantNode,
  useTurnData?: (key: string) => unknown,
  openFile?: (path: string) => void,
  fileMentions?: (owner: TurnTailOwner) => ComponentProps<typeof MarkdownText>['fileMentions'],
) {
  const turn = node.location?.kind === 'turn' || node.location?.kind === 'step' ? node.location.turn : undefined
  const tail = useTurnData?.('turn-tail') as { closing?: { finalNode?: { seq?: number } } } | undefined
  const finalSeq = node.data.finalNode?.seq
  const mentionOwner = useMemo<TurnTailOwner | undefined>(() => {
    if (!turn || turn.status !== 'closed' || finalSeq === undefined) return undefined
    if (tail?.closing?.finalNode?.seq !== finalSeq) return undefined
    return { turn, seq: finalSeq, openFile }
  }, [turn, tail, finalSeq, openFile])
  return useMemo(
    () => (mentionOwner && fileMentions ? fileMentions(mentionOwner) : undefined),
    [fileMentions, mentionOwner],
  )
}

function ReasoningFold(props: { text: string; streaming?: boolean }) {
  const t = useT()
  if (!props.text.trim()) return null
  return (
    <details className="dsh-tavern-reason">
      <summary>{props.streaming ? t('assistant.thinking') : t('assistant.thought')}</summary>
      <pre>{props.text}</pre>
    </details>
  )
}

export function TavernAssistantNode(props: {
  remote: TavernRemote
  sessionId: string
  sessions?: { open(id: string): void; refresh?: () => Promise<void> }
  useSessions?: UseSessions
  node: AssistantNode
  renderMessageImages?: RenderMessageImages
  useTurnData?: (key: string) => unknown
  openFile?: (path: string) => void
  fileMentions?: (owner: TurnTailOwner) => ComponentProps<typeof MarkdownText>['fileMentions']
}) {
  const { remote, sessionId, sessions, node } = props
  const t = useT()
  const tavern = isTavernSession(props.useSessions, sessionId)
  // 绑定/角色详情走进程内缓存（key=sessionId / cardId）：N 个 assistant 节点共享一次 RPC。
  const bindingLoader = useLoader(() => cachedSessionBinding(remote, sessionId), [sessionId], tavern)
  // 绑定/解绑或修改互动卡开关后，已渲染的楼层要随之切换排版；否则要等重新挂载才更新（操作条与 chip 同样监听）。
  useEffect(() => {
    if (!tavern || typeof window === 'undefined') return
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === sessionId) bindingLoader.reload()
    }
    window.addEventListener(BINDING_CHANGED_EVENT, changed)
    return () => window.removeEventListener(BINDING_CHANGED_EVENT, changed)
  }, [tavern, sessionId, bindingLoader.reload])
  // 重拉与读取失败时沿用同一会话上次确认的绑定，避免短暂故障卸载互动卡；成功解绑仍立即生效。
  const lastBinding = useRef<{ sessionId: string; binding: SessionBinding | null } | null>(null)
  if (bindingLoader.state.status === 'ready') lastBinding.current = { sessionId, binding: bindingLoader.state.value.binding }
  const binding = bindingLoader.state.status === 'ready'
    ? bindingLoader.state.value.binding
    : (bindingLoader.state.status === 'loading' || bindingLoader.state.status === 'error') && lastBinding.current?.sessionId === sessionId ? lastBinding.current.binding : null
  const detail = useLoader(
    () => cachedCharacterDetail(remote, binding!.cardId),
    [binding?.cardId],
    tavern && binding !== null,
  )
  useEffect(() => {
    if (!tavern || !binding) return
    const changed = (event: Event) => {
      if ((event as CustomEvent<string>).detail === binding.cardId) detail.reload()
    }
    window.addEventListener(CHARACTER_CHANGED_EVENT, changed)
    return () => window.removeEventListener(CHARACTER_CHANGED_EVENT, changed)
  }, [tavern, binding?.cardId, detail.reload])
  const streaming = node.data.status === 'running'
  const interrupted = node.data.status === 'interrupted'
  const text = node.data.blocks.filter((b) => b.kind === 'text').map((b) => b.text ?? '').join('\n')
  const name = detail.state.status === 'ready' ? detail.state.value.name : ''
  const hasImages = node.data.blocks.some((b) => b.kind === 'image')
  const firstImage = node.data.blocks.findIndex((block) => block.kind === 'image')
  const firstText = node.data.blocks.findIndex((block) => block.kind === 'text')
  // SpeechBubble 的卡面投影是整条文本的一次 output/render，宿主图片只能作为尾部
  // media 插槽。只接管 reasoning* → text* → image*（其间可有不可见 tool-call）；
  // 图片后还有可见块、正文后又出现 reasoning，或宿主新增未知块时回退原生节点，
  // 避免重排图片/思考过程，也不能静默丢掉未来块类型。
  const supportsBubbleBlocks = node.data.blocks.every((block) =>
    block.kind === 'reasoning' || block.kind === 'text' || block.kind === 'image' || block.kind === 'tool-call')
  const hasInterleavedImages = firstImage >= 0
    && node.data.blocks.slice(firstImage + 1).some((block) => block.kind !== 'image' && block.kind !== 'tool-call')
  const hasLateReasoning = firstText >= 0
    && node.data.blocks.slice(firstText + 1).some((block) => block.kind === 'reasoning')
  const reasoningBlocks = node.data.blocks.filter((b) => b.kind === 'reasoning')
  const mentions = useResolvedFileMentions(node, props.useTurnData, props.openFile, props.fileMentions)

  const reasoningText = reasoningBlocks.map((b) => b.text ?? '').filter((chunk) => chunk.trim()).join('\n\n---\n\n')

  if (!tavern) {
    return <NativeAssistantFallback {...props} mentions={mentions} streaming={streaming} interrupted={interrupted} />
  }

  // 失败不是“没有绑定”：保留可读正文并提供就地恢复，重试先清缓存以绕开仍挂起的旧请求。
  const bindingError = bindingLoader.state.status === 'error' ? (
    <div className="dsh-tavern-notice">
      <Err message={t('assistant.bindingLoadFailed', { message: bindingLoader.state.message })} />
      <Btn onClick={() => { invalidateSessionBinding(sessionId); bindingLoader.reload() }}>{t('assistant.retryBinding')}</Btn>
    </div>
  ) : null
  const detailError = binding && detail.state.status === 'error' ? (
    <div className="dsh-tavern-notice">
      <Err message={t('assistant.bindingLoadFailed', { message: detail.state.message })} />
      <Btn onClick={() => { invalidateCharacter(binding.cardId); detail.reload() }}>{t('assistant.retryBinding')}</Btn>
    </div>
  ) : null

  // 中断楼层（已停止）的补救操作组：宿主 assistant-actions slot 只挂 finalized 消息，
  // 这里在节点内按 turn 号补挂重新生成/回退/兄弟导航（见 actions.tsx）。
  const locationTurn =
    node.location && (node.location.kind === 'turn' || node.location.kind === 'step') ? node.location.turn?.turn : undefined
  const interruptedActions =
    interrupted && binding && typeof locationTurn === 'number' && sessions ? (
      <TavernInterruptedFloorActions remote={remote} sessionId={sessionId} sessions={sessions} turn={locationTurn} />
    ) : null

  if (binding && text && supportsBubbleBlocks && !hasInterleavedImages && !hasLateReasoning) {
    const images = hasImages && props.renderMessageImages
      ? props.renderMessageImages({
          images: node.data.blocks.filter((block) => block.kind === 'image').map(({ attachment }) => ({ attachment })),
          align: 'start',
        })
      : null
    return (
      <div>
        {bindingError}
        {detailError}
        <ReasoningFold text={reasoningText} streaming={streaming} />
        <SpeechBubble
          remote={remote}
          sessionId={sessionId}
          cardId={binding.cardId}
          name={name || t('assistant.characterFallback')}
          characterRevision={detail.state.status === 'ready' ? detail.state.value.revision : undefined}
          bindingRevision={displayBindingRevision(binding)}
          rawText={text}
          fileMentions={mentions}
          media={images}
          messageId={node.data.finalNode?.seq}
          streaming={streaming || node.location?.turn?.status === 'open'}
          interactiveCards={binding.interactiveCards}
          onMessageBranch={async branch=>{if(!sessions)throw new Error(t('speech.navigationUnavailable'));await openChildSession(sessions,branch.childSessionId,branch.title,sessionId)}}
          onSwipeGreeting={async (index) => {
            if (!sessions) throw new Error(t('speech.navigationUnavailable'))
            const r = await remote.swipeGreeting({ sessionId, index })
            if (!r.ok) throw new Error(r.error.message)
            await openChildSession(sessions, r.value.childSessionId, r.value.title, sessionId)
          }}
        />
        {interrupted && <div className="dsh-tavern-notice">{t('assistant.stopped')}</div>}
        {interruptedActions}
      </div>
    )
  }

  return (
    <div>
      {bindingError}
      <NativeAssistantFallback {...props} mentions={mentions} streaming={streaming} interrupted={interrupted} stripMeta />
      {interruptedActions}
    </div>
  )
}

function NativeAssistantFallback(props: {
  node: AssistantNode
  renderMessageImages?: RenderMessageImages
  useTurnData?: (key: string) => unknown
  openFile?: (path: string) => void
  fileMentions?: (owner: TurnTailOwner) => ComponentProps<typeof MarkdownText>['fileMentions']
  mentions?: ComponentProps<typeof MarkdownText>['fileMentions']
  streaming: boolean
  interrupted: boolean
  stripMeta?: boolean
}) {
  const { node, renderMessageImages, mentions, streaming, interrupted, stripMeta } = props
  const t = useT()
  const markdownLabels = useMarkdownLabels()
  const rendered: ReactNode[] = []
  const blocks = node.data.blocks
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block) continue
    if (block.kind === 'text') {
      const shown = stripMeta ? stripDisplayMeta(block.text ?? '') : (block.text ?? '')
      rendered.push(
        <MarkdownText key={i} text={shown} streaming={streaming} fileMentions={mentions} labels={markdownLabels} />,
      )
    } else if (block.kind === 'reasoning') {
      if (stripMeta) continue
      rendered.push(
        <details key={i} className="dsh-tavern-reason">
          <summary>{streaming ? t('assistant.thinking') : t('assistant.thought')}</summary>
          <pre>{block.text}</pre>
        </details>,
      )
    } else if (block.kind === 'image') {
      const group = [block]
      while (i + 1 < blocks.length) {
        const next = blocks[i + 1]
        if (!next || next.kind !== 'image') break
        group.push(next)
        i += 1
      }
      if (renderMessageImages) {
        rendered.push(
          <Fragment key={i}>
            {renderMessageImages({ images: group.map(({ attachment }) => ({ attachment })), align: 'start' })}
          </Fragment>,
        )
      }
    } else if (block.kind === 'tool-call') {
      continue
    } else {
      rendered.push(<JsonBlock key={i} label={t('assistant.unknownBlock')} truncatedLabel={(total) => t('assistant.truncated', { total })} payload={block.block} />)
    }
  }
  return (
    <div>
      {stripMeta ? <ReasoningFold text={node.data.blocks.filter((b) => b.kind === 'reasoning').map((b) => b.text ?? '').join('\n\n')} streaming={streaming} /> : null}
      {rendered}
      {interrupted ? <span>{t('assistant.stopped')}</span> : null}
    </div>
  )
}
