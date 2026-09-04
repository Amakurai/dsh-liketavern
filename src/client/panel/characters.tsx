/**
 * 设置面板分区：角色卡（列表 / 导入 / 删除 / 详情 / 交互卡）。
 * 列表行走 Avatar + 尾部详情/删除 IconBtn；导入/删除等瞬时反馈走 useToast，上下文错误用 Err。
 * 交互卡预览保留 CSP meta 注入 + sandbox iframe（无 allow-same-origin），不得放宽。
 */
import { useEffect, useState } from 'react'
import { Button, IconDownloadOutline16, IconTrashOutline16, IconUserOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { cachedAvatar, cachedCharacterDetail, invalidateCharacter } from '../cache.js'
import { useT } from '../i18n.js'
import type { CharacterDetail, CharacterInspect, CharacterSummary, TavernRemote } from '../types.js'
import { Avatar, Btn, ConfirmDialog, Dialog, Err, Field, FileBtn, IconBtn, Muted, NumInput, SearchEmpty, SearchInput, Section, Select, Skeleton, clickableProps, downloadBase64, downloadJson, errOf, fileToBase64, runAsync, useLoader, useToast } from '../util.js'

const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'">'

/** 把 CSP meta 注入交互卡 HTML 头部（无 <head> 则直接前置）。 */
function withCsp(html: string): string {
  const head = /<head[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + CSP_META + html.slice(at)
  }
  return CSP_META + html
}

/** 按 cardId 拉头像 dataURL 的 Avatar 包装（失败时回落首字符/图标）；头像走进程内缓存。 */
function CardAvatar(props: { remote: TavernRemote; cardId: string; name: string; size: number }) {
  const { state } = useLoader(() => cachedAvatar(props.remote, props.cardId), [props.cardId])
  const url = state.status === 'ready' ? state.value.dataUrl : null
  return <Avatar url={url} name={props.name} size={props.size} />
}

/** 海报卡：封面图（或首字符封面）+ 底部渐变上的名字与内嵌书信息；整卡可点进编辑，删除钮悬停浮现。 */
function CharacterCard(props: {
  remote: TavernRemote
  item: CharacterSummary
  busy: boolean
  onOpen: (cardId: string) => void
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
  return (
    <article className="dsh-tavern-charCard" {...clickableProps(() => props.onOpen(props.item.cardId))}>
      <div className="dsh-tavern-charCardCover">
        {url ? <img src={url} alt="" /> : <span className="dsh-tavern-charCardInitial">{initial}</span>}
      </div>
      <div className="dsh-tavern-charCardBar">
        <div className="dsh-tavern-charCardName">{props.item.name}</div>
        {meta ? <div className="dsh-tavern-charCardMeta">{meta}</div> : null}
      </div>
      <div className="dsh-tavern-charCardActions">
        <Tooltip label={t('characters.card.delete')} side="bottom">
          <button
            type="button"
            aria-label={t('characters.card.delete')}
            className="dsh-tavern-coverBtn is-danger"
            disabled={props.busy}
            onClick={(e: { stopPropagation: () => void }) => {
              e.stopPropagation()
              props.onDelete(props.item)
            }}
          >
            <IconTrashOutline16 />
          </button>
        </Tooltip>
      </div>
    </article>
  )
}

/** 详情弹窗里的「标签 + 多行框」单元，配合 groupHead 分组使用。 */
function LabeledArea(props: { label: string; value: string; minHeight?: number; onChange: (value: string) => void }) {
  return (
    <div className="dsh-tavern-field">
      <span className="dsh-tavern-fieldLabel">{props.label}</span>
      <textarea
        className="dsh-tavern-input dsh-tavern-textarea"
        style={{ minHeight: props.minHeight ?? 64 }}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
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
  const [draft, setDraft] = useState<CharacterDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const loaded: CharacterDetail | null = state.status === 'ready' ? state.value : null
  const detail = draft ?? loaded
  useEffect(() => {
    if (loaded) setDraft(loaded)
  }, [loaded])

  const set = (patch: Partial<CharacterDetail>) => setDraft(detail ? { ...detail, ...patch } : detail)
  const interactiveHtml = typeof detail?.extensions?.interactiveHtml === 'string' ? (detail.extensions.interactiveHtml as string) : null

  const save = async () => {
    if (!detail) return
    if (!detail.name.trim()) {
      setError(t('characters.detail.nameRequired'))
      return
    }
    await runAsync(setBusy, setError, async () => {
      const r = await remote.saveCharacter({
        cardId,
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
      if (err) setError(err)
      else {
        toast.show(t('characters.detail.saved', { name: detail.name }))
        // 先失效详情/头像缓存再 reload，否则详情弹窗与聊天气泡继续吃旧值。
        invalidateCharacter(cardId)
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
    <Dialog open width="xl" title={t('characters.detail.title', { name: detail?.name ?? cardId })} onClose={props.onClose}>
      {toast.node}
      {state.status === 'loading' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Skeleton height={48} />
          <Skeleton height={14} width="60%" />
          <Skeleton height={90} />
        </div>
      )}
      {state.status === 'error' && <Err message={state.message} />}
      {detail && (
        <div className="dsh-tavern-dialogStack dsh-tavern-scroll" style={{ maxHeight: '65vh', overflow: 'auto', fontSize: 13 }}>
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
              <textarea
                className="dsh-tavern-input dsh-tavern-textarea"
                style={{ minHeight: 72 }}
                value={detail.alternateGreetings.join('\n')}
                onChange={(e) => set({ alternateGreetings: e.target.value.split('\n') })}
              />
            </div>
            <LabeledArea label={t('characters.detail.mesExample')} value={detail.mesExample} onChange={(v) => set({ mesExample: v })} />
          </div>

          <div className="dsh-tavern-panelCard">
            <div className="dsh-tavern-groupHead">{t('characters.detail.groupAdvanced')}</div>
            <LabeledArea label={t('characters.detail.systemPrompt')} value={detail.systemPrompt} onChange={(v) => set({ systemPrompt: v })} />
            <LabeledArea label={t('characters.detail.postHistory')} value={detail.postHistoryInstructions} onChange={(v) => set({ postHistoryInstructions: v })} />
            <div className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">{t('characters.detail.depthPrompt')}</span>
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
            </div>
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
              <input
                className="dsh-tavern-input"
                style={{ width: '100%' }}
                value={detail.tags.join(', ')}
                onChange={(e) => set({ tags: e.target.value.split(/[，,]/).map((s: string) => s.trim()).filter(Boolean) })}
              />
            </Field>
          </div>
          <Err message={error} />
          <div className="dsh-tavern-footActions" style={{ marginTop: 2 }}>
            <IconBtn label={t('characters.detail.exportPng')} disabled={busy} onClick={() => void exportCard('png')}>
              <IconDownloadOutline16 />
            </IconBtn>
            {interactiveHtml !== null && <Btn size="md" onClick={() => setCardOpen(true)}>{t('interactive.open')}</Btn>}
            <span className="dsh-tavern-footSpacer" />
            <Btn size="md" disabled={busy} onClick={() => void exportCard('json')}>{t('characters.detail.exportJson')}</Btn>
            <Btn primary size="md" disabled={busy} onClick={() => void save()}>{t('action.save')}</Btn>
          </div>
        </div>
      )}
      {cardOpen && interactiveHtml !== null && (
        <Dialog open width="lg" title={t('characters.detail.interactiveTitle', { name: detail?.name ?? '' })} onClose={() => setCardOpen(false)}>
          <iframe
            sandbox="allow-scripts"
            srcDoc={withCsp(interactiveHtml)}
            title={t('characters.detail.interactiveFrame')}
            style={{ width: '100%', height: '60vh', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))', borderRadius: 16, background: 'var(--dsw-alias-bg-base, #111)' }}
          />
        </Dialog>
      )}
    </Dialog>
  )
}

export function CharactersSection(props: { remote: TavernRemote }) {
  const { remote } = props
  const t = useT()
  const { state, reload } = useLoader(() => remote.listCharacters({}), [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [pending, setPending] = useState<{ name: string; dataBase64: string; preview: CharacterInspect } | null>(null)
  const [toDelete, setToDelete] = useState<CharacterSummary | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [query, setQuery] = useState('')
  const toast = useToast()

  const doImport = async (name: string, dataBase64: string, importWorldBook: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const r = await remote.importCharacter({ name, dataBase64, importWorldBook })
      const err = errOf(r)
      if (err) setError(err)
      else {
        toast.show(t(importWorldBook ? 'characters.importedWithBook' : 'characters.imported'))
        reload()
      }
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : String(err2))
    } finally {
      setBusy(false)
      setPending(null)
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
      if (inspected.value.hasCharacterBook) {
        setPending({ name: file.name, dataBase64, preview: inspected.value })
        return
      }
      await doImport(file.name, dataBase64, false)
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : String(err2))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async () => {
    if (!toDelete) return
    await runAsync(setBusy, setError, async () => {
      const r = await remote.deleteCharacter({ cardId: toDelete.cardId })
      const err = errOf(r)
      if (err) setError(err)
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
    })
  }

  const items = state.status === 'ready' ? state.value.items : []
  // 卡多到要翻页找时才出搜索框；关键词同时匹配角色名与内嵌书名。
  const q = query.trim().toLowerCase()
  const filtered =
    q === ''
      ? items
      : items.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            (c.characterBookName ?? '').toLowerCase().includes(q),
        )
  return (
    <Section title={t('section.characters')} description={t('characters.section.desc')}>
      {toast.node}
      <div className="dsh-tavern-toolbar">
        <FileBtn accept=".png,.json" disabled={busy} onFile={(file) => void onImportFile(file)}>
          {t('characters.importFile')}
        </FileBtn>
        <Btn size="md" disabled={busy} onClick={() => setCreating(true)}>{t('characters.newCard')}</Btn>
        <Btn size="md" onClick={reload} disabled={busy}>{t('action.refresh')}</Btn>
        {items.length >= 5 && (
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
            <IconUserOutline16 size={32} />
          </div>
          <div className="dsh-tavern-emptyTitle">{t('hero.noCharacters')}</div>
          <div className="dsh-tavern-emptyDesc">{t('characters.emptyDesc')}</div>
        </div>
      )}
      {q !== '' && filtered.length === 0 && state.status === 'ready' && (
        <SearchEmpty what={t('characters.what')} query={query.trim()} onClear={() => setQuery('')} />
      )}
      <div className="dsh-tavern-charGrid">
        {filtered.map((item) => (
          <CharacterCard key={item.cardId} remote={remote} item={item} busy={busy} onOpen={setDetailId} onDelete={setToDelete} />
        ))}
      </div>
      {detailId && (
        <CharacterDetailDialog
          remote={remote}
          cardId={detailId}
          onClose={() => setDetailId(null)}
          onSaved={reload}
        />
      )}
      {pending && (
        <Dialog
          open
          title={t('characters.importBook.title')}
          description={
            pending.preview.characterBookName
              ? t('characters.importBook.descNamed', { name: pending.preview.name, book: pending.preview.characterBookName, count: pending.preview.entryCount })
              : t('characters.importBook.desc', { name: pending.preview.name, count: pending.preview.entryCount })
          }
          onClose={() => setPending(null)}
          footer={
            <div className="dsh-tavern-modalActions">
              <Button type="button" variant="outline" size="md" disabled={busy} onClick={() => void doImport(pending.name, pending.dataBase64, false)}>
                {t('characters.importBook.skip')}
              </Button>
              <Button type="button" variant="primary" size="md" disabled={busy} onClick={() => void doImport(pending.name, pending.dataBase64, true)}>
                {t('characters.importBook.import')}
              </Button>
            </div>
          }
        >
          <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }}>
            {t('characters.importBook.skipNote')}
          </p>
        </Dialog>
      )}
      <ConfirmDialog
        open={toDelete !== null}
        title={t('characters.delete.title')}
        description={toDelete ? t('characters.delete.desc', { name: toDelete.name }) : ''}
        confirmLabel={t('action.delete')}
        danger
        busy={busy}
        onCancel={() => setToDelete(null)}
        onConfirm={() => void onDelete()}
      />
      <Dialog
        open={creating}
        title={t('characters.create.title')}
        description={t('characters.create.desc')}
        onClose={() => setCreating(false)}
        footer={
          <div className="dsh-tavern-modalActions">
            <Btn size="md" onClick={() => setCreating(false)}>{t('action.cancel')}</Btn>
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
        <input
          className="dsh-tavern-input"
          style={{ width: '100%', height: 36, borderRadius: 8, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }}
          value={newName}
          placeholder={t('characters.create.namePlaceholder')}
          onChange={(e) => setNewName(e.target.value)}
        />
      </Dialog>
    </Section>
  )
}
