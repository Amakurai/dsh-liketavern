/**
 * 设置面板分区：记忆与世界状态（按角色卡查看 / 编辑 / 压缩 / 导出）。
 * 记忆/世界状态切换用 chip 段控；条目为 .dsh-tavern-memo 卡片（meta 行 + 正文 + IconBtn 操作）。
 * 压缩/导出等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useEffect, useState } from 'react'
import { IconEditOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryEntry, WorldDelta } from '../../core/types.js'
import type { TavernRemote } from '../types.js'
import { Btn, Err, IconBtn, Muted, Section, Select, SettingsRow, Skeleton, downloadJson, errOf, useLoader, useToast } from '../util.js'

function splitList(text: string): string[] {
  return text
    .split(/[，,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function MemoryEditor(props: { remote: TavernRemote; cardId: string; entry: MemoryEntry; onDone: () => void }) {
  const { entry } = props
  const [body, setBody] = useState(entry.body)
  const [tags, setTags] = useState(entry.tags.join(', '))
  const [keys, setKeys] = useState(entry.keys.join(', '))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    const r = await props.remote.saveMemory({
      cardId: props.cardId,
      id: entry.id,
      body,
      tags: splitList(tags),
      keys: splitList(keys),
    })
    setBusy(false)
    const err = errOf(r)
    if (err) setError(err)
    else props.onDone()
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
      <textarea className="dsh-tavern-input dsh-tavern-textarea" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="dsh-tavern-fieldRow">
        <label className="dsh-tavern-field">
          <span className="dsh-tavern-fieldLabel">标签</span>
          <input className="dsh-tavern-input" value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        <label className="dsh-tavern-field">
          <span className="dsh-tavern-fieldLabel">检索键</span>
          <input className="dsh-tavern-input" value={keys} onChange={(e) => setKeys(e.target.value)} />
        </label>
      </div>
      <Err message={error} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Btn onClick={props.onDone}>取消</Btn>
        <Btn primary disabled={busy || !body.trim()} onClick={() => void save()}>保存</Btn>
      </div>
    </div>
  )
}

export function MemorySection(props: { remote: TavernRemote }) {
  const { remote } = props
  const chars = useLoader(() => remote.listCharacters({}), [])
  const [cardId, setCardId] = useState('')
  const [tab, setTab] = useState<'memory' | 'delta' | 'journal'>('memory')
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newBody, setNewBody] = useState('')
  const [journalText, setJournalText] = useState('')
  const [deltaType, setDeltaType] = useState<'add' | 'update' | 'invalidate'>('add')
  const [deltaContent, setDeltaContent] = useState('')
  const [deltaRef, setDeltaRef] = useState('')
  const [deltaKeys, setDeltaKeys] = useState('')
  const toast = useToast()

  const memories = useLoader(() => remote.getMemories({ cardId }), [cardId], cardId !== '')
  const deltas = useLoader(() => remote.getWorldDeltas({ cardId }), [cardId], cardId !== '')
  const journal = useLoader(() => remote.getJournal({ cardId }), [cardId], cardId !== '')

  const charItems = chars.state.status === 'ready' ? chars.state.value.items : []
  const memoryItems = memories.state.status === 'ready' ? memories.state.value.items : []
  const deltaItems = deltas.state.status === 'ready' ? deltas.state.value.items : []
  useEffect(() => {
    if (journal.state.status === 'ready') setJournalText(journal.state.value.text)
  }, [journal.state])

  const addMemory = async () => {
    const r = await remote.saveMemory({ cardId, body: newBody.trim() })
    const err = errOf(r)
    if (err) setError(err)
    else {
      setNewBody('')
      memories.reload()
    }
  }

  const deleteMemory = async (id: string) => {
    const r = await remote.deleteMemory({ cardId, id })
    const err = errOf(r)
    if (err) setError(err)
    else memories.reload()
  }

  const compress = async () => {
    const r = await remote.compressMemories({ cardId })
    if (!r.ok) setError(r.error.message)
    else {
      toast.show(r.value.merged > 0 ? `已无损归并最旧 ${r.value.merged} 条记忆（原文仍可恢复）` : '记忆不足两条，无需归并')
      memories.reload()
    }
  }

  const revoke = async (id: string) => {
    const r = await remote.revokeWorldDelta({ cardId, id })
    const err = errOf(r)
    if (err) setError(err)
    else {
      toast.show(`已撤销世界状态 #${id}`)
      deltas.reload()
    }
  }

  const exportBook = async () => {
    const r = await remote.exportMergedLorebook({ cardId })
    if (!r.ok) setError(r.error.message)
    else {
      downloadJson(`lorebook-merged-${cardId}.json`, r.value.json)
      toast.show('已导出合并后的世界书')
    }
  }

  const saveJournal = async () => {
    const r = await remote.saveJournal({ cardId, text: journalText })
    const err = errOf(r)
    if (err) setError(err)
    else {
      toast.show('已保存角色笔记')
      journal.reload()
    }
  }

  const addDelta = async () => {
    const r = await remote.addWorldDelta({
      cardId,
      type: deltaType,
      content: deltaContent.trim(),
      ref: deltaRef.trim() || null,
      keys: splitList(deltaKeys),
    })
    const err = errOf(r)
    if (err) setError(err)
    else {
      toast.show(`已新增世界状态 #${r.ok ? r.value.id : ''}`)
      setDeltaContent('')
      setDeltaRef('')
      setDeltaKeys('')
      deltas.reload()
    }
  }

  return (
    <Section title="记忆与世界状态" description="按角色查看和编辑长期记忆、世界状态变化层、角色笔记 journal.md。">
      {toast.node}
      <SettingsRow title="角色" description="选择要查看的角色卡工作区。">
        <Select
          size="md"
          value={cardId}
          onChange={setCardId}
          options={[{ value: '', label: '（选择角色）' }, ...charItems.map((c) => ({ value: c.cardId, label: c.name }))]}
        />
      </SettingsRow>
      <Err message={error} />
      {cardId && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '8px 0' }}>
            <div className="dsh-tavern-filters">
              <button type="button" className="dsh-tavern-chip" data-active={tab === 'memory' ? 'true' : 'false'} onClick={() => setTab('memory')}>
                记忆（{memoryItems.length}）
              </button>
              <button type="button" className="dsh-tavern-chip" data-active={tab === 'delta' ? 'true' : 'false'} onClick={() => setTab('delta')}>
                世界状态（{deltaItems.length}）
              </button>
              <button type="button" className="dsh-tavern-chip" data-active={tab === 'journal' ? 'true' : 'false'} onClick={() => setTab('journal')}>
                角色笔记
              </button>
            </div>
            <span style={{ flex: 1 }} />
            {tab === 'memory' && <Btn onClick={() => void compress()}>归并最旧一批</Btn>}
            {tab === 'delta' && <Btn onClick={() => void exportBook()}>导出合并后的世界书</Btn>}
          </div>
          {tab === 'memory' && (
            <div className="dsh-tavern-list">
              {memories.state.status === 'loading' && (
                <>
                  <Skeleton height={72} />
                  <Skeleton height={72} />
                  <Skeleton height={72} />
                </>
              )}
              {memories.state.status === 'error' && <Err message={memories.state.message} />}
              {memoryItems.length === 0 && memories.state.status === 'ready' && <Muted>暂无记忆。让模型用 tavern_memory_write 写入，或在下方手动添加。</Muted>}
              {memoryItems.map((m) => (
                <div key={m.id} className="dsh-tavern-memo">
                  <div className="dsh-tavern-memoHead">
                    <span className="dsh-tavern-memoMeta">
                      {m.id} · {m.updated}
                      {m.archived ? ' · 已归档' : ''}
                      {m.tags.length > 0 ? ` · 标签 ${m.tags.join('、')}` : ''}
                    </span>
                    <span className="dsh-tavern-memoActions">
                      <IconBtn label={editingId === m.id ? '收起编辑' : '编辑'} onClick={() => setEditingId(editingId === m.id ? null : m.id)}>
                        <IconEditOutline16 />
                      </IconBtn>
                      <IconBtn label="删除记忆" danger onClick={() => void deleteMemory(m.id)}>
                        <IconTrashOutline16 />
                      </IconBtn>
                    </span>
                  </div>
                  <pre className="dsh-tavern-memoBody dsh-tavern-scroll">{m.body}</pre>
                  {editingId === m.id && (
                    <MemoryEditor
                      remote={remote}
                      cardId={cardId}
                      entry={m}
                      onDone={() => {
                        setEditingId(null)
                        memories.reload()
                      }}
                    />
                  )}
                </div>
              ))}
              <div className="dsh-tavern-memo">
                <textarea
                  className="dsh-tavern-input dsh-tavern-textarea"
                  style={{ minHeight: 60 }}
                  placeholder="新增记忆…"
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Btn primary disabled={!newBody.trim()} onClick={() => void addMemory()}>添加记忆</Btn>
                </div>
              </div>
            </div>
          )}
          {tab === 'delta' && (
            <div className="dsh-tavern-list">
              {deltas.state.status === 'loading' && (
                <>
                  <Skeleton height={72} />
                  <Skeleton height={72} />
                  <Skeleton height={72} />
                </>
              )}
              {deltas.state.status === 'error' && <Err message={deltas.state.message} />}
              {deltaItems.map((d: WorldDelta) => (
                <div key={d.id} className="dsh-tavern-memo">
                  <div className="dsh-tavern-memoHead">
                    <span className="dsh-tavern-memoMeta">
                      #{d.id} · {d.type}
                      {d.ref ? ` → ${d.ref}` : ''} · {d.ts}
                      {d.revoked ? ' · 已撤销' : ''}
                    </span>
                    {!d.revoked && (
                      <span className="dsh-tavern-memoActions">
                        <Btn size="sm" onClick={() => void revoke(d.id)}>撤销</Btn>
                      </span>
                    )}
                  </div>
                  <pre className="dsh-tavern-memoBody dsh-tavern-scroll">{d.content}</pre>
                </div>
              ))}
              {deltaItems.length === 0 && deltas.state.status === 'ready' && <Muted>暂无世界状态变化。</Muted>}
              <div className="dsh-tavern-memo">
                <div className="dsh-tavern-fieldRow">
                  <label className="dsh-tavern-field">
                    <span className="dsh-tavern-fieldLabel">类型</span>
                    <Select
                      size="md"
                      value={deltaType}
                      onChange={(v) => setDeltaType(v as 'add' | 'update' | 'invalidate')}
                      options={[
                        { value: 'add', label: '新增' },
                        { value: 'update', label: '更新' },
                        { value: 'invalidate', label: '作废' },
                      ]}
                    />
                  </label>
                  {(deltaType === 'update' || deltaType === 'invalidate') && (
                    <label className="dsh-tavern-field">
                      <span className="dsh-tavern-fieldLabel">原条目 uid</span>
                      <input className="dsh-tavern-input" value={deltaRef} onChange={(e) => setDeltaRef(e.target.value)} />
                    </label>
                  )}
                </div>
                <textarea
                  className="dsh-tavern-input dsh-tavern-textarea"
                  style={{ minHeight: 60, marginTop: 8 }}
                  placeholder="世界状态正文…"
                  value={deltaContent}
                  onChange={(e) => setDeltaContent(e.target.value)}
                />
                <label className="dsh-tavern-field" style={{ marginTop: 8 }}>
                  <span className="dsh-tavern-fieldLabel">触发键（逗号分隔，可空）</span>
                  <input className="dsh-tavern-input" value={deltaKeys} onChange={(e) => setDeltaKeys(e.target.value)} />
                </label>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <Btn primary disabled={!deltaContent.trim()} onClick={() => void addDelta()}>添加世界状态</Btn>
                </div>
              </div>
            </div>
          )}
          {tab === 'journal' && (
            <div className="dsh-tavern-list">
              {journal.state.status === 'loading' && <Skeleton height={120} />}
              {journal.state.status === 'error' && <Err message={journal.state.message} />}
              <Muted>写在角色工作区 journal.md。会话芯片打开「注入角色笔记」后才会进本轮 turn。</Muted>
              <textarea
                className="dsh-tavern-input dsh-tavern-textarea"
                style={{ minHeight: 180 }}
                value={journalText}
                onChange={(e) => setJournalText(e.target.value)}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Btn primary onClick={() => void saveJournal()}>保存笔记</Btn>
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  )
}
