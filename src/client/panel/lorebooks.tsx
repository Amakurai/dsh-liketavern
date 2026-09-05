/**
 * 设置面板分区：世界书库与角色卡内嵌书。卡片网格展示，点开后按条目开关/编辑。
 * 卡片可键盘触发（clickableProps）；导入/保存等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useState } from 'react'
import { PersistentEditor, useDraftState } from '../draftPersistence.js'
import { useDraftGuard } from '../drafts.js'
import { IconDownloadOutline16, IconEditOutline16, IconFolderOpenOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorldInfoEntry } from '../../core/types.js'
import { parseLorebook } from '../../state/lorebook.js'
import { useT } from '../i18n.js'
import type { CharacterSummary, TavernRemote } from '../types.js'
import { Badge, Btn, ConfirmDialog, Dialog, Err, FileBtn, IconBtn, SearchEmpty, SearchInput, Section, Skeleton, clickableProps, downloadJson, errOf, readJsonFile, runAsync, useLoader, useToast } from '../util.js'
import { LorebookEditor, type LorebookTarget } from './lorebookEditor.js'

type Opened = { target: LorebookTarget; entries: WorldInfoEntry[] }

export function LorebooksSection(props: { remote: TavernRemote }) {
  return <PersistentEditor remote={props.remote} scope="lorebooks"><LorebooksSectionContent {...props} /></PersistentEditor>
}

function LorebooksSectionContent(props: { remote: TavernRemote }) {
  const { remote } = props
  const { state, reload } = useLoader(() => remote.listLorebooks({}), [])
  const chars = useLoader(() => remote.listCharacters({}), [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [opening, setOpening] = useState(false)
  const [opened, setOpened] = useDraftState<Opened | null>('lorebooks:opened', null)
  const [toDelete, setToDelete] = useState<string | null>(null)
  const [toDeleteEmbedded, setToDeleteEmbedded] = useState<CharacterSummary | null>(null)
  const [creating, setCreating] = useDraftState('lorebooks:creating', false)
  const [newName, setNewName] = useDraftState('lorebooks:newName', '')
  const toast = useToast()
  const t = useT()
  const createGuard = useDraftGuard(creating && !!newName.trim(), busy)
  const closeCreate = () => createGuard.request(() => {
    setCreating(false)
    setNewName('')
  })

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
    await runAsync(setBusy, setError, async () => {
      const r = await remote.deleteLorebook({ name: toDelete })
      const err = errOf(r)
      if (err) setError(err)
      else {
        if (opened?.target.kind === 'library' && opened.target.name === toDelete) setOpened(null)
        setToDelete(null)
        reload()
      }
    })
  }

  /** 删除角色卡内嵌世界书（保留角色卡本身）。 */
  const removeEmbedded = async () => {
    const target = toDeleteEmbedded
    if (!target) return
    await runAsync(setBusy, setError, async () => {
      const r = await remote.deleteEmbeddedLorebook({ cardId: target.cardId })
      const err = errOf(r)
      if (err) setError(err)
      else {
        toast.show(t('lorebooks.embeddedDeleted', { name: target.name }))
        setToDeleteEmbedded(null)
        chars.reload()
      }
    })
  }

  const exportBook = async (name: string) => {
    await runAsync(setBusy, setError, async () => {
      const r = await remote.getLorebook({ name })
      if (!r.ok) setError(r.error.message)
      else downloadJson(`${name}.json`, r.value.json)
    })
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
        toast.show(t('lorebooks.imported', { name: r.value.name, count: r.value.entryCount }))
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
      setError(t('lorebooks.nameRequired'))
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
        title={t('section.lorebooks')}
        description={t('lorebooks.editorDesc')}
      >
        {toast.node}
        <LorebookEditor
          remote={remote}
          target={opened.target}
          entries={opened.entries}
          onClose={() => setOpened(null)}
          onSaved={() => {
            toast.show(t('lorebooks.saved', { name: opened.target.name }))
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
    <Section title={t('section.lorebooks')} description={t('lorebooks.listDesc')}>
      {toast.node}
      {createGuard.confirmation}
      <div className="dsh-tavern-toolbar">
        <FileBtn accept=".json" disabled={busy} onFile={(file) => void onImportFile(file)}>
          {t('lorebooks.importJson')}
        </FileBtn>
        <Btn size="md" disabled={busy} onClick={() => setCreating(true)}>
          {t('lorebooks.newEmpty')}
        </Btn>
        <Btn
          size="md"
          onClick={() => {
            reload()
            chars.reload()
          }}
          disabled={busy}
        >
          {t('action.refresh')}
        </Btn>
        {totalBooks >= 5 && (
          <SearchInput label={t('lorebooks.searchLabel')} value={query} onChange={setQuery} placeholder={t('lorebooks.searchPlaceholder')} width={220} />
        )}
      </div>
      {(state.status === 'loading' || opening) && (
        <div className="dsh-tavern-list">
          <Skeleton height={70} radius={16} />
          <Skeleton height={70} radius={16} />
          <Skeleton height={70} radius={16} />
        </div>
      )}
      {state.status === 'error' && <Err message={state.message} />}
      <Err message={error} />
      {q !== '' && shownCharBooks.length === 0 && shownNames.length === 0 && state.status === 'ready' && chars.state.status === 'ready' && (
        <SearchEmpty what={t('section.lorebooks')} query={query.trim()} onClear={() => setQuery('')} />
      )}

      {shownCharBooks.length > 0 && (
        <>
          <div className="dsh-tavern-groupHead">{t('lorebooks.groupEmbedded')}</div>
          <div className="dsh-tavern-list">
            {shownCharBooks.map((item) => (
              <div key={item.cardId} className="dsh-tavern-tile" {...clickableProps(() => void openCharacter(item))}>
                <span className="dsh-tavern-tileIcon">
                  <IconFolderOpenOutline16 size={18} />
                </span>
                <div className="dsh-tavern-tileMain">
                  <div className="dsh-tavern-tileTitleRow">
                    <span className="dsh-tavern-tileName">{item.characterBookName || item.name}</span>
                    <Badge>{t('lorebooks.badgeEmbedded')}</Badge>
                  </div>
                  <span className="dsh-tavern-tileSub">
                    {typeof item.characterBookEntryCount === 'number' && item.characterBookEntryCount > 0
                      ? t('lorebooks.fromCharacterWithCount', { name: item.name, count: item.characterBookEntryCount })
                      : t('lorebooks.fromCharacter', { name: item.name })}
                  </span>
                </div>
                <div className="dsh-tavern-tileActions">
                  <IconBtn label={t('lorebooks.editEntries')} onClick={() => void openCharacter(item)}>
                    <IconEditOutline16 />
                  </IconBtn>
                  <IconBtn label={t('lorebooks.deleteEmbedded')} danger onClick={() => setToDeleteEmbedded(item)}>
                    <IconTrashOutline16 />
                  </IconBtn>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="dsh-tavern-groupHead">{t('lorebooks.groupLibrary')}</div>
      {shownNames.length === 0 && state.status === 'ready' ? (
        q === '' ? (
          <div className="dsh-tavern-empty">
            <div className="dsh-tavern-emptyIcon">
              <IconFolderOpenOutline16 size={32} />
            </div>
            <div className="dsh-tavern-emptyTitle">{t('lorebooks.emptyTitle')}</div>
            <div className="dsh-tavern-emptyDesc">
              {charBooks.length > 0 ? t('lorebooks.emptyDescEmbeddedAbove') : t('lorebooks.emptyDesc')}
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
                  <Badge>{t('lorebooks.badgeLibrary')}</Badge>
                </div>
                <span className="dsh-tavern-tileSub">{t('lorebooks.libraryFileSub')}</span>
              </div>
              <div className="dsh-tavern-tileActions">
                <IconBtn label={t('lorebooks.editEntries')} onClick={() => void openLibrary(name)}>
                  <IconEditOutline16 />
                </IconBtn>
                <IconBtn label={t('lorebooks.exportJson')} disabled={busy} onClick={() => void exportBook(name)}>
                  <IconDownloadOutline16 />
                </IconBtn>
                <IconBtn label={t('lorebooks.deleteBook')} danger onClick={() => setToDelete(name)}>
                  <IconTrashOutline16 />
                </IconBtn>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title={t('lorebooks.confirmDeleteTitle')}
        description={toDelete ? t('lorebooks.confirmDeleteDesc', { name: toDelete }) : ''}
        confirmLabel={t('action.delete')}
        danger
        busy={busy}
        onCancel={() => setToDelete(null)}
        onConfirm={() => void remove()}
      />
      <ConfirmDialog
        open={toDeleteEmbedded !== null}
        title={t('lorebooks.confirmDeleteEmbeddedTitle')}
        description={
          toDeleteEmbedded
            ? t('lorebooks.confirmDeleteEmbeddedDesc', {
                name: toDeleteEmbedded.name,
                book: toDeleteEmbedded.characterBookName ? t('lorebooks.bookNameSuffix', { name: toDeleteEmbedded.characterBookName }) : '',
              })
            : ''
        }
        confirmLabel={t('action.delete')}
        danger
        busy={busy}
        onCancel={() => setToDeleteEmbedded(null)}
        onConfirm={() => void removeEmbedded()}
      />
      <Dialog
        open={creating}
        title={t('lorebooks.createTitle')}
        description={t('lorebooks.createDesc')}
        onClose={closeCreate}
        footer={
          <div className="dsh-tavern-modalActions">
            <Btn size="md" disabled={busy} onClick={closeCreate}>
              {t('action.cancel')}
            </Btn>
            <Btn primary size="md" disabled={busy || !newName.trim()} onClick={() => void createEmpty()}>
              {t('lorebooks.create')}
            </Btn>
          </div>
        }
      >
        <input
          className="dsh-tavern-input"
          style={{ width: '100%', height: 36, borderRadius: 8, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }}
          value={newName}
          disabled={busy}
          placeholder={t('lorebooks.namePlaceholder')}
          onChange={(e) => setNewName(e.target.value)}
        />
      </Dialog>
    </Section>
  )
}
