/**
 * 新会话英雄区的角色卡选择（slot conversation.input.dock）。
 *
 * 平台英雄行只有 workspace / agentPreset 两个座位，角色芯片经 portal 并入该行。
 * 选中角色卡后先预览开场白，点「开始对话」再写入日志；封面 HTML 在聊天区渲染。
 * 开场白 swipe 也可在进入对话之后的 assistant 工具栏右侧使用。
 */
import { describeError } from '../core/guards.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconChevronLeftOutlineMedium,
  IconChevronRightOutlineMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { CharacterPicker, rememberCharacter } from './characterPicker.js'
import { BINDING_CHANGED_EVENT } from './actions.js'
import { CHARACTER_CHANGED_EVENT, cachedAvatar, cachedCharacterDetail, invalidateSessionBinding } from './cache.js'
import { bindingFromDefaults } from './chip.js'
import { useDisplaySettingsRevision } from './displayPrefs.js'
import { useT } from './i18n.js'
import { isTavernSession, type UseSessions } from './mode.js'
import { useSessionView } from './sessionViews.js'
import { TavernSeatChip } from './seatChip.js'
import type { CharacterDetail, CharacterSummary, SessionBinding, TavernRemote } from './types.js'
import { Avatar, Btn, Err, errOf, Skeleton, useLoader } from './util.js'
import { expandIdentityMacros } from '../core/macros.js'
import { cardGreetingVariants } from '../core/greetingLog.js'
import { normalizeHostMarkdown } from '../core/hostMarkdown.js'
import { DEFAULT_USER_NAME } from '../core/persona.js'
import { formatPlainDetailsText, parsePlainDetailsBlocks } from '../core/plainDetails.js'
import './styles.js'

/** 英雄区写操作的有界等待：宿主 RPC 可能永不返回，超时必须明确失败而不是无限等待。 */
const HERO_WRITE_TIMEOUT_MS = 20_000

/** race 出结果或超时后立即清掉定时器；卸载后不再排队。 */
function withWriteTimeout<T>(pending: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(onTimeout()), ms) }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}

/** 开场白只读展示与聊天共用服务端处理；纯 `<details>` 展开为可读正文，真实互动 HTML 只提示，避免源码泄露或提前执行脚本。 */
function GreetingPreview(props: {
  remote: TavernRemote
  sessionId: string
  text: string
  interactiveCards?: boolean | null
  cardId?: string
  characterRevision?: string
  presetId?: string | null
}) {
  const t = useT()
  const displaySettingsRevision = useDisplaySettingsRevision()
  const preview = useLoader(
    () => props.remote.renderOutputText({ sessionId: props.sessionId, text: props.text }),
    [props.sessionId, props.text, props.interactiveCards, props.cardId, props.characterRevision, props.presetId, displaySettingsRevision],
  )
  if (preview.state.status === 'error') return <Err message={preview.state.message} />
  if (preview.state.status !== 'ready') return <Skeleton />
  const value = preview.state.value
  const interactive = props.interactiveCards !== false && value.interactiveCards !== false
  const chunks: string[] = []
  let hasInteractiveHtml = false
  if (value.parts && value.parts.length > 0) {
    for (const part of value.parts) {
      if (part.kind === 'markdown') {
        const shown = interactive ? normalizeHostMarkdown(part.text) : part.text
        if (shown.trim()) chunks.push(shown)
      } else if (interactive) {
        const details = part.title === undefined ? parsePlainDetailsBlocks(part.text) : null
        if (details) {
          const expanded = formatPlainDetailsText(details)
          if (expanded.trim()) chunks.push(expanded)
        } else {
          hasInteractiveHtml = true
        }
      }
    }
  } else {
    const shown = interactive ? normalizeHostMarkdown(value.text) : value.text
    if (shown) chunks.push(shown)
    if (interactive) {
      for (const html of value.htmls) {
        const details = parsePlainDetailsBlocks(html)
        if (details) {
          const expanded = formatPlainDetailsText(details)
          if (expanded.trim()) chunks.push(expanded)
        } else {
          hasInteractiveHtml = true
        }
      }
    }
  }
  const visibleText = chunks.join('\n\n')
  return <>{visibleText}{hasInteractiveHtml && <span>{t('hero.interactiveGreeting')}</span>}</>
}

/** 芯片只能并入英雄行，绝不能塞进模式选择按钮内部（会把菜单点坏）。 */
function isSafeChipHost(el: HTMLElement, from: HTMLElement): boolean {
  return el.tagName !== 'BUTTON' && el.closest('button') === null && el !== from && !from.contains(el)
}

/** 从 dock 节点向上找英雄芯片行（workspace + 模式选择所在的 flex 行）。 */
function findHeroChipRow(from: HTMLElement | null): HTMLElement | null {
  const seat = from?.closest('[data-composer-seat]')
  if (!(seat instanceof HTMLElement) || !from) return null
  let node: HTMLElement | null = from
  while (node && node !== seat) {
    const prev = node.previousElementSibling
    if (prev instanceof HTMLElement && isSafeChipHost(prev, from) && prev.querySelector('button[aria-haspopup="menu"]')) {
      return prev
    }
    node = node.parentElement
  }
  const buttons = Array.from(seat.querySelectorAll('button[aria-haspopup="menu"]')).filter(
    (b) => !b.closest('[data-tavern-hero-seat]'),
  )
  for (const btn of buttons) {
    let parent = btn.parentElement
    while (parent && parent !== seat) {
      if (
        isSafeChipHost(parent, from) &&
        getComputedStyle(parent).display === 'flex' &&
        parent.querySelectorAll('button[aria-haspopup="menu"]').length >= 2
      ) {
        return parent
      }
      parent = parent.parentElement
    }
  }
  return null
}

function greetingVariants(detail: CharacterDetail): string[] {
  return cardGreetingVariants(detail.firstMes, detail.alternateGreetings)
}

interface HeroSession {
  blank?: boolean
  // 0.1.2 起 SessionSnapshot 移除 composerPhase；promptAttempted 是原 blank→engaging
  // 相位边的粘性标记（首次发送前置位、永不复位），用它表达「还没动过输入框」。
  promptAttempted?: boolean
}

interface HeroProps {
  remote: TavernRemote
  sessionId: string
  sessions: { open(id: string): void; refresh?: () => Promise<void> }
  session?: HeroSession
  useSessions?: UseSessions
}

/** 会话切换时卸载旧选择器，异步结果不能把忙碌态、错误或弹窗带到新会话。 */
export function TavernHeroCharacter(props: HeroProps) {
  return <HeroCharacterSession key={props.sessionId} {...props} />
}

function HeroCharacterSession(props: HeroProps) {
  const { remote, sessionId, session } = props
  const t = useT()
  const tavern = isTavernSession(props.useSessions, sessionId)
  // 英雄区只在会话被显示时挂载；登记后无会话补偿与消息排版都能判断当前视图。
  useSessionView(sessionId, tavern)
  const eligible = tavern && session?.blank === true && session.promptAttempted !== true
  const [entered, setEntered] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const dockRef = useRef<HTMLDivElement | null>(null)
  const [chipHost, setChipHost] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 空白判定涉及写操作，不使用可能仍缓存着「未开始」的绑定快照。
  const bindingLoader = useLoader(() => remote.getSessionBinding({ sessionId }), [sessionId], eligible)
  const lastBinding = useRef<{ sessionId: string; binding: SessionBinding | null; userName: string } | null>(null)
  if (lastBinding.current && lastBinding.current.sessionId !== sessionId) {
    lastBinding.current = null
  }
  if (bindingLoader.state.status === 'ready') {
    lastBinding.current = {
      sessionId,
      binding: bindingLoader.state.value.binding,
      userName: bindingLoader.state.value.userName || DEFAULT_USER_NAME,
    }
  }
  const started = bindingLoader.state.status === 'ready' && bindingLoader.state.value.conversationStarted
  const showHero = eligible && !entered && !started
  useEffect(() => {
    if (eligible && started) void props.sessions.refresh?.().catch(() => {})
  }, [eligible, started, props.sessions])
  // 重载期间保留同一会话的已知绑定，切开场白时不卸载预览卡片、不丢失键盘焦点。
  const binding: SessionBinding | null = bindingLoader.state.status === 'ready'
    ? bindingLoader.state.value.binding
    : bindingLoader.state.status === 'loading' && lastBinding.current?.sessionId === sessionId
      ? lastBinding.current.binding
      : null
  const userName = bindingLoader.state.status === 'ready'
    ? (bindingLoader.state.value.userName || DEFAULT_USER_NAME)
    : bindingLoader.state.status === 'loading' && lastBinding.current?.sessionId === sessionId
      ? lastBinding.current.userName
      : DEFAULT_USER_NAME

  const charsLoader = useLoader(() => remote.listCharacters({}), [sessionId], showHero)
  const characters: CharacterSummary[] = charsLoader.state.status === 'ready' ? charsLoader.state.value.items : []

  const detailLoader = useLoader(
    () => cachedCharacterDetail(remote, binding!.cardId),
    [binding?.cardId],
    showHero && binding !== null,
  )
  const avatarLoader = useLoader(
    () => cachedAvatar(remote, binding!.cardId),
    [binding?.cardId],
    showHero && binding !== null,
  )

  useEffect(() => {
    if (!showHero || !binding) return
    const onCharacterChanged = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== binding.cardId) return
      detailLoader.reload()
      avatarLoader.reload()
      charsLoader.reload()
    }
    window.addEventListener(CHARACTER_CHANGED_EVENT, onCharacterChanged)
    return () => window.removeEventListener(CHARACTER_CHANGED_EVENT, onCharacterChanged)
  }, [showHero, binding?.cardId, detailLoader.reload, avatarLoader.reload, charsLoader.reload])

  /** 用户正在点选角色：不要把刚写入的绑定当成「上次留下的」清掉。 */
  const picking = useRef(false)
  /** 外部（如头部 chip）已修改当前会话绑定：取消本会话的自动清扫，避免误删刚保存的绑定。 */
  const externalBindingChanged = useRef(false)
  /** 区分自身清扫派发的绑定变更事件与外部保存事件。 */
  const dispatchingSweep = useRef(false)
  /** 选卡/开聊/切开场白共用同步互斥锁，防止 React 提交 busy 前连点触发并发写入。 */
  const writing = useRef(false)
  /** 进行中的陈旧绑定清扫；点选角色要等它结束（有界），不再用定时器轮询。 */
  const clearing = useRef<Promise<void> | null>(null)
  const clearingSerial = useRef(0)
  /** 每个空白会话只清一次陈旧绑定；失败不算完成，可显式重试。 */
  const sweptSession = useRef<string | null>(null)
  const [sweepRetry, setSweepRetry] = useState(0)
  const [sweepFailed, setSweepFailed] = useState(false)

  useEffect(() => {
    sweptSession.current = null
    picking.current = false
    externalBindingChanged.current = false
    setSweepFailed(false)
  }, [sessionId])

  useEffect(() => {
    if (!showHero) return
    const onChanged = (e: Event) => {
      const target = (e as CustomEvent<string | undefined>).detail
      if (!target || target === sessionId) {
        if (!dispatchingSweep.current && target === sessionId) {
          externalBindingChanged.current = true
          sweptSession.current = sessionId
          setSweepFailed(false)
        }
        bindingLoader.reload()
      }
    }
    window.addEventListener(BINDING_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(BINDING_CHANGED_EVENT, onChanged)
    // reload 随 loader 每次 render 换新引用，只跟会话走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHero, sessionId])

  // 新对话常会复用仍空白的 Tavern 会话；清掉上次留下的角色绑定，才能切回其他模式。
  useEffect(() => {
    if (!showHero) {
      picking.current = false
      return
    }
    if (picking.current || externalBindingChanged.current || busy || clearing.current) return
    if (bindingLoader.state.status !== 'ready') return
    if (sweptSession.current === sessionId) return
    sweptSession.current = sessionId
    if (!binding) return
    const serial = ++clearingSerial.current
    clearing.current = (async () => {
      try {
        if (picking.current || externalBindingChanged.current) return
        // 宿主写入可能永不返回；有界等待，超时明确失败而不是无上限轮询。
        const r = await withWriteTimeout(remote.clearSessionBinding({ sessionId, onlyIfBlank: true }), HERO_WRITE_TIMEOUT_MS, () => new Error(t('util.loadTimeout')))
        if (picking.current || externalBindingChanged.current || !alive.current) return
        const err = errOf(r)
        if (err) {
          sweptSession.current = null
          setSweepFailed(true)
          setError(err)
          return
        }
        if (r.ok && !r.value.cleared) setEntered(true)
        setSweepFailed(false)
        invalidateSessionBinding(sessionId)
        dispatchingSweep.current = true
        try {
          window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
        } finally {
          dispatchingSweep.current = false
        }
        bindingLoader.reload()
      } catch (cause) {
        if (!alive.current || externalBindingChanged.current) return
        if (picking.current) {
          // 用户已开始选卡：仍提示清扫失败/超时，但不能重置 sweptSession 或置 sweepFailed，
          // 否则选卡完成后会把刚选好的新角色当成陈旧绑定再次清扫。
          setError(describeError(cause))
          return
        }
        // 失败不能消费一次性标记：留出重试入口，避免陈旧绑定继续被用来开始对话。
        sweptSession.current = null
        setSweepFailed(true)
        setError(describeError(cause))
      }
    })().finally(() => { if (clearingSerial.current === serial) clearing.current = null })
    // reload 随 loader 每次 render 换新引用；只跟空白会话上的陈旧绑定走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHero, bindingLoader.state.status, binding?.cardId, sessionId, sweepRetry])

  useLayoutEffect(() => {
    if (!showHero) {
      setChipHost(null)
      return
    }
    const apply = (): HTMLElement | null => {
      const host = findHeroChipRow(dockRef.current)
      setChipHost((prev) => (prev === host ? prev : host))
      return host
    }
    if (apply()) return
    const seat = dockRef.current?.closest('[data-composer-seat]')
    const root = seat instanceof HTMLElement ? seat : document.body
    const obs = new MutationObserver(() => {
      if (apply()) obs.disconnect()
    })
    obs.observe(root, { childList: true, subtree: true })
    const timer = window.setTimeout(() => {
      apply()
      obs.disconnect()
    }, 2000)
    return () => {
      obs.disconnect()
      window.clearTimeout(timer)
    }
  }, [showHero, sessionId, binding?.cardId])

  if (!showHero) return null

  const detail = detailLoader.state.status === 'ready' ? detailLoader.state.value : null
  const avatar = avatarLoader.state.status === 'ready' ? avatarLoader.state.value.dataUrl : null
  const selected = binding ? characters.find((c) => c.cardId === binding.cardId) : undefined
  const chipLabel = binding ? (detail?.name ?? selected?.name ?? binding.cardName ?? t('hero.characterFallback')) : t('hero.pickCharacter')
  const variants = detail ? greetingVariants(detail) : []
  // 编辑角色卡会缩短开场白列表，旧空白会话仍可能保存着原下标。预览、计数与
  // 键盘翻页都以同一安全下标为准，避免正文回退到第一条却显示成“8/2”。
  const storedGreetingIndex = binding?.greetingIndex ?? 0
  const greetingIndex = Number.isSafeInteger(storedGreetingIndex)
    && storedGreetingIndex >= 0 && storedGreetingIndex < variants.length ? storedGreetingIndex : 0
  const greetingText = detail
      ? expandIdentityMacros(
        variants[greetingIndex] ?? variants[0] ?? '',
        { char: detail?.characterName ?? detail?.name ?? chipLabel, user: userName },
      )
    : ''
  const hasAnyGreeting = variants.some((v) => v.trim() !== '')
  // 头像旁的元信息行：作者 / 版本 / 前三个标签，有才显示。
  const metaParts: string[] = []
  if (detail?.creator) metaParts.push(t('hero.creator', { name: detail.creator }))
  if (detail?.characterVersion) metaParts.push(`v${detail.characterVersion}`)
  if (detail && detail.tags.length > 0) metaParts.push(detail.tags.slice(0, 3).join(' · '))

  const pickCharacter = async (cardId: string) => {
    if (!cardId || busy || writing.current) return
    writing.current = true
    picking.current = true
    sweptSession.current = sessionId
    setBusy(true)
    setError(null)
    try {
      // 等待进行中的清扫结束（清扫自身有界）；不再用 20ms 定时器轮询，卸载后立即退出。
      const pending = clearing.current
      const syncFailedPick = () => {
        picking.current = false
        if (pending && clearing.current === null && alive.current) {
          invalidateSessionBinding(sessionId)
          window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
          bindingLoader.reload()
        }
      }
      if (pending) await pending
      if (!alive.current) return
      // 点选角色始终重新读取默认配置；不能复用清扫请求发出前 render 闭包里的陈旧 binding。
      const next = await withWriteTimeout(bindingFromDefaults(remote, sessionId, cardId), HERO_WRITE_TIMEOUT_MS, () => new Error(t('util.loadTimeout'))).catch((e) => { syncFailedPick(); throw e })
      if (!alive.current) return
      const saved = await withWriteTimeout(remote.setSessionBinding({ binding: next }), HERO_WRITE_TIMEOUT_MS, () => new Error(t('util.loadTimeout'))).catch((e) => { syncFailedPick(); throw e })
      if (!alive.current) return
      const saveErr = errOf(saved)
      if (saveErr) {
        syncFailedPick()
        setError(saveErr)
        return
      }
      invalidateSessionBinding(sessionId)
      window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
      bindingLoader.reload()
      rememberCharacter(remote, cardId)
      setOpen(false)
    } catch (cause) {
      if (alive.current) setError(describeError(cause))
    } finally {
      writing.current = false
      if (alive.current) setBusy(false)
    }
  }

  const startConversation = async () => {
    if (!binding || busy || writing.current) return
    writing.current = true
    picking.current = true
    setBusy(true)
    setError(null)
    try {
      if (!greetingText.trim() && hasAnyGreeting) {
        setError(t('hero.error.emptyGreetingVariant'))
        return
      }
      if (!greetingText.trim()) {
        setError(t('hero.error.noGreetingInput'))
        return
      }
      const entered = await withWriteTimeout(remote.ensureGreeting({ sessionId }), HERO_WRITE_TIMEOUT_MS, () => new Error(t('util.loadTimeout')))
      const enterErr = errOf(entered)
      if (enterErr) {
        if (alive.current) setError(enterErr)
      } else if (entered.ok) {
        if (entered.value.created || entered.value.conversationStarted) {
          invalidateSessionBinding(sessionId)
          window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
          if (!alive.current) return
          setEntered(true)
          // 插件直接追加日志不会经过宿主 send；主动同步 blank，解除空白会话复用。
          try {
            await props.sessions.refresh?.()
          } catch (cause) {
            if (alive.current) setEntered(false)
            throw cause
          }
        } else if (alive.current) setError(t('hero.error.enterFailed'))
      }
    } catch (cause) {
      if (alive.current) setError(describeError(cause))
    } finally {
      writing.current = false
      if (alive.current) setBusy(false)
    }
  }

  /** 空白页只改绑定下标，不 fork、不写日志，以免毁掉可复用的空白会话。 */
  const swipeTo = async (index: number) => {
    if (!binding || busy || writing.current) return
    writing.current = true
    setBusy(true)
    setError(null)
    try {
      const saved = await withWriteTimeout(remote.setSessionBinding({ binding: { ...binding, greetingIndex: index } }), HERO_WRITE_TIMEOUT_MS, () => new Error(t('util.loadTimeout')))
      const saveErr = errOf(saved)
      if (saveErr) {
        if (alive.current) setError(saveErr)
      } else {
        invalidateSessionBinding(sessionId)
        window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
        if (alive.current) bindingLoader.reload()
      }
    } catch (cause) {
      if (alive.current) setError(describeError(cause))
    } finally {
      writing.current = false
      if (alive.current) setBusy(false)
    }
  }

  const swipe = async (delta: number) => {
    if (!binding || variants.length < 2) return
    const next = ((greetingIndex + delta) % variants.length + variants.length) % variants.length
    await swipeTo(next)
  }

  const chip = (
    <span data-tavern-hero-seat="" className="dsh-tavern-ui">
      <TavernSeatChip label={chipLabel} title={t('hero.pickCharacter')} avatarUrl={avatar}
        open={open} hasPopup="dialog" loading={bindingLoader.state.status === 'loading' && lastBinding.current?.sessionId !== sessionId} disabled={busy}
        onClick={() => { setError(null); setOpen(true) }} />
    </span>
  )

  return (
    <div ref={dockRef} data-tavern-hero-root="" className="dsh-tavern-ui">
      {chipHost ? createPortal(chip, chipHost) : chip}
      {open && <CharacterPicker remote={remote} selectedId={binding?.cardId} busy={busy} error={error}
        onPick={(id) => void pickCharacter(id)} onClose={() => setOpen(false)} />}
      {error && (sweepFailed
        ? <div role="alert" className="dsh-tavern-hero-error">
            {error}
            <Btn disabled={busy} onClick={() => { setSweepFailed(false); setError(null); setSweepRetry((n) => n + 1) }}>{t('action.retry')}</Btn>
          </div>
        : <div className="dsh-tavern-hero-error">{error}</div>)}
      {bindingLoader.state.status === 'error' && <div role="alert" className="dsh-tavern-hero-error">
        {bindingLoader.state.message}
        <Btn onClick={bindingLoader.reload} disabled={busy}>{t('action.retry')}</Btn>
      </div>}
      {binding && detailLoader.state.status === 'loading' && (
        <div className="dsh-tavern-hero-preview" aria-busy="true">
          <div className="dsh-tavern-hero-previewHead">
            <Skeleton width={28} height={28} radius={999} />
            <Skeleton width={140} height={14} />
          </div>
          <Skeleton height={14} style={{ marginTop: 14 }} />
          <Skeleton height={14} width="72%" style={{ marginTop: 8 }} />
          <Skeleton height={14} width="48%" style={{ marginTop: 8 }} />
          <Skeleton height={32} width={104} radius={18} style={{ marginTop: 14 }} />
        </div>
      )}
      {binding && detailLoader.state.status !== 'loading' && (
        <div
          className="dsh-tavern-hero-preview dsh-tavern-rise"
          tabIndex={variants.length > 1 ? 0 : undefined}
          onKeyDown={(e: { key: string; target: unknown; currentTarget: unknown; preventDefault: () => void }) => {
            // ←/→ 切换开场白变体；只在卡片本身聚焦时响应，避免抢子按钮的键盘事件
            if (variants.length < 2 || e.target !== e.currentTarget) return
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              void swipe(-1)
            } else if (e.key === 'ArrowRight') {
              e.preventDefault()
              void swipe(1)
            }
          }}
        >
          <div className="dsh-tavern-hero-previewHead">
            <Avatar url={avatar} name={chipLabel} size={40} className="dsh-tavern-speechAvatar" />
            <div className="dsh-tavern-hero-previewHeadText">
              <div className="dsh-tavern-hero-previewName">{chipLabel}</div>
              {metaParts.length > 0 && <div className="dsh-tavern-hero-previewMeta">{metaParts.join(' · ')}</div>}
            </div>
          </div>
          {detailLoader.state.status === 'error' ? (
            <div className="dsh-tavern-hero-previewText" role="alert">{t('hero.detailLoadFailed')}</div>
          ) : greetingText.trim() ? (
            <div className="dsh-tavern-hero-quote"><GreetingPreview remote={remote} sessionId={sessionId} text={greetingText} interactiveCards={binding.interactiveCards} cardId={binding.cardId} characterRevision={detail?.revision} presetId={binding.presetId} /></div>
          ) : hasAnyGreeting ? (
            <div className="dsh-tavern-hero-previewText">{t('hero.emptyVariantHint')}</div>
          ) : (
            <div className="dsh-tavern-hero-previewText">{t('hero.noGreetingHint')}</div>
          )}
          <div className="dsh-tavern-hero-actions">
            <Btn primary size="md" disabled={busy || !greetingText.trim() || !detail} onClick={() => void startConversation()}>
              {t('hero.start')}
            </Btn>
            {detailLoader.state.status === 'error' && <Btn disabled={busy} onClick={detailLoader.reload}>{t('action.retry')}</Btn>}
            {variants.length > 1 && (
              <div className="dsh-tavern-hero-swipe">
                <button
                  type="button"
                  className="dsh-tavern-hero-swipeBtn"
                  disabled={busy}
                  title={t('hero.prevGreeting')}
                  aria-label={t('hero.prevGreeting')}
                  onClick={() => void swipe(-1)}
                >
                  <IconChevronLeftOutlineMedium />
                </button>
                <span className="dsh-tavern-hero-swipeIdx" role="status" aria-live="polite" aria-atomic="true">
                  {greetingIndex + 1}/{variants.length}
                </span>
                <button
                  type="button"
                  className="dsh-tavern-hero-swipeBtn"
                  disabled={busy}
                  title={t('hero.nextGreeting')}
                  aria-label={t('hero.nextGreeting')}
                  onClick={() => void swipe(1)}
                >
                  <IconChevronRightOutlineMedium />
                </button>
                <span className="dsh-tavern-hero-swipeHint">{t('hero.swipeHint')}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
