/**
 * 设置面板分区：角色卡（列表 / 导入 / 收纳与恢复 / 永久删除 / 详情 / 交互卡）。
 * 活跃卡只提供可逆收纳；收纳箱内才提供恢复与永久删除，瞬时反馈走 useToast，上下文错误用 Err。
 * 交互卡预览保留 CSP meta 注入 + sandbox iframe（无 allow-same-origin），不得放宽。
 */
import {cardVariableLabels} from '../cardVariableLabels.js'
import { useDraftGuard } from '../drafts.js'
import { buildCardSrcDoc } from '../../core/cardFrame.js'
import { CARD_VARIABLE_STYLES } from '../styles.js'
import { PersistentEditor, useDraftRestored, useDraftState } from '../draftPersistence.js'
import { useEffect, useRef, useState } from 'react'
import { Button, IconArchiveOutlineMedium, IconDownloadOutlineMedium, IconRefreshOutlineMedium, IconTrashOutlineMedium, IconUserOutlineMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { cachedAvatar, cachedCharacterDetail, invalidateCharacter, notifyCharacterChanged } from '../cache.js'
import { matchesCharacterSearch } from '../characterSearch.js'
import { useT } from '../i18n.js'
import type { CharacterDetail, CharacterInspect, CharacterSummary, TavernRemote } from '../types.js'
import { Avatar, Btn, ConfirmDialog, Dialog, Err, Field, FileBtn, IconBtn, ListInput, Muted, NumInput, SearchEmpty, SearchInput, Section, Select, Skeleton, Tabs, clickableProps, downloadBase64, downloadJson, errOf, fileToBase64, runAsync, useLoader, useToast } from '../util.js'

/** 按 cardId 拉头像 dataURL 的 Avatar 包装（失败时回落首字符/图标）；头像走进程内缓存。 */
function CardAvatar(props: { remote: TavernRemote; cardId: string; name: string; size: number }) {
  const { state } = useLoader(() => cachedAvatar(props.remote, props.cardId), [props.cardId])
  const url = state.status === 'ready' ? state.value.dataUrl : null
  return <Avatar url={url} name={props.name} size={props.size} />
}

/** 海报卡：活跃卡可点进编辑并收纳；收纳箱卡只允许恢复或发起受保护的永久删除。 */
function CharacterCard(props: {
  remote: TavernRemote
  item: CharacterSummary
  busy: boolean
  archived: boolean
  onOpen?: (cardId: string) => void
  onArchive: (item: CharacterSummary) => void
  onRestore: (item: CharacterSummary) => void
  onDelete: (item: CharacterSummary) => void
}) {
  const t = useT()
  const { state } = useLoader(() => cachedAvatar(props.remote, props.item.cardId), [props.item.cardId])
  const url = state.status === 'ready' ? state.value.dataUrl : null
  const initial = props.item.name.trim().charAt(0) || '?'
  const book = props.item.characterBookName
    ? t('characters.card.embeddedBookNamed', { name: props.item.characterBookName })
    : t('characters.card.embeddedBook')
  const meta = props.item.hasCharacterBook
    ? `${book}${
        typeof props.item.characterBookEntryCount === 'number' && props.item.characterBookEntryCount > 0
          ? ` · ${t('characters.card.entryCount', { count: props.item.characterBookEntryCount })}`
          : ''
      }`
    : ''
  const openProps = props.onOpen ? {
    ...clickableProps(() => { if (!props.busy) props.onOpen?.(props.item.cardId) }),
    'aria-disabled': props.busy || undefined,
  } : {}
  return (
    <article className={`dsh-tavern-charCard${props.archived ? ' is-archived' : ''}`} {...openProps}>
      <div className="dsh-tavern-charCardCover">
        {url ? <img src={url} alt="" /> : <span className="dsh-tavern-charCardInitial">{initial}</span>}
      </div>
      <div className="dsh-tavern-charCardBar">
        <div className="dsh-tavern-charCardName">{props.item.name}</div>
        {meta ? <div className="dsh-tavern-charCardMeta">{meta}</div> : null}
      </div>
      <div className="dsh-tavern-charCardActions">
        {props.archived ? (
          <>
            <Tooltip label={t('characters.card.restore')} side="bottom">
              <button type="button" aria-label={t('characters.card.restore')} className="dsh-tavern-coverBtn" disabled={props.busy}
                onClick={(e: { stopPropagation: () => void }) => { e.stopPropagation(); props.onRestore(props.item) }}>
                <IconRefreshOutlineMedium />
              </button>
            </Tooltip>
            <Tooltip label={t('characters.card.deletePermanently')} side="bottom">
              <button type="button" aria-label={t('characters.card.deletePermanently')} className="dsh-tavern-coverBtn is-danger" disabled={props.busy}
                onClick={(e: { stopPropagation: () => void }) => { e.stopPropagation(); props.onDelete(props.item) }}>
                <IconTrashOutlineMedium />
              </button>
            </Tooltip>
          </>
        ) : (
          <Tooltip label={t('characters.card.archive')} side="bottom">
            <button type="button" aria-label={t('characters.card.archive')} className="dsh-tavern-coverBtn" disabled={props.busy}
              onClick={(e: { stopPropagation: () => void }) => { e.stopPropagation(); props.onArchive(props.item) }}>
              <IconArchiveOutlineMedium size={16} />
            </button>
          </Tooltip>
        )}
      </div>
    </article>
  )
}

/** 详情弹窗里的「标签 + 多行框」单元，配合 groupHead 分组使用。 */
function LabeledArea(props: { label: string; value: string; minHeight?: number; onChange: (value: string) => void }) {
  return (
    <Field label={props.label}>
      <textarea
        className="dsh-tavern-input dsh-tavern-textarea"
        style={{ minHeight: props.minHeight ?? 64 }}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </Field>
  )
}

function CharacterDetailDialog(props: { remote: TavernRemote; cardId: string; onClose: () => void; onSaved: () => void }) {
  const { remote, cardId } = props
  const t = useT()
  const { state, reload } = useLoader(
    () => cachedCharacterDetail(remote, cardId),
    [cardId],
  )
  const [cardOpen, setCardOpen] = useState(false)
  const draftKey = `characters.detail:${cardId}`
  const [draft, setDraft] = useDraftState<CharacterDetail | null>(draftKey, null)
  const restored = useDraftRestored(draftKey)
  const preserveRestored = useRef(restored && draft !== null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const loaded: CharacterDetail | null = state.status === 'ready' ? state.value : null
  const detail = draft ?? loaded
  // 最近一次应用到草稿的服务端值（或保存成功那一刻的草稿）：用于识别 reload 往返窗口期内的新编辑。
  const appliedRef = useRef<CharacterDetail | null>(null)
  // 重读挂起或失败时仍用已知保存版本比较，不能把刚输入的正文误判为已保存。
  const baseline = loaded ?? appliedRef.current
  const dirty = draft !== null && (baseline === null ? restored : JSON.stringify(draft) !== JSON.stringify(baseline))
  const guard = useDraftGuard(dirty, busy)
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => {
    if (!loaded) return
    // 首次 ready 仅提供比较基线；恢复的未保存正文必须保留。
    if (preserveRestored.current) { preserveRestored.current = false; appliedRef.current = loaded; return }
    // 保存后 reload 落地时，草稿若已偏离基线（往返窗口期内有新键入），不整体覆盖：
    // 覆盖会静默丢掉窗口期编辑并把 dirty 复位为 false；保留草稿让「未保存」提示继续可见。
    if (draftRef.current !== null && appliedRef.current !== null && JSON.stringify(draftRef.current) !== JSON.stringify(appliedRef.current)) return
    appliedRef.current = loaded
    setDraft(loaded)
  }, [loaded, setDraft])

  const close = () => guard.request(() => {
    setDraft(null)
    props.onClose()
  })

  const set = (patch: Partial<CharacterDetail>) => setDraft(detail ? { ...detail, ...patch } : detail)
  const interactiveHtml = typeof detail?.extensions?.interactiveHtml === 'string' ? (detail.extensions.interactiveHtml as string) : null

  const save = async () => {
    if (!detail) return
    // 旧版恢复草稿没有基线版本，不能拿刚读取的版本替它授权覆盖。
    if (!detail.revision) { setError(t('characters.detail.missingRevision')); return }
    if (!detail.name.trim()) {
      setError(t('characters.detail.nameRequired'))
      return
    }
    await runAsync(setBusy, setError, async () => {
      const r = await remote.saveCharacter({
        cardId,
        expectedRevision: detail.revision,
        name: detail.name,
        description: detail.description,
        personality: detail.personality,
        scenario: detail.scenario,
        firstMes: detail.firstMes,
        alternateGreetings: detail.alternateGreetings.map((s) => s.trim()).filter(Boolean),
        mesExample: detail.mesExample,
        systemPrompt: detail.systemPrompt,
        postHistoryInstructions: detail.postHistoryInstructions,
        creatorNotes: detail.creatorNotes,
        creator: detail.creator,
        characterVersion: detail.characterVersion,
        tags: detail.tags,
        depthPrompt: detail.depthPrompt ?? null,
      })
      const err = errOf(r)
      if (err) { setError(err); invalidateCharacter(cardId) }
      else if (r.ok) {
        // 保存回执推进版本，但只更新版本字段，不能覆盖往返期间的新键入。
        const revision = r.value.revision
        appliedRef.current = { ...detail, revision }
        setDraft(current => current ? { ...current, revision } : current)
        toast.show(t('characters.detail.saved', { name: detail.name }))
        // 先失效详情/头像缓存再 reload，否则详情弹窗与聊天气泡继续吃旧值。
        notifyCharacterChanged(cardId)
        reload()
        props.onSaved()
      }
    })
  }

  const exportCard = async (kind: 'json' | 'png') => {
    await runAsync(setBusy, setError, async () => {
      const r = await remote.exportCharacter({ cardId })
      if (!r.ok) {
        setError(r.error.message)
        return
      }
      if (kind === 'json') downloadJson(`${r.value.name}.json`, r.value.json)
      else downloadBase64(`${r.value.name}.png`, r.value.pngBase64, 'image/png')
      toast.show(t('characters.detail.exported', { kind: kind.toUpperCase() }))
    })
  }

  return (
    <Dialog open width="xl" title={t('characters.detail.title', { name: detail?.name ?? cardId })} onClose={close}
      footer={detail ? <div className="dsh-tavern-ui dsh-tavern-footActions">
        <span className="dsh-tavern-muted" role="status">{dirty ? t('draft.unsaved') : ''}</span>
        <span className="dsh-tavern-footSpacer" />
        <Btn size="md" disabled={busy} onClick={close}>{t('action.close')}</Btn>
        <Btn primary size="md" disabled={busy || !dirty} onClick={() => void save()}>{t(busy ? 'draft.saving' : 'action.save')}</Btn>
      </div> : undefined}>
      {toast.node}
      {guard.confirmation}
      {state.status === 'loading' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Skeleton height={48} />
          <Skeleton height={14} width="60%" />
          <Skeleton height={90} />
        </div>
      )}
      {state.status === 'error' && <div>
        <Err message={state.message} />
        <Btn disabled={busy} onClick={reload}>{t('action.retry')}</Btn>
      </div>}
      {detail && (
        <fieldset disabled={busy} className="dsh-tavern-editorFields dsh-tavern-dialogStack" style={{ fontSize: 13 }}>
          <div className="dsh-tavern-panelCard" style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <CardAvatar remote={remote} cardId={cardId} name={detail.name} size={52} />
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Field label={t('characters.detail.displayName')}>
                <input className="dsh-tavern-input" style={{ width: '100%' }} value={detail.name} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <Muted>
                {detail.spec} · v{detail.characterVersion || '?'} · {detail.creator || t('characters.detail.unknownCreator')}
                {detail.hasCharacterBook
                  ? ` · ${detail.characterBookName ? t('characters.card.embeddedBookNamed', { name: detail.characterBookName }) : t('characters.card.embeddedBook')}`
                  : ''}
              </Muted>
            </div>
          </div>
          <div className="dsh-tavern-panelCard">
            <div className="dsh-tavern-groupHead">{t('characters.detail.groupPersona')}</div>
            <LabeledArea label={t('characters.detail.description')} minHeight={88} value={detail.description} onChange={(v) => set({ description: v })} />
            <LabeledArea label={t('characters.detail.personality')} value={detail.personality} onChange={(v) => set({ personality: v })} />
            <LabeledArea label={t('characters.detail.scenario')} value={detail.scenario} onChange={(v) => set({ scenario: v })} />
          </div>

          <div className="dsh-tavern-panelCard">
            <div className="dsh-tavern-groupHead">{t('characters.detail.groupGreetings')}</div>
            <LabeledArea label={t('characters.detail.greeting')} minHeight={88} value={detail.firstMes} onChange={(v) => set({ firstMes: v })} />
            <div className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">{t('characters.detail.altGreetings')}</span>
              {detail.alternateGreetings.map((greeting, index) => <div key={index} className="dsh-tavern-greetingEntry">
                <label className="dsh-tavern-field">
                  <span className="dsh-tavern-fieldLabel">{t('characters.detail.greetingNumber', { index: index + 1 })}</span>
                  <textarea className="dsh-tavern-input dsh-tavern-textarea" value={greeting} disabled={busy}
                    onChange={(e) => set({ alternateGreetings: detail.alternateGreetings.map((text, i) => i === index ? e.target.value : text) })} />
                </label>
                <Btn disabled={busy} onClick={() => set({ alternateGreetings: detail.alternateGreetings.filter((_, i) => i !== index) })}>{t('action.delete')}</Btn>
              </div>)}
              <Btn disabled={busy} onClick={() => set({ alternateGreetings: [...detail.alternateGreetings, ''] })}>{t('characters.detail.addGreeting')}</Btn>
            </div>
            <LabeledArea label={t('characters.detail.mesExample')} value={detail.mesExample} onChange={(v) => set({ mesExample: v })} />
          </div>

          <div className="dsh-tavern-panelCard">
            <div className="dsh-tavern-groupHead">{t('characters.detail.groupAdvanced')}</div>
            <LabeledArea label={t('characters.detail.systemPrompt')} value={detail.systemPrompt} onChange={(v) => set({ systemPrompt: v })} />
            <LabeledArea label={t('characters.detail.postHistory')} value={detail.postHistoryInstructions} onChange={(v) => set({ postHistoryInstructions: v })} />
            <Field label={t('characters.detail.depthPrompt')}>
              <textarea
                className="dsh-tavern-input dsh-tavern-textarea"
                style={{ minHeight: 64 }}
                value={detail.depthPrompt?.prompt ?? ''}
                onChange={(e) =>
                  set({
                    depthPrompt: e.target.value.trim()
                      ? { prompt: e.target.value, depth: detail.depthPrompt?.depth ?? 4, role: detail.depthPrompt?.role ?? 'system' }
                      : null,
                  })
                }
              />
              {detail.depthPrompt ? (
                <div className="dsh-tavern-fieldRow" style={{ marginTop: 6 }}>
                  <Field label={t('characters.detail.depth')}>
                    <NumInput value={detail.depthPrompt.depth} onChange={(depth) => set({ depthPrompt: { ...detail.depthPrompt!, depth: Math.max(0, Math.round(depth)) } })} />
                  </Field>
                  <Field label={t('characters.detail.role')}>
                    <Select
                      value={detail.depthPrompt.role}
                      onChange={(role) => set({ depthPrompt: { ...detail.depthPrompt!, role: role as 'system' | 'user' | 'assistant' } })}
                      options={[
                        { value: 'system', label: 'system' },
                        { value: 'user', label: 'user' },
                        { value: 'assistant', label: 'assistant' },
                      ]}
                    />
                  </Field>
                </div>
              ) : null}
            </Field>
          </div>

          <div className="dsh-tavern-panelCard">
            <div className="dsh-tavern-groupHead">{t('characters.detail.groupMetadata')}</div>
            <LabeledArea label={t('characters.detail.creatorNotes')} value={detail.creatorNotes} onChange={(v) => set({ creatorNotes: v })} />
            <div className="dsh-tavern-fieldRow">
              <Field label={t('characters.detail.creator')}>
                <input className="dsh-tavern-input" value={detail.creator} onChange={(e) => set({ creator: e.target.value })} />
              </Field>
              <Field label={t('characters.detail.version')}>
                <input className="dsh-tavern-input" value={detail.characterVersion} onChange={(e) => set({ characterVersion: e.target.value })} />
              </Field>
            </div>
            <Field label={t('characters.detail.tags')}>
              <ListInput style={{ width: '100%' }} value={detail.tags} onChange={(tags) => set({ tags })} />
            </Field>
          </div>
          <Err message={error} />
          <div className="dsh-tavern-footActions" style={{ marginTop: 2 }}>
            <IconBtn label={t('characters.detail.exportPng')} disabled={busy} onClick={() => void exportCard('png')}>
              <IconDownloadOutlineMedium />
            </IconBtn>
            {interactiveHtml !== null && <Btn size="md" onClick={() => setCardOpen(true)}>{t('interactive.open')}</Btn>}
            <span className="dsh-tavern-footSpacer" />
            <Btn size="md" disabled={busy} onClick={() => void exportCard('json')}>{t('characters.detail.exportJson')}</Btn>
          </div>
        </fieldset>
      )}
      {cardOpen && interactiveHtml !== null && (
        <Dialog open width="lg" title={t('characters.detail.interactiveTitle', { name: detail?.name ?? '' })} onClose={() => setCardOpen(false)}>
          <iframe
            sandbox="allow-scripts"
            srcDoc={buildCardSrcDoc(interactiveHtml, { greetings: detail ? [detail.firstMes, ...detail.alternateGreetings] : [], greetingIndex: 0,
              helperContext: { name: detail?.name, macroName: detail?.characterName ?? detail?.name, canSwipe: false },
              helperLabels: { diagnostics: t('speech.helperMessages'), unsupported: t('speech.helperUnsupported') },
              variableStyles: CARD_VARIABLE_STYLES,
              variableLabels:cardVariableLabels(t,t('speech.cardDataNote')),
            })}
            title={t('characters.detail.interactiveFrame')}
            style={{ width: '100%', height: '60vh', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))', borderRadius: 16, background: 'var(--dsw-alias-bg-base, #111)' }}
          />
        </Dialog>
      )}
    </Dialog>
  )
}

export function CharactersSection(props: { remote: TavernRemote }) {
  return <PersistentEditor remote={props.remote} scope="characters"><CharactersSectionContent {...props} /></PersistentEditor>
}

function CharactersSectionContent(props: { remote: TavernRemote }) {
  const { remote } = props
  const t = useT()
  const [collection, setCollection] = useState<'active' | 'archived'>('active')
  const { state, reload } = useLoader(
    () => collection === 'active' ? remote.listCharacters({}) : remote.listArchivedCharacters({}),
    [collection],
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [detailId, setDetailId] = useDraftState<string | null>('characters:detailId', null)
  const [pending, setPending] = useState<{ name: string; dataBase64: string; preview: CharacterInspect } | null>(null)
  const [toDelete, setToDelete] = useState<CharacterSummary | null>(null)
  const [creating, setCreating] = useDraftState('characters:creating', false)
  const [newName, setNewName] = useDraftState('characters:newName', '')
  const [query, setQuery] = useState('')
  const toast = useToast()
  const createGuard = useDraftGuard(creating && !!newName.trim(), busy)
  const closeCreate = () => createGuard.request(() => {
    setCreating(false)
    setNewName('')
  })

  const doImport = async (name: string, dataBase64: string, importWorldBook: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const r = await remote.importCharacter({ name, dataBase64, importWorldBook })
      const err = errOf(r)
      if (err) setError(err)
      else {
        setPending(null)
        toast.show(t(importWorldBook ? 'characters.importedWithBook' : 'characters.imported'))
        reload()
      }
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : String(err2))
    } finally {
      setBusy(false)
    }
  }

  const onImportFile = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const dataBase64 = await fileToBase64(file)
      const inspected = await remote.inspectCharacter({ name: file.name, dataBase64 })
      if (!inspected.ok) {
        setError(inspected.error.message)
        return
      }
      setPending({ name: file.name, dataBase64, preview: inspected.value })
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : String(err2))
    } finally {
      setBusy(false)
    }
  }

  // 写入失败可能只是回执丢失，也可能是另一窗口改了收纳状态；重读列表恢复真实状态，保留错误供重试判断。
  const refreshAfterError = (message: string) => {
    setError(message)
    reload()
  }

  const onDelete = async () => {
    if (!toDelete) return
    const failed = (message: string) => {
      // 引用保护和传输失败都关闭确认框，避免正文错误被模态框遮住。
      setToDelete(null)
      refreshAfterError(message)
    }
    await runAsync(setBusy, setError, async () => {
      const r = await remote.deleteCharacter({ cardId: toDelete.cardId })
      const err = errOf(r)
      if (err) failed(err)
      else {
        toast.show(
          r.ok && r.value.salvagedLorebook
            ? t('characters.deletedSalvaged', { name: toDelete.name, book: r.value.salvagedLorebook })
            : t('characters.deleted', { name: toDelete.name }),
        )
        invalidateCharacter(toDelete.cardId)
        setToDelete(null)
        reload()
      }
    }, failed)
  }

  const onArchive = async (item: CharacterSummary) => {
    await runAsync(setBusy, setError, async () => {
      const r = await remote.archiveCharacter({ cardId: item.cardId })
      const err = errOf(r)
      if (err) refreshAfterError(err)
      else {
        toast.show(t('characters.archived', { name: item.name }))
        if (detailId === item.cardId) setDetailId(null)
        reload()
      }
    }, refreshAfterError)
  }

  const onRestore = async (item: CharacterSummary) => {
    await runAsync(setBusy, setError, async () => {
      const r = await remote.restoreCharacter({ cardId: item.cardId })
      const err = errOf(r)
      if (err) refreshAfterError(err)
      else {
        toast.show(t('characters.restored', { name: item.name }))
        reload()
      }
    }, refreshAfterError)
  }

  const items = state.status === 'ready' ? state.value.items : []
  // 卡多或已有搜索内容时显示搜索框；删卡与刷新不能隐藏仍生效的筛选。
  const q = query.trim().toLowerCase()
  const filtered = items.filter((c) => matchesCharacterSearch(c, query))
  return (
    <Section title={t('section.characters')} description={t('characters.section.desc')}>
      {toast.node}
      {createGuard.confirmation}
      <Tabs
        value={collection}
        label={t('characters.collectionLabel')}
        onChange={(value) => {
          setCollection(value as 'active' | 'archived')
          setError(null)
          setToDelete(null)
        }}
        items={[
          { id: 'active', label: t('characters.collection.active') },
          { id: 'archived', label: t('characters.collection.archived') },
        ]}
      />
      <div className="dsh-tavern-toolbar">
        {collection === 'active' && <>
          <FileBtn accept=".png,.json" disabled={busy} onFile={(file) => void onImportFile(file)}>
            {t('characters.importFile')}
          </FileBtn>
          <Btn size="md" disabled={busy} onClick={() => setCreating(true)}>{t('characters.newCard')}</Btn>
        </>}
        <Btn size="md" onClick={reload} disabled={busy}>{t('action.refresh')}</Btn>
        {(items.length >= 5 || query !== '') && (
          <SearchInput
            label={t('characters.searchLabel')}
            value={query}
            onChange={setQuery}
            placeholder={t('characters.searchPlaceholder')}
            width={220}
          />
        )}
      </div>
      {state.status === 'loading' && (
        <div className="dsh-tavern-charGrid">
          <Skeleton height={198} radius={18} />
          <Skeleton height={198} radius={18} />
          <Skeleton height={198} radius={18} />
        </div>
      )}
      {state.status === 'error' && <Err message={state.message} />}
      <Err message={error} />
      {items.length === 0 && state.status === 'ready' && (
        <div className="dsh-tavern-empty">
          <div className="dsh-tavern-emptyIcon">
            {collection === 'active' ? <IconUserOutlineMedium size={32} /> : <IconArchiveOutlineMedium size={32} />}
          </div>
          <div className="dsh-tavern-emptyTitle">{t(collection === 'active' ? 'hero.noCharacters' : 'characters.archive.emptyTitle')}</div>
          <div className="dsh-tavern-emptyDesc">{t(collection === 'active' ? 'characters.emptyDesc' : 'characters.archive.emptyDesc')}</div>
        </div>
      )}
      {q !== '' && filtered.length === 0 && state.status === 'ready' && (
        <SearchEmpty what={t('characters.what')} query={query.trim()} onClear={() => setQuery('')} />
      )}
      <div className="dsh-tavern-charGrid">
        {filtered.map((item) => (
          <CharacterCard key={item.cardId} remote={remote} item={item} busy={busy} archived={collection === 'archived'}
            onOpen={collection === 'active' ? setDetailId : undefined} onArchive={(card) => void onArchive(card)}
            onRestore={(card) => void onRestore(card)} onDelete={setToDelete} />
        ))}
      </div>
      {detailId && (
        <CharacterDetailDialog
          key={detailId}
          remote={remote}
          cardId={detailId}
          onClose={() => setDetailId(null)}
          onSaved={reload}
        />
      )}
      {pending && (
        <Dialog
          open
          title={t('characters.importPreview.title')}
          description={
            !pending.preview.hasCharacterBook
              ? t('characters.importPreview.desc', { name: pending.preview.name })
              : pending.preview.characterBookName
              ? t('characters.importBook.descNamed', { name: pending.preview.name, book: pending.preview.characterBookName, count: pending.preview.entryCount })
              : t('characters.importBook.desc', { name: pending.preview.name, count: pending.preview.entryCount })
          }
          onClose={() => { if (!busy) setPending(null) }}
          footer={
            <div className="dsh-tavern-modalActions">
              <Button type="button" variant="outline" size="md" disabled={busy} onClick={() => { setPending(null); setError(null) }}>
                {t('action.cancel')}
              </Button>
              {pending.preview.hasCharacterBook && <Button type="button" variant="outline" size="md" disabled={busy} onClick={() => void doImport(pending.name, pending.dataBase64, false)}>
                {t('characters.importBook.skip')}
              </Button>}
              <Button type="button" variant="primary" size="md" disabled={busy} onClick={() => void doImport(pending.name, pending.dataBase64, pending.preview.hasCharacterBook)}>
                {t(pending.preview.hasCharacterBook ? 'characters.importBook.import' : 'characters.importPreview.import')}
              </Button>
            </div>
          }
        >
          <Err message={error} />
          <section className="dsh-tavern-compatibility" aria-label={t('characters.compatibility.title')}>
            <p className="dsh-tavern-compatibilityNote">{t('characters.compatibility.note')}</p>
            {(['unsupported', 'review', 'supported'] as const).map(status => {
              const findings = pending.preview.compatibility.findings.filter(item => item.status === status)
              return findings.length > 0 && <div key={status}>
                <h3>{t(`characters.compatibility.status.${status}`)}</h3>
                <ul>{findings.map(item => <li key={item.code}>
                  <strong>{t(`characters.compatibility.${item.code}.title`)}</strong>
                  <span>{t(`characters.compatibility.${item.code}.desc`)}</span>
                  <small>{t('characters.compatibility.locations', { count: item.count, locations: item.locations.join(', ') })}</small>
                </li>)}</ul>
              </div>
            })}
          </section>
          {pending.preview.hasCharacterBook && <p className="dsh-tavern-compatibilityNote">
            {t('characters.importBook.skipNote')}
          </p>}
        </Dialog>
      )}
      <ConfirmDialog
        open={toDelete !== null}
        title={t('characters.deletePermanently.title')}
        description={toDelete ? t('characters.deletePermanently.desc', { name: toDelete.name }) : ''}
        confirmLabel={t('characters.deletePermanently.confirm')}
        danger
        busy={busy}
        onCancel={() => setToDelete(null)}
        onConfirm={() => void onDelete()}
      />
      <Dialog
        open={creating}
        title={t('characters.create.title')}
        description={t('characters.create.desc')}
        onClose={closeCreate}
        footer={
          <div className="dsh-tavern-modalActions">
            <Btn size="md" disabled={busy} onClick={closeCreate}>{t('action.cancel')}</Btn>
            <Btn
              primary
              size="md"
              disabled={busy || !newName.trim()}
              onClick={() => {
                void runAsync(setBusy, setError, async () => {
                  const r = await remote.createCharacter({ name: newName.trim() })
                  const err = errOf(r)
                  if (err) setError(err)
                  else {
                    toast.show(t('characters.created', { name: r.ok ? r.value.name : newName }))
                    setCreating(false)
                    setNewName('')
                    reload()
                    if (r.ok) setDetailId(r.value.cardId)
                  }
                })
              }}
            >
              {t('characters.create.confirm')}
            </Btn>
          </div>
        }
      >
        <Field label={t('characters.create.namePlaceholder')}>
          <input
            className="dsh-tavern-input"
            style={{ width: '100%', height: 36, borderRadius: 8, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }}
            disabled={busy}
            value={newName}
            placeholder={t('characters.create.namePlaceholder')}
            onChange={(e) => setNewName(e.target.value)}
          />
        </Field>
      </Dialog>
    </Section>
  )
}
