/**
 * 会话头部角色 chip（slot conversation.session.header.actions，session 作用域）。
 * 显示当前会话绑定的角色；点击展开绑定编辑 / 开场白 / 调试小面板。
 */
import { useEffect, useRef, useState } from 'react'
import { BINDING_CHANGED_EVENT } from './actions.js'
import { isTavernSession, type UseSessions } from './mode.js'
import { openChildSession } from './openChild.js'
import { TavernSeatChip } from './seatChip.js'
import type { WorldInfoEntry } from '../core/types.js'
import { parseLorebook } from '../state/lorebook.js'
import { LorebookEditor } from './panel/lorebookEditor.js'
import type { CharacterSummary, Persona, PresetSummary, SessionBinding, TavernRemote, TavernSettings } from './types.js'
import { EMPTY_SESSION_DEFAULTS } from './types.js'
import { IconCopyOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Btn, CheckChips, ConfirmDialog, Dialog, Err, Field, IconBtn, Muted, Select, Skeleton, Toggle, errOf, useLoader, useToast } from './util.js'

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

function PreDialog(props: { title: string; text: string; onClose: () => void }) {
  return (
    <Dialog open title={props.title} onClose={props.onClose} width="lg">
      <pre className="dsh-tavern-modalPre">{props.text}</pre>
    </Dialog>
  )
}

type PromptPreview = {
  standing: string
  turnContext: string
  system: string
  messages: unknown[]
  logLines: string[]
  worldInfoBudget: { limit: number; used: number; overflowed: boolean }
  assembleBudget: { tokensBefore: number; tokensAfter: number; trimmedSections: string[] }
}

/** 千位缩写（12.3k）；null 显示 ?。 */
function fmtTokens(n: number | null): string {
  if (n === null) return '?'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function PromptPreviewDialog(props: { data: PromptPreview; onClose: () => void }) {
  const { data } = props
  const [tab, setTab] = useState<'standing' | 'turn' | 'full' | 'log'>('standing')
  const toast = useToast()
  const wi = data.worldInfoBudget
  const assemble = data.assembleBudget
  const body =
    tab === 'standing'
      ? data.standing || '（空）'
      : tab === 'turn'
        ? data.turnContext || '（空）'
        : tab === 'log'
          ? data.logLines.join('\n') || '（无触发日志）'
          : `=== system ===\n${data.system}\n\n=== messages ===\n${data.messages.map((m) => JSON.stringify(m)).join('\n\n')}`
  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(body)
      toast.show('已复制当前视图内容')
    } catch {
      toast.show('复制失败')
    }
  }
  return (
    <Dialog open title="提示词预览" onClose={props.onClose} width="lg">
      <Muted>
        世界书预算 {wi.used}/{wi.limit}
        {wi.overflowed ? ' · 已溢出' : ''}
        {' · '}
        组装 {assemble.tokensAfter}/{assemble.tokensBefore} token
        {assemble.trimmedSections.length > 0 ? ` · 裁剪 ${assemble.trimmedSections.join('、')}` : ''}
      </Muted>
      <div className="dsh-tavern-filters" style={{ margin: '10px 0 12px' }}>
        {(
          [
            ['standing', 'standing'],
            ['turn', '本轮 turn'],
            ['full', '完整序列'],
            ['log', '触发日志'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="dsh-tavern-chip"
            data-active={tab === id ? 'true' : 'false'}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <IconBtn label="复制当前视图" onClick={() => void copyBody()}>
          <IconCopyOutline16 />
        </IconBtn>
      </div>
      <pre className="dsh-tavern-modalPre">{body}</pre>
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
  useSessions?: UseSessions
}) {
  const { remote, sessionId, sessions } = props
  const tavern = isTavernSession(props.useSessions, sessionId)
  const bindingLoader = useLoader(() => remote.getSessionBinding({ sessionId }), [sessionId], tavern)
  const binding = bindingLoader.state.status === 'ready' ? bindingLoader.state.value.binding : null
  const canSwipeGreeting =
    bindingLoader.state.status === 'ready' ? bindingLoader.state.value.canSwipeGreeting !== false : false
  const detail = useLoader(
    async () => {
      const [d, a] = await Promise.all([remote.getCharacterDetail({ cardId: binding!.cardId }), remote.getAvatar({ cardId: binding!.cardId })])
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
  const [chatLore, setChatLore] = useState<{ cardId: string; entries: WorldInfoEntry[] } | null>(null)
  const [confirmUnbind, setConfirmUnbind] = useState(false)
  const [unbindBusy, setUnbindBusy] = useState(false)
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
    ? `${selectedChar.characterBookName || selectedChar.name}（卡内嵌${typeof selectedChar.characterBookEntryCount === 'number' ? ` ${selectedChar.characterBookEntryCount} 条` : ''}）`
    : '（卡内嵌书 / 无）'

  const saveBinding = async () => {
    if (!draft) return
    const r = await remote.setSessionBinding({ binding: draft })
    const err = errOf(r)
    if (err) setError(err)
    else {
      toast.show('绑定已保存（对之后的消息生效）')
      bindingLoader.reload()
      // 通知操作条等按绑定显隐的组件刷新
      window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId }))
    }
  }

  const insertGreeting = async () => {
    const r = await remote.ensureGreeting({ sessionId })
    if (!r.ok) setError(r.error.message)
    else toast.show(r.value.created ? '已插入开场白' : '会话已有内容，未插入')
  }

  const swipeBy = async (delta: number) => {
    if (!binding) return
    const variants = await remote.getCharacterDetail({ cardId: binding.cardId })
    if (!variants.ok) {
      setError(variants.error.message)
      return
    }
    const total = 1 + variants.value.alternateGreetings.length
    if (total < 2) {
      toast.show('该角色没有额外开场白')
      return
    }
    const next = ((binding.greetingIndex + delta) % total + total) % total
    const r = await remote.swipeGreeting({ sessionId, index: next })
    if (!r.ok) setError(r.error.message)
    else {
      // 二次打开可能因会话尚未登记而抛错；分支已建好，toast 提示即可
      await openChildSession(sessions, r.value.childSessionId, r.value.title).catch(() => {
        toast.show('分支会话已创建，请在会话列表中打开')
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
      title: '触发日志',
      text: log ? `时间：${log.at}\n\n${log.lines.join('\n')}` : '暂无日志（该会话还没有跑过一次 Tavern 组装）',
    })
  }

  const preview = async () => {
    const r = await remote.previewPrompt({ sessionId })
    if (!r.ok) return setError(r.error.message)
    setPreviewData(r.value)
  }

  const openChatLore = async () => {
    const cardId = draft?.cardId
    if (!cardId) return
    const r = await remote.getChatLorebook({ cardId })
    if (!r.ok) {
      setError(r.error.message)
      return
    }
    try {
      setChatLore({
        cardId,
        entries: parseLorebook(r.value.json, { source: 'chat', sourceRef: 'chat-lorebook' }),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <span className="dsh-tavern-ui" style={{ display: 'inline-flex' }}>
      <TavernSeatChip
        label={binding ? (name ?? listedName ?? '角色') : '选择角色卡'}
        title="选择角色卡"
        avatarUrl={avatar}
        open={open}
        hasPopup="dialog"
        onClick={() => setOpen(!open)}
      />
      <Dialog open={open} title="Tavern 绑定" onClose={() => setOpen(false)} width="xl">
          <div className="dsh-tavern-binding">
          <Err message={error} />
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
                    <div className="dsh-tavern-groupHead">绑定</div>
                    <Field label="角色">
                      <Select
                        width="100%"
                        value={draft.cardId}
                        onChange={(cardId) => {
                          if (!cardId) return
                          const picked = lists.characters.find((c) => c.cardId === cardId)
                          setDraft({ ...draft, cardId, cardName: picked?.name ?? draft.cardName })
                        }}
                        options={[
                          { value: '', label: '（选择角色）' },
                          ...lists.characters.map((c) => ({ value: c.cardId, label: c.name })),
                        ]}
                      />
                    </Field>
                    <Field label="预设">
                      <Select
                        width="100%"
                        value={draft.presetId ?? ''}
                        onChange={(v) => setDraft({ ...draft, presetId: v || null })}
                        options={[{ value: '', label: '（内建默认）' }, ...lists.presets.map((p) => ({ value: p.id, label: p.regexCount > 0 ? `${p.name}（${p.regexCount} 条正则）` : p.name }))]}
                      />
                    </Field>
                    <Field label="人设">
                      <Select
                        width="100%"
                        value={draft.personaId ?? ''}
                        onChange={(v) => setDraft({ ...draft, personaId: v || null })}
                        options={[{ value: '', label: '（无）' }, ...lists.personas.map((p) => ({ value: p.id, label: p.name }))]}
                      />
                    </Field>
                  </div>

                  <div className="dsh-tavern-panelCard">
                    <div className="dsh-tavern-groupHead">世界书</div>
                    <Field label="主世界书">
                      <Select
                        width="100%"
                        value={draft.characterLorebookId ?? ''}
                        onChange={(v) => setDraft({ ...draft, characterLorebookId: v || null })}
                        options={[
                          { value: '', label: embeddedBookLabel },
                          ...lists.lorebooks.map((n) => ({ value: n, label: n })),
                        ]}
                      />
                    </Field>
                    <Field label="全局世界书（多选）">
                      {lists.lorebooks.length === 0 ? (
                        <Muted>库中暂无世界书</Muted>
                      ) : (
                        <CheckChips
                          ariaLabel="全局世界书"
                          options={lists.lorebooks.map((n) => ({ value: n, label: n }))}
                          selected={draft.lorebookIds}
                          onChange={(lorebookIds) => setDraft({ ...draft, lorebookIds })}
                        />
                      )}
                    </Field>
                  </div>

                  <div className="dsh-tavern-panelCard">
                    <div className="dsh-tavern-groupHead">本轮注入</div>
                    <Field label="作者注释（本会话，进本轮 turn）">
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
                        注入角色笔记 journal.md
                      </label>
                    </div>
                  </div>

                  <div className="dsh-tavern-footActions">
                    {binding ? (
                      <Btn
                        danger
                        size="md"
                        onClick={() => {
                          setConfirmUnbind(true)
                        }}
                      >
                        解除绑定
                      </Btn>
                    ) : null}
                    <span className="dsh-tavern-footSpacer" />
                    <Btn size="md" onClick={() => void openChatLore()}>编辑本会话世界书</Btn>
                    <Btn primary size="md" onClick={() => void saveBinding()}>保存绑定</Btn>
                  </div>
                </>
              ) : (
                <div className="dsh-tavern-panelCard">
                  <div className="dsh-tavern-groupHead">绑定</div>
                  <Field label="角色">
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
                        { value: '', label: '（选择角色）' },
                        ...lists.characters.map((c) => ({ value: c.cardId, label: c.name })),
                      ]}
                    />
                  </Field>
                </div>
              )}

              <div className="dsh-tavern-panelCard">
                <div className="dsh-tavern-groupHead">开场白与调试</div>
                <div className="dsh-tavern-bindingActions">
                  <Btn disabled={!binding} onClick={() => void insertGreeting()}>插入开场白</Btn>
                  <Btn disabled={!binding || !canSwipeGreeting} onClick={() => void swipeBy(-1)}>上一条开场白</Btn>
                  <Btn disabled={!binding || !canSwipeGreeting} onClick={() => void swipeBy(1)}>下一条开场白</Btn>
                  <Btn onClick={() => void showTriggerLog()}>触发日志</Btn>
                  <Btn onClick={() => void preview()}>预览提示词</Btn>
                </div>
              </div>

              {usage && (
                <div className="dsh-tavern-usageBar">
                  {typeof usage.percent === 'number' && (
                    <div
                      className="dsh-tavern-meter"
                      role="progressbar"
                      aria-label="上下文占用"
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
                    上下文：
                    {usage.contextWindow !== null && usage.pressureTokens !== null
                      ? `${fmtTokens(usage.pressureTokens)} / ${fmtTokens(usage.contextWindow)}（${usage.percent ?? '?'}%）`
                      : `约 ${fmtTokens(usage.surfaceTokens)} token`}
                    {usage.messageTokens !== null
                      ? ` · 系统 ${fmtTokens(usage.systemTokens)} · 工具 ${fmtTokens(usage.toolsTokens)} · 消息 ${fmtTokens(usage.messageTokens)}`
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
      {chatLore && (
        <Dialog open width="xl" title="本会话世界书" onClose={() => setChatLore(null)}>
          <LorebookEditor
            target={{ kind: 'chat', cardId: chatLore.cardId, name: '本会话世界书' }}
            entries={chatLore.entries}
            onClose={() => setChatLore(null)}
            onSaved={() => {
              toast.show('已保存本会话世界书')
              setChatLore(null)
            }}
            save={(json) => remote.saveChatLorebook({ cardId: chatLore.cardId, json })}
          />
        </Dialog>
      )}
      <ConfirmDialog
        open={confirmUnbind}
        title="解除角色绑定？"
        description="解除后本会话不再使用角色卡，后续回复按普通 Tavern 助手。对话记录不会删除。"
        confirmLabel="解除绑定"
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
