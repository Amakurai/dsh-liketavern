/**
 * 世界书条目编辑器：按 SillyTavern World Info 语义列出条目，
 * 折叠行上可开关，展开后编辑关键词/正文/插入位置等。不展示原始 JSON。
 * 展开/收起走 .dsh-tavern-collapse 动画容器（grid-rows 过渡，表单始终渲染）。
 */
import { useMemo, useState } from 'react'
import {
  IconChevronDownOutline14,
  IconPlusOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { WIPosition, WIRole, WISelectiveLogic, WISource, WorldInfoEntry } from '../../core/types.js'
import { exportLorebook } from '../../state/lorebook.js'
import { Badge, Btn, ConfirmDialog, Err, IconBtn, Muted, NumInput, NullableNumInput, Select, Toggle, errOf } from '../util.js'
import type { Envelope } from '../types.js'

const PAGE_SIZE = 40

const POSITION_OPTIONS = [
  { value: '0', label: '角色定义之前' },
  { value: '1', label: '角色定义之后' },
  { value: '2', label: '作者注释顶部' },
  { value: '3', label: '作者注释底部' },
  { value: '4', label: '@D 指定深度' },
  { value: '5', label: '示例对话之前' },
  { value: '6', label: '示例对话之后' },
  { value: '7', label: 'Outlet' },
]

const LOGIC_OPTIONS = [
  { value: '0', label: 'AND ANY（任一）' },
  { value: '1', label: 'NOT ALL' },
  { value: '2', label: 'NOT ANY' },
  { value: '3', label: 'AND ALL（全部）' },
]

const ROLE_OPTIONS = [
  { value: '0', label: 'system' },
  { value: '1', label: 'user' },
  { value: '2', label: 'assistant' },
]

/** 条目级布尔覆盖（boolean | null）的三态选项：null = 跟随全局设置。 */
const TRI_STATE_OPTIONS = [
  { value: '', label: '跟随全局' },
  { value: 'true', label: '开' },
  { value: 'false', label: '关' },
]

const triValue = (v: boolean | null): string => (v === null ? '' : String(v))
const triFrom = (v: string): boolean | null => (v === '' ? null : v === 'true')

type FilterId = 'all' | 'on' | 'off' | 'constant'

function splitKeys(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function joinKeys(keys: string[]): string {
  return keys.join(', ')
}

function entryTitle(entry: WorldInfoEntry): string {
  const comment = entry.comment.trim()
  if (comment) return comment
  if (entry.keys.length > 0) return entry.keys.slice(0, 3).join(', ')
  return '未命名条目'
}

function entrySub(entry: WorldInfoEntry): string {
  const bits: string[] = []
  if (entry.keys.length > 0) bits.push(entry.keys.slice(0, 4).join(', '))
  bits.push(`顺序 ${entry.order}`)
  if (entry.constant) bits.push('常驻')
  if (entry.group.trim()) bits.push(`组 ${entry.group.trim()}`)
  return bits.join('  ·  ')
}

function newUid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function newEntry(source: WISource, sourceRef: string): WorldInfoEntry {
  const uid = newUid()
  return {
    key: `${source}:${sourceRef}:${uid}`,
    uid,
    source,
    sourceRef,
    keys: [],
    secondaryKeys: [],
    selective: false,
    selectiveLogic: 0,
    comment: '',
    content: '',
    constant: false,
    enabled: true,
    order: 100,
    position: 0,
    depth: 4,
    role: 0,
    outletName: '',
    probability: 100,
    useProbability: true,
    caseSensitive: null,
    matchWholeWords: null,
    scanDepth: null,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    ignoreBudget: false,
    group: '',
    groupWeight: 100,
    groupOverride: false,
    automationId: '',
  }
}

export type LorebookTarget =
  | { kind: 'library'; name: string }
  | { kind: 'character'; cardId: string; name: string }
  | { kind: 'chat'; cardId: string; name: string }

function sourceOf(target: LorebookTarget): { source: WISource; sourceRef: string } {
  if (target.kind === 'library') return { source: 'global', sourceRef: target.name }
  if (target.kind === 'chat') return { source: 'chat', sourceRef: 'chat-lorebook' }
  return { source: 'character', sourceRef: target.cardId }
}

function targetKindLabel(kind: LorebookTarget['kind']): string {
  if (kind === 'character') return '角色卡内嵌'
  if (kind === 'chat') return '本会话世界书'
  return '世界书库'
}

export function LorebookEditor(props: {
  target: LorebookTarget
  entries: WorldInfoEntry[]
  onClose: () => void
  onSaved: () => void
  save: (json: unknown) => Promise<Envelope<unknown>>
}) {
  const { target } = props
  const { source, sourceRef } = sourceOf(target)
  const [entries, setEntries] = useState<WorldInfoEntry[]>(() => props.entries.map((e) => ({ ...e })))
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterId>('all')
  const [page, setPage] = useState(0)
  const [openUid, setOpenUid] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<string | null>(null)
  const [leaveConfirm, setLeaveConfirm] = useState(false)

  const mark = (next: WorldInfoEntry[]) => {
    setEntries(next)
    setDirty(true)
  }

  const patch = (uid: string, partial: Partial<WorldInfoEntry>) => {
    mark(entries.map((e) => (e.uid === uid ? { ...e, ...partial } : e)))
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (filter === 'on' && !e.enabled) return false
      if (filter === 'off' && e.enabled) return false
      if (filter === 'constant' && !e.constant) return false
      if (!q) return true
      const hay = `${e.comment}\n${e.keys.join(' ')}\n${e.secondaryKeys.join(' ')}\n${e.content.slice(0, 400)}`.toLowerCase()
      return hay.includes(q)
    })
  }, [entries, filter, query])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)
  const enabledCount = entries.filter((e) => e.enabled).length
  const constantCount = entries.filter((e) => e.constant).length

  const save = async () => {
    setBusy(true)
    setError(null)
    const json =
      target.kind === 'character'
        ? { name: target.name, ...(exportLorebook(entries, target.name) as object) }
        : exportLorebook(entries, target.name)
    const r = await props.save(json)
    setBusy(false)
    const err = errOf(r)
    if (err) setError(err)
    else {
      setDirty(false)
      props.onSaved()
    }
  }

  const addEntry = () => {
    const created = newEntry(source, sourceRef)
    mark([created, ...entries])
    setFilter('all')
    setQuery('')
    setPage(0)
    setOpenUid(created.uid)
    setAdvanced(false)
  }

  const applyFilterEnabled = (enabled: boolean) => {
    const ids = new Set(filtered.map((e) => e.uid))
    mark(entries.map((e) => (ids.has(e.uid) ? { ...e, enabled } : e)))
  }

  const removeEntry = () => {
    if (!toDelete) return
    mark(entries.filter((e) => e.uid !== toDelete))
    if (openUid === toDelete) setOpenUid(null)
    setToDelete(null)
  }

  const askClose = () => {
    if (dirty) setLeaveConfirm(true)
    else props.onClose()
  }

  return (
    <div>
      <div className="dsh-tavern-toolbar">
        <Btn size="md" onClick={askClose}>
          {target.kind === 'chat' ? '关闭' : '返回列表'}
        </Btn>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="dsh-tavern-cardName" style={{ fontSize: 15 }}>
            {target.name}
          </div>
          <Muted>
            {targetKindLabel(target.kind)} · {entries.length} 条 · 启用 {enabledCount}
            {constantCount > 0 ? ` · 常驻 ${constantCount}` : ''}
            {dirty ? ' · 未保存' : ''}
          </Muted>
        </div>
        <Btn size="md" onClick={addEntry}>
          新建条目
        </Btn>
        <Btn primary size="md" disabled={busy || !dirty} onClick={() => void save()}>
          保存
        </Btn>
      </div>
      <Err message={error} />

      <div className="dsh-tavern-search" style={{ margin: '8px 0' }}>
        <span className="dsh-tavern-searchIcon">
          <IconSearchOutline16 />
        </span>
        <input
          value={query}
          placeholder="搜索条目名、关键词或正文…"
          onChange={(e) => {
            setQuery(e.target.value)
            setPage(0)
          }}
        />
      </div>
      <div className="dsh-tavern-filters">
        {(
          [
            ['all', `全部 ${entries.length}`],
            ['on', `启用 ${enabledCount}`],
            ['off', `关闭 ${entries.length - enabledCount}`],
            ['constant', `常驻 ${constantCount}`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="dsh-tavern-chip"
            data-active={filter === id ? 'true' : 'false'}
            onClick={() => {
              setFilter(id)
              setPage(0)
            }}
          >
            {label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <Btn size="sm" onClick={() => applyFilterEnabled(true)} disabled={filtered.length === 0}>
          启用筛选结果
        </Btn>
        <Btn size="sm" onClick={() => applyFilterEnabled(false)} disabled={filtered.length === 0}>
          关闭筛选结果
        </Btn>
      </div>

      {filtered.length === 0 ? (
        <Muted>{entries.length === 0 ? '还没有条目，点「新建条目」开始。' : '没有匹配的条目。'}</Muted>
      ) : (
        <div className="dsh-tavern-list dsh-tavern-scroll">
          {pageItems.map((entry) => {
            const open = openUid === entry.uid
            return (
              <div key={entry.uid} className={`dsh-tavern-entry${open ? ' is-open' : ''}${entry.enabled ? '' : ' is-off'}`}>
                <div className="dsh-tavern-entryHead" onClick={() => setOpenUid(open ? null : entry.uid)}>
                  <Toggle
                    checked={entry.enabled}
                    title={entry.enabled ? '关闭此条目' : '启用此条目'}
                    onChange={(enabled) => patch(entry.uid, { enabled })}
                  />
                  <div className="dsh-tavern-entryMain">
                    <div className="dsh-tavern-entryTitle">{entryTitle(entry)}</div>
                    <div className="dsh-tavern-entrySub">{entrySub(entry)}</div>
                  </div>
                  <div className="dsh-tavern-entryBadges">
                    {entry.constant ? <Badge>常驻</Badge> : null}
                    {entry.keys.length > 0 ? <Badge>{entry.keys.length} 键</Badge> : <Badge>无关键词</Badge>}
                  </div>
                  <span className={`dsh-tavern-chevron${open ? ' is-open' : ''}`}>
                    <IconChevronDownOutline14 />
                  </span>
                </div>
                <div className={`dsh-tavern-collapse${open ? ' is-open' : ''}`}>
                  <div className="dsh-tavern-collapseInner">
                    <EntryForm
                      entry={entry}
                      advanced={advanced}
                      onAdvanced={setAdvanced}
                      onChange={(partial) => patch(entry.uid, partial)}
                      onDelete={() => setToDelete(entry.uid)}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {pageCount > 1 && (
        <div className="dsh-tavern-pager">
          <Btn size="sm" disabled={safePage <= 0} onClick={() => setPage(safePage - 1)}>
            上一页
          </Btn>
          <Muted>
            {safePage + 1} / {pageCount} 页（本页 {pageItems.length} 条）
          </Muted>
          <Btn size="sm" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>
            下一页
          </Btn>
        </div>
      )}

      <div className="dsh-tavern-stickyBar">
        <Btn size="md" onClick={addEntry}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <IconPlusOutline16 /> 新建条目
          </span>
        </Btn>
        <Btn primary size="md" disabled={busy || !dirty} onClick={() => void save()}>
          保存
        </Btn>
        <Btn size="md" onClick={askClose}>
          {dirty ? '放弃并返回' : '返回'}
        </Btn>
      </div>

      <ConfirmDialog
        open={toDelete !== null}
        title="删除这条世界书？"
        description="删除后需点「保存」才会写回文件。可先返回列表放弃更改。"
        confirmLabel="删除条目"
        danger
        onCancel={() => setToDelete(null)}
        onConfirm={removeEntry}
      />
      <ConfirmDialog
        open={leaveConfirm}
        title="放弃未保存的更改？"
        description="开关和编辑还没有写回世界书文件。"
        confirmLabel="放弃更改"
        danger
        onCancel={() => setLeaveConfirm(false)}
        onConfirm={() => {
          setLeaveConfirm(false)
          props.onClose()
        }}
      />
    </div>
  )
}

function EntryForm(props: {
  entry: WorldInfoEntry
  advanced: boolean
  onAdvanced: (v: boolean) => void
  onChange: (partial: Partial<WorldInfoEntry>) => void
  onDelete: () => void
}) {
  const { entry } = props
  const set = props.onChange
  return (
    <div className="dsh-tavern-entryBody" onClick={(e) => e.stopPropagation()}>
      <label className="dsh-tavern-field">
        <span className="dsh-tavern-fieldLabel">条目标题（comment）</span>
        <input
          className="dsh-tavern-input"
          style={{ width: '100%', height: 36, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }}
          value={entry.comment}
          placeholder="给自己看的名字，例如「主角身世」"
          onChange={(e) => set({ comment: e.target.value })}
        />
      </label>
      <label className="dsh-tavern-field">
        <span className="dsh-tavern-fieldLabel">关键词（逗号分隔）</span>
        <input
          className="dsh-tavern-input dsh-tavern-codeFont"
          style={{ width: '100%', height: 36, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }}
          value={joinKeys(entry.keys)}
          placeholder="命中这些词时注入"
          onChange={(e) => set({ keys: splitKeys(e.target.value) })}
        />
      </label>
      <label className="dsh-tavern-field">
        <span className="dsh-tavern-fieldLabel">内容</span>
        <textarea
          className="dsh-tavern-input dsh-tavern-textarea"
          style={{ minHeight: 120 }}
          value={entry.content}
          placeholder="写入提示词的正文"
          onChange={(e) => set({ content: e.target.value })}
        />
      </label>
      <div className="dsh-tavern-inlineChecks">
        <label>
          <Toggle checked={entry.constant} onChange={(constant) => set({ constant })} />
          常驻（不需关键词）
        </label>
        <label>
          <Toggle checked={entry.selective} onChange={(selective) => set({ selective })} />
          启用次级键
        </label>
        <label>
          <Toggle checked={entry.ignoreBudget} onChange={(ignoreBudget) => set({ ignoreBudget })} />
          忽略预算
        </label>
      </div>
      <div className="dsh-tavern-fieldRow">
        <label className="dsh-tavern-field">
          <span className="dsh-tavern-fieldLabel">插入位置</span>
          <Select
            size="md"
            value={String(entry.position)}
            onChange={(v) => set({ position: Number(v) as WIPosition })}
            options={POSITION_OPTIONS}
          />
        </label>
        <label className="dsh-tavern-field">
          <span className="dsh-tavern-fieldLabel">顺序 order</span>
          <NumInput value={entry.order} onChange={(order) => set({ order: Math.round(order) })} />
        </label>
        {entry.position === 4 || entry.position === 7 ? (
          <label className="dsh-tavern-field">
            <span className="dsh-tavern-fieldLabel">{entry.position === 7 ? 'Outlet 名' : '深度 depth'}</span>
            {entry.position === 7 ? (
              <input
                className="dsh-tavern-input"
                style={{ width: '100%', height: 36, padding: '0 10px', boxSizing: 'border-box' }}
                value={entry.outletName}
                onChange={(e) => set({ outletName: e.target.value })}
              />
            ) : (
              <NumInput value={entry.depth} onChange={(depth) => set({ depth: Math.max(0, Math.round(depth)) })} />
            )}
          </label>
        ) : null}
      </div>
      {entry.selective ? (
        <div className="dsh-tavern-fieldRow">
          <label className="dsh-tavern-field">
            <span className="dsh-tavern-fieldLabel">次级关键词</span>
            <input
              className="dsh-tavern-input dsh-tavern-codeFont"
              style={{ width: '100%', height: 36, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }}
              value={joinKeys(entry.secondaryKeys)}
              placeholder="与主关键词组合判定"
              onChange={(e) => set({ secondaryKeys: splitKeys(e.target.value) })}
            />
          </label>
          <label className="dsh-tavern-field">
            <span className="dsh-tavern-fieldLabel">次级键逻辑</span>
            <Select
              size="md"
              value={String(entry.selectiveLogic)}
              onChange={(v) => set({ selectiveLogic: Number(v) as WISelectiveLogic })}
              options={LOGIC_OPTIONS}
            />
          </label>
        </div>
      ) : null}

      <Btn size="sm" onClick={() => props.onAdvanced(!props.advanced)}>
        {props.advanced ? '收起更多选项' : '更多选项（匹配 / 概率 / 递归 / 定时 / 分组）'}
      </Btn>
      {props.advanced ? (
        <>
          <div className="dsh-tavern-fieldRow">
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">概率</span>
              <NumInput value={entry.probability} onChange={(probability) => set({ probability })} />
            </label>
            <label className="dsh-tavern-inlineChecks" style={{ paddingTop: 22 }}>
              <span>
                <Toggle checked={entry.useProbability} onChange={(useProbability) => set({ useProbability })} /> 启用概率
              </span>
            </label>
            {entry.position === 4 ? (
              <label className="dsh-tavern-field">
                <span className="dsh-tavern-fieldLabel">@D 角色</span>
                <Select
                  size="md"
                  value={String(entry.role)}
                  onChange={(v) => set({ role: Number(v) as WIRole })}
                  options={ROLE_OPTIONS}
                />
              </label>
            ) : null}
          </div>
          <div className="dsh-tavern-inlineChecks">
            <label>
              <Toggle checked={entry.excludeRecursion} onChange={(excludeRecursion) => set({ excludeRecursion })} />
              不可被递归激活
            </label>
            <label>
              <Toggle checked={entry.preventRecursion} onChange={(preventRecursion) => set({ preventRecursion })} />
              激活后停止递归
            </label>
          </div>
          <div className="dsh-tavern-fieldRow">
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">延迟到递归层</span>
              <NumInput
                value={entry.delayUntilRecursion}
                onChange={(delayUntilRecursion) => set({ delayUntilRecursion: Math.max(0, Math.round(delayUntilRecursion)) })}
              />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">sticky</span>
              <NullableNumInput value={entry.sticky} onChange={(sticky) => set({ sticky })} />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">cooldown</span>
              <NullableNumInput value={entry.cooldown} onChange={(cooldown) => set({ cooldown })} />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">delay</span>
              <NullableNumInput value={entry.delay} onChange={(delay) => set({ delay })} />
            </label>
          </div>
          <div className="dsh-tavern-fieldRow">
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">扫描深度（空=跟随全局）</span>
              <NullableNumInput value={entry.scanDepth} onChange={(scanDepth) => set({ scanDepth })} />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">区分大小写</span>
              <Select size="md" value={triValue(entry.caseSensitive)} onChange={(v) => set({ caseSensitive: triFrom(v) })} options={TRI_STATE_OPTIONS} />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">整词匹配</span>
              <Select size="md" value={triValue(entry.matchWholeWords)} onChange={(v) => set({ matchWholeWords: triFrom(v) })} options={TRI_STATE_OPTIONS} />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">分组</span>
              <input
                className="dsh-tavern-input"
                style={{ width: '100%', height: 36, padding: '0 10px', boxSizing: 'border-box' }}
                value={entry.group}
                onChange={(e) => set({ group: e.target.value })}
              />
            </label>
            <label className="dsh-tavern-field">
              <span className="dsh-tavern-fieldLabel">组权重</span>
              <NumInput value={entry.groupWeight} onChange={(groupWeight) => set({ groupWeight: Math.max(0, Math.round(groupWeight)) })} />
            </label>
          </div>
          <div className="dsh-tavern-inlineChecks">
            <label>
              <Toggle checked={entry.groupOverride} onChange={(groupOverride) => set({ groupOverride })} />
              组内优先（覆盖同组其它条目）
            </label>
          </div>
        </>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <IconBtn label="删除条目" danger onClick={props.onDelete}>
          <IconTrashOutline16 />
        </IconBtn>
      </div>
    </div>
  )
}
