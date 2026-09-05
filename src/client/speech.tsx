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
import { restoreCardVariableBackup } from '../core/cardVariables.js'
import { stripDisplayMeta } from '../core/displaySanitize.js'
import type { TemplateDisplayPart } from '../core/templateDisplay.js'
import { cachedAvatar } from './cache.js'
import { useT, useMarkdownLabels } from './i18n.js'
import { Avatar, Btn, Dialog, Err, IconBtn, useLoader, useToast } from './util.js'
import { useDraftGuard } from './drafts.js'
import type { TavernRemote } from './types.js'
import { CARD_VARIABLE_STYLES } from './styles.js'

function SpeechHtmlFrame(props: {
  srcDoc: string
  title: string
  widget: boolean
  compact?: boolean
  onSwipeGreeting?: (index: number) => void
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [frameH, setFrameH] = useState<number | null>(null)
  const t = useT()
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [backup, setBackup] = useState('')
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [restored, setRestored] = useState<{ source: string; doc: string; revision: number } | null>(null)
  const guard = useDraftGuard(restoreOpen && backup.trim() !== '')
  const activeRestore = restored?.source === props.srcDoc ? restored : null
  const srcDoc = activeRestore?.doc ?? props.srcDoc
  const closeRestore = () => guard.request(() => { setRestoreOpen(false); setBackup('') })
  const restore = () => {
    try {
      const doc = restoreCardVariableBackup(props.srcDoc, backup)
      setRestored((current) => ({ source: props.srcDoc, doc, revision: (current?.revision ?? 0) + 1 }))
      setRestoreOpen(false)
      setBackup('')
      setRestoreError(null)
    } catch { setRestoreError(t('speech.cardDataFailed')) }
  }

  useEffect(() => {
    setFrameH(null)
  }, [srcDoc])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return
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
      : props.compact
        ? { height: 80, minHeight: 0, overflow: 'auto' as const }
      : props.widget
        ? { height: 280, minHeight: 0, overflow: 'auto' as const }
        : { overflow: 'auto' as const }

  return (
    <>
    <iframe
      key={activeRestore?.revision ?? 0}
      ref={iframeRef}
      className={`dsh-tavern-speechHtml${props.widget || props.compact ? ' is-widget' : ''}`}
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      title={props.title}
      style={frameStyle}
    />
    <div className="dsh-tavern-cardBackupBar">
      <Btn onClick={() => { setRestoreError(null); setRestoreOpen(true) }}>{t('speech.cardDataRestore')}</Btn>
    </div>
    {guard.confirmation}
    {restoreOpen && <Dialog open title={t('speech.cardDataRestore')} onClose={closeRestore}
      footer={<><Btn onClick={closeRestore}>{t('action.cancel')}</Btn><Btn primary disabled={!backup.trim()} onClick={restore}>{t('action.confirm')}</Btn></>}>
      <p>{t('speech.cardDataRestoreDesc')}</p>
      <textarea className="dsh-tavern-input dsh-tavern-textarea" aria-label={t('speech.cardDataText')}
        value={backup} onChange={(event) => setBackup(event.target.value)} />
      <Err message={restoreError} />
    </Dialog>}
    </>
  )
}

interface SpeechBubbleProps {
  remote: TavernRemote
  sessionId: string
  cardId: string
  name: string
  rawText: string
  messageId?: number
  streaming?: boolean
  /** 会话级交互卡开关（binding.interactiveCards）；null/缺省回落全局设置。 */
  interactiveCards?: boolean | null
  onSwipeGreeting?: (index: number) => void | Promise<void>
}

/** 按会话和角色卸载旧气泡状态，慢请求的报错不能留到新会话。 */
export function SpeechBubble(props: SpeechBubbleProps) {
  return <SpeechBubbleSession key={`${props.sessionId}:${props.cardId}`} {...props} />
}

function SpeechBubbleSession(props: SpeechBubbleProps) {
  const { remote, sessionId, cardId, name, rawText, streaming, onSwipeGreeting } = props
  const t = useT()
  const markdownLabels = useMarkdownLabels()
  // 头像走进程内缓存（key=cardId，TTL 60s）：同一会话的 N 条气泡不再各传一次 dataURL。
  const avatar = useLoader(() => cachedAvatar(remote, cardId), [cardId], Boolean(cardId))
  const rendered = useLoader(
    () => remote.renderOutputText({ sessionId, text: rawText, messageId: props.messageId }),
    [sessionId, rawText, props.messageId],
    Boolean(rawText) && !streaming,
  )
  const avatarUrl = avatar.state.status === 'ready' ? avatar.state.value.dataUrl : null
  // 交互卡渲染决策：会话绑定有值时优先于全局设置（renderOutputText 回包的
  // interactiveCards 即全局值）。HTML 抽取在服务端按全局开关做，会话关 → 不渲染
  // 封面 iframe；正文若已随抽取变空，回退原始文本，对齐全局关闭的「纯文本显示」。
  const interactive =
    props.interactiveCards ?? (rendered.state.status === 'ready' ? rendered.state.value.interactiveCards : true)
  const htmls =
    !streaming && interactive && rendered.state.status === 'ready'
      ? rendered.state.value.htmls && rendered.state.value.htmls.length > 0
        ? rendered.state.value.htmls
        : rendered.state.value.html
          ? [rendered.state.value.html]
          : []
      : []
  const text =
    !streaming && rendered.state.status === 'ready'
      ? interactive || rendered.state.value.text || rendered.state.value.parts !== undefined
        ? rendered.state.value.text
        : stripDisplayMeta(rawText)
      : stripDisplayMeta(rawText)
  const whitelist = rendered.state.status === 'ready' ? rendered.state.value.whitelist : []
  const greetings = rendered.state.status === 'ready' ? rendered.state.value.greetings ?? [] : []
  const greetingIndex = rendered.state.status === 'ready' ? rendered.state.value.greetingIndex ?? 0 : 0
  const canSwipe =
    rendered.state.status === 'ready' ? rendered.state.value.canSwipeGreeting !== false : false
  const toast = useToast()
  const swipeBusy = useRef(false)
  const [swipeError, setSwipeError] = useState<string | null>(null)
  const swipeGreeting = async (index: number) => {
    if (swipeBusy.current) return
    if (!canSwipe) { setSwipeError(t('speech.swipeStarted')); return }
    if (!onSwipeGreeting) { setSwipeError(t('speech.navigationUnavailable')); return }
    swipeBusy.current = true
    setSwipeError(null)
    try {
      await onSwipeGreeting(index)
    } catch (cause) {
      setSwipeError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      swipeBusy.current = false
    }
  }

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
        toast.show(ok ? t('speech.copied') : t('speech.copyFailed'))
      } catch {
        toast.show(t('speech.copyFailed'))
      }
    }
    try {
      await navigator.clipboard.writeText(plain)
      toast.show(t('speech.copied'))
    } catch {
      fallback()
    }
  }
  const storedParts = !streaming && rendered.state.status === 'ready' ? rendered.state.value.parts : undefined
  const visibleParts: TemplateDisplayPart[] = storedParts
    ? storedParts.filter(part => interactive || part.kind === 'markdown')
    : [...htmls.map(html => ({ kind: 'html' as const, text: html })), ...(text ? [{ kind: 'markdown' as const, text }] : [])]
  if (!visibleParts.length) visibleParts.push({ kind: 'markdown', text: text || ' ' })
  const content = visibleParts.map((part, i) => {
    if (part.kind === 'markdown') return <MarkdownText key={`text:${i}`} text={part.text} streaming={Boolean(streaming)} labels={markdownLabels} />
    const srcDoc = buildCardSrcDoc(part.text, { greetings, greetingIndex, connectHosts: whitelist,
      variableStyles: CARD_VARIABLE_STYLES,
      variableLabels: { title: t('speech.cardDataTitle'), note: t('speech.cardDataNote'), backup: t('speech.cardDataBackup'),
        text: t('speech.cardDataText') },
    })
    const widget = visibleParts.length > 1
    const frame = (
      <SpeechHtmlFrame
        key={`${i}:${part.text.length}`}
        srcDoc={srcDoc}
        title={part.title || name}
        widget={widget}
        compact={Boolean(storedParts)}
        onSwipeGreeting={(index) => void swipeGreeting(index)}
      />
    )
    return part.title ? <details key={`fold:${i}`} className="dsh-tavern-reason"><summary>{part.title}</summary>{frame}</details> : frame
  })

  return (
    <div className="dsh-tavern-speech dsh-tavern-rise">
      <Avatar url={avatarUrl} name={name} size={40} className="dsh-tavern-speechAvatar" />
      <div className="dsh-tavern-speechBody">
        <div className="dsh-tavern-speechName">{name}</div>
        <Err message={swipeError} />
        <Err message={rendered.state.status === 'error' ? rendered.state.message : null} />
        {content}
      </div>
      <div className="dsh-tavern-speechCopy">
        <IconBtn label={t('speech.copy')} onClick={() => void onCopy()}>
          <IconCopyOutline16 />
        </IconBtn>
      </div>
      {toast.node}
    </div>
  )
}
