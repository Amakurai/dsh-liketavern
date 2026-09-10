/**
 * 会话头部角色 chip（slot conversation.session.header.actions，session 作用域）。
 * 显示当前会话绑定的角色；点击展开绑定编辑 / 开场白 / 调试小面板。
 */
import { DraftScope } from './drafts.js'
import { MemorySection } from './panel/memory.js'
import { useEffect, useId, useRef, useState } from 'react'
import { BINDING_CHANGED_EVENT } from './actions.js'
import { cachedAvatar, cachedCharacterDetail, cachedSessionBinding, invalidateSessionBinding } from './cache.js'
import { useT } from './i18n.js'
import { isTavernSession, type UseSessions } from './mode.js'
import { openChildSession } from './openChild.js'
import { TavernSeatChip } from './seatChip.js'
import { HelperScripts } from './helperScripts.js'
import type { WorldInfoEntry } from '../core/types.js'
import { parseLorebook } from '../state/lorebook.js'
import { LorebookEditor } from './panel/lorebookEditor.js'
import type { CharacterSummary, Persona, PresetSummary, SessionBinding, TavernRemote, TavernSettings } from './types.js'
import { EMPTY_SESSION_DEFAULTS } from './types.js'
import { IconCopyOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Btn, CheckChips, ConfirmDialog, Dialog, Err, Field, IconBtn, Muted, Select, Skeleton, Tabs, Toggle, errOf, runAsync, useLoader, useToast } from './util.js'

export function defaultBinding(sessionId: string, cardId: string, defaults?: TavernSettings['defaults']): SessionBinding {
  const d = defaults ?? EMPTY_SESSION_DEFAULTS
  return {
    sessionId,
    cardId,
    presetId: d.presetId || null,
    personaId: d.personaId || null,
    lorebookIds: [...d.lorebookIds],
    characterLorebookId: d.characterLorebookId || null,
    interactiveCards: null,
    greetingIndex: 0,
    authorNote: '',
    injectJournal: false,
    createdAt: new Date().toISOString(),
  }
}

export async function bindingFromDefaults(remote: TavernRemote, sessionId: string, cardId: string): Promise<SessionBinding> {
  const r = await remote.getSettings({})
  // 读取设置失败时不能静默套用空默认值，否则一次暂时性的 RPC 故障会覆盖用户原有的绑定配置。
  if (!r.ok) throw new Error(r.error.message)
  return defaultBinding(sessionId, cardId, r.value.settings.defaults)
}

/** 独立于脚本运行器和全局交互开关的恢复入口；只在确认后放弃任务，不触碰宿主输入队列。 */
export function HelperMvuAbandonAction(props: { remote: TavernRemote; sessionId: string; storyId: string; onChanged: () => void }) {
  const t = useT(), pending = useRef(false)
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null), [done, setDone] = useState(false)
  const abandon = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(null); setDone(false)
    try {
      const result = await props.remote.abandonHelperMvu({ sessionId: props.sessionId, storyId: props.storyId })
      if (!result.ok) throw new Error(result.error.message)
      setConfirm(false); setDone(true)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { pending.current = false; setBusy(false); props.onChanged() }
  }
  return <div>
    <Btn danger disabled={busy} onClick={() => { setError(null); setDone(false); setConfirm(true) }}>{t('chip.mvuAbandon.action')}</Btn>
    {done && <Muted>{t('chip.mvuAbandon.done')}</Muted>}
    <Err message={error}/>
    <ConfirmDialog open={confirm} title={t('chip.mvuAbandon.title')} description={t('chip.mvuAbandon.desc') + (error ? '\n' + error : '')}
      confirmLabel={t('chip.mvuAbandon.action')} danger busy={busy} onCancel={() => { if (!pending.current) setConfirm(false) }} onConfirm={() => { void abandon() }}/>
  </div>
}

function PreDialog(props: { title: string; text: string; onClose: () => void }) {
  return (
    <Dialog open title={props.title} onClose={props.onClose} width="lg">
      <pre className="dsh-tavern-modalPre">{props.text}</pre>
    </Dialog>
  )
}

type PromptPreview = import('../remote.js').PromptPreview

/** 千位缩写（12.3k）；null 显示 ?。 */
function fmtTokens(n: number | null): string {
  if (n === null) return '?'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function PromptPreviewDialog(props: { data: PromptPreview; onClose: () => void }) {
  const { data } = props
  const t = useT()
  const tabsId = useId()
  const [tab, setTab] = useState<'standing' | 'turn' | 'full' | 'log' | 'actual'>('actual')
  const toast = useToast()
  const wi = data.worldInfoBudget
  const assemble = data.assembleBudget
  const body =
    tab === 'actual'
      ? data.actualRequest ? data.actualRequest.text + (data.actualRequest.truncated ? '\n' + t('chip.preview.actualTruncated') : '') : t('chip.preview.noActual')
      : tab === 'standing'
      ? data.standing || t('chip.preview.empty')
      : tab === 'turn'
        ? data.turnContext || t('chip.preview.empty')
        : tab === 'log'
          ? data.logLines.join('\n') || t('chip.preview.noLog')
          : `=== system ===\n${data.system}\n\n=== messages ===\n${data.messages.map((m) => JSON.stringify(m)).join('\n\n')}`
  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(body)
      toast.show(t('chip.preview.copied'))
    } catch {
      toast.show(t('chip.preview.copyFailed'))
    }
  }
  return (
    <Dialog open title={t('chip.preview.title')} onClose={props.onClose} width="lg">
      <Muted>{t('chip.preview.notice')}</Muted>
      <Muted>
        {t('chip.preview.budget', { used: wi.used, limit: wi.limit })}
        {wi.overflowed ? ` · ${t('chip.preview.overflowed')}` : ''}
        {' · '}
        {t('chip.preview.assemble', { after: assemble.tokensAfter, before: assemble.tokensBefore })}
        {assemble.trimmedSections.length > 0
          ? ` · ${t('chip.preview.trimmed', { sections: assemble.trimmedSections.join(t('chip.preview.listSep')) })}`
          : ''}
      </Muted>
      <div className="dsh-tavern-filters" style={{ margin: '10px 0 12px' }}>
        <Tabs
          id={tabsId} panelId={`${tabsId}-panel`} label={t('chip.preview.title')}
          size="sm"
          value={tab}
          onChange={(id) => setTab(id as typeof tab)}
          items={[
            { id: 'actual', label: t('chip.preview.actual') },
            { id: 'standing', label: 'standing' },
            { id: 'turn', label: t('chip.preview.tab.turn') },
            { id: 'full', label: t('chip.preview.tab.full') },
            { id: 'log', label: t('binding.triggerLog') },
          ]}
        />
        <span style={{ flex: 1 }} />
        <IconBtn label={t('chip.preview.copyView')} onClick={() => void copyBody()}>
          <IconCopyOutline16 />
        </IconBtn>
      </div>
      <pre id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} tabIndex={0} className="dsh-tavern-modalPre">{body}</pre>
      {toast.node}
    </Dialog>
  )
}

interface Lists {
  characters: CharacterSummary[]
  presets: PresetSummary[]
  personas: Persona[]
  lorebooks: string[]
}

export function TavernHeaderChip(props: {
  remote: TavernRemote
  sessionId: string
  sessions: { open(id: string): void; refresh?: () => Promise<void> }
  onCancel?: () => Promise<void>
  useSessions?: UseSessions
}) {
  const { remote, sessionId, sessions } = props
  const t = useT()
  const tavern = isTavernSession(props.useSessions, sessionId)
  const bindingLoader = useLoader(() => cachedSessionBinding(remote, sessionId), [sessionId], tavern)
  useEffect(()=>{const changed=(event:Event)=>{if((event as CustomEvent).detail===sessionId)bindingLoader.reload()};window.addEventListener(BINDING_CHANGED_EVENT,changed);return()=>window.removeEventListener(BINDING_CHANGED_EVENT,changed)},[sessionId,bindingLoader.reload])
  const binding = bindingLoader.state.status === 'ready' ? bindingLoader.state.value.binding : null
  const canSwipeGreeting =
    bindingLoader.state.status === 'ready' ? bindingLoader.state.value.canSwipeGreeting !== false : false
  const detail = useLoader(
    async () => {
      const [d, a] = await Promise.all([cachedCharacterDetail(remote, binding!.cardId), cachedAvatar(remote, binding!.cardId)])
      if (!d.ok) return d
      return { ok: true as const, value: { name: d.value.name, avatar: a.ok ? a.value.dataUrl : null } }
    },
    [binding?.cardId],
    tavern && binding !== null,
  )

  const listsLoader = useLoader(
    () => remote.listCharacters({}),
    [sessionId],
    tavern,
  )
  const listed = listsLoader.state.status === 'ready' ? listsLoader.state.value.items : []
  const listedName = binding ? listed.find((c) => c.cardId === binding.cardId)?.name : undefined

  const [open, setOpen] = useState(false)
  const usageLoader = useLoader(() => remote.getContextUsage({ sessionId }), [sessionId, open], tavern && open)
  const usage = usageLoader.state.status === 'ready' ? usageLoader.state.value.usage : null
  const [lists, setLists] = useState<Lists | null>(null)
  const [draft, setDraft] = useState<SessionBinding | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toast = useToast()
  const [view, setView] = useState<{ title: string; text: string } | null>(null)
  const [previewData, setPreviewData] = useState<PromptPreview | null>(null)
  const [chatLore, setChatLore] = useState<{ cardId: string; storyId?: string; entries: WorldInfoEntry[] } | null>(null)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [confirmUnbind, setConfirmUnbind] = useState(false)
  const [unbindBusy, setUnbindBusy] = useState(false)
  /** 保存/开场白/预览等写操作共用一个 busy：传输层 reject 也要显示错误并解锁，重复点击不能发出第二次请求（换开场白会再建一条分支）。 */
  const [busy, setBusy] = useState(false)
  const run = (fn: () => Promise<void>) => { if (!busy) void runAsync(setBusy, setError, fn) }
  /** 无绑定时选择角色会异步读取 defaults；序号保证只有最后一次选择能落到草稿。 */
  const characterRequest = useRef(0)

  // 打开面板时拉取四个候选列表。绑定晚到时再填草稿，但不要在用户编辑中途用 reload 覆盖。
  useEffect(() => {
    if (!open) return
    let alive = true
    setError(null)
    void (async () => {
      try {
        const [chars, presets, personas, lorebooks] = await Promise.all([
          remote.listCharacters({}),
          remote.listPresets({}),
          remote.listPersonas({}),
          remote.listLorebooks({}),
        ])
        if (!alive) return
        if (!chars.ok) return setError(chars.error.message)
        if (!presets.ok) return setError(presets.error.message)
        if (!personas.ok) return setError(personas.error.message)
        if (!lorebooks.ok) return setError(lorebooks.error.message)
        setLists({
          characters: chars.value.items,
          presets: presets.value.items,
          personas: personas.value.items,
          lorebooks: lorebooks.value.items,
        })
      } catch (cause) {
        // RPC 传输/校验失败是 reject 而非错误信封；不兜会停在骨架屏
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) {
      characterRequest.current += 1
      setDraft(null)
      return
    }
    if (draft !== null) return
    if (binding) setDraft({ ...binding, lorebookIds: [...binding.lorebookIds] })
  }, [open, binding, draft, sessionId])

  if (!tavern) return null

  const name = detail.state.status === 'ready' ? detail.state.value.name : null
  const avatar = detail.state.status === 'ready' ? detail.state.value.avatar : null
  const selectedChar = lists && draft ? lists.characters.find((c) => c.cardId === draft.cardId) : undefined
  const embeddedBookLabel = selectedChar?.hasCharacterBook
    ? typeof selectedChar.characterBookEntryCount === 'number'
      ? t('chip.embeddedBook.withCount', {
          name: selectedChar.characterBookName || selectedChar.name,
          count: selectedChar.characterBookEntryCount,
        })
      : t('chip.embeddedBook.noCount', { name: selectedChar.characterBookName || selectedChar.name })
    : t('chip.embeddedBook.none')

  const saveBinding = async () => {
    if (!draft) return
    const r = await remote.setSessionBinding({ binding: draft })
    const err = errOf(r)
    if (err) setError(err)
    else {
      toast.show(t('chip.saved'))
      // 先失效进程内缓存再 reload/广播，否则重拉吃到旧绑定（见 cache.ts TTL 口径）。
      invalidateSessionBinding(sessionId)
      bindingLoader.reload()
      // 通知操作条等按绑定显隐的组件刷新
      window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
    }
  }

  const insertGreeting = async () => {
    const r = await remote.ensureGreeting({ sessionId })
    if (!r.ok) setError(r.error.message)
    else toast.show(r.value.created ? t('chip.greeting.inserted') : t('chip.greeting.skipped'))
  }

  const swipeBy = async (delta: number) => {
    if (!binding) return
    const variants = await cachedCharacterDetail(remote, binding.cardId)
    if (!variants.ok) {
      setError(variants.error.message)
      return
    }
    const total = 1 + variants.value.alternateGreetings.length
    if (total < 2) {
      toast.show(t('chip.swipe.none'))
      return
    }
    const next = ((binding.greetingIndex + delta) % total + total) % total
    const r = await remote.swipeGreeting({ sessionId, index: next })
    if (!r.ok) setError(r.error.message)
    else {
      // 二次打开可能因会话尚未登记而抛错；分支已建好，toast 提示即可
      await openChildSession(sessions, r.value.childSessionId, r.value.title).catch(() => {
        toast.show(t('chip.swipe.childCreated'))
      })
    }
  }

  const unbind = async () => {
    setUnbindBusy(true)
    try {
      const r = await remote.clearSessionBinding({ sessionId })
      const err = errOf(r)
      if (err) {
        // 收起确认层后，错误会显示在仍打开的主 Dialog 中。
        setConfirmUnbind(false)
        setError(err)
      } else {
        setConfirmUnbind(false)
        setOpen(false)
        invalidateSessionBinding(sessionId)
        bindingLoader.reload()
        window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
      }
    } finally {
      setUnbindBusy(false)
    }
  }

  const showTriggerLog = async () => {
    const r = await remote.getTriggerLog({ sessionId })
    if (!r.ok) return setError(r.error.message)
    const log = r.value.log
    setView({
      title: t('binding.triggerLog'),
      text: log ? `${t('chip.log.time', { at: log.at })}\n\n${log.lines.join('\n')}` : t('chip.log.empty'),
    })
  }

  const preview = async () => {
    const r = await remote.previewPrompt({ sessionId })
    if (!r.ok) return setError(r.error.message)
    setPreviewData(r.value)
  }

  const openChatLore = async () => {
    const cardId = draft?.cardId
    if (!cardId || cardId !== binding?.cardId || !binding.storyId) return
    const r = await remote.getChatLorebook({ cardId, storyId: binding?.cardId === cardId ? binding.storyId : undefined })
    if (!r.ok) {
      setError(r.error.message)
      return
    }
    try {
      setChatLore({
        cardId,
        storyId: binding?.cardId === cardId ? binding.storyId : undefined,
        entries: parseLorebook(r.value.json, { source: 'chat', sourceRef: 'chat-lorebook' }),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <span className="dsh-tavern-ui" style={{ display: 'inline-flex' }}>
      {binding?.storyId&&<HelperScripts key={`${sessionId}:${binding.storyId}:${binding.helperMvu===true}`} remote={remote} sessionId={sessionId} sessions={sessions} onCancel={props.onCancel}/>}
      <TavernSeatChip
        label={binding ? (name ?? listedName ?? t('chip.characterFallback')) : t('hero.pickCharacter')}
        title={t('hero.pickCharacter')}
        avatarUrl={avatar}
        open={open}
        loading={bindingLoader.state.status === 'loading'}
        hasPopup="dialog"
        onClick={() => setOpen(!open)}
      />
      <Dialog
        open={open}
        title={t('chip.dialog.title')}
        onClose={() => setOpen(false)}
        width="full"
        footer={
          draft ? (
            <div className="dsh-tavern-footActions">
              {binding ? (
                <Btn
                  danger
                  size="md"
                  onClick={() => {
                    setConfirmUnbind(true)
                  }}
                >
                  {t('chip.unbind.action')}
                </Btn>
              ) : null}
              <span className="dsh-tavern-footSpacer" />
              <span className="dsh-tavern-footGroup">
                <Btn size="md" disabled={busy || !binding?.storyId || draft?.cardId !== binding.cardId} onClick={() => run(openChatLore)}>{t('chip.chatLore.edit')}</Btn>
                <Btn size="md" disabled={!binding?.storyId} onClick={() => setMemoryOpen(true)}>{t('section.memory')}</Btn>
                <Btn primary size="md" disabled={busy} onClick={() => run(saveBinding)}>{t('binding.save')}</Btn>
              </span>
            </div>
          ) : undefined
        }
      >
          <div className="dsh-tavern-binding dsh-tavern-bindingWide">
          <Err message={error} />
          {binding?.storyId && <HelperMvuAbandonAction key={sessionId + ':' + binding.storyId} remote={remote} sessionId={sessionId} storyId={binding.storyId} onChanged={() => {
            invalidateSessionBinding(sessionId)
            bindingLoader.reload()
            window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
            // 关闭绑定后正文写入可能失败；重新读取真实开关，保留用户其它尚未保存的绑定编辑。
            void cachedSessionBinding(remote, sessionId).then(result => {
              if (result.ok && result.value.binding) {
                const current = result.value.binding
                setDraft(previous => previous?.cardId === current.cardId && previous.storyId === current.storyId ? { ...previous, helperMvu: current.helperMvu } : previous)
              }
            }).catch(() => {})
          }}/>}
          {!lists && (
            <div className="dsh-tavern-panelCard">
              <Skeleton height={14} width="24%" />
              <Skeleton height={38} radius={18} />
              <Skeleton height={38} radius={18} />
              <Skeleton height={38} radius={18} />
            </div>
          )}
          {lists && (
            <>
              {draft ? (
                <>
                  <div className="dsh-tavern-panelCard">
                    <div className="dsh-tavern-groupHead">{t('chip.group.binding')}</div>
                    <Field label={t('chip.field.character')}>
                      <Select
                        width="100%"
                        value={draft.cardId}
                        onChange={(cardId) => {
                          if (!cardId) return
                          const picked = lists.characters.find((c) => c.cardId === cardId)
                          setDraft({ ...draft, cardId, cardName: picked?.name ?? draft.cardName })
                        }}
                        options={[
                          { value: '', label: t('chip.field.selectCharacter') },
                          ...lists.characters.map((c) => ({ value: c.cardId, label: c.name })),
                        ]}
                      />
                    </Field>
                    <Field label={t('chip.field.preset')}>
                      <Select
                        width="100%"
                        value={draft.presetId ?? ''}
                        onChange={(v) => setDraft({ ...draft, presetId: v || null })}
                        options={[{ value: '', label: t('chip.field.builtinPreset') }, ...lists.presets.map((p) => ({ value: p.id, label: p.regexCount > 0 ? t('settings.defaults.presetRegexCount', { name: p.name, count: p.regexCount }) : p.name }))]}
                      />
                    </Field>
                    <Field label={t('chip.field.persona')}>
                      <Select
                        width="100%"
                        value={draft.personaId ?? ''}
                        onChange={(v) => setDraft({ ...draft, personaId: v || null })}
                        options={[{ value: '', label: t('chip.field.none') }, ...lists.personas.map((p) => ({ value: p.id, label: p.name }))]}
                      />
                    </Field>
                  </div>

                  <div className="dsh-tavern-panelCard">
                    <div className="dsh-tavern-groupHead">{t('section.lorebooks')}</div>
                    {draft.worldInfo&&Object.keys(draft.worldInfo).length>0&&<Field label={t('chip.worldInfoOverride')}>
                      <Muted>{t('chip.worldInfoOverrideDesc',{count:Object.keys(draft.worldInfo).length})}</Muted>
                      <Btn onClick={()=>setDraft({...draft,worldInfo:{}})}>{t('chip.worldInfoReset')}</Btn>
                    </Field>}
                    <Field label={t('chip.field.mainLore')}>
                      <Select
                        width="100%"
                        value={draft.characterLorebookId ?? (draft.useEmbeddedLorebook===false?'@dsh/no-main-worldbook':'')}
                        onChange={(v) => setDraft({ ...draft, characterLorebookId: v===''||v==='@dsh/no-main-worldbook'?null:v,useEmbeddedLorebook:v!=='@dsh/no-main-worldbook' })}
                        options={[
                          { value: '', label: embeddedBookLabel },
                            {value:'@dsh/no-main-worldbook',label:t('chip.field.none')},
                          ...lists.lorebooks.map((n) => ({ value: n, label: n })),
                        ]}
                      />
                    </Field>
                    <Field label={t('chip.field.additionalLore')}>
                      {lists.lorebooks.length === 0 ? <Muted>{t('chip.field.noLorebooks')}</Muted> : (
                        <CheckChips
                          ariaLabel={t('chip.field.additionalLore')}
                          options={lists.lorebooks.filter(n => n !== draft.characterLorebookId).map(n => ({value:n,label:n}))}
                          selected={draft.characterLorebookIds ?? []}
                          onChange={characterLorebookIds => setDraft({...draft,characterLorebookIds})}
                        />
                      )}
                    </Field>
                    <Field label={t('chip.field.globalLore')}>
                      {lists.lorebooks.length === 0 ? (
                        <Muted>{t('chip.field.noLorebooks')}</Muted>
                      ) : (
                        <CheckChips
                          ariaLabel={t('chip.field.globalLoreAria')}
                          options={lists.lorebooks.map((n) => ({ value: n, label: n }))}
                          selected={draft.lorebookIds}
                          onChange={(lorebookIds) => setDraft({ ...draft, lorebookIds })}
                        />
                      )}
                    </Field>
                  </div>

                  <div className="dsh-tavern-panelCard">
                    <div className="dsh-tavern-groupHead">{t('chip.group.turnInject')}</div>
                    <Field label={t('chip.field.authorNote')}>
                      <textarea
                        className="dsh-tavern-input dsh-tavern-textarea"
                        style={{ minHeight: 96 }}
                        value={draft.authorNote ?? ''}
                        onChange={(e) => setDraft({ ...draft, authorNote: e.target.value })}
                      />
                    </Field>
                    <div className="dsh-tavern-inlineChecks">
                      <label>
                        <Toggle
                          checked={draft.injectJournal === true}
                          onChange={(injectJournal) => setDraft({ ...draft, injectJournal })}
                        />
                        {t('chip.field.injectJournal')}
                      </label>
                      <label><Toggle checked={draft.helperMvu===true} onChange={helperMvu=>setDraft({...draft,helperMvu})}/>{t('chip.field.helperMvu')}</label>
                    </div>
                    <Muted>{t('chip.field.helperMvuNote')}</Muted>
                  </div>
                </>
              ) : (
                <div className="dsh-tavern-panelCard">
                  <div className="dsh-tavern-groupHead">{t('chip.group.binding')}</div>
                  <Field label={t('chip.field.character')}>
                    <Select
                      width="100%"
                      value=""
                      onChange={(cardId) => {
                        if (!cardId) return
                        const request = ++characterRequest.current
                        void bindingFromDefaults(remote, sessionId, cardId).then((next) => {
                          if (characterRequest.current !== request) return
                          const picked = lists.characters.find((c) => c.cardId === cardId)
                          setDraft({ ...next, cardName: picked?.name })
                        }).catch((cause) => {
                          if (characterRequest.current === request) {
                            setError(cause instanceof Error ? cause.message : String(cause))
                          }
                        })
                      }}
                      options={[
                        { value: '', label: t('chip.field.selectCharacter') },
                        ...lists.characters.map((c) => ({ value: c.cardId, label: c.name })),
                      ]}
                    />
                  </Field>
                </div>
              )}

              <div className="dsh-tavern-panelCard">
                <div className="dsh-tavern-groupHead">{t('chip.group.greetingDebug')}</div>
                <div className="dsh-tavern-bindingActions">
                  <Btn disabled={busy || !binding} onClick={() => run(insertGreeting)}>{t('binding.greeting')}</Btn>
                  <Btn disabled={busy || !binding || !canSwipeGreeting} onClick={() => run(() => swipeBy(-1))}>{t('chip.greeting.prev')}</Btn>
                  <Btn disabled={busy || !binding || !canSwipeGreeting} onClick={() => run(() => swipeBy(1))}>{t('chip.greeting.next')}</Btn>
                  <Btn disabled={busy} onClick={() => run(showTriggerLog)}>{t('binding.triggerLog')}</Btn>
                  <Btn disabled={busy} onClick={() => run(preview)}>{t('binding.preview')}</Btn>
                </div>
              </div>

              {usage && (
                <div className="dsh-tavern-usageBar">
                  {typeof usage.percent === 'number' && (
                    <div
                      className="dsh-tavern-meter"
                      role="progressbar"
                      aria-label={t('chip.usage.aria')}
                      aria-valuenow={Math.round(usage.percent)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <span
                        className="dsh-tavern-meterFill"
                        data-warn={usage.percent >= 90 ? 'true' : 'false'}
                        style={{ width: `${Math.min(100, Math.max(0, usage.percent))}%` }}
                      />
                    </div>
                  )}
                  <Muted>
                    {t('chip.usage.label')}
                    {usage.contextWindow !== null && usage.pressureTokens !== null
                      ? t('chip.usage.full', { used: fmtTokens(usage.pressureTokens), window: fmtTokens(usage.contextWindow), percent: usage.percent ?? '?' })
                      : t('chip.usage.approx', { tokens: fmtTokens(usage.surfaceTokens) })}
                    {usage.messageTokens !== null
                      ? ` · ${t('chip.usage.breakdown', { system: fmtTokens(usage.systemTokens), tools: fmtTokens(usage.toolsTokens), messages: fmtTokens(usage.messageTokens) })}`
                      : ''}
                  </Muted>
                </div>
              )}
            </>
          )}
          </div>
      </Dialog>
      {toast.node}
      {view && <PreDialog title={view.title} text={view.text} onClose={() => setView(null)} />}
      {previewData && <PromptPreviewDialog data={previewData} onClose={() => setPreviewData(null)} />}
      {chatLore && <DraftScope>{(request) =>
        <Dialog open width="xl" title={t('chip.chatLore.title')} onClose={() => request(() => setChatLore(null))}>
          <LorebookEditor
            remote={remote}
            target={{ kind: 'chat', cardId: chatLore.cardId, storyId: chatLore.storyId, name: t('chip.chatLore.title') }}
            entries={chatLore.entries}
            onClose={() => setChatLore(null)}
            onSaved={() => {
              toast.show(t('chip.chatLore.saved'))
              setChatLore(null)
            }}
            save={(json) => remote.saveChatLorebook({ cardId: chatLore.cardId, storyId: chatLore.storyId, json })}
          />
        </Dialog>
      }</DraftScope>}
      {memoryOpen && binding?.storyId && <DraftScope>{(request) =>
        <Dialog open width="xl" title={t('section.memory')} onClose={() => request(() => setMemoryOpen(false))}>
          <MemorySection key={binding.storyId} remote={remote} initialContext={{ cardId: binding.cardId, storyId: binding.storyId! }} />
        </Dialog>
      }</DraftScope>}
      <ConfirmDialog
        open={confirmUnbind}
        title={t('chip.unbind.title')}
        description={t('chip.unbind.desc')}
        confirmLabel={t('chip.unbind.action')}
        danger
        busy={unbindBusy}
        onCancel={() => {
          setConfirmUnbind(false)
        }}
        onConfirm={() => void unbind()}
      />
    </span>
  )
}
