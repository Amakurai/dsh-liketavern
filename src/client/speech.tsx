/**
 * 角色发言条：头像 + 名字 + 正文。正文经 output/render 正则后，
 * 再收起 UpdateVariable 等机读标签；整页 HTML 进沙箱 iframe，其余走 Markdown。
 *
 * 封面 iframe：允许 https 图片/字体；注入 ST getChatMessages/setChatMessage stub，
 * 卡内按钮经 postMessage 请求宿主 swipeGreeting。无 allow-same-origin。
 * 正则若只把标记换成 HTML，iframe 下面仍渲染剩余正文。
 */
import { useEffect, useRef, useState } from 'react'
import { IconCopyOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { buildCardSrcDoc, parseCardBridgeMessage } from '../core/cardFrame.js'
import { stripDisplayMeta } from '../core/displaySanitize.js'
import { Avatar, IconBtn, useLoader, useToast } from './util.js'
import type { TavernRemote } from './types.js'
import './styles.js'

function SpeechHtmlFrame(props: {
  srcDoc: string
  title: string
  widget: boolean
  onSwipeGreeting?: (index: number) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [frameH, setFrameH] = useState<number | null>(null)

  useEffect(() => {
    setFrameH(null)
  }, [props.srcDoc])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (iframeRef.current && e.source !== iframeRef.current.contentWindow) return
      const parsed = parseCardBridgeMessage(e.data)
      if (!parsed) return
      if (parsed.action === 'swipeGreeting' && typeof parsed.index === 'number') {
        props.onSwipeGreeting?.(parsed.index)
      }
      if (parsed.action === 'resize' && typeof parsed.height === 'number' && Number.isFinite(parsed.height)) {
        setFrameH(Math.min(8000, Math.max(80, Math.ceil(parsed.height))))
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [props.onSwipeGreeting])

  const frameStyle =
    frameH != null
      ? { height: frameH, minHeight: 0, overflow: 'hidden' as const }
      : props.widget
        ? { height: 280, minHeight: 0 }
        : undefined

  return (
    <iframe
      ref={iframeRef}
      className={`dsh-tavern-speechHtml${props.widget ? ' is-widget' : ''}`}
      sandbox="allow-scripts"
      srcDoc={props.srcDoc}
      title={props.title}
      style={frameStyle}
    />
  )
}

export function SpeechBubble(props: {
  remote: TavernRemote
  sessionId: string
  cardId: string
  name: string
  rawText: string
  streaming?: boolean
  onSwipeGreeting?: (index: number) => void
}) {
  const { remote, sessionId, cardId, name, rawText, streaming, onSwipeGreeting } = props
  const avatar = useLoader(() => remote.getAvatar({ cardId }), [cardId], Boolean(cardId))
  const rendered = useLoader(
    () => remote.renderOutputText({ sessionId, text: rawText }),
    [sessionId, rawText],
    Boolean(rawText) && !streaming,
  )
  const avatarUrl = avatar.state.status === 'ready' ? avatar.state.value.dataUrl : null
  const htmls =
    !streaming && rendered.state.status === 'ready'
      ? rendered.state.value.htmls && rendered.state.value.htmls.length > 0
        ? rendered.state.value.htmls
        : rendered.state.value.html
          ? [rendered.state.value.html]
          : []
      : []
  const text =
    !streaming && rendered.state.status === 'ready' ? rendered.state.value.text : stripDisplayMeta(rawText)
  const whitelist = rendered.state.status === 'ready' ? rendered.state.value.whitelist : []
  const greetings = rendered.state.status === 'ready' ? rendered.state.value.greetings ?? [] : []
  const greetingIndex = rendered.state.status === 'ready' ? rendered.state.value.greetingIndex ?? 0 : 0
  const canSwipe =
    rendered.state.status === 'ready' ? rendered.state.value.canSwipeGreeting !== false : false
  const toast = useToast()

  /** 复制纯文本：优先 navigator.clipboard，沙盒/权限被拒时回退 execCommand。 */
  const onCopy = async () => {
    const plain = text || stripDisplayMeta(rawText)
    const fallback = () => {
      try {
        const ta = document.createElement('textarea')
        ta.value = plain
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        ta.remove()
        toast.show(ok ? '已复制消息文本' : '复制失败')
      } catch {
        toast.show('复制失败')
      }
    }
    try {
      await navigator.clipboard.writeText(plain)
      toast.show('已复制消息文本')
    } catch {
      fallback()
    }
  }
  const frames = htmls.map((html, i) => {
    const srcDoc = buildCardSrcDoc(html, { greetings, greetingIndex, connectHosts: whitelist })
    const widget = htmls.length > 1 ? i > 0 : Boolean(text)
    return (
      <SpeechHtmlFrame
        key={`${i}:${html.length}`}
        srcDoc={srcDoc}
        title={name}
        widget={widget}
        onSwipeGreeting={canSwipe ? onSwipeGreeting : undefined}
      />
    )
  })

  return (
    <div className="dsh-tavern-speech dsh-tavern-rise">
      <Avatar url={avatarUrl} name={name} size={40} className="dsh-tavern-speechAvatar" />
      <div className="dsh-tavern-speechBody">
        <div className="dsh-tavern-speechName">{name}</div>
        {frames}
        {(frames.length === 0 || text) && <MarkdownText text={text || ' '} streaming={Boolean(streaming)} />}
      </div>
      <div className="dsh-tavern-speechCopy">
        <IconBtn label="复制消息文本" onClick={() => void onCopy()}>
          <IconCopyOutline16 />
        </IconBtn>
      </div>
      {toast.node}
    </div>
  )
}
