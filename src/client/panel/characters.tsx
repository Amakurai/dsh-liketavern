/**
 * 设置面板分区：角色卡（列表 / 导入 / 删除 / 详情 / 交互卡）。
 * 列表行走 Avatar + 尾部详情/删除 IconBtn；导入/删除等瞬时反馈走 useToast，上下文错误用 Err。
 * 交互卡预览保留 CSP meta 注入 + sandbox iframe（无 allow-same-origin），不得放宽。
 */
import { useEffect, useState } from 'react'
import { Button, IconDownloadOutline16, IconSearchOutline16, IconTrashOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CharacterDetail, CharacterInspect, CharacterSummary, TavernRemote } from '../types.js'
import { Avatar, Btn, ConfirmDialog, Dialog, Err, Field, FileBtn, IconBtn, Muted, NumInput, Section, Select, Skeleton, downloadBase64, downloadJson, errOf, fileToBase64, useLoader, useToast } from '../util.js'

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

function CharacterDetailDialog(props: { remote: TavernRemote; cardId: string; onClose: () => void; onSaved: () => void }) {
  const { remote, cardId } = props
  const { state, reload } = useLoader(
    async () => {
      const r = await remote.getCharacterDetail({ cardId })
      return r
    },
    [cardId],
  )
  const [cardOpen, setCardOpen] = useState(false)
  const [draft, setDraft] = useState<CharacterDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const loaded: CharacterDetail | null = state.status === 'ready' ? state.value : null
  const detail = draft ?? loaded
  useEffect(() => {
    if (loaded) setDraft(loaded)
  }, [loaded])

  const set = (patch: Partial<CharacterDetail>) => setDraft(detail ? { ...detail, ...patch } : detail)
  const interactiveHtml = typeof detail?.extensions?.interactiveHtml === 'string' ? (detail.extensions.interactiveHtml as string) : null

  const save = async () => {
    if (!detail) return
    if (!detail.name.trim()) {
      setError('角色名不能为空')
      return
    }
    setBusy(true)
    setError(null)
    const r = await remote.saveCharacter({
      cardId,
      name: detail.name,
      description: detail.description,
      personality: detail.personality,
      scenario: detail.scenario,
      firstMes: detail.firstMes,
      alternateGreetings: detail.alternateGreetings,
      mesExample: detail.mesExample,
      systemPrompt: detail.systemPrompt,
      postHistoryInstructions: detail.postHistoryInstructions,
      creatorNotes: detail.creatorNotes,
      creator: detail.creator,
      characterVersion: detail.characterVersion,
      tags: detail.tags,
      depthPrompt: detail.depthPrompt ?? null,
    })
    setBusy(false)
    const err = errOf(r)
    if (err) setError(err)
    else {
      toast.show(`已保存「${detail.name}」`)
      reload()
      props.onSaved()
    }
  }

  const exportCard = async (kind: 'json' | 'png') => {
    const r = await remote.exportCharacter({ cardId })
    if (!r.ok) {
      setError(r.error.message)
      return
    }
    if (kind === 'json') downloadJson(`${r.value.name}.json`, r.value.json)
    else downloadBase64(`${r.value.name}.png`, r.value.pngBase64, 'image/png')
    toast.show(kind === 'json' ? '已导出 JSON' : '已导出 PNG')
  }

  return (
    <Dialog open width="lg" title={`编辑角色：${detail?.name ?? cardId}`} onClose={props.onClose}>
      {toast.node}
      {state.status === 'loading' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Skeleton height={48} />
          <Skeleton height={14} width="60%" />
          <Skeleton height={90} />
        </div>
      )}
      {state.status === 'error' && <Err message={state.message} />}
      {detail && (
        <div className="dsh-tavern-scroll" style={{ maxHeight: '65vh', overflow: 'auto', fontSize: 13 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 10 }}>
            <CardAvatar remote={remote} cardId={cardId} name={detail.name} size={48} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <Field label="显示名（不会改工作区 ID）">
                <input className="dsh-tavern-input" style={{ width: '100%' }} value={detail.name} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <Muted>
                {detail.spec} · v{detail.characterVersion || '?'} · {detail.creator || '未知作者'}
                {detail.hasCharacterBook ? ` · 内嵌世界书${detail.characterBookName ? `「${detail.characterBookName}」` : ''}` : ''}
              </Muted>
            </div>
          </div>
          {(
            [
              ['description', '描述', detail.description],
              ['personality', '性格', detail.personality],
              ['scenario', '场景', detail.scenario],
              ['firstMes', '开场白', detail.firstMes],
              ['mesExample', '对话示例', detail.mesExample],
              ['systemPrompt', '系统提示', detail.systemPrompt],
              ['postHistoryInstructions', '历史后指令', detail.postHistoryInstructions],
              ['creatorNotes', '作者备注', detail.creatorNotes],
            ] as const
          ).map(([key, label, value]) => (
            <div key={key} className="dsh-tavern-field" style={{ marginBottom: 8 }}>
              <span className="dsh-tavern-fieldLabel">{label}</span>
              <textarea
                className="dsh-tavern-input dsh-tavern-textarea"
                style={{ minHeight: key === 'description' || key === 'firstMes' ? 88 : 64 }}
                value={value}
                onChange={(e) => set({ [key]: e.target.value } as Partial<CharacterDetail>)}
              />
            </div>
          ))}
          <div className="dsh-tavern-field" style={{ marginBottom: 8 }}>
            <span className="dsh-tavern-fieldLabel">开场白变体（每行一条）</span>
            <textarea
              className="dsh-tavern-input dsh-tavern-textarea"
              style={{ minHeight: 72 }}
              value={detail.alternateGreetings.join('\n')}
              onChange={(e) => set({ alternateGreetings: e.target.value.split('\n') })}
            />
          </div>
          <div className="dsh-tavern-fieldRow">
            <Field label="作者">
              <input className="dsh-tavern-input" value={detail.creator} onChange={(e) => set({ creator: e.target.value })} />
            </Field>
            <Field label="版本">
              <input className="dsh-tavern-input" value={detail.characterVersion} onChange={(e) => set({ characterVersion: e.target.value })} />
            </Field>
          </div>
          <Field label="标签（逗号分隔）">
            <input
              className="dsh-tavern-input"
              style={{ width: '100%' }}
              value={detail.tags.join(', ')}
              onChange={(e) => set({ tags: e.target.value.split(/[，,]/).map((s: string) => s.trim()).filter(Boolean) })}
            />
          </Field>
          <div className="dsh-tavern-field" style={{ marginTop: 8 }}>
            <span className="dsh-tavern-fieldLabel">depth_prompt（预览按深度插位，live 并入本轮 turn）</span>
            <textarea
              className="dsh-tavern-input dsh-tavern-textarea"
              style={{ minHeight: 64 }}
              value={detail.depthPrompt?.prompt ?? ''}
              onChange={(e) =>
                set({
                  depthPrompt: e.target.value.trim()
                    ? { prompt: e.target.value, depth: detail.depthPrompt?.depth ?? 4, role: detail.depthPrompt?.role ?? 'system' }
                    : null,
                })
              }
            />
            {detail.depthPrompt ? (
              <div className="dsh-tavern-fieldRow" style={{ marginTop: 6 }}>
                <Field label="深度">
                  <NumInput value={detail.depthPrompt.depth} onChange={(depth) => set({ depthPrompt: { ...detail.depthPrompt!, depth: Math.max(0, Math.round(depth)) } })} />
                </Field>
                <Field label="角色">
                  <Select
                    value={detail.depthPrompt.role}
                    onChange={(role) => set({ depthPrompt: { ...detail.depthPrompt!, role: role as 'system' | 'user' | 'assistant' } })}
                    options={[
                      { value: 'system', label: 'system' },
                      { value: 'user', label: 'user' },
                      { value: 'assistant', label: 'assistant' },
                    ]}
                  />
                </Field>
              </div>
            ) : null}
          </div>
          <Err message={error} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <Btn primary disabled={busy} onClick={() => void save()}>保存</Btn>
            <Btn disabled={busy} onClick={() => void exportCard('json')}>导出 JSON</Btn>
            <IconBtn label="导出 PNG" onClick={() => void exportCard('png')}>
              <IconDownloadOutline16 />
            </IconBtn>
            {interactiveHtml !== null && <Btn onClick={() => setCardOpen(true)}>打开交互卡</Btn>}
          </div>
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
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
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
    <Section title="角色卡" description="导入或新建角色卡。点进卡片可编辑正文并导出 PNG/JSON。删除会清掉该卡工作区，以及仍指向它的会话绑定。">
      {toast.node}
      <div className="dsh-tavern-toolbar">
        <FileBtn accept=".png,.json" disabled={busy} onFile={(file) => void onImportFile(file)}>
          导入 PNG / JSON
        </FileBtn>
        <Btn size="md" disabled={busy} onClick={() => setCreating(true)}>新建空白卡</Btn>
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
          <div className="dsh-tavern-emptyDesc">导入一张 SillyTavern 角色卡，或新建空白卡。</div>
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
            <IconBtn label="编辑角色" onClick={() => setDetailId(item.cardId)}>
              <IconSearchOutline16 />
            </IconBtn>
            <IconBtn label="删除" danger disabled={busy} onClick={() => setToDelete(item)}>
              <IconTrashOutline16 />
            </IconBtn>
          </div>
        ))}
      </div>
      {detailId && (
        <CharacterDetailDialog
          remote={remote}
          cardId={detailId}
          onClose={() => setDetailId(null)}
          onSaved={reload}
        />
      )}
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
      <Dialog
        open={creating}
        title="新建空白角色卡"
        description="先建一张只有名字和默认开场白的卡，再点进去填描述。"
        onClose={() => setCreating(false)}
        footer={
          <div className="dsh-tavern-modalActions">
            <Btn size="md" onClick={() => setCreating(false)}>取消</Btn>
            <Btn
              primary
              size="md"
              disabled={busy || !newName.trim()}
              onClick={() => {
                void (async () => {
                  setBusy(true)
                  const r = await remote.createCharacter({ name: newName.trim() })
                  setBusy(false)
                  const err = errOf(r)
                  if (err) setError(err)
                  else {
                    toast.show(`已创建「${r.ok ? r.value.name : newName}」`)
                    setCreating(false)
                    setNewName('')
                    reload()
                    if (r.ok) setDetailId(r.value.cardId)
                  }
                })()
              }}
            >
              创建
            </Btn>
          </div>
        }
      >
        <input
          className="dsh-tavern-input"
          style={{ width: '100%', height: 36, borderRadius: 8, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }}
          value={newName}
          placeholder="角色名"
          onChange={(e) => setNewName(e.target.value)}
        />
      </Dialog>
    </Section>
  )
}
