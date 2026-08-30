/**
 * 设置面板分区：提示词预设（卡片网格 / 导入 / 导出 / 删除 / 条目表格编辑）。
 * 卡片可键盘触发（clickableProps）；保存/导入/设默认等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useState } from 'react'
import { IconDownloadOutline16, IconEditOutline16, IconFolderOpenOutline16, IconListPenOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CardRegexScript, ChatRole, PresetEntry, PromptPreset } from '../../core/types.js'
import { EMPTY_SESSION_DEFAULTS, type PresetSummary, type TavernRemote } from '../types.js'
import { Badge, Btn, ConfirmDialog, Err, Field, FileBtn, IconBtn, Muted, NumInput, RegexScriptRow, SaveBar, SearchEmpty, SearchInput, Section, Select, Skeleton, Toggle, clickableProps, downloadJson, errOf, readJsonFile, runAsync, useLoader, useToast } from '../util.js'

function newEntry(order: number): PresetEntry {
  return {
    identifier: `entry-${Date.now().toString(36)}-${order}`,
    name: '新条目',
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
  return (
    <div className="dsh-tavern-field">
      <span className="dsh-tavern-fieldLabel">随预设导入的正则（{props.scripts.length} 条；开关随「保存预设」生效，重新导入以文件为准）</span>
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

function EntryEditor(props: { entry: PresetEntry; onChange: (e: PresetEntry) => void; onDelete: () => void }) {
  const { entry } = props
  const set = (patch: Partial<PresetEntry>) => props.onChange({ ...entry, ...patch })
  return (
    <div className="dsh-tavern-entry">
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '12px 16px 8px' }}>
        <Toggle checked={entry.enabled} onChange={(enabled) => set({ enabled })} title={entry.enabled ? '关闭此条目' : '启用此条目'} />
        <input className="dsh-tavern-input" style={{ width: 160 }} value={entry.name} placeholder="名称" onChange={(e) => set({ name: e.target.value })} />
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
            深度 <NumInput value={entry.depth} width={64} onChange={(v) => set({ depth: Math.max(0, Math.round(v)) })} />
          </label>
        )}
        <label style={{ fontSize: 12 }}>
          顺序 <NumInput value={entry.order} width={64} onChange={(v) => set({ order: Math.round(v) })} />
        </label>
        <label style={{ fontSize: 12 }}>
          <input type="checkbox" checked={entry.marker} onChange={(e) => set({ marker: e.target.checked })} /> 占位符
        </label>
        {entry.marker && (
          <input className="dsh-tavern-input" style={{ width: 140 }} value={entry.markerId ?? ''} placeholder="markerId" onChange={(e) => set({ markerId: e.target.value })} />
        )}
        <span style={{ flex: 1 }} />
        <IconBtn label="删除条目" danger onClick={props.onDelete}>
          <IconTrashOutline16 />
        </IconBtn>
      </div>
      {!entry.marker && (
        <div style={{ padding: '2px 16px 14px' }}>
          <textarea className="dsh-tavern-input dsh-tavern-textarea" style={{ minHeight: 60 }} value={entry.content} placeholder="内容" onChange={(e) => set({ content: e.target.value })} />
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
  const [editing, setEditing] = useState<PromptPreset | null>(null)
  const [toDelete, setToDelete] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const toast = useToast()

  const items: PresetSummary[] = state.status === 'ready' ? state.value.items : []
  const q = query.trim().toLowerCase()
  const filtered = q === '' ? items : items.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))

  const open = async (id: string) => {
    setError(null)
    const r = await remote.getPreset({ id })
    if (r.ok) setEditing(structuredClone(r.value.preset))
    else setError(r.error.message)
  }

  const save = async () => {
    if (!editing) return
    await runAsync(setBusy, setError, async () => {
      const r = await remote.savePreset({ preset: editing })
      const err = errOf(r)
      if (err) setError(err)
      else {
        toast.show(`已保存预设 ${editing.name}`)
        reload()
      }
    })
  }

  const remove = async () => {
    if (!toDelete) return
    const r = await remote.deletePreset({ id: toDelete })
    const err = errOf(r)
    if (err) setError(err)
    else {
      if (editing?.identifier === toDelete) setEditing(null)
      setToDelete(null)
      reload()
    }
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
        toast.show(r.value.warnings.length > 0 ? `已导入，警告：${r.value.warnings.map(String).join('；')}` : '已导入预设')
        reload()
      }
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : String(err2))
    } finally {
      setBusy(false)
    }
  }

  const setAsDefault = async (id: string) => {
    const current = await remote.getSettings({})
    if (!current.ok) {
      setError(current.error.message)
      return
    }
    const defaults = { ...EMPTY_SESSION_DEFAULTS, ...current.value.settings.defaults, presetId: id }
    const r = await remote.updateSettings({ patch: { defaults } })
    const err = errOf(r)
    if (err) setError(err)
    else toast.show('已设为新会话默认预设（当前打开的对话请用角色芯片切换）')
  }

  const exportPreset = async (id: string, name: string) => {
    const r = await remote.getPreset({ id })
    if (!r.ok) {
      setError(r.error.message)
      return
    }
    const preset = r.value.preset
    const prompts = preset.entries.map((e) => ({
      identifier: e.identifier,
      name: e.name,
      role: e.role,
      content: e.content,
      marker: e.marker,
      system_prompt: e.role === 'system',
      injection_position: e.position === 'in-chat' ? 1 : 0,
      injection_depth: e.depth,
      injection_order: e.order,
    }))
    const order = preset.entries.map((e) => ({ identifier: e.identifier, enabled: e.enabled }))
    const json: Record<string, unknown> = {
      name: preset.name,
      identifier: preset.identifier,
      prompts,
      prompt_order: [{ character_id: 100001, order }],
    }
    if (preset.regexScripts && preset.regexScripts.length > 0) {
      json.extensions = { regex_scripts: preset.regexScripts }
    }
    downloadJson(`${name || id}.json`, json)
  }

  const createNew = () => {
    const id = `preset-${Date.now().toString(36)}`
    setEditing({ name: '新预设', identifier: id, entries: [newEntry(100)] })
  }

  const setEntry = (index: number, entry: PresetEntry) => {
    if (!editing) return
    const entries = editing.entries.slice()
    entries[index] = entry
    setEditing({ ...editing, entries })
  }

  return (
    <Section title="提示词预设" description="导入 SillyTavern 预设 JSON（含 extensions.regex_scripts）。新会话默认在「设置」页或卡脚「设为默认」；当前对话用角色芯片切换。已在库中的预设需重新导入才会带上正则。">
      {toast.node}
      <div className="dsh-tavern-toolbar">
        <FileBtn accept=".json" disabled={busy} onFile={(file) => void onImportFile(file)}>
          导入 SillyTavern 预设 JSON
        </FileBtn>
        <Btn size="md" onClick={createNew}>新建预设</Btn>
        <Btn size="md" onClick={reload} disabled={busy}>刷新</Btn>
        {items.length >= 5 && (
          <SearchInput label="搜索预设" value={query} onChange={setQuery} placeholder="搜索预设名 / 标识" width={220} />
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
            <IconFolderOpenOutline16 size={32} />
          </div>
          <div className="dsh-tavern-emptyTitle">暂无预设</div>
          <div className="dsh-tavern-emptyDesc">未绑定时使用内建默认预设；也可以导入 SillyTavern 预设 JSON。</div>
        </div>
      )}
      {q !== '' && filtered.length === 0 && state.status === 'ready' && (
        <SearchEmpty what="预设" query={query.trim()} onClear={() => setQuery('')} />
      )}
      <div className="dsh-tavern-list" style={{ marginBottom: 12 }}>
        {filtered.map((item) => (
          <div key={item.id} className="dsh-tavern-tile" {...clickableProps(() => void open(item.id))}>
            <span className="dsh-tavern-tileIcon">
              <IconListPenOutline16 size={18} />
            </span>
            <div className="dsh-tavern-tileMain">
              <div className="dsh-tavern-tileTitleRow">
                <span className="dsh-tavern-tileName">{item.name}</span>
                {item.regexCount > 0 ? <Badge>{item.regexCount} 条正则</Badge> : null}
              </div>
              <span className="dsh-tavern-tileSub">{item.id}</span>
            </div>
            <div className="dsh-tavern-tileActions">
              <IconBtn label="编辑" onClick={() => void open(item.id)}>
                <IconEditOutline16 />
              </IconBtn>
              <IconBtn label="导出 JSON" onClick={() => void exportPreset(item.id, item.name)}>
                <IconDownloadOutline16 />
              </IconBtn>
              <Btn size="sm" onClick={() => void setAsDefault(item.id)}>设为默认</Btn>
              <IconBtn label="删除预设" danger onClick={() => setToDelete(item.id)}>
                <IconTrashOutline16 />
              </IconBtn>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={toDelete !== null}
        title="删除预设？"
        description={toDelete ? `确定删除预设 ${toDelete}？` : ''}
        confirmLabel="删除"
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={() => void remove()}
      />
      {editing && (
        <div className="dsh-tavern-card" style={{ marginBottom: 12 }}>
          <Field label="名称">
            <input className="dsh-tavern-input" style={{ flex: 1 }} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </Field>
          <Field label="标识">
            <Muted>{editing.identifier}</Muted>
          </Field>
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
            <Btn onClick={() => setEditing({ ...editing, entries: [...editing.entries, newEntry(editing.entries.length * 100 + 100)] })}>添加条目</Btn>
            <Btn disabled={busy} onClick={() => void save()} primary>保存预设</Btn>
            <Btn onClick={() => setEditing(null)}>关闭</Btn>
          </SaveBar>
        </div>
      )}
    </Section>
  )
}
