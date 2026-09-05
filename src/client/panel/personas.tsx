/**
 * 设置面板分区：人设（卡片网格 / 新建编辑 / 删除 / 设为默认）。
 * 卡片可键盘触发（clickableProps）；保存/设默认等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useDraftGuard } from '../drafts.js'
import { useDraftState } from '../draftPersistence.js'
import { useState } from 'react'
import { IconEditOutline16, IconTrashOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useT } from '../i18n.js'
import type { Persona, TavernRemote } from '../types.js'
import { EMPTY_SESSION_DEFAULTS } from '../types.js'
import { Badge, Btn, ConfirmDialog, Err, Field, IconBtn, SaveBar, SearchEmpty, SearchInput, Section, Select, Skeleton, clickableProps, errOf, runAsync, useLoader, useToast } from '../util.js'

export function PersonasSection(props: { remote: TavernRemote }) {
  const { remote } = props
  const t = useT()
  const { state, reload } = useLoader(() => remote.listPersonas({}), [])
  const lore = useLoader(() => remote.listLorebooks({}), [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [baseline, setBaseline] = useDraftState<string | null>('personas:baseline', null)
  const [editing, setEditing] = useDraftState<Persona | null>('personas:editing', null)
  const [toDelete, setToDelete] = useState<Persona | null>(null)
  const [query, setQuery] = useState('')
  const toast = useToast()
  const guard = useDraftGuard(editing !== null && JSON.stringify(editing) !== baseline, busy)
  const openPersona = (p: Persona) => guard.request(() => { setEditing({ ...p }); setBaseline(JSON.stringify(p)) })

  const items = state.status === 'ready' ? state.value.items : []
  const q = query.trim().toLowerCase()
  const filtered = q === '' ? items : items.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))

  const save = async () => {
    if (!editing) return
    if (!editing.name.trim()) {
      setError(t('personas.nameRequired'))
      return
    }
    await runAsync(setBusy, setError, async () => {
      const r = await remote.savePersona({ persona: editing })
      const err = errOf(r)
      if (err) setError(err)
      else {
        setBaseline(JSON.stringify(editing))
        toast.show(t('personas.saved', { name: editing.name }))
        reload()
      }
    })
  }

  const remove = async () => {
    if (!toDelete) return
    await runAsync(setBusy, setError, async () => {
      const r = await remote.deletePersona({ id: toDelete.id })
      const err = errOf(r)
      if (err) setError(err)
      else {
        if (editing?.id === toDelete.id) setEditing(null)
        setToDelete(null)
        reload()
      }
    })
  }

  const createNew = () => {
    setEditing({ id: `persona-${Date.now().toString(36)}`, name: '', description: '', avatar: null, lorebookId: null })
  }

  const setAsDefault = async (id: string) => {
    await runAsync(setBusy, setError, async () => {
      const current = await remote.getSettings({})
      if (!current.ok) {
        setError(current.error.message)
        return
      }
      const defaults = { ...EMPTY_SESSION_DEFAULTS, ...current.value.settings.defaults, personaId: id }
      const r = await remote.updateSettings({ patch: { defaults } })
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
        <Btn size="md" onClick={() => guard.request(createNew)}>{t('personas.new')}</Btn>
        <Btn size="md" onClick={reload} disabled={busy}>{t('action.refresh')}</Btn>
        {items.length >= 5 && (
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
      <Err message={error} />
      {items.length === 0 && state.status === 'ready' && (
        <div className="dsh-tavern-empty">
          <div className="dsh-tavern-emptyIcon">
            <IconUserOutline16 size={32} />
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
              <IconBtn label={t('action.edit')} onClick={() => openPersona(p)}>
                <IconEditOutline16 />
              </IconBtn>
              <Btn size="sm" disabled={busy} onClick={() => void setAsDefault(p.id)}>{t('personas.setDefault')}</Btn>
              <IconBtn label={t('personas.delete')} danger onClick={() => setToDelete(p)}>
                <IconTrashOutline16 />
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
        onCancel={() => setToDelete(null)}
        onConfirm={() => void remove()}
      />
      {editing && (
        <fieldset disabled={busy} className="dsh-tavern-editorFields dsh-tavern-card" style={{ marginBottom: 12 }}>
          <Field label={t('personas.field.name')}>
            <input className="dsh-tavern-input" style={{ flex: 1 }} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </Field>
          <div className="dsh-tavern-field">
            <span className="dsh-tavern-fieldLabel">{t('personas.field.description')}</span>
            <textarea
              className="dsh-tavern-input dsh-tavern-textarea"
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
          </div>
          <Field label={t('personas.field.lorebook')}>
            <Select
              width="100%"
              value={editing.lorebookId ?? ''}
              onChange={(v) => setEditing({ ...editing, lorebookId: v || null })}
              options={[
                { value: '', label: t('personas.lorebookNone') },
                ...(lore.state.status === 'ready' ? lore.state.value.items.map((n) => ({ value: n, label: n })) : []),
              ]}
            />
          </Field>
          <SaveBar>
            <Btn disabled={busy} onClick={() => void save()} primary>{t('action.save')}</Btn>
            <Btn onClick={() => guard.request(() => setEditing(null))}>{t('action.close')}</Btn>
          </SaveBar>
        </fieldset>
      )}
    </Section>
  )
}
