/**
 * 接管 conversation.chat.node / assistant-step：仅 Tavern 会话用「头像 + 正文」排版，
 * 并套 output/render 正则（标记换成 HTML 封面时进 iframe）。
 *
 * 本组件只在当前会话为 Tavern 时才会被登记（见 client/index.tsx）。若仍被挂到
 * 非 Tavern 会话上（切换瞬间），立刻交回空树之外的原生 Markdown 回退，避免挡住 dsh。
 */
import { Fragment, useMemo } from 'react'
import type { ReactNode } from 'react'
import { JsonBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { stripDisplayMeta } from '../core/displaySanitize.js'
import { useT } from './i18n.js'
import { isTavernSession, type UseSessions } from './mode.js'
import { openChildSession } from './openChild.js'
import { SpeechBubble } from './speech.js'
import type { TavernRemote } from './types.js'
import { useLoader } from './util.js'

interface AssistantBlock {
  kind: string
  text?: string
  attachment?: unknown
  block?: unknown
}

interface AssistantNode {
  location?: { kind?: string; turn?: { status?: string } }
  data: {
    status: string
    blocks: AssistantBlock[]
    finalNode?: { seq?: number }
  }
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
  fileMentions?: (owner: TurnTailOwner) => unknown
}) {
  const { remote, sessionId, sessions, node } = props
  const t = useT()
  const tavern = isTavernSession(props.useSessions, sessionId)
  const bindingLoader = useLoader(() => remote.getSessionBinding({ sessionId }), [sessionId], tavern)
  const binding = bindingLoader.state.status === 'ready' ? bindingLoader.state.value.binding : null
  const detail = useLoader(
    () => remote.getCharacterDetail({ cardId: binding!.cardId }),
    [binding?.cardId],
    tavern && binding !== null,
  )
  const streaming = node.data.status === 'running'
  const interrupted = node.data.status === 'interrupted'
  const text = node.data.blocks.filter((b) => b.kind === 'text').map((b) => b.text ?? '').join('\n')
  const name = detail.state.status === 'ready' ? detail.state.value.name : ''
  const hasImages = node.data.blocks.some((b) => b.kind === 'image')
  const reasoningBlocks = node.data.blocks.filter((b) => b.kind === 'reasoning')

  const reasoningText = reasoningBlocks.map((b) => b.text ?? '').filter((chunk) => chunk.trim()).join('\n\n---\n\n')

  if (!tavern) {
    return <NativeAssistantFallback {...props} streaming={streaming} interrupted={interrupted} />
  }

  if (binding && text && !hasImages) {
    return (
      <div>
        <ReasoningFold text={reasoningText} streaming={streaming} />
        <SpeechBubble
          remote={remote}
          sessionId={sessionId}
          cardId={binding.cardId}
          name={name || t('assistant.characterFallback')}
          rawText={text}
          streaming={streaming}
          onSwipeGreeting={(index) => {
            if (!sessions) return
            void remote.swipeGreeting({ sessionId, index }).then((r) => {
              if (r.ok) return openChildSession(sessions, r.value.childSessionId, r.value.title)
            }).catch(() => {
              // 对话已开始等错误：封面按钮无独立报错条，忽略以免未处理 rejection。
            })
          }}
        />
        {interrupted && <div className="dsh-tavern-notice">{t('assistant.stopped')}</div>}
      </div>
    )
  }

  return <NativeAssistantFallback {...props} streaming={streaming} interrupted={interrupted} stripMeta />
}

function NativeAssistantFallback(props: {
  node: AssistantNode
  renderMessageImages?: RenderMessageImages
  useTurnData?: (key: string) => unknown
  openFile?: (path: string) => void
  fileMentions?: (owner: TurnTailOwner) => unknown
  streaming: boolean
  interrupted: boolean
  stripMeta?: boolean
}) {
  const { node, renderMessageImages, useTurnData, openFile, fileMentions, streaming, interrupted, stripMeta } = props
  const t = useT()
  // fileMentions 是宿主 owner 函数，需按原生 AssistantNodeView 的方式用
  // turn-tail owner 解析成 mentions 再交给 MarkdownText（旧版直接透传函数本体，等于没配）。
  const turn = node.location?.kind === 'turn' || node.location?.kind === 'step' ? node.location.turn : undefined
  const tail = useTurnData?.('turn-tail') as { closing?: { finalNode?: { seq?: number } } } | undefined
  const finalSeq = node.data.finalNode?.seq
  const mentionOwner = useMemo<TurnTailOwner | undefined>(() => {
    if (!turn || turn.status !== 'closed' || finalSeq === undefined) return undefined
    if (tail?.closing?.finalNode?.seq !== finalSeq) return undefined
    return { turn, seq: finalSeq, openFile }
  }, [turn, tail, finalSeq, openFile])
  const mentions = useMemo(
    () => (mentionOwner && fileMentions ? fileMentions(mentionOwner) : undefined),
    [fileMentions, mentionOwner],
  )
  const rendered: unknown[] = []
  const blocks = node.data.blocks
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block) continue
    if (block.kind === 'text') {
      const shown = stripMeta ? stripDisplayMeta(block.text ?? '') : (block.text ?? '')
      rendered.push(
        <MarkdownText key={i} text={shown} streaming={streaming} fileMentions={mentions} />,
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
      rendered.push(<JsonBlock key={i} label={t('assistant.unknownBlock')} payload={block.block} />)
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
