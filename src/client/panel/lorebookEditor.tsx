/**
 * 世界书条目编辑器：按 SillyTavern World Info 语义列出条目，
 * 折叠行上可开关，展开后编辑关键词/正文/插入位置等。不展示原始 JSON。
 * 展开/收起走 .dsh-tavern-collapse 动画容器（grid-rows 过渡，表单始终渲染）。
 */
import { useDraftGuard } from '../drafts.js'
import { PersistentEditor, useDraftState } from '../draftPersistence.js'
import { useId, useMemo, useRef, useState } from 'react'
import {
  IconChevronDownOutline14,
  IconPlusOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WIPosition, WIRole, WISelectiveLogic, WISource, WorldInfoEntry } from '../../core/types.js'
import { exportLorebook } from '../../state/lorebook.js'
import { useT } from '../i18n.js'
import { Badge, Btn, ConfirmDialog, Err, IconBtn, Muted, NumInput, NullableNumInput, Select, Toggle, errOf, runAsync } from '../util.js'
import type { Envelope, TavernRemote } from '../types.js'

const PAGE_SIZE = 40

type TFunc = ReturnType<typeof useT>

const positionOptions = (t: TFunc) => [
  { value: '0', label: t('lorebookEditor.position.0') },
  { value: '1', label: t('lorebookEditor.position.1') },
  { value: '2', label: t('lorebookEditor.position.2') },
  { value: '3', label: t('lorebookEditor.position.3') },
  { value: '4', label: t('lorebookEditor.position.4') },
  { value: '5', label: t('lorebookEditor.position.5') },
  { value: '6', label: t('lorebookEditor.position.6') },
  { value: '7', label: t('lorebookEditor.position.7') },
]

const logicOptions = (t: TFunc) => [
  { value: '0', label: t('lorebookEditor.logic.0') },
  { value: '1', label: t('lorebookEditor.logic.1') },
  { value: '2', label: t('lorebookEditor.logic.2') },
  { value: '3', label: t('lorebookEditor.logic.3') },
]

const ROLE_OPTIONS = [
  { value: '0', label: 'system' },
  { value: '1', label: 'user' },
  { value: '2', label: 'assistant' },
]

/** 条目级布尔覆盖（boolean | null）的三态选项：null = 跟随全局设置。 */
const triStateOptions = (t: TFunc) => [
  { value: '', label: t('lorebookEditor.tri.follow') },
  { value: 'true', label: t('lorebookEditor.tri.on') },
  { value: 'false', label: t('lorebookEditor.tri.off') },
]

const triValue = (v: boolean | null): string => (v === null ? '' : String(v))
const triFrom = (v: string): boolean | null => (v === '' ? null : v === 'true')

type FilterId = 'all' | 'on' | 'off' | 'constant'

function splitKeys(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function joinKeys(keys: string[]): string {
  return keys.join(', ')
}

function entryTitle(t: TFunc, entry: WorldInfoEntry): string {
  const comment = entry.comment.trim()
  if (comment) return comment
  if (entry.keys.length > 0) return entry.keys.slice(0, 3).join(', ')
  return t('lorebookEditor.entry.untitled')
}

function entrySub(t: TFunc, entry: WorldInfoEntry): string {
  const bits: string[] = []
  if (entry.keys.length > 0) bits.push(entry.keys.slice(0, 4).join(', '))
  bits.push(t('lorebookEditor.entry.order', { order: entry.order }))
  if (entry.constant) bits.push(t('lorebookEditor.constant'))
  if (entry.group.trim()) bits.push(t('lorebookEditor.entry.group', { group: entry.group.trim() }))
  return bits.join('  ·  ')
}

function newUid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function newEntry(source: WISource, sourceRef: string): WorldInfoEntry {
  const uid = newUid()
  return {
    key: `${source}:${sourceRef}:${uid}`,
    uid,
    source,
    sourceRef,
    keys: [],
    secondaryKeys: [],
    selective: false,
    selectiveLogic: 0,
    comment: '',
    content: '',
    constant: false,
    enabled: true,
    order: 100,
    position: 0,
    depth: 4,
    role: 0,
    outletName: '',
    probability: 100,
    useProbability: true,
    caseSensitive: null,
    matchWholeWords: null,
    scanDepth: null,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    ignoreBudget: false,
    group: '',
    groupWeight: 100,
    groupOverride: false,
    automationId: '',
  }
}

export type LorebookTarget =
  | { kind: 'library'; name: string }
  | { kind: 'character'; cardId: string; name: string }
  | { kind: 'chat'; cardId: string; storyId?: string; name: string }

function sourceOf(target: LorebookTarget): { source: WISource; sourceRef: string } {
  if (target.kind === 'library') return { source: 'global', sourceRef: target.name }
  if (target.kind === 'chat') return { source: 'chat', sourceRef: 'chat-lorebook' }
  return { source: 'character', sourceRef: target.cardId }
}

function targetKindLabel(t: TFunc, kind: LorebookTarget['kind']): string {
  if (kind === 'character') return t('lorebookEditor.kind.character')
  if (kind === 'chat') return t('lorebookEditor.kind.chat')
  return t('lorebookEditor.kind.library')
}

type LorebookEditorProps = {
  remote?: TavernRemote
  target: LorebookTarget
  entries: WorldInfoEntry[]
  onClose: () => void
  onSaved: () => void
  save: (json: unknown) => Promise<Envelope<unknown>>
}

/** 共享库按名字、内嵌书按角色、聊天书按角色和剧情隔离；无剧情的旧入口不跨挂载恢复。 */
function targetDraftKey(target: LorebookTarget, fallback: string): string {
  if (target.kind === 'library') return `lorebook.library:${JSON.stringify(target.name)}`
  if (target.kind === 'character') return `lorebook.character:${target.cardId}`
  return `lorebook.chat:${JSON.stringify([target.cardId, target.storyId ?? fallback])}`
}

export function LorebookEditor(props: LorebookEditorProps) {
  const fallback = useId()
  const draftKey = targetDraftKey(props.target, fallback)
  const editor = <LorebookEditorContent key={draftKey} {...props} draftKey={draftKey} />
  if (!props.remote || (props.target.kind === 'chat' && !props.target.storyId)) return editor
  return <PersistentEditor remote={props.remote} scope={draftKey}>{editor}</PersistentEditor>
}

function LorebookEditorContent(props: LorebookEditorProps & { draftKey: string }) {
  const t = useT()
  const { target, draftKey } = props
  const { source, sourceRef } = sourceOf(target)
  const [entries, setEntries] = useDraftState<WorldInfoEntry[]>(`${draftKey}.entries`, () => props.entries.map((e) => ({ ...e })))
  const [dirty, setDirty] = useDraftState(`${draftKey}.dirty`, false)
  const [query, setQuery] = useDraftState(`${draftKey}.query`, '')
  const [filter, setFilter] = useDraftState<FilterId>(`${draftKey}.filter`, 'all')
  const [page, setPage] = useDraftState(`${draftKey}.page`, 0)
  const [openUid, setOpenUid] = useDraftState<string | null>(`${draftKey}.openUid`, null)
  const [advanced, setAdvanced] = useDraftState(`${draftKey}.advanced`, false)
  const savedEntries = useRef(props.entries)
  const [busy, setBusy] = useState(false)
  const guard = useDraftGuard(dirty, busy)
  const [error, setError] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<string | null>(null)
  const [leaveConfirm, setLeaveConfirm] = useState(false)

  const mark = (next: WorldInfoEntry[]) => {
    setEntries(next)
    setDirty(true)
  }

  const patch = (uid: string, partial: Partial<WorldInfoEntry>) => {
    mark(entries.map((e) => (e.uid === uid ? { ...e, ...partial } : e)))
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (filter === 'on' && !e.enabled) return false
      if (filter === 'off' && e.enabled) return false
      if (filter === 'constant' && !e.constant) return false
      if (!q) return true
      const hay = `${e.comment}\n${e.keys.join(' ')}\n${e.secondaryKeys.join(' ')}\n${e.content.slice(0, 400)}`.toLowerCase()
      return hay.includes(q)
    })
  }, [entries, filter, query])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)
  const enabledCount = entries.filter((e) => e.enabled).length
  const constantCount = entries.filter((e) => e.constant).length

  // 整段包进 runAsync：typert 传输失败或入参严格校验不过时是 reject 而非错误信封，
  // 传输层 reject 也必须解锁按钮——否则 busy 卡死，两个「保存」都点不动，
  // 编辑器里这一批未写回的条目全部作废。
  const save = () =>
    runAsync(setBusy, setError, async () => {
      const json =
        target.kind === 'character'
          ? { name: target.name, ...(exportLorebook(entries, target.name) as object) }
          : exportLorebook(entries, target.name)
      const r = await props.save(json)
      const err = errOf(r)
      if (err) setError(err)
      else {
        savedEntries.current = entries
        setDirty(false)
        guard.clearDraft()
        props.onSaved()
      }
    })

  const addEntry = () => {
    const created = newEntry(source, sourceRef)
    mark([created, ...entries])
    setFilter('all')
    setQuery('')
    setPage(0)
    setOpenUid(created.uid)
    setAdvanced(false)
  }

  const applyFilterEnabled = (enabled: boolean) => {
    const ids = new Set(filtered.map((e) => e.uid))
    mark(entries.map((e) => (ids.has(e.uid) ? { ...e, enabled } : e)))
  }

  const removeEntry = () => {
    if (!toDelete) return
    mark(entries.filter((e) => e.uid !== toDelete))
    if (openUid === toDelete) setOpenUid(null)
    setToDelete(null)
  }

  const askClose = () => {
    if (busy) return
    if (dirty) setLeaveConfirm(true)
    else props.onClose()
  }

  return (
    <div>
      <div className="dsh-tavern-toolbar">
        <Btn size="md" onClick={askClose}>
          {target.kind === 'chat' ? t('action.close') : t('lorebookEditor.backToList')}
        </Btn>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="dsh-tavern-cardName" style={{ fontSize: 15 }}>
            {target.name}
          </div>
          <div className="dsh-tavern-editorMeta">
            <Muted>
              {t('lorebookEditor.meta', { kind: targetKindLabel(t, target.kind), total: entries.length, enabled: enabledCount })}
              {constantCount > 0 ? t('lorebookEditor.metaConstant', { count: constantCount }) : ''}
            </Muted>
            {dirty ? <Badge accent>{t('lorebookEditor.unsaved')}</Badge> : null}
          </div>
        </div>
        <Btn size="md" onClick={addEntry}>
          {t('lorebookEditor.newEntry')}
        </Btn>
        <Btn primary size="md" disabled={busy || !dirty} onClick={() => void save()}>
          {t('action.save')}
        </Btn>
      </div>
      <Err message={error} />

      <div className="dsh-tavern-search" style={{ margin: '10px 0 12px' }}>
        <span className="dsh-tavern-searchIcon">
          <IconSearchOutline16 />
        </span>
        <input
          value={query}
          placeholder={t('lorebookEditor.searchPlaceholder')}
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(0)
          }}
        />
      </div>
      <div className="dsh-tavern-filters">
        {(
          [
            ['all', t('lorebookEditor.filter.all', { count: entries.length })],
            ['on', t('lorebookEditor.filter.on', { count: enabledCount })],
            ['off', t('lorebookEditor.filter.off', { count: entries.length - enabledCount })],
            ['constant', t('lorebookEditor.filter.constant', { count: constantCount })],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="dsh-tavern-chip"
            data-active={filter === id ? 'true' : 'false'}
            onClick={() => {
              setFilter(id)
              setPage(0)
            }}
          >
            {label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <Btn size="sm" onClick={() => applyFilterEnabled(true)} disabled={filtered.length === 0}>
          {t('lorebookEditor.enableFiltered')}
        </Btn>
        <Btn size="sm" onClick={() => applyFilterEnabled(false)} disabled={filtered.length === 0}>
          {t('lorebookEditor.disableFiltered')}
        </Btn>
      </div>

      {filtered.length === 0 ? (
        <Muted>{entries.length === 0 ? t('lorebookEditor.empty') : t('common.noMatch', { what: t('lorebookEditor.entryNoun') })}</Muted>
      ) : (
        <div className="dsh-tavern-list dsh-tavern-scroll">
          {pageItems.map((entry) => {
            const open = openUid === entry.uid
            return (
              <div key={entry.uid} className={`dsh-tavern-entry${open ? ' is-open' : ''}${entry.enabled ? '' : ' is-off'}`}>
                <div className="dsh-tavern-entryHead" onClick={() => setOpenUid(open ? null : entry.uid)}>
                  <Toggle
                    checked={entry.enabled}
                    title={entry.enabled ? t('lorebookEditor.entry.disable') : t('lorebookEditor.entry.enable')}
                    onChange={(enabled) => patch(entry.uid, { enabled })}
                  />
                  <div className="dsh-tavern-entryMain">
                    <div className="dsh-tavern-entryTitle">{entryTitle(t, entry)}</div>
                    <div className="dsh-tavern-entrySub">{entrySub(t, entry)}</div>
                  </div>
                  <div className="dsh-tavern-entryBadges">
                    {entry.constant ? <Badge>{t('lorebookEditor.constant')}</Badge> : null}
                    {entry.keys.length > 0 ? <Badge>{t('lorebookEditor.entry.keys', { count: entry.keys.length })}</Badge> : <Badge>{t('lorebookEditor.entry.noKeys')}</Badge>}
                  </div>
                  <span className={`dsh-tavern-chevron${open ? ' is-open' : ''}`}>
                    <IconChevronDownOutline14 />
                  </span>
                </div>
                <div className={`dsh-tavern-collapse${open ? ' is-open' : ''}`}>
                  <div className="dsh-tavern-collapseInner">
                    <EntryForm
                      entry={entry}
                      advanced={advanced}
                      onAdvanced={setAdvanced}
                      onChange={(partial) => patch(entry.uid, partial)}
                      onDelete={() => setToDelete(entry.uid)}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {pageCount > 1 && (
        <div className="dsh-tavern-pager">
          <Btn size="sm" disabled={safePage <= 0} onClick={() => setPage(safePage - 1)}>
            {t('lorebookEditor.pager.prev')}
          </Btn>
          <Muted>
            {t('lorebookEditor.pager.status', { page: safePage + 1, pageCount, count: pageItems.length })}
          </Muted>
          <Btn size="sm" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
            {t('lorebookEditor.pager.next')}
          </Btn>
        </div>
      )}

      <div className="dsh-tavern-stickyBar">
        <Btn size="md" onClick={addEntry}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <IconPlusOutline16 /> {t('lorebookEditor.newEntry')}
          </span>
        </Btn>
        <Btn primary size="md" disabled={busy || !dirty} onClick={() => void save()}>
          {t('action.save')}
        </Btn>
        <Btn size="md" onClick={askClose}>
          {dirty ? t('lorebookEditor.discardAndBack') : t('lorebookEditor.back')}
        </Btn>
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title={t('lorebookEditor.delete.title')}
        description={t('lorebookEditor.delete.desc')}
        confirmLabel={t('lorebookEditor.deleteEntry')}
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={removeEntry}
      />
      <ConfirmDialog
        open={leaveConfirm}
        title={t('lorebookEditor.discard.title')}
        description={t('lorebookEditor.discard.desc')}
        confirmLabel={t('lorebookEditor.discard.confirm')}
        danger
        onCancel={() => setLeaveConfirm(false)}
        onConfirm={() => {
          if (busy) return
          setLeaveConfirm(false)
          setEntries(savedEntries.current)
          setDirty(false)
          guard.clearDraft()
          props.onClose()
        }}
      />
    </div>
  )
}

function EntryForm(props: {
  entry: WorldInfoEntry
  advanced: boolean
  onAdvanced: (v: boolean) => void
  onChange: (partial: Partial<WorldInfoEntry>) => void
  onDelete: () => void
}) {
  const t = useT()
  const { entry } = props
  const set = props.onChange
  return (
    <div className="dsh-tavern-entryBody" onClick={(e) => e.stopPropagation()}>
      <label className="dsh-tavern-field">
        <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.comment')}</span>
        <input
          className="dsh-tavern-input"
          style={{ width: '100%', height: 36, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }}
          value={entry.comment}
          placeholder={t('lorebookEditor.form.commentPlaceholder')}
          onChange={(e) => set({ comment: e.target.value })}
        />
      </label>
      <label className="dsh-tavern-field">
        <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.keys')}</span>
        <input
          className="dsh-tavern-input dsh-tavern-codeFont"
          style={{ width: '100%', height: 36, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }}
          value={joinKeys(entry.keys)}
          placeholder={t('lorebookEditor.form.keysPlaceholder')}
          onChange={(e) => set({ keys: splitKeys(e.target.value) })}
        />
      </label>
      <label className="dsh-tavern-field">
        <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.content')}</span>
        <textarea
          className="dsh-tavern-input dsh-tavern-textarea"
          style={{ minHeight: 120 }}
          value={entry.content}
          placeholder={t('lorebookEditor.form.contentPlaceholder')}
          onChange={(e) => set({ content: e.target.value })}
        />
      </label>
      <div className="dsh-tavern-inlineChecks">
        <label>
          <Toggle checked={entry.constant} onChange={(constant) => set({ constant })} />
          {t('lorebookEditor.form.constant')}
        </label>
        <label>
          <Toggle checked={entry.selective} onChange={(selective) => set({ selective })} />
          {t('lorebookEditor.form.selective')}
        </label>
        <label>
          <Toggle checked={entry.ignoreBudget} onChange={(ignoreBudget) => set({ ignoreBudget })} />
          {t('lorebookEditor.form.ignoreBudget')}
        </label>
      </div>
      <div className="dsh-tavern-fieldRow">
        <label className="dsh-tavern-field">
          <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.position')}</span>
          <Select
            size="md"
            value={String(entry.position)}
            onChange={(v) => set({ position: Number(v) as WIPosition })}
            options={positionOptions(t)}
          />
        </label>
        <label className="dsh-tavern-field">
          <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.order')}</span>
          <NumInput value={entry.order} onChange={(order) => set({ order: Math.round(order) })} />
        </label>
        {entry.position === 4 || entry.position === 7 ? (
          <label className="dsh-tavern-field">
            <span className="dsh-tavern-fieldLabel">{entry.position === 7 ? t('lorebookEditor.form.outletName') : t('lorebookEditor.form.depth')}</span>
            {entry.position === 7 ? (
              <input
                className="dsh-tavern-input"
                style={{ width: '100%', height: 36, padding: '0 10px', boxSizing: 'border-box' }}
                value={entry.outletName}
                onChange={(e) => set({ outletName: e.target.value })}
              />
            ) : (
              <NumInput value={entry.depth} onChange={(depth) => set({ depth: Math.max(0, Math.round(depth)) })} />
            )}
          </label>
        ) : null}
      </div>
      {entry.selective ? (
        <div className="dsh-tavern-fieldRow">
          <label className="dsh-tavern-field">
            <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.secondaryKeys')}</span>
            <input
              className="dsh-tavern-input dsh-tavern-codeFont"
              style={{ width: '100%', height: 36, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }}
              value={joinKeys(entry.secondaryKeys)}
              placeholder={t('lorebookEditor.form.secondaryKeysPlaceholder')}
              onChange={(e) => set({ secondaryKeys: splitKeys(e.target.value) })}
            />
          </label>
          <label className="dsh-tavern-field">
            <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.selectiveLogic')}</span>
            <Select
              size="md"
              value={String(entry.selectiveLogic)}
              onChange={(v) => set({ selectiveLogic: Number(v) as WISelectiveLogic })}
              options={logicOptions(t)}
            />
          </label>
        </div>
      ) : null}

      <Btn size="sm" onClick={() => props.onAdvanced(!props.advanced)}>
        {props.advanced ? t('lorebookEditor.form.advanced.hide') : t('lorebookEditor.form.advanced.show')}
      </Btn>
      {props.advanced ? (
        <>
          <div className="dsh-tavern-fieldRow">
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.probability')}</span>
              <NumInput value={entry.probability} onChange={(probability) => set({ probability })} />
            </label>
            <label className="dsh-tavern-inlineChecks" style={{ paddingTop: 22 }}>
              <span>
                <Toggle checked={entry.useProbability} onChange={(useProbability) => set({ useProbability })} /> {t('lorebookEditor.form.useProbability')}
              </span>
            </label>
            {entry.position === 4 ? (
              <label className="dsh-tavern-field">
                <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.role')}</span>
                <Select
                  size="md"
                  value={String(entry.role)}
                  onChange={(v) => set({ role: Number(v) as WIRole })}
                  options={ROLE_OPTIONS}
                />
              </label>
            ) : null}
          </div>
          <div className="dsh-tavern-inlineChecks">
            <label>
              <Toggle checked={entry.excludeRecursion} onChange={(excludeRecursion) => set({ excludeRecursion })} />
              {t('lorebookEditor.form.excludeRecursion')}
            </label>
            <label>
              <Toggle checked={entry.preventRecursion} onChange={(preventRecursion) => set({ preventRecursion })} />
              {t('lorebookEditor.form.preventRecursion')}
            </label>
          </div>
          <div className="dsh-tavern-fieldRow">
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.delayUntilRecursion')}</span>
              <NumInput
                value={entry.delayUntilRecursion}
                onChange={(delayUntilRecursion) => set({ delayUntilRecursion: Math.max(0, Math.round(delayUntilRecursion)) })}
              />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">sticky</span>
              <NullableNumInput value={entry.sticky} onChange={(sticky) => set({ sticky })} />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">cooldown</span>
              <NullableNumInput value={entry.cooldown} onChange={(cooldown) => set({ cooldown })} />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">delay</span>
              <NullableNumInput value={entry.delay} onChange={(delay) => set({ delay })} />
            </label>
          </div>
          <div className="dsh-tavern-fieldRow">
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.scanDepth')}</span>
              <NullableNumInput value={entry.scanDepth} onChange={(scanDepth) => set({ scanDepth })} />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.caseSensitive')}</span>
              <Select size="md" value={triValue(entry.caseSensitive)} onChange={(v) => set({ caseSensitive: triFrom(v) })} options={triStateOptions(t)} />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.matchWholeWords')}</span>
              <Select size="md" value={triValue(entry.matchWholeWords)} onChange={(v) => set({ matchWholeWords: triFrom(v) })} options={triStateOptions(t)} />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.group')}</span>
              <input
                className="dsh-tavern-input"
                style={{ width: '100%', height: 36, padding: '0 10px', boxSizing: 'border-box' }}
                value={entry.group}
                onChange={(e) => set({ group: e.target.value })}
              />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">{t('lorebookEditor.form.groupWeight')}</span>
              <NumInput value={entry.groupWeight} onChange={(groupWeight) => set({ groupWeight: Math.max(0, Math.round(groupWeight)) })} />
            </label>
          </div>
          <div className="dsh-tavern-inlineChecks">
            <label>
              <Toggle checked={entry.groupOverride} onChange={(groupOverride) => set({ groupOverride })} />
              {t('lorebookEditor.form.groupOverride')}
            </label>
          </div>
        </>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <IconBtn label={t('lorebookEditor.deleteEntry')} danger onClick={props.onDelete}>
          <IconTrashOutline16 />
        </IconBtn>
      </div>
    </div>
  )
}
