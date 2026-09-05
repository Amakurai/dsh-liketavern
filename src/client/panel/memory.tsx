/**
 * 设置面板分区：记忆与世界状态（按角色卡查看 / 编辑 / 压缩 / 导出）。
 * 记忆/世界状态切换用 chip 段控；条目为 .dsh-tavern-memo 卡片（meta 行 + 正文 + IconBtn 操作）。
 * 压缩/导出等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useEffect, useState } from 'react'
import { IconEditOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MemoryEntry, WorldDelta } from '../../core/types.js'
import { useT } from '../i18n.js'
import type { TavernRemote } from '../types.js'
import { Badge, Btn, Err, IconBtn, Muted, Section, Select, SettingsRow, Skeleton, downloadJson, errOf, runAsync, useLoader, useToast } from '../util.js'

/** 变化层类型徽标/选项对应的 i18n 键；渲染处经 t() 取文案。 */
const DELTA_TYPE_KEY: Record<WorldDelta['type'], string> = { add: 'memory.deltaType.add', update: 'memory.deltaType.update', invalidate: 'memory.deltaType.invalidate' }

function splitList(text: string): string[] {
  return text
    .split(/[，,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function MemoryEditor(props: { remote: TavernRemote; cardId: string; storyId?: string; entry: MemoryEntry; onDone: () => void }) {
  const { entry } = props
  const t = useT()
  const [body, setBody] = useState(entry.body)
  const [tags, setTags] = useState(entry.tags.join(', '))
  const [keys, setKeys] = useState(entry.keys.join(', '))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = () =>
    runAsync(setBusy, setError, async () => {
      const r = await props.remote.saveMemory({
        cardId: props.cardId,
        storyId: props.storyId,
        id: entry.id,
        body,
        tags: splitList(tags),
        keys: splitList(keys),
      })
      const err = errOf(r)
      if (err) setError(err)
      else props.onDone()
    })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
      <textarea className="dsh-tavern-input dsh-tavern-textarea" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="dsh-tavern-fieldRow">
        <label className="dsh-tavern-field">
          <span className="dsh-tavern-fieldLabel">{t('memory.tags')}</span>
          <input className="dsh-tavern-input" value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        <label className="dsh-tavern-field">
          <span className="dsh-tavern-fieldLabel">{t('memory.keys')}</span>
          <input className="dsh-tavern-input" value={keys} onChange={(e) => setKeys(e.target.value)} />
        </label>
      </div>
      <Err message={error} />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Btn onClick={props.onDone}>{t('action.cancel')}</Btn>
        <Btn primary disabled={busy || !body.trim()} onClick={() => void save()}>{t('action.save')}</Btn>
      </div>
    </div>
  )
}

export function MemorySection(props: { remote: TavernRemote }) {
  const { remote } = props
  const t = useT()
  const chars = useLoader(() => remote.listCharacters({}), [])
  const [cardId, setCardId] = useState('')
  const [storyId, setStoryId] = useState<string | undefined>(undefined)
  const stories = useLoader(() => remote.listStories({ cardId }), [cardId], cardId !== '')
  const [tab, setTab] = useState<'memory' | 'delta' | 'journal'>('memory')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newBody, setNewBody] = useState('')
  const [journalText, setJournalText] = useState('')
  const [deltaType, setDeltaType] = useState<'add' | 'update' | 'invalidate'>('add')
  const [deltaContent, setDeltaContent] = useState('')
  const [deltaRef, setDeltaRef] = useState('')
  const [deltaKeys, setDeltaKeys] = useState('')
  const toast = useToast()

  const memories = useLoader(() => remote.getMemories({ cardId, storyId }), [cardId, storyId], cardId !== '')
  const deltas = useLoader(() => remote.getWorldDeltas({ cardId, storyId }), [cardId, storyId], cardId !== '')
  const journal = useLoader(() => remote.getJournal({ cardId, storyId }), [cardId, storyId], cardId !== '')

  /**
   * 写操作统一外壳：busy 防连击（快速双击重复创建/并发压缩）；
   * 错误信封进 Err（上下文），传输/zod 严格校验的 reject 落 toast，不留未处理 rejection。
   */
  const op = (fn: () => Promise<void>) =>
    runAsync(setBusy, setError, fn, (message) => toast.show(t('memory.opFailed', { message })))

  const charItems = chars.state.status === 'ready' ? chars.state.value.items : []
  const memoryItems = memories.state.status === 'ready' ? memories.state.value.items : []
  const deltaItems = deltas.state.status === 'ready' ? deltas.state.value.items : []
  // journalText 只在查询 ready 时回填，切卡瞬间它还是上一张卡的正文；
  // 此时 cardId 已指向新卡，不清空就会被「保存笔记」原样写进新卡的 journal.md（覆盖丢数据）。
  useEffect(() => {
    setJournalText('')
    setEditingId(null)
    setNewBody('')
    setDeltaContent('')
  }, [cardId, storyId])
  useEffect(() => {
    if (journal.state.status === 'ready') setJournalText(journal.state.value.text)
  }, [journal.state])

  const addMemory = () =>
    op(async () => {
      const r = await remote.saveMemory({ cardId, storyId, body: newBody.trim() })
      const err = errOf(r)
      if (err) setError(err)
      else {
        setNewBody('')
        memories.reload()
      }
    })

  const deleteMemory = (id: string) =>
    op(async () => {
      const r = await remote.deleteMemory({ cardId, storyId, id })
      const err = errOf(r)
      if (err) setError(err)
      else memories.reload()
    })

  const compress = () =>
    op(async () => {
      const r = await remote.compressMemories({ cardId, storyId })
      if (!r.ok) setError(r.error.message)
      else {
        toast.show(r.value.merged > 0 ? t('memory.compressed', { count: r.value.merged }) : t('memory.compressNoop'))
        memories.reload()
      }
    })

  const revoke = (id: string) =>
    op(async () => {
      const r = await remote.revokeWorldDelta({ cardId, storyId, id })
      const err = errOf(r)
      if (err) setError(err)
      else {
        toast.show(t('memory.revokeDone', { id }))
        deltas.reload()
      }
    })

  const exportBook = () =>
    op(async () => {
      const r = await remote.exportMergedLorebook({ cardId, storyId })
      if (!r.ok) setError(r.error.message)
      else {
        downloadJson(`lorebook-merged-${cardId}.json`, r.value.json)
        toast.show(t('memory.bookExported'))
      }
    })

  const saveJournal = () =>
    op(async () => {
      const r = await remote.saveJournal({ cardId, storyId, text: journalText })
      const err = errOf(r)
      if (err) setError(err)
      else {
        toast.show(t('memory.journalSaved'))
        journal.reload()
      }
    })

  const addDelta = () =>
    op(async () => {
      const r = await remote.addWorldDelta({
        cardId, storyId,
        type: deltaType,
        content: deltaContent.trim(),
        ref: deltaRef.trim() || null,
        keys: splitList(deltaKeys),
      })
      const err = errOf(r)
      if (err) setError(err)
      else {
        toast.show(t('memory.deltaAdded', { id: r.ok ? r.value.id : '' }))
        setDeltaContent('')
        setDeltaRef('')
        setDeltaKeys('')
        deltas.reload()
      }
    })

  return (
    <Section title={t('section.memory')} description={t('memory.desc')}>
      {toast.node}
      <SettingsRow title={t('memory.character')} description={t('memory.characterDesc')}>
        <Select
          size="md"
          value={cardId}
          disabled={busy} onChange={(value) => { setStoryId(undefined); setCardId(value) }}
          options={[{ value: '', label: t('memory.pickCharacter') }, ...charItems.map((c) => ({ value: c.cardId, label: c.name }))]}
        />
      </SettingsRow>
      {cardId && <SettingsRow title={t('memory.story')} description={t('memory.storyDesc')}>
        <Select value={storyId ?? ''} disabled={busy} onChange={(value) => setStoryId(value || undefined)}
          options={[{ value: '', label: t('memory.initialState') }, ...(stories.state.status === 'ready' ? stories.state.value.items.map((story) => ({ value: story.id, label: `${story.sessionId} · ${story.createdAt.slice(0, 10)}` })) : [])]} />
      </SettingsRow>}
      <Err message={stories.state.status === 'error' ? stories.state.message : error} />
      {cardId && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, margin: '10px 0 14px' }}>
            <div className="dsh-tavern-filters">
              <button type="button" className="dsh-tavern-chip" data-active={tab === 'memory' ? 'true' : 'false'} onClick={() => setTab('memory')}>
                {t('memory.tab.memory', { count: memoryItems.length })}
              </button>
              <button type="button" className="dsh-tavern-chip" data-active={tab === 'delta' ? 'true' : 'false'} onClick={() => setTab('delta')}>
                {t('memory.tab.delta', { count: deltaItems.length })}
              </button>
              <button type="button" className="dsh-tavern-chip" data-active={tab === 'journal' ? 'true' : 'false'} onClick={() => setTab('journal')}>
                {t('memory.tab.journal')}
              </button>
            </div>
            <span style={{ flex: 1 }} />
            {tab === 'memory' && <Btn disabled={busy} onClick={() => void compress()}>{t('memory.compressOldest')}</Btn>}
            {tab === 'delta' && <Btn disabled={busy} onClick={() => void exportBook()}>{t('memory.exportBook')}</Btn>}
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
              {memoryItems.length === 0 && memories.state.status === 'ready' && (
                <div className="dsh-tavern-empty is-compact">
                  <div className="dsh-tavern-emptyTitle">{t('memory.emptyMemories')}</div>
                  <div className="dsh-tavern-emptyDesc">{t('memory.emptyMemoriesDesc')}</div>
                </div>
              )}
              {memoryItems.map((m) => (
                <div key={m.id} className="dsh-tavern-memo">
                  <div className="dsh-tavern-memoHead">
                    <Badge>{m.id}</Badge>
                    {m.archived ? <Badge>{t('memory.archived')}</Badge> : null}
                    {m.tags.map((tag) => (
                      <Badge key={tag}>{tag}</Badge>
                    ))}
                    <span className="dsh-tavern-memoMeta">{m.updated}</span>
                    <span className="dsh-tavern-memoActions">
                      <IconBtn label={editingId === m.id ? t('memory.collapseEdit') : t('action.edit')} onClick={() => setEditingId(editingId === m.id ? null : m.id)}>
                        <IconEditOutline16 />
                      </IconBtn>
                      <IconBtn label={t('memory.deleteEntry')} danger disabled={busy} onClick={() => void deleteMemory(m.id)}>
                        <IconTrashOutline16 />
                      </IconBtn>
                    </span>
                  </div>
                  <pre className="dsh-tavern-memoBody dsh-tavern-scroll">{m.body}</pre>
                  {editingId === m.id && (
                    <MemoryEditor
                      remote={remote}
                      cardId={cardId}
                      storyId={storyId}
                      entry={m}
                      onDone={() => {
                        setEditingId(null)
                        memories.reload()
                      }}
                    />
                  )}
                </div>
              ))}
              <div className="dsh-tavern-memo is-compose">
                <textarea
                  className="dsh-tavern-input dsh-tavern-textarea"
                  style={{ minHeight: 60 }}
                  placeholder={t('memory.newPlaceholder')}
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                />
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Btn primary disabled={busy || !newBody.trim()} onClick={() => void addMemory()}>{t('memory.addEntry')}</Btn>
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
                <div key={d.id} className={`dsh-tavern-memo${d.revoked ? ' is-revoked' : ''}`}>
                  <div className="dsh-tavern-memoHead">
                    <Badge>#{d.id}</Badge>
                    <Badge danger={d.type === 'invalidate'}>{t(DELTA_TYPE_KEY[d.type])}</Badge>
                    {d.ref ? <Badge>→ {d.ref}</Badge> : null}
                    {d.revoked ? <Badge danger>{t('memory.revoked')}</Badge> : null}
                    <span className="dsh-tavern-memoMeta">{d.ts}</span>
                    {!d.revoked && (
                      <span className="dsh-tavern-memoActions">
                        <Btn size="sm" disabled={busy} onClick={() => void revoke(d.id)}>{t('memory.revoke')}</Btn>
                      </span>
                    )}
                  </div>
                  <pre className="dsh-tavern-memoBody dsh-tavern-scroll">{d.content}</pre>
                </div>
              ))}
              {deltaItems.length === 0 && deltas.state.status === 'ready' && (
                <div className="dsh-tavern-empty is-compact">
                  <div className="dsh-tavern-emptyTitle">{t('memory.emptyDeltas')}</div>
                  <div className="dsh-tavern-emptyDesc">{t('memory.emptyDeltasDesc')}</div>
                </div>
              )}
              <div className="dsh-tavern-memo is-compose">
                <div className="dsh-tavern-fieldRow">
                  <label className="dsh-tavern-field">
                    <span className="dsh-tavern-fieldLabel">{t('memory.deltaType')}</span>
                    <Select
                      size="md"
                      value={deltaType}
                      onChange={(v) => setDeltaType(v as 'add' | 'update' | 'invalidate')}
                      options={[
                        { value: 'add', label: t(DELTA_TYPE_KEY.add) },
                        { value: 'update', label: t(DELTA_TYPE_KEY.update) },
                        { value: 'invalidate', label: t(DELTA_TYPE_KEY.invalidate) },
                      ]}
                    />
                  </label>
                  {(deltaType === 'update' || deltaType === 'invalidate') && (
                    <label className="dsh-tavern-field">
                      <span className="dsh-tavern-fieldLabel">{t('memory.deltaRef')}</span>
                      <input className="dsh-tavern-input" value={deltaRef} onChange={(e) => setDeltaRef(e.target.value)} />
                    </label>
                  )}
                </div>
                <textarea
                  className="dsh-tavern-input dsh-tavern-textarea"
                  style={{ minHeight: 60, marginTop: 8 }}
                  placeholder={t('memory.deltaBodyPlaceholder')}
                  value={deltaContent}
                  onChange={(e) => setDeltaContent(e.target.value)}
                />
                <label className="dsh-tavern-field" style={{ marginTop: 8 }}>
                  <span className="dsh-tavern-fieldLabel">{t('memory.deltaKeys')}</span>
                  <input className="dsh-tavern-input" value={deltaKeys} onChange={(e) => setDeltaKeys(e.target.value)} />
                </label>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                  <Btn primary disabled={busy || !deltaContent.trim()} onClick={() => void addDelta()}>{t('memory.addDelta')}</Btn>
                </div>
              </div>
            </div>
          )}
          {tab === 'journal' && (
            <div className="dsh-tavern-list">
              <Muted>{t('memory.journalHint')}</Muted>
              {/* 加载期只出骨架：输入框和骨架并排渲染的话，正文还是上一张卡的，保存就会覆盖当前卡。 */}
              {journal.state.status === 'ready' ? (
                <textarea
                  className="dsh-tavern-input dsh-tavern-textarea"
                  style={{ minHeight: 180 }}
                  value={journalText}
                  onChange={(e) => setJournalText(e.target.value)}
                />
              ) : journal.state.status === 'error' ? (
                <Err message={journal.state.message} />
              ) : (
                <Skeleton height={180} />
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Btn primary disabled={busy || journal.state.status !== 'ready' || !cardId} onClick={() => void saveJournal()}>{t('memory.saveJournal')}</Btn>
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  )
}
