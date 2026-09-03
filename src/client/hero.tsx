/**
 * 新会话英雄区的角色卡选择（slot conversation.input.dock）。
 *
 * 平台英雄行只有 workspace / agentPreset 两个座位，角色芯片经 portal 并入该行。
 * 选中角色卡后先预览开场白，点「开始对话」再写入日志；封面 HTML 在聊天区渲染。
 * 开场白 swipe 也可在进入对话之后的 assistant 工具栏右侧使用。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { BINDING_CHANGED_EVENT } from './actions.js'
import { bindingFromDefaults } from './chip.js'
import { useT } from './i18n.js'
import { isTavernSession, type UseSessions } from './mode.js'
import { TavernSeatChip } from './seatChip.js'
import type { CharacterDetail, CharacterSummary, SessionBinding, TavernRemote } from './types.js'
import { Avatar, Btn, errOf, Skeleton, useLoader } from './util.js'
import { expandIdentityMacros } from '../core/macros.js'
import { DEFAULT_USER_NAME } from '../core/persona.js'
import './styles.js'

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
  return [detail.firstMes, ...detail.alternateGreetings]
}

interface HeroSession {
  blank?: boolean
  // 0.1.2 起 SessionSnapshot 移除 composerPhase；promptAttempted 是原 blank→engaging
  // 相位边的粘性标记（首次发送前置位、永不复位），用它表达「还没动过输入框」。
  promptAttempted?: boolean
}

export function TavernHeroCharacter(props: {
  remote: TavernRemote
  sessionId: string
  sessions: { open(id: string): void }
  session?: HeroSession
  useSessions?: UseSessions
}) {
  const { remote, sessionId, session } = props
  const t = useT()
  const tavern = isTavernSession(props.useSessions, sessionId)
  const showHero = tavern && session?.blank === true && session.promptAttempted !== true
  const dockRef = useRef<HTMLDivElement | null>(null)
  const [chipHost, setChipHost] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bindingLoader = useLoader(() => remote.getSessionBinding({ sessionId }), [sessionId], showHero)
  const binding: SessionBinding | null = bindingLoader.state.status === 'ready' ? bindingLoader.state.value.binding : null
  const userName =
    bindingLoader.state.status === 'ready' ? (bindingLoader.state.value.userName || DEFAULT_USER_NAME) : DEFAULT_USER_NAME

  const charsLoader = useLoader(() => remote.listCharacters({}), [sessionId], showHero)
  const characters: CharacterSummary[] = charsLoader.state.status === 'ready' ? charsLoader.state.value.items : []

  const detailLoader = useLoader(
    () => remote.getCharacterDetail({ cardId: binding!.cardId }),
    [binding?.cardId],
    showHero && binding !== null,
  )
  const avatarLoader = useLoader(
    () => remote.getAvatar({ cardId: binding!.cardId }),
    [binding?.cardId],
    showHero && binding !== null,
  )

  useEffect(() => {
    if (!showHero) return
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<string>).detail === sessionId) bindingLoader.reload()
    }
    window.addEventListener(BINDING_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(BINDING_CHANGED_EVENT, onChanged)
    // reload 随 loader 每次 render 换新引用，只跟会话走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHero, sessionId])

  /** 用户正在点选角色：不要把刚写入的绑定当成「上次留下的」清掉。 */
  const picking = useRef(false)
  const clearing = useRef(false)
  /** 每个空白会话只清一次陈旧绑定；之后用户点选的角色要留着预览。 */
  const sweptSession = useRef<string | null>(null)

  useEffect(() => {
    sweptSession.current = null
    picking.current = false
  }, [sessionId])

  // 新对话常会复用仍空白的 Tavern 会话；清掉上次留下的角色绑定，才能切回其他模式。
  useEffect(() => {
    if (!showHero) {
      picking.current = false
      return
    }
    if (picking.current || busy || clearing.current) return
    if (bindingLoader.state.status !== 'ready') return
    if (sweptSession.current === sessionId) return
    sweptSession.current = sessionId
    if (!binding) return
    clearing.current = true
    void (async () => {
      try {
        if (picking.current) return
        const r = await remote.clearSessionBinding({ sessionId })
        if (picking.current) return
        const err = errOf(r)
        if (err) {
          setError(err)
          return
        }
        window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
        bindingLoader.reload()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        clearing.current = false
      }
    })()
    // reload 随 loader 每次 render 换新引用；只跟空白会话上的陈旧绑定走。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHero, bindingLoader.state.status, binding?.cardId, sessionId])

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
  const chipLabel = binding ? (detail?.name ?? selected?.name ?? t('hero.characterFallback')) : t('hero.pickCharacter')
  const variants = detail ? greetingVariants(detail) : []
  const greetingIndex = binding?.greetingIndex ?? 0
  const greetingText = detail
    ? expandIdentityMacros(
        variants[greetingIndex] ?? variants[0] ?? '',
        { char: detail?.name ?? chipLabel, user: userName },
      )
    : ''
  const hasAnyGreeting = variants.some((v) => v.trim() !== '')
  // 头像旁的元信息行：作者 / 版本 / 前三个标签，有才显示。
  const metaParts: string[] = []
  if (detail?.creator) metaParts.push(t('hero.creator', { name: detail.creator }))
  if (detail?.characterVersion) metaParts.push(`v${detail.characterVersion}`)
  if (detail && detail.tags.length > 0) metaParts.push(detail.tags.slice(0, 3).join(' · '))

  const pickCharacter = async (cardId: string) => {
    if (!cardId || busy) return
    picking.current = true
    sweptSession.current = sessionId
    setBusy(true)
    setError(null)
    try {
      while (clearing.current) await new Promise((resolve) => setTimeout(resolve, 20))
      // 点选角色始终重新读取默认配置；不能复用清扫请求发出前 render 闭包里的陈旧 binding。
      const next = await bindingFromDefaults(remote, sessionId, cardId)
      const saved = await remote.setSessionBinding({ binding: next })
      const saveErr = errOf(saved)
      if (saveErr) {
        setError(saveErr)
        return
      }
      window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
      bindingLoader.reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const startConversation = async () => {
    if (!binding || busy) return
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
      const entered = await remote.ensureGreeting({ sessionId })
      const enterErr = errOf(entered)
      if (enterErr) setError(enterErr)
      else if (entered.ok && !entered.value.created) {
        setError(t('hero.error.enterFailed'))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  /** 空白页只改绑定下标，不 fork、不写日志，以免毁掉可复用的空白会话。 */
  const swipeTo = async (index: number) => {
    if (!binding || busy) return
    setBusy(true)
    setError(null)
    try {
      const saved = await remote.setSessionBinding({ binding: { ...binding, greetingIndex: index } })
      const saveErr = errOf(saved)
      if (saveErr) setError(saveErr)
      else {
        window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
        bindingLoader.reload()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const swipe = async (delta: number) => {
    if (!binding || variants.length < 2) return
    const next = ((greetingIndex + delta) % variants.length + variants.length) % variants.length
    await swipeTo(next)
  }

  const chip = (
    <span data-tavern-hero-seat="" className="dsh-tavern-ui">
      <Menu
        open={open}
        portal
        compact
        align="start"
        selectedId={binding?.cardId}
        onClose={() => setOpen(false)}
        onSelect={(id: string) => {
          setOpen(false)
          void pickCharacter(id)
        }}
        items={
          characters.length === 0
            ? [{ id: '__empty__', label: charsLoader.state.status === 'loading' ? t('hero.loadingCharacters') : t('hero.noCharacters'), disabled: true }]
            : characters.map((c) => ({
                id: c.cardId,
                label: !c.hasCharacterBook
                  ? c.name
                  : typeof c.characterBookEntryCount === 'number' && c.characterBookEntryCount > 0
                    ? t('hero.pickBook.withCount', { name: c.name, count: c.characterBookEntryCount })
                    : t('hero.pickBook.noCount', { name: c.name }),
              }))
        }
        anchor={
          <TavernSeatChip
            label={chipLabel}
            title={t('hero.pickCharacter')}
            avatarUrl={avatar}
            open={open}
            loading={bindingLoader.state.status === 'loading'}
            disabled={busy}
            onClick={() => setOpen((v: boolean) => !v)}
          />
        }
      />
    </span>
  )

  return (
    <div ref={dockRef} data-tavern-hero-root="" className="dsh-tavern-ui">
      {chipHost ? createPortal(chip, chipHost) : chip}
      {error && <div className="dsh-tavern-hero-error">{error}</div>}
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
            <div className="dsh-tavern-hero-previewText">{t('hero.detailLoadFailed')}</div>
          ) : greetingText ? (
            <div className="dsh-tavern-hero-quote">{greetingText}</div>
          ) : hasAnyGreeting ? (
            <div className="dsh-tavern-hero-previewText">{t('hero.emptyVariantHint')}</div>
          ) : (
            <div className="dsh-tavern-hero-previewText">{t('hero.noGreetingHint')}</div>
          )}
          <div className="dsh-tavern-hero-actions">
            <Btn primary size="md" disabled={busy} onClick={() => void startConversation()}>
              {t('hero.start')}
            </Btn>
            {variants.length > 1 && (
              <div className="dsh-tavern-hero-swipe">
                <button
                  type="button"
                  className="dsh-tavern-hero-swipeBtn"
                  disabled={busy}
                  title={t('hero.prevGreeting')}
                  onClick={() => void swipe(-1)}
                >
                  <IconChevronLeftOutline14 />
                </button>
                <span className="dsh-tavern-hero-swipeIdx">
                  {greetingIndex + 1}/{variants.length}
                </span>
                <button
                  type="button"
                  className="dsh-tavern-hero-swipeBtn"
                  disabled={busy}
                  title={t('hero.nextGreeting')}
                  onClick={() => void swipe(1)}
                >
                  <IconChevronRightOutline14 />
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
