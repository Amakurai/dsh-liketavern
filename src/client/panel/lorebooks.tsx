/**
 * 设置面板分区：世界书库与角色卡内嵌书。卡片网格展示，点开后按条目开关/编辑。
 * 卡片可键盘触发（clickableProps）；导入/保存等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useState } from 'react'
import { IconDownloadOutline16, IconEditOutline16, IconFolderOpenOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorldInfoEntry } from '../../core/types.js'
import { parseLorebook } from '../../state/lorebook.js'
import type { CharacterSummary, TavernRemote } from '../types.js'
import { Badge, Btn, ConfirmDialog, Dialog, Err, FileBtn, IconBtn, SearchEmpty, SearchInput, Section, Skeleton, clickableProps, downloadJson, errOf, readJsonFile, runAsync, useLoader, useToast } from '../util.js'
import { LorebookEditor, type LorebookTarget } from './lorebookEditor.js'

type Opened = { target: LorebookTarget; entries: WorldInfoEntry[] }

export function LorebooksSection(props: { remote: TavernRemote }) {
  const { remote } = props
  const { state, reload } = useLoader(() => remote.listLorebooks({}), [])
  const chars = useLoader(() => remote.listCharacters({}), [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState(false)
  const [opened, setOpened] = useState<Opened | null>(null)
  const [toDelete, setToDelete] = useState<string | null>(null)
  const [toDeleteEmbedded, setToDeleteEmbedded] = useState<CharacterSummary | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const toast = useToast()

  const names = state.status === 'ready' ? state.value.items : []
  const charItems: CharacterSummary[] = chars.state.status === 'ready' ? chars.state.value.items : []
  const charBooks = charItems.filter((c) => c.hasCharacterBook)
  // 关键词同时过滤「角色卡内嵌」与「世界书库」两组；书多到要滚动找时才出搜索框。
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const matchBook = (label: string) => q === '' || label.toLowerCase().includes(q)
  const shownCharBooks = q === '' ? charBooks : charBooks.filter((c) => matchBook(c.characterBookName || c.name) || c.name.toLowerCase().includes(q))
  const shownNames = q === '' ? names : names.filter(matchBook)
  const totalBooks = charBooks.length + names.length

  const openLibrary = async (name: string) => {
    setError(null)
    setOpening(true)
    try {
      const r = await remote.getLorebook({ name })
      if (!r.ok) {
        setError(r.error.message)
        return
      }
      setOpened({
        target: { kind: 'library', name },
        entries: parseLorebook(r.value.json, { source: 'global', sourceRef: name }),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpening(false)
    }
  }

  const openCharacter = async (item: CharacterSummary) => {
    setError(null)
    setOpening(true)
    try {
      const r = await remote.getCharacterLorebook({ cardId: item.cardId })
      if (!r.ok) {
        setError(r.error.message)
        return
      }
      setOpened({
        target: { kind: 'character', cardId: item.cardId, name: r.value.name },
        entries: parseLorebook(r.value.json, { source: 'character', sourceRef: item.cardId }),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpening(false)
    }
  }

  const remove = async () => {
    if (!toDelete) return
    const r = await remote.deleteLorebook({ name: toDelete })
    const err = errOf(r)
    if (err) setError(err)
    else {
      if (opened?.target.kind === 'library' && opened.target.name === toDelete) setOpened(null)
      setToDelete(null)
      reload()
    }
  }

  /** 删除角色卡内嵌世界书（保留角色卡本身）。 */
  const removeEmbedded = async () => {
    const target = toDeleteEmbedded
    if (!target) return
    const r = await remote.deleteEmbeddedLorebook({ cardId: target.cardId })
    const err = errOf(r)
    if (err) setError(err)
    else {
      toast.show(`已删除「${target.name}」的内嵌世界书`)
      setToDeleteEmbedded(null)
      chars.reload()
    }
  }

  const exportBook = async (name: string) => {
    const r = await remote.getLorebook({ name })
    if (!r.ok) setError(r.error.message)
    else downloadJson(`${name}.json`, r.value.json)
  }

  const onImportFile = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const json = await readJsonFile(file)
      const name = file.name.replace(/\.json$/i, '')
      const r = await remote.importLorebook({ name, json })
      if (!r.ok) setError(r.error.message)
      else {
        toast.show(`已导入 ${r.value.name}（${r.value.entryCount} 条）`)
        reload()
      }
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : String(err2))
    } finally {
      setBusy(false)
    }
  }

  const createEmpty = async () => {
    const name = newName.trim()
    if (!name) {
      setError('请填写世界书名称')
      return
    }
    await runAsync(setBusy, setError, async () => {
      const r = await remote.importLorebook({ name, json: { entries: {} } })
      if (!r.ok) {
        setError(r.error.message)
        return
      }
      setCreating(false)
      setNewName('')
      reload()
      await openLibrary(r.value.name)
    })
  }

  if (opened) {
    return (
      <Section
        title="世界书"
        description="按条目开关与编辑。关掉的条目不会再被扫描命中。改完后记得保存。"
      >
        {toast.node}
        <LorebookEditor
          target={opened.target}
          entries={opened.entries}
          onClose={() => setOpened(null)}
          onSaved={() => {
            toast.show(`已保存「${opened.target.name}」`)
            chars.reload()
            reload()
          }}
          save={(json) =>
            opened.target.kind === 'library'
              ? remote.saveLorebook({ name: opened.target.name, json })
              : remote.saveCharacterLorebook({ cardId: opened.target.cardId, json })
          }
        />
      </Section>
    )
  }

  return (
    <Section title="世界书" description="库文件与角色卡内嵌书。点开一本书，按条目开关、改关键词和正文。新会话启用哪本，在「设置」页勾选。">
      {toast.node}
      <div className="dsh-tavern-toolbar">
        <FileBtn accept=".json" disabled={busy} onFile={(file) => void onImportFile(file)}>
          导入世界书 JSON
        </FileBtn>
        <Btn size="md" disabled={busy} onClick={() => setCreating(true)}>
          新建空书
        </Btn>
        <Btn
          size="md"
          onClick={() => {
            reload()
            chars.reload()
          }}
          disabled={busy}
        >
          刷新
        </Btn>
        {totalBooks >= 5 && (
          <SearchInput label="搜索世界书" value={query} onChange={setQuery} placeholder="搜索书名 / 角色名" width={220} />
        )}
      </div>
      {(state.status === 'loading' || opening) && (
        <div className="dsh-tavern-list">
          <Skeleton height={62} radius={14} />
          <Skeleton height={62} radius={14} />
          <Skeleton height={62} radius={14} />
        </div>
      )}
      {state.status === 'error' && <Err message={state.message} />}
      <Err message={error} />
      {q !== '' && shownCharBooks.length === 0 && shownNames.length === 0 && state.status === 'ready' && chars.state.status === 'ready' && (
        <SearchEmpty what="世界书" query={query.trim()} onClear={() => setQuery('')} />
      )}

      {shownCharBooks.length > 0 && (
        <>
          <div className="dsh-tavern-groupHead">角色卡内嵌</div>
          <div className="dsh-tavern-list">
            {shownCharBooks.map((item) => (
              <div key={item.cardId} className="dsh-tavern-tile" {...clickableProps(() => void openCharacter(item))}>
                <span className="dsh-tavern-tileIcon">
                  <IconFolderOpenOutline16 size={18} />
                </span>
                <div className="dsh-tavern-tileMain">
                  <div className="dsh-tavern-tileTitleRow">
                    <span className="dsh-tavern-tileName">{item.characterBookName || item.name}</span>
                    <Badge>内嵌</Badge>
                  </div>
                  <span className="dsh-tavern-tileSub">
                    来自角色「{item.name}」
                    {typeof item.characterBookEntryCount === 'number' && item.characterBookEntryCount > 0
                      ? ` · ${item.characterBookEntryCount} 条`
                      : ''}
                  </span>
                </div>
                <div className="dsh-tavern-tileActions">
                  <IconBtn label="编辑条目" onClick={() => void openCharacter(item)}>
                    <IconEditOutline16 />
                  </IconBtn>
                  <IconBtn label="删除内嵌世界书" danger onClick={() => setToDeleteEmbedded(item)}>
                    <IconTrashOutline16 />
                  </IconBtn>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="dsh-tavern-groupHead">世界书库</div>
      {shownNames.length === 0 && state.status === 'ready' ? (
        q === '' ? (
          <div className="dsh-tavern-empty">
            <div className="dsh-tavern-emptyIcon">
              <IconFolderOpenOutline16 size={32} />
            </div>
            <div className="dsh-tavern-emptyTitle">暂无独立世界书</div>
            <div className="dsh-tavern-emptyDesc">
              {charBooks.length > 0 ? '卡内嵌书见上方分组。' : '导入角色卡或 JSON，也可以新建一本空书。'}
            </div>
          </div>
        ) : null
      ) : (
        <div className="dsh-tavern-list">
          {shownNames.map((name) => (
            <div key={name} className="dsh-tavern-tile" {...clickableProps(() => void openLibrary(name))}>
              <span className="dsh-tavern-tileIcon">
                <IconFolderOpenOutline16 size={18} />
              </span>
              <div className="dsh-tavern-tileMain">
                <div className="dsh-tavern-tileTitleRow">
                  <span className="dsh-tavern-tileName">{name}</span>
                  <Badge>库</Badge>
                </div>
                <span className="dsh-tavern-tileSub">独立世界书文件 · JSON</span>
              </div>
              <div className="dsh-tavern-tileActions">
                <IconBtn label="编辑条目" onClick={() => void openLibrary(name)}>
                  <IconEditOutline16 />
                </IconBtn>
                <IconBtn label="导出 JSON" onClick={() => void exportBook(name)}>
                  <IconDownloadOutline16 />
                </IconBtn>
                <IconBtn label="删除世界书" danger onClick={() => setToDelete(name)}>
                  <IconTrashOutline16 />
                </IconBtn>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title="删除世界书？"
        description={toDelete ? `确定删除世界书 ${toDelete}？此操作不能从设置里撤销。` : ''}
        confirmLabel="删除"
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={toDeleteEmbedded !== null}
        title="删除内嵌世界书？"
        description={
          toDeleteEmbedded
            ? `确定删除角色「${toDeleteEmbedded.name}」的内嵌世界书${toDeleteEmbedded.characterBookName ? `（${toDeleteEmbedded.characterBookName}）` : ''}？角色卡本身保留，此操作不能从设置里撤销。`
            : ''
        }
        confirmLabel="删除"
        danger
        onCancel={() => setToDeleteEmbedded(null)}
        onConfirm={() => void removeEmbedded()}
      />
      <Dialog
        open={creating}
        title="新建世界书"
        description="先建一本空书，再在条目列表里添加关键词和正文。"
        onClose={() => setCreating(false)}
        footer={
          <div className="dsh-tavern-modalActions">
            <Btn size="md" onClick={() => setCreating(false)}>
              取消
            </Btn>
            <Btn primary size="md" disabled={busy} onClick={() => void createEmpty()}>
              创建
            </Btn>
          </div>
        }
      >
        <input
          className="dsh-tavern-input"
          style={{ width: '100%', height: 36, borderRadius: 8, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }}
          value={newName}
          placeholder="世界书名称"
          onChange={(e) => setNewName(e.target.value)}
        />
      </Dialog>
    </Section>
  )
}
