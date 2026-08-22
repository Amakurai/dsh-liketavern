/**
 * 设置面板分区：人设（卡片网格 / 新建编辑 / 删除 / 设为默认）。
 * 卡片可键盘触发（clickableProps）；保存/设默认等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useState } from 'react'
import { IconEditOutline16, IconTrashOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Persona, TavernRemote } from '../types.js'
import { EMPTY_SESSION_DEFAULTS } from '../types.js'
import { Avatar, Badge, Btn, ConfirmDialog, Err, Field, IconBtn, SearchEmpty, SearchInput, Section, Select, Skeleton, clickableProps, errOf, runAsync, useLoader, useToast } from '../util.js'

export function PersonasSection(props: { remote: TavernRemote }) {
  const { remote } = props
  const { state, reload } = useLoader(() => remote.listPersonas({}), [])
  const lore = useLoader(() => remote.listLorebooks({}), [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Persona | null>(null)
  const [toDelete, setToDelete] = useState<Persona | null>(null)
  const [query, setQuery] = useState('')
  const toast = useToast()

  const items = state.status === 'ready' ? state.value.items : []
  const q = query.trim().toLowerCase()
  const filtered = q === '' ? items : items.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))

  const save = async () => {
    if (!editing) return
    if (!editing.name.trim()) {
      setError('人设名称不能为空')
      return
    }
    await runAsync(setBusy, setError, async () => {
      const r = await remote.savePersona({ persona: editing })
      const err = errOf(r)
      if (err) setError(err)
      else {
        toast.show(`已保存人设 ${editing.name}`)
        reload()
      }
    })
  }

  const remove = async () => {
    if (!toDelete) return
    const r = await remote.deletePersona({ id: toDelete.id })
    const err = errOf(r)
    if (err) setError(err)
    else {
      if (editing?.id === toDelete.id) setEditing(null)
      setToDelete(null)
      reload()
    }
  }

  const createNew = () => {
    setEditing({ id: `persona-${Date.now().toString(36)}`, name: '', description: '', avatar: null, lorebookId: null })
  }

  const setAsDefault = async (id: string) => {
    const current = await remote.getSettings({})
    if (!current.ok) {
      setError(current.error.message)
      return
    }
    const defaults = { ...EMPTY_SESSION_DEFAULTS, ...current.value.settings.defaults, personaId: id }
    const r = await remote.updateSettings({ patch: { defaults } })
    const err = errOf(r)
    if (err) setError(err)
    else toast.show('已设为新会话默认人设（当前打开的对话请用角色芯片切换）')
  }

  return (
    <Section title="人设" description="用户侧人设，名字会替换 {{user}}。库里只有一条时，未绑人设的会话也会自动用它；多条时请在「设置」页或对话芯片里选择。">
      {toast.node}
      <div className="dsh-tavern-toolbar">
        <Btn size="md" onClick={createNew}>新建人设</Btn>
        <Btn size="md" onClick={reload} disabled={busy}>刷新</Btn>
        {items.length >= 5 && (
          <SearchInput label="搜索人设" value={query} onChange={setQuery} placeholder="搜索人设名 / 描述" width={220} />
        )}
      </div>
      {state.status === 'loading' && (
        <div className="dsh-tavern-list">
          <Skeleton height={62} radius={14} />
          <Skeleton height={62} radius={14} />
          <Skeleton height={62} radius={14} />
        </div>
      )}
      {state.status === 'error' && <Err message={state.message} />}
      <Err message={error} />
      {items.length === 0 && state.status === 'ready' && (
        <div className="dsh-tavern-empty">
          <div className="dsh-tavern-emptyIcon">
            <IconUserOutline16 size={32} />
          </div>
          <div className="dsh-tavern-emptyTitle">暂无人设</div>
          <div className="dsh-tavern-emptyDesc">新建一条人设，对话里的 {'{{user}}'} 就会换成它。</div>
        </div>
      )}
      {q !== '' && filtered.length === 0 && state.status === 'ready' && (
        <SearchEmpty what="人设" query={query.trim()} onClear={() => setQuery('')} />
      )}
      <div className="dsh-tavern-list" style={{ marginBottom: 12 }}>
        {filtered.map((p) => (
          <div key={p.id} className="dsh-tavern-tile" {...clickableProps(() => setEditing({ ...p }))}>
            <Avatar url={p.avatar} name={p.name} size={38} />
            <div className="dsh-tavern-tileMain">
              <div className="dsh-tavern-tileTitleRow">
                <span className="dsh-tavern-tileName">{p.name}</span>
                {p.lorebookId ? <Badge>{p.lorebookId}</Badge> : null}
              </div>
              <span className="dsh-tavern-tileSub">{p.description.trim() || '还没有填写人设描述。'}</span>
            </div>
            <div className="dsh-tavern-tileActions">
              <IconBtn label="编辑" onClick={() => setEditing({ ...p })}>
                <IconEditOutline16 />
              </IconBtn>
              <Btn size="sm" onClick={() => void setAsDefault(p.id)}>设为默认</Btn>
              <IconBtn label="删除人设" danger onClick={() => setToDelete(p)}>
                <IconTrashOutline16 />
              </IconBtn>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={toDelete !== null}
        title="删除人设？"
        description={toDelete ? `确定删除人设「${toDelete.name}」？` : ''}
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
          <div className="dsh-tavern-field">
            <span className="dsh-tavern-fieldLabel">描述</span>
            <textarea
              className="dsh-tavern-input dsh-tavern-textarea"
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
          </div>
          <Field label="人设世界书">
            <Select
              width="100%"
              value={editing.lorebookId ?? ''}
              onChange={(v) => setEditing({ ...editing, lorebookId: v || null })}
              options={[
                { value: '', label: '（无）' },
                ...(lore.state.status === 'ready' ? lore.state.value.items.map((n) => ({ value: n, label: n })) : []),
              ]}
            />
          </Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Btn disabled={busy} onClick={() => void save()} primary>保存</Btn>
            <Btn onClick={() => setEditing(null)}>关闭</Btn>
          </div>
        </div>
      )}
    </Section>
  )
}
