/**
 * 设置面板分区：角色卡（列表 / 导入 / 删除 / 详情 / 交互卡）。
 * 列表行走 Avatar + 尾部详情/删除 IconBtn；导入/删除等瞬时反馈走 useToast，上下文错误用 Err。
 * 交互卡预览保留 CSP meta 注入 + sandbox iframe（无 allow-same-origin），不得放宽。
 */
import { useState } from 'react'
import { Button, IconSearchOutline16, IconTrashOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CharacterDetail, CharacterInspect, CharacterSummary, TavernRemote } from '../types.js'
import { Avatar, Btn, ConfirmDialog, Dialog, Err, FileBtn, IconBtn, Muted, Section, Skeleton, errOf, fileToBase64, useLoader, useToast } from '../util.js'

const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'">'

/** 把 CSP meta 注入交互卡 HTML 头部（无 <head> 则直接前置）。 */
function withCsp(html: string): string {
  const head = /<head[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + CSP_META + html.slice(at)
  }
  return CSP_META + html
}

/** 按 cardId 拉头像 dataURL 的 Avatar 包装（失败时回落首字符/图标）。 */
function CardAvatar(props: { remote: TavernRemote; cardId: string; name: string; size: number }) {
  const { state } = useLoader(() => props.remote.getAvatar({ cardId: props.cardId }), [props.cardId])
  const url = state.status === 'ready' ? state.value.dataUrl : null
  return <Avatar url={url} name={props.name} size={props.size} />
}

function CharacterDetailDialog(props: { remote: TavernRemote; cardId: string; onClose: () => void }) {
  const { remote, cardId } = props
  const { state } = useLoader(
    async () => {
      const r = await remote.getCharacterDetail({ cardId })
      return r
    },
    [cardId],
  )
  const [cardOpen, setCardOpen] = useState(false)
  const detail: CharacterDetail | null = state.status === 'ready' ? state.value : null
  const interactiveHtml = typeof detail?.extensions?.interactiveHtml === 'string' ? (detail.extensions.interactiveHtml as string) : null
  return (
    <Dialog open width="md" title={`角色详情：${detail?.name ?? cardId}`} onClose={props.onClose}>
      {state.status === 'loading' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Skeleton height={48} />
          <Skeleton height={14} width="60%" />
          <Skeleton height={90} />
        </div>
      )}
      {state.status === 'error' && <Err message={state.message} />}
      {detail && (
        <div className="dsh-tavern-scroll" style={{ maxHeight: '60vh', overflow: 'auto', fontSize: 13 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
            <CardAvatar remote={remote} cardId={cardId} name={detail.name} size={48} />
            <div>
              <div style={{ fontWeight: 600 }}>{detail.name}</div>
              <Muted>
                {detail.spec} · v{detail.characterVersion || '?'} · {detail.creator || '未知作者'}
                {detail.hasCharacterBook ? ` · 内嵌世界书${detail.characterBookName ? `「${detail.characterBookName}」` : ''}${typeof detail.characterBookEntryCount === 'number' ? ` ${detail.characterBookEntryCount} 条` : ''}` : ''}
              </Muted>
            </div>
          </div>
          {detail.tags.length > 0 && <div style={{ marginBottom: 8 }}><Muted>标签：{detail.tags.join('、')}</Muted></div>}
          {(
            [
              ['描述', detail.description],
              ['性格', detail.personality],
              ['场景', detail.scenario],
              ['开场白', detail.firstMes],
              ...detail.alternateGreetings.map((g, i) => [`开场白变体 ${i + 1}`, g] as const),
              ['对话示例', detail.mesExample],
              ['系统提示', detail.systemPrompt],
              ['历史后指令', detail.postHistoryInstructions],
              ['作者备注', detail.creatorNotes],
            ] as [string, string][]
          )
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} style={{ marginBottom: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 12, opacity: 0.8 }}>{k}</div>
                <pre className="dsh-tavern-scroll" style={{ whiteSpace: 'pre-wrap', margin: '4px 0', fontSize: 12, maxHeight: 160, overflow: 'auto' }}>{v}</pre>
              </div>
            ))}
          {interactiveHtml !== null && (
            <div style={{ marginTop: 8 }}>
              <Btn onClick={() => setCardOpen(true)}>打开交互卡</Btn>
            </div>
          )}
        </div>
      )}
      {cardOpen && interactiveHtml !== null && (
        <Dialog open width="lg" title={`交互卡：${detail?.name ?? ''}`} onClose={() => setCardOpen(false)}>
          <iframe
            sandbox="allow-scripts"
            srcDoc={withCsp(interactiveHtml)}
            title="交互卡"
            style={{ width: '100%', height: '60vh', border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25))', borderRadius: 16, background: 'var(--dsw-alias-bg-base, #111)' }}
          />
        </Dialog>
      )}
    </Dialog>
  )
}

export function CharactersSection(props: { remote: TavernRemote }) {
  const { remote } = props
  const { state, reload } = useLoader(() => remote.listCharacters({}), [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [pending, setPending] = useState<{ name: string; dataBase64: string; preview: CharacterInspect } | null>(null)
  const [toDelete, setToDelete] = useState<CharacterSummary | null>(null)
  const toast = useToast()

  const doImport = async (name: string, dataBase64: string, importWorldBook: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const r = await remote.importCharacter({ name, dataBase64, importWorldBook })
      const err = errOf(r)
      if (err) setError(err)
      else {
        toast.show(importWorldBook ? '已导入角色卡（含内嵌世界书）' : '已导入角色卡')
        reload()
      }
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : String(err2))
    } finally {
      setBusy(false)
      setPending(null)
    }
  }

  const onImportFile = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const dataBase64 = await fileToBase64(file)
      const inspected = await remote.inspectCharacter({ name: file.name, dataBase64 })
      if (!inspected.ok) {
        setError(inspected.error.message)
        return
      }
      if (inspected.value.hasCharacterBook) {
        setPending({ name: file.name, dataBase64, preview: inspected.value })
        return
      }
      await doImport(file.name, dataBase64, false)
    } catch (err2) {
      setError(err2 instanceof Error ? err2.message : String(err2))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async () => {
    if (!toDelete) return
    setBusy(true)
    const r = await remote.deleteCharacter({ cardId: toDelete.cardId })
    setBusy(false)
    const err = errOf(r)
    if (err) setError(err)
    else {
      toast.show(
        r.ok && r.value.salvagedLorebook
          ? `已删除「${toDelete.name}」，内嵌世界书已保留到世界书库：${r.value.salvagedLorebook}`
          : `已删除「${toDelete.name}」`,
      )
      setToDelete(null)
      reload()
    }
  }

  const items = state.status === 'ready' ? state.value.items : []
  return (
    <Section title="角色卡" description="导入 SillyTavern PNG / JSON。删除会清掉该卡工作区，以及仍指向它的会话绑定。">
      {toast.node}
      <div className="dsh-tavern-toolbar">
        <FileBtn accept=".png,.json" disabled={busy} onFile={(file) => void onImportFile(file)}>
          导入 PNG / JSON
        </FileBtn>
        <Btn size="md" onClick={reload} disabled={busy}>刷新</Btn>
      </div>
      {state.status === 'loading' && (
        <div className="dsh-tavern-list">
          <Skeleton height={48} />
          <Skeleton height={48} />
          <Skeleton height={48} />
        </div>
      )}
      {state.status === 'error' && <Err message={state.message} />}
      <Err message={error} />
      {items.length === 0 && state.status === 'ready' && (
        <div className="dsh-tavern-empty">
          <div className="dsh-tavern-emptyIcon">
            <IconUserOutline16 size={32} />
          </div>
          <div className="dsh-tavern-emptyTitle">还没有角色卡</div>
          <div className="dsh-tavern-emptyDesc">导入一张 SillyTavern 角色卡（PNG 或 JSON）开始。</div>
        </div>
      )}
      <div className="dsh-tavern-list">
        {items.map((item) => (
          <div key={item.cardId} className="dsh-tavern-listRow">
            <CardAvatar remote={remote} cardId={item.cardId} name={item.name} size={36} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <div className="dsh-tavern-cardName">{item.name}</div>
              {item.hasCharacterBook ? (
                <Muted>
                  内嵌世界书{item.characterBookName ? `「${item.characterBookName}」` : ''}
                  {typeof item.characterBookEntryCount === 'number' && item.characterBookEntryCount > 0 ? ` ${item.characterBookEntryCount} 条` : ''}
                </Muted>
              ) : (
                <Muted>无内嵌世界书</Muted>
              )}
            </span>
            <IconBtn label="查看详情" onClick={() => setDetailId(item.cardId)}>
              <IconSearchOutline16 />
            </IconBtn>
            <IconBtn label="删除" danger disabled={busy} onClick={() => setToDelete(item)}>
              <IconTrashOutline16 />
            </IconBtn>
          </div>
        ))}
      </div>
      {detailId && <CharacterDetailDialog remote={remote} cardId={detailId} onClose={() => setDetailId(null)} />}
      {pending && (
        <Dialog
          open
          title="导入内嵌世界书？"
          description={`角色卡「${pending.preview.name}」内嵌世界书${pending.preview.characterBookName ? `「${pending.preview.characterBookName}」` : ''}，共 ${pending.preview.entryCount} 条。导入后会作为该卡的主世界书。`}
          onClose={() => setPending(null)}
          footer={
            <div className="dsh-tavern-modalActions">
              <Button type="button" variant="outline" size="md" disabled={busy} onClick={() => void doImport(pending.name, pending.dataBase64, false)}>
                跳过
              </Button>
              <Button type="button" variant="primary" size="md" disabled={busy} onClick={() => void doImport(pending.name, pending.dataBase64, true)}>
                导入世界书
              </Button>
            </div>
          }
        >
          <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }}>
            跳过后仍导入角色卡（描述、开场白、正则），只是不启用这本内嵌世界书。
          </p>
        </Dialog>
      )}
      <ConfirmDialog
        open={toDelete !== null}
        title="删除角色卡？"
        description={toDelete ? `确定删除角色「${toDelete.name}」？其工作区（记忆/世界状态）以及仍绑定该卡的会话都会解除。文件夹 ID 不会出现在对话标题里。` : ''}
        confirmLabel="删除"
        danger
        busy={busy}
        onCancel={() => setToDelete(null)}
        onConfirm={() => void onDelete()}
      />
    </Section>
  )
}
