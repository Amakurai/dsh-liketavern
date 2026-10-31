/**
 * 设置面板分区：人设（卡片网格 / 新建编辑 / 删除 / 设为默认）。
 * 卡片可键盘触发（clickableProps）；保存/设默认等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useDraftGuard } from '../drafts.js'
import { useDraftState } from '../draftPersistence.js'
import { randomUuid } from '../../core/secureRandom.js'
import { useRef, useState } from 'react'
import { IconEditOutlineMedium, IconTrashOutlineMedium, IconUserOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { useT } from '../i18n.js'
import type { Persona, TavernRemote } from '../types.js'
import { Badge, Btn, ConfirmDialog, Err, Field, IconBtn, SaveBar, SearchEmpty, SearchInput, Section, Select, Skeleton, clickableProps, errOf, runAsync, useLoader, useToast } from '../util.js'

/** 编辑器保留读取时的版本；旧版恢复草稿缺少版本时必须重新打开，不能借刷新结果授权覆盖。 */
type PersonaDraft = Persona & { revision?: string }

export function PersonasSection(props: { remote: TavernRemote }) {
  const { remote } = props
  const t = useT()
  const { state, reload } = useLoader(() => remote.listPersonas({}), [])
  const lore = useLoader(() => remote.listLorebooks({}), [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [baseline, setBaseline] = useDraftState<string | null>('personas:baseline', null)
  const [editing, setEditing] = useDraftState<PersonaDraft | null>('personas:editing', null)
  const [toDelete, setToDelete] = useState<Persona | null>(null)
  const [query, setQuery] = useState('')
  const toast = useToast()
  const guard = useDraftGuard(editing !== null && JSON.stringify(editing) !== baseline, busy)
  const requestEditor = (action: () => void) => { if (!pending.current) guard.request(action) }
  const openPersona = (p: Persona) => requestEditor(() => { setEditing({ ...p }); setBaseline(JSON.stringify(p)) })
  /** 先同步占住写入，再提交 busy；同批事件与已打开弹层不能穿透保存边界。 */
  const perform = async (operation: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true
    try { await runAsync(setBusy, setError, operation) } finally { pending.current = false }
  }
  const edit = (patch: Partial<PersonaDraft>) => {
    if (pending.current) return
    setEditing(current => current ? { ...current, ...patch } : current)
  }

  const items = state.status === 'ready' ? state.value.items : []
  const q = query.trim().toLowerCase()
  const filtered = q === '' ? items : items.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))

  const save = async () => {
    if (!editing || pending.current) return
    if (baseline === null || (baseline !== 'null' && !editing.revision)) {
      setError(t('personas.missingRevision'))
      return
    }
    if (!editing.name.trim()) {
      setError(t('personas.nameRequired'))
      return
    }
    await perform(async () => {
      const r = await remote.savePersona({ persona: editing, expectedRevision: baseline === 'null' ? null : editing.revision! })
      const err = errOf(r)
      if (err) setError(err)
      else if (r.ok) {
        const saved = { ...editing, id: r.value.id, revision: r.value.revision }
        setEditing(saved)
        setBaseline(JSON.stringify(saved))
        if (r.value.defaultWarning) setError(t('personas.defaultFailed', { message: r.value.defaultWarning }))
        toast.show(t('personas.saved', { name: editing.name }))
        reload()
      }
    })
  }

  const remove = async () => {
    if (!toDelete) return
    await perform(async () => {
      const r = await remote.deletePersona({ id: toDelete.id })
      const err = errOf(r)
      if (err) setError(err)
      else {
        if (editing?.id === toDelete.id) { setEditing(null); setBaseline(null) }
        setToDelete(null)
        reload()
      }
    })
  }

  const createNew = () => {
    setBaseline('null')
    setEditing({ id: `persona-${randomUuid()}`, name: '', description: '', avatar: null, lorebookId: null })
  }

  const setAsDefault = async (id: string) => {
    await perform(async () => {
      // 宿主按字段合并；不能把旧默认快照中的角色、预设和世界书写回去。
      const r = await remote.updateSettings({ patch: { defaults: { personaId: id } } })
      const err = errOf(r)
      if (err) setError(err)
      else toast.show(t('personas.defaultSet'))
    })
  }

  return (
    <Section title={t('section.personas')} description={t('personas.sectionDesc')}>
      {toast.node}
      {guard.confirmation}
      <div className="dsh-tavern-toolbar">
        <Btn size="md" disabled={busy} onClick={() => requestEditor(createNew)}>{t('personas.new')}</Btn>
        <Btn size="md" onClick={() => { reload(); lore.reload() }} disabled={busy}>{t('action.refresh')}</Btn>
        {(items.length >= 5 || query !== '') && (
          <SearchInput label={t('personas.searchLabel')} value={query} onChange={setQuery} placeholder={t('personas.searchPlaceholder')} width={220} />
        )}
      </div>
      {state.status === 'loading' && (
        <div className="dsh-tavern-list">
          <Skeleton height={70} radius={16} />
          <Skeleton height={70} radius={16} />
          <Skeleton height={70} radius={16} />
        </div>
      )}
      {state.status === 'error' && <Err message={state.message} />}
      {lore.state.status === 'error' && <Err message={lore.state.message} />}
      <Err message={error} />
      {items.length === 0 && state.status === 'ready' && (
        <div className="dsh-tavern-empty">
          <div className="dsh-tavern-emptyIcon">
            <IconUserOutlineMedium size={32} />
          </div>
          <div className="dsh-tavern-emptyTitle">{t('personas.emptyTitle')}</div>
          <div className="dsh-tavern-emptyDesc">{t('personas.emptyDesc')}</div>
        </div>
      )}
      {q !== '' && filtered.length === 0 && state.status === 'ready' && (
        <SearchEmpty what={t('personas.entity')} query={query.trim()} onClear={() => setQuery('')} />
      )}
      <div className="dsh-tavern-list" style={{ marginBottom: 12 }}>
        {filtered.map((p) => (
          <div key={p.id} className="dsh-tavern-tile" {...clickableProps(() => openPersona(p))}>
            <div className="dsh-tavern-tileMain">
              <div className="dsh-tavern-tileTitleRow">
                <span className="dsh-tavern-tileName">{p.name}</span>
                {p.lorebookId ? <Badge>{p.lorebookId}</Badge> : null}
              </div>
              <span className="dsh-tavern-tileSub">{p.description.trim() || t('personas.noDescription')}</span>
            </div>
            <div className="dsh-tavern-tileActions">
              <IconBtn label={t('action.edit')} disabled={busy} onClick={() => openPersona(p)}>
                <IconEditOutlineMedium />
              </IconBtn>
              <Btn size="sm" disabled={busy} onClick={() => void setAsDefault(p.id)}>{t('personas.setDefault')}</Btn>
              <IconBtn label={t('personas.delete')} danger disabled={busy} onClick={() => { if (!pending.current) setToDelete(p) }}>
                <IconTrashOutlineMedium />
              </IconBtn>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={toDelete !== null}
        title={t('personas.deleteTitle')}
        description={toDelete ? t('personas.deleteDesc', { name: toDelete.name }) : ''}
        confirmLabel={t('action.delete')}
        danger
        busy={busy}
        onCancel={() => { if (!pending.current) setToDelete(null) }}
        onConfirm={() => void remove()}
      />
      {editing && (
        <fieldset disabled={busy} className="dsh-tavern-editorFields dsh-tavern-card" style={{ marginBottom: 12 }}>
          <Field label={t('personas.field.name')}>
            <input className="dsh-tavern-input" style={{ flex: 1 }} value={editing.name} onChange={(e) => edit({ name: e.target.value })} />
          </Field>
          <Field label={t('personas.field.description')}>
            <textarea
              className="dsh-tavern-input dsh-tavern-textarea"
              value={editing.description}
              onChange={(e) => edit({ description: e.target.value })}
            />
          </Field>
          <Field label={t('personas.field.lorebook')}>
            <Select
              width="100%"
              value={editing.lorebookId ?? ''}
              disabled={busy || lore.state.status !== 'ready'}
              onChange={(v) => edit({ lorebookId: v || null })}
              options={[
                { value: '', label: t('personas.lorebookNone') },
                ...(lore.state.status === 'ready' ? lore.state.value.items.map((n) => ({ value: n, label: n })) : []),
              ]}
            />
          </Field>
          <SaveBar>
            <Btn disabled={busy} onClick={() => void save()} primary>{t('action.save')}</Btn>
            <Btn onClick={() => requestEditor(() => { setEditing(null); setBaseline(null) })}>{t('action.close')}</Btn>
          </SaveBar>
        </fieldset>
      )}
    </Section>
  )
}
