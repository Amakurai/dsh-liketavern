/**
 * 设置面板分区：人设（卡片网格 / 新建编辑 / 删除 / 设为默认）。
 * 卡片可键盘触发（clickableProps）；保存/设默认等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useState } from 'react'
import { IconEditOutline16, IconTrashOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Persona, TavernRemote } from '../types.js'
import { EMPTY_SESSION_DEFAULTS } from '../types.js'
import { Btn, ConfirmDialog, Err, Field, IconBtn, Section, Skeleton, clickableProps, errOf, useLoader, useToast } from '../util.js'

export function PersonasSection(props: { remote: TavernRemote }) {
  const { remote } = props
  const { state, reload } = useLoader(() => remote.listPersonas({}), [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Persona | null>(null)
  const [toDelete, setToDelete] = useState<Persona | null>(null)
  const toast = useToast()

  const items = state.status === 'ready' ? state.value.items : []

  const save = async () => {
    if (!editing) return
    if (!editing.name.trim()) {
      setError('人设名称不能为空')
      return
    }
    setBusy(true)
    const r = await remote.savePersona({ persona: editing })
    setBusy(false)
    const err = errOf(r)
    if (err) setError(err)
    else {
      toast.show(`已保存人设 ${editing.name}`)
      reload()
    }
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
    setEditing({ id: `persona-${Date.now().toString(36)}`, name: '', description: '', avatar: null })
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
      </div>
      {state.status === 'loading' && (
        <div className="dsh-tavern-cards">
          <Skeleton height={96} />
          <Skeleton height={96} />
          <Skeleton height={96} />
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
      <div className="dsh-tavern-cards" style={{ marginBottom: 12 }}>
        {items.map((p) => (
          <article key={p.id} className="dsh-tavern-card is-clickable" {...clickableProps(() => setEditing({ ...p }))}>
            <div className="dsh-tavern-cardHead">
              <div className="dsh-tavern-cardName">{p.name}</div>
            </div>
            <p className="dsh-tavern-cardDesc">{p.description.trim() || '还没有填写人设描述。'}</p>
            <div className="dsh-tavern-cardFoot">
              <IconBtn label="编辑" onClick={() => setEditing({ ...p })}>
                <IconEditOutline16 />
              </IconBtn>
              <Btn size="sm" onClick={() => void setAsDefault(p.id)}>设为默认</Btn>
              <IconBtn label="删除人设" danger onClick={() => setToDelete(p)}>
                <IconTrashOutline16 />
              </IconBtn>
            </div>
          </article>
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
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Btn disabled={busy} onClick={() => void save()} primary>保存</Btn>
            <Btn onClick={() => setEditing(null)}>关闭</Btn>
          </div>
        </div>
      )}
    </Section>
  )
}
