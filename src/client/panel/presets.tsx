/**
 * 设置面板分区：提示词预设（卡片网格 / 导入 / 导出 / 删除 / 条目表格编辑）。
 * 卡片可键盘触发（clickableProps）；保存/导入/设默认等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { exportStPreset } from '../../core/presetExport.js'
import { useDraftGuard } from '../drafts.js'
import { useDraftState } from '../draftPersistence.js'
import { useState } from 'react'
import { IconDownloadOutlineMedium, IconEditOutlineMedium, IconFolderOpenOutlineMedium, IconListPenOutlineMedium, IconTrashOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CardRegexScript, ChatRole, PresetEntry, PromptPreset } from '../../core/types.js'
import { EMPTY_SESSION_DEFAULTS, type PresetSummary, type TavernRemote } from '../types.js'
import { t as tBare, useT } from '../i18n.js'
import { Badge, Btn, ConfirmDialog, Err, Field, FileBtn, IconBtn, Muted, NumInput, RegexScriptRow, SaveBar, SearchEmpty, SearchInput, Section, Select, Skeleton, Toggle, clickableProps, downloadJson, errOf, readJsonFile, runAsync, useLoader, useToast } from '../util.js'

function newEntry(order: number): PresetEntry {
  return {
    identifier: `entry-${Date.now().toString(36)}-${order}`,
    name: tBare('presets.newEntryName'),
    enabled: true,
    role: 'system',
    position: 'relative',
    depth: 4,
    order,
    content: '',
    marker: false,
  }
}

/** 预设内嵌正则列表（开关写进草稿，随「保存预设」落盘；重新导入以文件为准）。 */
function PresetRegexList(props: { scripts: CardRegexScript[]; onChange: (scripts: CardRegexScript[]) => void }) {
  const t = useT()
  return (
    <div className="dsh-tavern-field">
      <span className="dsh-tavern-fieldLabel">{t('presets.regexList.label', { count: props.scripts.length })}</span>
      <div className="dsh-tavern-list">
        {props.scripts.map((s, i) => (
          <RegexScriptRow
            key={s.id ?? i}
            script={s}
            index={i}
            onToggle={(disabled) => props.onChange(props.scripts.map((x, j) => (j === i ? { ...x, disabled } : x)))}
          />
        ))}
      </div>
    </div>
  )
}

/** 展示随预设保存的采样覆盖，避免用户把导入值与插件全局设置混淆。 */
function PresetSamplingSummary({ sampling, onChange }: { sampling: PromptPreset['sampling']; onChange: () => void }) {
  const t = useT()
  const supported = [
    ...(sampling?.temperature !== undefined ? [t('presets.sampling.temperature', { value: sampling.temperature })] : []),
    ...(sampling?.maxTokens !== undefined ? [t('presets.sampling.maxTokens', { value: sampling.maxTokens ?? t('presets.sampling.modelDefault') })] : []),
    ...(sampling?.stop !== undefined ? [t('presets.sampling.stop', { value: JSON.stringify(sampling.stop) })] : []),
  ]
  const retained = [
    ...(sampling?.topP !== undefined ? [`top_p=${sampling.topP}`] : []),
    ...(sampling?.presencePenalty !== undefined ? [`presence_penalty=${sampling.presencePenalty}`] : []),
    ...(sampling?.frequencyPenalty !== undefined ? [`frequency_penalty=${sampling.frequencyPenalty}`] : []),
  ]
  return <Field label={t('presets.sampling.label')}>
    <Muted>{supported.length > 0 ? supported.join(t('presets.warningSep')) : t('presets.sampling.global')}</Muted>
    <Muted>{t('presets.sampling.desc')}</Muted>
    {retained.length > 0 && <Muted>{t('presets.sampling.retained', { values: retained.join(t('presets.warningSep')) })}</Muted>}
    {sampling !== undefined && <>
      <Btn onClick={onChange}>{t('presets.sampling.useGlobal')}</Btn>
      <Muted>{t('presets.sampling.useGlobalDesc')}</Muted>
    </>}
  </Field>
}

function EntryEditor(props: { entry: PresetEntry; onChange: (e: PresetEntry) => void; onDelete: () => void }) {
  const { entry } = props
  const t = useT()
  const set = (patch: Partial<PresetEntry>) => props.onChange({ ...entry, ...patch })
  return (
    <div className="dsh-tavern-entry">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '12px 16px 8px' }}>
        <Toggle checked={entry.enabled} onChange={(enabled) => set({ enabled })} title={entry.enabled ? t('presets.entry.disable') : t('presets.entry.enable')} />
        <input aria-label={t('presets.name')} className="dsh-tavern-input" style={{ width: 160 }} value={entry.name} placeholder={t('presets.name')} onChange={(e) => set({ name: e.target.value })} />
        <Select
          value={entry.role}
          onChange={(v) => set({ role: v as ChatRole })}
          options={[
            { value: 'system', label: 'system' },
            { value: 'user', label: 'user' },
            { value: 'assistant', label: 'assistant' },
          ]}
        />
        <Select
          value={entry.position}
          onChange={(v) => set({ position: v as PresetEntry['position'] })}
          options={[
            { value: 'relative', label: 'relative' },
            { value: 'in-chat', label: 'in-chat' },
          ]}
        />
        {entry.position === 'in-chat' && (
          <label style={{ fontSize: 12 }}>
            {t('presets.entry.depth')} <NumInput value={entry.depth} width={64} onChange={(v) => set({ depth: Math.max(0, Math.round(v)) })} />
          </label>
        )}
        <label style={{ fontSize: 12 }}>
          {t('presets.entry.order')} <NumInput value={entry.order} width={64} onChange={(v) => set({ order: Math.round(v) })} />
        </label>
        <label style={{ fontSize: 12 }}>
          <input type="checkbox" checked={entry.marker} onChange={(e) => set({ marker: e.target.checked })} /> {t('presets.entry.marker')}
        </label>
        {entry.marker && (
          <input aria-label={t('presets.entry.markerId')} className="dsh-tavern-input" style={{ width: 140 }} value={entry.markerId ?? ''} placeholder="markerId" onChange={(e) => set({ markerId: e.target.value })} />
        )}
        <span style={{ flex: 1 }} />
        <IconBtn label={t('presets.entry.delete')} danger onClick={props.onDelete}>
          <IconTrashOutlineMedium />
        </IconBtn>
      </div>
      {!entry.marker && (
        <div style={{ padding: '2px 16px 14px' }}>
          <textarea aria-label={t('presets.entry.content')} className="dsh-tavern-input dsh-tavern-textarea" style={{ minHeight: 60 }} value={entry.content} placeholder={t('presets.entry.content')} onChange={(e) => set({ content: e.target.value })} />
        </div>
      )}
    </div>
  )
}

export function PresetsSection(props: { remote: TavernRemote }) {
  const { remote } = props
  const { state, reload } = useLoader(() => remote.listPresets({}), [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [baseline, setBaseline] = useDraftState<string | null>('presets:baseline', null)
  const [editing, setEditing] = useDraftState<PromptPreset | null>('presets:editing', null)
  // identifier 保留导入原值，磁盘 id 可能经过净化或带冲突后缀；草稿同时保存实际资产身份。
  const [editingId, setEditingId] = useDraftState<string | null>('presets:editingId', null)
  const [toDelete, setToDelete] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const toast = useToast()
  const t = useT()
  const guard = useDraftGuard(editing !== null && JSON.stringify(editing) !== baseline, busy)

  const items: PresetSummary[] = state.status === 'ready' ? state.value.items : []
  const q = query.trim().toLowerCase()
  const filtered = q === '' ? items : items.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))

  const closeEditor = () => {
    setEditing(null)
    setEditingId(null)
    setBaseline(null)
  }

  const open = async (id: string) => {
    await runAsync(setBusy, setError, async () => {
      const r = await remote.getPreset({ id })
      if (r.ok) { setEditing(structuredClone(r.value.preset)); setEditingId(id); setBaseline(JSON.stringify(r.value.preset)) }
      else setError(r.error.message)
    })
  }

  const save = async () => {
    if (!editing) return
    await runAsync(setBusy, setError, async () => {
      const r = await remote.savePreset({ preset: editing })
      if (!r.ok) setError(r.error.message)
      else {
        setEditingId(r.value.id)
        setBaseline(JSON.stringify(editing))
        toast.show(t('presets.saved', { name: editing.name }))
        reload()
      }
    })
  }

  const remove = async () => {
    if (!toDelete) return
    await runAsync(setBusy, setError, async () => {
      const r = await remote.deletePreset({ id: toDelete })
      const err = errOf(r)
      if (err) setError(err)
      else {
        if ((editingId ?? editing?.identifier) === toDelete) closeEditor()
        setToDelete(null)
        reload()
      }
    })
  }

  const onImportFile = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const json = await readJsonFile(file)
      const name = file.name.replace(/\.json$/i, '')
      const r = await remote.importPreset({ name, json })
      if (!r.ok) setError(r.error.message)
      else {
        toast.show(
          r.value.warnings.length > 0
            ? t('presets.importedWarnings', { warnings: r.value.warnings.map(String).join(t('presets.warningSep')) })
            : t('presets.imported'),
        )
        reload()
      }
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : String(err2))
    } finally {
      setBusy(false)
    }
  }

  const setAsDefault = async (id: string) => {
    await runAsync(setBusy, setError, async () => {
      const current = await remote.getSettings({})
      if (!current.ok) {
        setError(current.error.message)
        return
      }
      const defaults = { ...EMPTY_SESSION_DEFAULTS, ...current.value.settings.defaults, presetId: id }
      const r = await remote.updateSettings({ patch: { defaults } })
      const err = errOf(r)
      if (err) setError(err)
      else toast.show(t('presets.setDefaultDone'))
    })
  }

  const exportPreset = async (id: string, name: string) => {
    await runAsync(setBusy, setError, async () => {
      const r = await remote.getPreset({ id })
      if (!r.ok) {
        setError(r.error.message)
        return
      }
      const preset = r.value.preset
      downloadJson(`${name || id}.json`, exportStPreset(preset))
    })
  }

  const createNew = () => {
    const id = `preset-${Date.now().toString(36)}`
    setEditing({ name: t('presets.newPresetName'), identifier: id, entries: [newEntry(100)] })
    setEditingId(null)
    setBaseline(null)
  }

  const setEntry = (index: number, entry: PresetEntry) => {
    if (!editing) return
    const entries = editing.entries.slice()
    entries[index] = entry
    setEditing({ ...editing, entries })
  }

  return (
    <Section title={t('section.presets')} description={t('presets.section.desc')}>
      {toast.node}
      {guard.confirmation}
      <div className="dsh-tavern-toolbar">
        <FileBtn accept=".json" disabled={busy} onFile={(file) => void onImportFile(file)}>
          {t('presets.importFile')}
        </FileBtn>
        <Btn size="md" disabled={busy} onClick={() => guard.request(createNew)}>{t('presets.new')}</Btn>
        <Btn size="md" onClick={reload} disabled={busy}>{t('action.refresh')}</Btn>
        {(items.length >= 5 || query !== '') && (
          <SearchInput label={t('presets.searchLabel')} value={query} onChange={setQuery} placeholder={t('presets.searchPlaceholder')} width={220} />
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
            <IconFolderOpenOutlineMedium size={32} />
          </div>
          <div className="dsh-tavern-emptyTitle">{t('presets.empty')}</div>
          <div className="dsh-tavern-emptyDesc">{t('presets.emptyDesc')}</div>
        </div>
      )}
      {q !== '' && filtered.length === 0 && state.status === 'ready' && (
        <SearchEmpty what={t('presets.noun')} query={query.trim()} onClear={() => setQuery('')} />
      )}
      <div className="dsh-tavern-list" style={{ marginBottom: 12 }}>
        {filtered.map((item) => (
          <div key={item.id} className="dsh-tavern-tile" {...clickableProps(() => guard.request(() => void open(item.id)))}>
            <span className="dsh-tavern-tileIcon">
              <IconListPenOutlineMedium size={18} />
            </span>
            <div className="dsh-tavern-tileMain">
              <div className="dsh-tavern-tileTitleRow">
                <span className="dsh-tavern-tileName">{item.name}</span>
                {item.regexCount > 0 ? <Badge>{t('presets.regexCount', { count: item.regexCount })}</Badge> : null}
              </div>
              <span className="dsh-tavern-tileSub">{item.id}</span>
            </div>
            <div className="dsh-tavern-tileActions">
              <IconBtn label={t('action.edit')} disabled={busy} onClick={() => guard.request(() => void open(item.id))}>
                <IconEditOutlineMedium />
              </IconBtn>
              <IconBtn label={t('presets.export')} disabled={busy} onClick={() => void exportPreset(item.id, item.name)}>
                <IconDownloadOutlineMedium />
              </IconBtn>
              <Btn size="sm" disabled={busy} onClick={() => void setAsDefault(item.id)}>{t('presets.setAsDefault')}</Btn>
              <IconBtn label={t('presets.delete')} danger disabled={busy} onClick={() => setToDelete(item.id)}>
                <IconTrashOutlineMedium />
              </IconBtn>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={toDelete !== null}
        title={t('presets.deleteTitle')}
        description={toDelete ? t('presets.deleteDesc', { id: toDelete }) : ''}
        confirmLabel={t('action.delete')}
        danger
        busy={busy}
        onCancel={() => setToDelete(null)}
        onConfirm={() => void remove()}
      />
      {editing && (
        <fieldset disabled={busy} className="dsh-tavern-editorFields dsh-tavern-card" style={{ marginBottom: 12 }}>
          <Field label={t('presets.name')}>
            <input className="dsh-tavern-input" style={{ flex: 1 }} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </Field>
          <Field label={t('presets.identifier')}>
            <Muted>{editing.identifier}</Muted>
          </Field>
          <PresetSamplingSummary sampling={editing.sampling} onChange={() => {
            const next = { ...editing }
            delete next.sampling
            setEditing(next)
          }} />
          {(editing.regexScripts?.length ?? 0) > 0 && (
            <PresetRegexList
              scripts={editing.regexScripts!}
              onChange={(scripts) => setEditing({ ...editing, regexScripts: scripts })}
            />
          )}
          <div className="dsh-tavern-list" style={{ margin: '8px 0' }}>
            {editing.entries.map((entry, i) => (
              <EntryEditor
                key={entry.identifier}
                entry={entry}
                onChange={(e2) => setEntry(i, e2)}
                onDelete={() => setEditing({ ...editing, entries: editing.entries.filter((_, j) => j !== i) })}
              />
            ))}
          </div>
          <SaveBar>
            <span className="dsh-tavern-muted">{JSON.stringify(editing) !== baseline ? t('draft.unsaved') : ''}</span>
            <Btn onClick={() => setEditing({ ...editing, entries: [...editing.entries, newEntry(editing.entries.length * 100 + 100)] })}>{t('presets.addEntry')}</Btn>
            <Btn disabled={busy} onClick={() => void save()} primary>{t('presets.save')}</Btn>
            <Btn onClick={() => guard.request(closeEditor)}>{t('action.close')}</Btn>
          </SaveBar>
        </fieldset>
      )}
    </Section>
  )
}
