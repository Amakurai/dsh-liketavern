/**
 * 设置面板分区：角色卡（列表 / 导入 / 删除 / 详情 / 交互卡）。
 * 列表行走 Avatar + 尾部详情/删除 IconBtn；导入/删除等瞬时反馈走 useToast，上下文错误用 Err。
 * 交互卡预览保留 CSP meta 注入 + sandbox iframe（无 allow-same-origin），不得放宽。
 */
import { useEffect, useState } from 'react'
import { Button, IconDownloadOutline16, IconTrashOutline16, IconUserOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CharacterDetail, CharacterInspect, CharacterSummary, TavernRemote } from '../types.js'
import { Avatar, Btn, ConfirmDialog, Dialog, Err, Field, FileBtn, IconBtn, Muted, NumInput, SearchEmpty, SearchInput, Section, Select, Skeleton, clickableProps, downloadBase64, downloadJson, errOf, fileToBase64, runAsync, useLoader, useToast } from '../util.js'

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

/** 海报卡：封面图（或首字符封面）+ 底部渐变上的名字与内嵌书信息；整卡可点进编辑，删除钮悬停浮现。 */
function CharacterCard(props: {
  remote: TavernRemote
  item: CharacterSummary
  busy: boolean
  onOpen: (cardId: string) => void
  onDelete: (item: CharacterSummary) => void
}) {
  const { state } = useLoader(() => props.remote.getAvatar({ cardId: props.item.cardId }), [props.item.cardId])
  const url = state.status === 'ready' ? state.value.dataUrl : null
  const initial = props.item.name.trim().charAt(0) || '?'
  const meta = props.item.hasCharacterBook
    ? `内嵌世界书${props.item.characterBookName ? `「${props.item.characterBookName}」` : ''}${
        typeof props.item.characterBookEntryCount === 'number' && props.item.characterBookEntryCount > 0
          ? ` · ${props.item.characterBookEntryCount} 条`
          : ''
      }`
    : ''
  return (
    <article className="dsh-tavern-charCard" {...clickableProps(() => props.onOpen(props.item.cardId))}>
      <div className="dsh-tavern-charCardCover">
        {url ? <img src={url} alt="" /> : <span className="dsh-tavern-charCardInitial">{initial}</span>}
      </div>
      <div className="dsh-tavern-charCardBar">
        <div className="dsh-tavern-charCardName">{props.item.name}</div>
        {meta ? <div className="dsh-tavern-charCardMeta">{meta}</div> : null}
      </div>
      <div className="dsh-tavern-charCardActions">
        <Tooltip label="删除角色卡" side="bottom">
          <button
            type="button"
            aria-label="删除角色卡"
            className="dsh-tavern-coverBtn is-danger"
            disabled={props.busy}
            onClick={(e: { stopPropagation: () => void }) => {
              e.stopPropagation()
              props.onDelete(props.item)
            }}
          >
            <IconTrashOutline16 />
          </button>
        </Tooltip>
      </div>
    </article>
  )
}

/** 详情弹窗里的「标签 + 多行框」单元，配合 groupHead 分组使用。 */
function LabeledArea(props: { label: string; value: string; minHeight?: number; onChange: (value: string) => void }) {
  return (
    <div className="dsh-tavern-field" style={{ marginBottom: 8 }}>
      <span className="dsh-tavern-fieldLabel">{props.label}</span>
      <textarea
        className="dsh-tavern-input dsh-tavern-textarea"
        style={{ minHeight: props.minHeight ?? 64 }}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  )
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
    await runAsync(setBusy, setError, async () => {
      const r = await remote.saveCharacter({
        cardId,
        name: detail.name,
        description: detail.description,
        personality: detail.personality,
        scenario: detail.scenario,
        firstMes: detail.firstMes,
        alternateGreetings: detail.alternateGreetings.map((s) => s.trim()).filter(Boolean),
        mesExample: detail.mesExample,
        systemPrompt: detail.systemPrompt,
        postHistoryInstructions: detail.postHistoryInstructions,
        creatorNotes: detail.creatorNotes,
        creator: detail.creator,
        characterVersion: detail.characterVersion,
        tags: detail.tags,
        depthPrompt: detail.depthPrompt ?? null,
      })
      const err = errOf(r)
      if (err) setError(err)
      else {
        toast.show(`已保存「${detail.name}」`)
        reload()
        props.onSaved()
      }
    })
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
    <Dialog open width="xl" title={`编辑角色：${detail?.name ?? cardId}`} onClose={props.onClose}>
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
        <div className="dsh-tavern-dialogStack dsh-tavern-scroll" style={{ maxHeight: '65vh', overflow: 'auto', fontSize: 13 }}>
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
          <div className="dsh-tavern-panelCard">
            <div className="dsh-tavern-groupHead">人设与场景</div>
            <LabeledArea label="描述" minHeight={88} value={detail.description} onChange={(v) => set({ description: v })} />
            <LabeledArea label="性格" value={detail.personality} onChange={(v) => set({ personality: v })} />
            <LabeledArea label="场景" value={detail.scenario} onChange={(v) => set({ scenario: v })} />
          </div>

          <div className="dsh-tavern-panelCard">
            <div className="dsh-tavern-groupHead">开场白与示例</div>
            <LabeledArea label="开场白" minHeight={88} value={detail.firstMes} onChange={(v) => set({ firstMes: v })} />
            <div className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">开场白变体（每行一条）</span>
              <textarea
                className="dsh-tavern-input dsh-tavern-textarea"
                style={{ minHeight: 72 }}
                value={detail.alternateGreetings.join('\n')}
                onChange={(e) => set({ alternateGreetings: e.target.value.split('\n') })}
              />
            </div>
            <LabeledArea label="对话示例" value={detail.mesExample} onChange={(v) => set({ mesExample: v })} />
          </div>

          <div className="dsh-tavern-panelCard">
            <div className="dsh-tavern-groupHead">高级注入</div>
            <LabeledArea label="系统提示" value={detail.systemPrompt} onChange={(v) => set({ systemPrompt: v })} />
            <LabeledArea label="历史后指令" value={detail.postHistoryInstructions} onChange={(v) => set({ postHistoryInstructions: v })} />
            <div className="dsh-tavern-field">
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
          </div>

          <div className="dsh-tavern-panelCard">
            <div className="dsh-tavern-groupHead">元数据</div>
            <LabeledArea label="作者备注" value={detail.creatorNotes} onChange={(v) => set({ creatorNotes: v })} />
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
          </div>
          <Err message={error} />
          <div className="dsh-tavern-footActions" style={{ marginTop: 2 }}>
            <IconBtn label="导出 PNG" onClick={() => void exportCard('png')}>
              <IconDownloadOutline16 />
            </IconBtn>
            {interactiveHtml !== null && <Btn size="md" onClick={() => setCardOpen(true)}>打开交互卡</Btn>}
            <span className="dsh-tavern-footSpacer" />
            <Btn size="md" disabled={busy} onClick={() => void exportCard('json')}>导出 JSON</Btn>
            <Btn primary size="md" disabled={busy} onClick={() => void save()}>保存</Btn>
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
  const [query, setQuery] = useState('')
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
    await runAsync(setBusy, setError, async () => {
      const r = await remote.deleteCharacter({ cardId: toDelete.cardId })
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
    })
  }

  const items = state.status === 'ready' ? state.value.items : []
  // 卡多到要翻页找时才出搜索框；关键词同时匹配角色名与内嵌书名。
  const q = query.trim().toLowerCase()
  const filtered =
    q === ''
      ? items
      : items.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            (c.characterBookName ?? '').toLowerCase().includes(q),
        )
  return (
    <Section title="角色卡" description="导入或新建角色卡。点进卡片可编辑正文并导出 PNG/JSON。删除会清掉该卡工作区，以及仍指向它的会话绑定。">
      {toast.node}
      <div className="dsh-tavern-toolbar">
        <FileBtn accept=".png,.json" disabled={busy} onFile={(file) => void onImportFile(file)}>
          导入 PNG / JSON
        </FileBtn>
        <Btn size="md" disabled={busy} onClick={() => setCreating(true)}>新建空白卡</Btn>
        <Btn size="md" onClick={reload} disabled={busy}>刷新</Btn>
        {items.length >= 5 && (
          <SearchInput
            label="搜索角色卡"
            value={query}
            onChange={setQuery}
            placeholder="搜索角色名 / 内嵌书名"
            width={220}
          />
        )}
      </div>
      {state.status === 'loading' && (
        <div className="dsh-tavern-charGrid">
          <Skeleton height={186} radius={16} />
          <Skeleton height={186} radius={16} />
          <Skeleton height={186} radius={16} />
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
      {q !== '' && filtered.length === 0 && state.status === 'ready' && (
        <SearchEmpty what="角色卡" query={query.trim()} onClear={() => setQuery('')} />
      )}
      <div className="dsh-tavern-charGrid">
        {filtered.map((item) => (
          <CharacterCard key={item.cardId} remote={remote} item={item} busy={busy} onOpen={setDetailId} onDelete={setToDelete} />
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
                void runAsync(setBusy, setError, async () => {
                  const r = await remote.createCharacter({ name: newName.trim() })
                  const err = errOf(r)
                  if (err) setError(err)
                  else {
                    toast.show(`已创建「${r.ok ? r.value.name : newName}」`)
                    setCreating(false)
                    setNewName('')
                    reload()
                    if (r.ok) setDetailId(r.value.cardId)
                  }
                })
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
