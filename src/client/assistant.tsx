/**
 * 接管 conversation.chat.node / assistant-step：仅 Tavern 会话用「头像 + 正文」排版，
 * 并套 output/render 正则（标记换成 HTML 封面时进 iframe）。
 *
 * 本组件只在当前会话为 Tavern 时才会被登记（见 client/index.tsx）。若仍被挂到
 * 非 Tavern 会话上（切换瞬间），立刻交回空树之外的原生 Markdown 回退，避免挡住 dsh。
 */
import { ImageGallery } from '@deepseek-ai/dsh-client-ui-attachment'
import { JsonBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { stripDisplayMeta } from '../core/displaySanitize.js'
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
  data: {
    status: string
    blocks: AssistantBlock[]
    finalNode?: unknown
  }
}

function ReasoningFold(props: { text: string; streaming?: boolean }) {
  if (!props.text.trim()) return null
  return (
    <details className="dsh-tavern-reason">
      <summary>{props.streaming ? '思考中…' : '思考过程'}</summary>
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
  loadImage?: (attachment: unknown) => Promise<string>
  fileMentions?: unknown
  t?: (key: string, vars?: Record<string, unknown>) => string
}) {
  const { remote, sessionId, sessions, node, loadImage, t } = props
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
          name={name || '角色'}
          rawText={text}
          streaming={streaming}
          onSwipeGreeting={(index) => {
            if (!sessions) return
            void remote.swipeGreeting({ sessionId, index }).then((r) => {
              if (r.ok) return openChildSession(sessions, r.value.childSessionId)
            }).catch(() => {
              // 对话已开始等错误：封面按钮无独立报错条，忽略以免未处理 rejection。
            })
          }}
        />
        {interrupted && <div style={{ opacity: 0.7, fontSize: 13 }}>{t?.('message.stopped') ?? '已停止'}</div>}
      </div>
    )
  }

  return <NativeAssistantFallback {...props} streaming={streaming} interrupted={interrupted} stripMeta />
}

function NativeAssistantFallback(props: {
  node: AssistantNode
  loadImage?: (attachment: unknown) => Promise<string>
  fileMentions?: unknown
  t?: (key: string, vars?: Record<string, unknown>) => string
  streaming: boolean
  interrupted: boolean
  stripMeta?: boolean
}) {
  const { node, loadImage, fileMentions, t, streaming, interrupted, stripMeta } = props
  const imageLoader = loadImage ?? (() => Promise.reject(new Error(t?.('image.serviceUnavailable') ?? 'no image loader')))
  const rendered: unknown[] = []
  const blocks = node.data.blocks
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (!block) continue
    if (block.kind === 'text') {
      const shown = stripMeta ? stripDisplayMeta(block.text ?? '') : (block.text ?? '')
      rendered.push(
        <MarkdownText key={i} text={shown} streaming={streaming} fileMentions={fileMentions} />,
      )
    } else if (block.kind === 'reasoning') {
      if (stripMeta) continue
      rendered.push(
        <details key={i} className="dsh-tavern-reason">
          <summary>{streaming ? (t?.('message.thinking') ?? '思考中…') : (t?.('message.thought') ?? '思考过程')}</summary>
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
      rendered.push(
        <ImageGallery
          key={i}
          images={group}
          load={imageLoader}
          align="start"
        />,
      )
    } else if (block.kind === 'tool-call') {
      continue
    } else {
      rendered.push(<JsonBlock key={i} label={t?.('message.unknownBlock') ?? '未知块'} payload={block.block} />)
    }
  }
  return (
    <div>
      {stripMeta ? <ReasoningFold text={node.data.blocks.filter((b) => b.kind === 'reasoning').map((b) => b.text ?? '').join('\n\n')} streaming={streaming} /> : null}
      {rendered}
      {interrupted ? <span>{t?.('message.stopped') ?? '已停止'}</span> : null}
    </div>
  )
}
