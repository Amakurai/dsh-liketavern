/**
 * 共享 UI 工具：对齐 dsh 原语（Button / Menu / Modal / Tooltip / Toast）+ 加载 Hook + 文件/下载助手。
 * 样式集中在 ./styles.js（模块加载即注入）；颜色一律走宿主 --dsw-* 令牌 + Tavern 青碧 accent。
 * 原生 select 的 option 弹层用 Menu 实现（避开 Windows 系统白底白字）。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, IconChevronDownOutline14, IconSearchOutline16, IconUserOutline16, Menu, Modal, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactNode } from 'react'
import type { CardRegexScript } from '../core/types.js'
import { useT } from './i18n.js'
import type { Envelope } from './types.js'
import './styles.js'

export function Btn(props: {
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  primary?: boolean
  title?: string
  size?: 'sm' | 'md'
  children?: ReactNode
}) {
  return (
    <Button
      type="button"
      variant={props.primary ? 'primary' : 'outline'}
      size={props.size ?? 'sm'}
      disabled={props.disabled}
      title={props.title}
      onClick={(e: { stopPropagation: () => void }) => {
        e.stopPropagation()
        props.onClick()
      }}
      style={props.danger ? { color: 'var(--dsw-alias-state-error-primary, #ec1313)' } : undefined}
    >
      {props.children}
    </Button>
  )
}

const EMPTY_SELECT_ID = '__empty__'

export interface SelectOption {
  value: string
  label: string
}

/** 用 dsh Menu 实现的下拉（避开 Windows 原生 option 白底白字）；anchor 是通用设置的 36px 胶囊选择器。 */
export function Select(props: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  disabled?: boolean
  title?: string
  width?: number | string
  size?: 'sm' | 'md'
}) {
  const [open, setOpen] = useState(false)
  const selected = props.options.find((o) => o.value === props.value)
  const width = props.width ?? '100%'
  return (
    <div className="dsh-tavern-select" style={{ width }}>
      <Menu
        open={open}
        portal
        compact={props.size !== 'md'}
        align="start"
        selectedId={props.value === '' ? EMPTY_SELECT_ID : props.value}
        onClose={() => setOpen(false)}
        onSelect={(id: string) => {
          props.onChange(id === EMPTY_SELECT_ID ? '' : id)
          setOpen(false)
        }}
        anchor={
          <button
            type="button"
            className={`dsh-tavern-pillSelect${props.size === 'sm' ? ' is-sm' : ''}`}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={props.disabled}
            title={props.title}
            onClick={() => setOpen((v: boolean) => !v)}
          >
            <span className="dsh-tavern-pillSelectLabel">{selected?.label ?? props.value}</span>
            <IconChevronDownOutline14 className="dsh-tavern-pillSelectChevron" />
          </button>
        }
        items={props.options.map((o) => ({
          id: o.value === '' ? EMPTY_SELECT_ID : o.value,
          label: o.label,
        }))}
      />
    </div>
  )
}

export function FileBtn(props: {
  accept: string
  disabled?: boolean
  onFile: (file: File) => void
  children?: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="md"
      disabled={props.disabled}
      className="dsh-tavern-file"
      onClick={() => {
        const el = document.createElement('input')
        el.type = 'file'
        el.accept = props.accept
        el.onchange = () => {
          const file = el.files?.[0]
          if (file) props.onFile(file)
        }
        el.click()
      }}
    >
      {props.children}
    </Button>
  )
}

export function Section(props: { title?: string; description?: string; children?: ReactNode }) {
  return (
    <section className="dsh-tavern-section">
      {props.title || props.description ? (
        <header className="dsh-tavern-pageHead">
          {props.title ? <h3 className="dsh-tavern-pageTitle">{props.title}</h3> : null}
          {props.description ? <p className="dsh-tavern-pageIntro">{props.description}</p> : null}
        </header>
      ) : null}
      {props.children}
    </section>
  )
}

export interface TabItem {
  id: string
  label: string
}

/** 分段控件式页签（pill track，区别于宿主通用设置的下划线页签）；size="sm" 用于页内第二级导航。 */
export function Tabs(props: { items: TabItem[]; value: string; onChange: (id: string) => void; size?: 'md' | 'sm' }) {
  return (
    <div className={`dsh-tavern-navPills${props.size === 'sm' ? ' is-sub' : ''}`} role="tablist">
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          className="dsh-tavern-navPill"
          data-active={props.value === item.id ? 'true' : 'false'}
          aria-selected={props.value === item.id}
          onClick={() => props.onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/** 分组保存行：与上方表单一条淡分隔，主操作左齐。 */
export function SaveBar(props: { children?: ReactNode }) {
  return <div className="dsh-tavern-saveBar">{props.children}</div>
}

export function Badge(props: { accent?: boolean; danger?: boolean; children?: ReactNode }) {
  const cls = props.accent ? ' is-accent' : props.danger ? ' is-danger' : ''
  return <span className={`dsh-tavern-badge${cls}`}>{props.children}</span>
}

/**
 * 预设/卡内嵌 regex_scripts 的展示行：开关 + 名称 + 作用域徽标 + 查找式。
 * 作用域语义与 core/regex.ts 的 compileRegexScripts 一致；onToggle 传入时显示启用开关。
 */
export function RegexScriptRow(props: { script: CardRegexScript; index: number; onToggle?: (disabled: boolean) => void }) {
  const { script } = props
  const t = useT()
  const badges: string[] = []
  if (script.markdownOnly && script.promptOnly) badges.push(t('util.regexScope.displayAndPrompt'))
  else if (script.markdownOnly) badges.push(t('util.regexScope.displayOnly'))
  else if (script.promptOnly) badges.push(t('util.regexScope.promptOnly'))
  else {
    for (const p of script.placement ?? [2]) {
      if (p === 1) badges.push(t('util.regexScope.userInput'))
      else if (p === 2) badges.push(t('util.regexScope.aiOutput'))
      else if (p === 5) badges.push(t('util.regexScope.worldInfo'))
    }
  }
  const find = script.findRegex ?? ''
  const enabled = script.disabled !== true
  return (
    <div className="dsh-tavern-memo">
      <div className="dsh-tavern-memoHead">
        {props.onToggle ? (
          <Toggle checked={enabled} onChange={(on) => props.onToggle!(!on)} title={enabled ? t('util.regex.disable') : t('util.regex.enable')} />
        ) : null}
        <span className="dsh-tavern-memoMeta" style={{ color: 'var(--dsw-alias-label-primary, inherit)', fontWeight: 500 }}>
          {script.scriptName?.trim() || t('util.regex.unnamed', { index: props.index + 1 })}
        </span>
        {badges.map((label) => (
          <Badge key={label}>{label}</Badge>
        ))}
      </div>
      <div
        className="dsh-tavern-codeFont"
        title={find}
        style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary, inherit)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {find || t('util.regex.noFind')}
      </div>
    </div>
  )
}

/** 条目启用开关（对齐 SillyTavern 的 on/off，视觉走 dsh 胶囊）。 */
export function Toggle(props: {
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      className={`dsh-tavern-toggle${props.checked ? ' is-on' : ''}`}
      disabled={props.disabled}
      title={props.title}
      onClick={(e) => {
        e.stopPropagation()
        props.onChange(!props.checked)
      }}
    />
  )
}

export function IconBtn(props: {
  label: string
  danger?: boolean
  disabled?: boolean
  onClick: () => void
  children?: ReactNode
}) {
  return (
    <Tooltip label={props.label} side="bottom">
      <button
        type="button"
        aria-label={props.label}
        className={`dsh-tavern-iconBtn${props.danger ? ' is-danger' : ''}`}
        disabled={props.disabled}
        onClick={(e) => {
          e.stopPropagation()
          props.onClick()
        }}
      >
        {props.children}
      </button>
    </Tooltip>
  )
}

/** 对齐通用设置：标题 + 说明 + 右侧控件。stacked = 宽控件（checkbox 列表等）换成纵向满宽。inline 已废弃（现在默认就是行式）。 */
export function SettingsRow(props: { title: string; description?: string; stacked?: boolean; inline?: boolean; children?: ReactNode }) {
  return (
    <div className={`dsh-tavern-row${props.stacked ? ' is-stacked' : ''}`}>
      <div className="dsh-tavern-rowText">
        <div className="dsh-tavern-rowTitle">{props.title}</div>
        {props.description ? <div className="dsh-tavern-rowDesc">{props.description}</div> : null}
      </div>
      <div className="dsh-tavern-rowControl">{props.children}</div>
    </div>
  )
}

export function Field(props: { label: string; children?: ReactNode }) {
  return (
    <div className="dsh-tavern-field">
      <span className="dsh-tavern-fieldLabel">{props.label}</span>
      {props.children}
    </div>
  )
}

/** 列表搜索框（36px 胶囊 + 前导图标），配合面板里的关键字过滤。 */
export function SearchInput(props: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  width?: number | string
}) {
  const t = useT()
  return (
    <div className="dsh-tavern-search" role="search" style={{ width: props.width ?? 220 }}>
      <span className="dsh-tavern-searchIcon">
        <IconSearchOutline16 />
      </span>
      <input
        type="text"
        aria-label={props.label}
        placeholder={props.placeholder ?? t('common.searchPlaceholder')}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </div>
  )
}

/** 列表搜索的空结果态：与各面板空态同一套样式，附「清空搜索」动作。 */
export function SearchEmpty(props: { what: string; query: string; onClear: () => void }) {
  const t = useT()
  return (
    <div className="dsh-tavern-empty">
      <div className="dsh-tavern-emptyTitle">{t('common.noMatch', { what: props.what })}</div>
      <div className="dsh-tavern-emptyDesc">
        {t('common.noMatchDesc', { query: props.query })}
        <button type="button" className="dsh-tavern-linkBtn" onClick={props.onClear}>
          {t('action.clearSearch')}
        </button>
      </div>
    </div>
  )
}

/** 多选 chip 组（替代复选框列表）：点击把选项切进/切出 selected，选中带对勾前缀。 */
export function CheckChips(props: {
  options: { value: string; label: string }[]
  selected: readonly string[]
  onChange: (next: string[]) => void
  ariaLabel?: string
}) {
  return (
    <div className="dsh-tavern-filters" role="group" aria-label={props.ariaLabel}>
      {props.options.map((o) => {
        const on = props.selected.includes(o.value)
        return (
          <button
            key={o.value}
            type="button"
            className="dsh-tavern-chip is-check"
            data-active={on ? 'true' : 'false'}
            aria-pressed={on}
            onClick={() => props.onChange(on ? props.selected.filter((v) => v !== o.value) : [...props.selected, o.value])}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Err(props: { message: string | null }) {
  if (!props.message) return null
  return <div className="dsh-tavern-errText">{props.message}</div>
}

export function Muted(props: { children?: ReactNode }) {
  return <span className="dsh-tavern-muted">{props.children}</span>
}

/** 头像：有图出图，无图出首字符（小尺寸回退为用户图标），不再是灰块。尺寸经 --tavern-avatar-s 传入。 */
export function Avatar(props: { url?: string | null; name?: string; size?: number; className?: string }) {
  const size = props.size ?? 40
  const style = { '--tavern-avatar-s': `${size}px` } as CSSProperties
  const cls = `dsh-tavern-avatar${props.className ? ` ${props.className}` : ''}`
  if (props.url) {
    return (
      <span className={cls} style={style}>
        <img src={props.url} alt="" />
      </span>
    )
  }
  const initial = (props.name ?? '').trim().charAt(0)
  if (initial && size >= 24) {
    return (
      <span className={cls} style={style}>
        {initial}
      </span>
    )
  }
  return (
    <span className={cls} style={style}>
      <IconUserOutline16 size={Math.max(12, Math.round(size * 0.6))} />
    </span>
  )
}

/** shimmer 骨架条/块，替换「加载中…」。 */
export function Skeleton(props: { width?: number | string; height?: number; radius?: number; style?: CSSProperties }) {
  return (
    <div
      className="dsh-tavern-skeleton"
      style={{ width: props.width ?? '100%', height: props.height ?? 14, borderRadius: props.radius, ...props.style }}
    />
  )
}

/** 顶部横幅通知（宿主 Toast：滑入→停留→淡出后 onDone）。瞬时操作反馈用它，上下文错误仍用 Err。 */
export function useToast() {
  const [item, setItem] = useState<{ key: number; text: string } | null>(null)
  const show = useCallback((text: string) => setItem({ key: Date.now(), text }), [])
  const node = item ? <Toast key={item.key} text={item.text} onDone={() => setItem(null)} /> : null
  return { show, node }
}

/** 让卡片等元素可键盘触发（Enter/Space），配合 .is-clickable。 */
export function clickableProps(onClick: () => void) {
  return {
    role: 'button',
    tabIndex: 0,
    onClick,
    onKeyDown: (e: { key: string; preventDefault: () => void }) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onClick()
      }
    },
  }
}

type LoadState<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; message: string }

/** 拉取一个 remote 读取；reload() 触发重拉；enabled=false 时挂起（idle）。 */
export function useLoader<T>(load: () => Promise<Envelope<T>>, deps: readonly unknown[] = [], enabled = true) {
  const [state, setState] = useState<LoadState<T>>(enabled ? { status: 'loading' } : { status: 'idle' })
  const [seq, setSeq] = useState(0)
  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle' })
      return
    }
    let alive = true
    setState({ status: 'loading' })
    load()
      .then((r) => {
        if (alive) setState(r.ok ? { status: 'ready', value: r.value } : { status: 'error', message: r.error.message })
      })
      .catch((e) => {
        if (alive) setState({ status: 'error', message: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, seq, enabled])
  return { state, reload: () => setSeq((s) => s + 1) }
}

/** 信封 → 错误消息（ok 时返回 null）。 */
export function errOf(r: Envelope<unknown>): string | null {
  return r.ok ? null : r.error.message
}

/**
 * 面板写操作的统一外壳：置 busy → 清旧错 → 跑 fn，成功失败都在 finally 解锁。
 * typert 在传输失败和入参 zod 严格校验不过时是 reject，不是错误信封，
 * 而按钮上的 `onClick={() => void save()}` 会把这个 reject 吞掉；
 * 传输层 reject 也必须解锁按钮，否则 busy 永远为 true、保存按钮再也点不动，草稿全丢。
 */
export async function runAsync(
  setBusy: (busy: boolean) => void,
  setError: (message: string | null) => void,
  fn: () => Promise<void>,
): Promise<void> {
  setBusy(true)
  setError(null)
  try {
    await fn()
  } catch (e) {
    setError(e instanceof Error ? e.message : String(e))
  } finally {
    setBusy(false)
  }
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export async function readJsonFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text()) as unknown
}

export function downloadJson(filename: string, json: unknown): void {
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadBase64(filename: string, base64: string, mime: string): void {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** primitives Modal 的薄封装（统一关闭文案）；width 档：sm 380（默认）/ md 480 / lg 680 / xl 880。 */
export function Dialog(props: {
  open: boolean
  title: string
  description?: string
  onClose: () => void
  footer?: ReactNode
  width?: 'sm' | 'md' | 'lg' | 'xl'
  children?: ReactNode
}) {
  const t = useT()
  // Modal 的 dialog 本体不限高，超高内容会把整个弹窗顶出视口。
  // 滚动区放在 content 层（Modal 注释里指定的 scrollable content region）并钉死
  // max-height，保证任何视口高度下弹窗底部都不被裁。
  const widthClass =
    props.width === 'md'
      ? 'dsh-tavern-modal-md'
      : props.width === 'lg'
        ? 'dsh-tavern-modal-lg'
        : props.width === 'xl'
          ? 'dsh-tavern-modal-xl'
          : ''
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      description={props.description}
      closeLabel={t('action.close')}
      footer={props.footer}
      contentClassName={`dsh-tavern-modalContent${widthClass ? ` ${widthClass}` : ''}`}
    >
      <div className="dsh-tavern-ui dsh-tavern-modalBody">{props.children}</div>
    </Modal>
  )
}

export function ConfirmDialog(props: {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  danger?: boolean
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useT()
  return (
    <Modal
      open={props.open}
      onClose={props.onCancel}
      title={props.title}
      description={props.description}
      closeLabel={t('action.cancel')}
      footer={
        <div className="dsh-tavern-modalActions">
          <Button type="button" variant="outline" size="md" disabled={props.busy} onClick={props.onCancel}>
            {t('action.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            disabled={props.busy}
            onClick={props.onConfirm}
            style={props.danger ? { background: 'var(--dsw-alias-state-error-primary, #ec1313)', borderColor: 'transparent' } : undefined}
          >
            {props.confirmLabel ?? t('action.confirm')}
          </Button>
        </div>
      }
    />
  )
}

/** 数字输入（number）。 */
export function NumInput(props: { value: number; onChange: (v: number) => void; step?: string; width?: number }) {
  return (
    <input
      type="number"
      className="dsh-tavern-input"
      style={{ width: props.width ?? 90 }}
      value={Number.isFinite(props.value) ? props.value : 0}
      step={props.step ?? 'any'}
      onChange={(e) => {
        const v = Number(e.target.value)
        if (Number.isFinite(v)) props.onChange(v)
      }}
    />
  )
}

/** 可空数字输入（null ↔ 空串）。 */
export function NullableNumInput(props: { value: number | null; onChange: (v: number | null) => void; width?: number }) {
  const t = useT()
  return (
    <input
      type="number"
      className="dsh-tavern-input"
      style={{ width: props.width ?? 90 }}
      value={props.value ?? ''}
      placeholder={t('common.unlimited')}
      onChange={(e) => {
        const raw = e.target.value
        if (raw === '') return props.onChange(null)
        const v = Number(raw)
        if (Number.isFinite(v)) props.onChange(v)
      }}
    />
  )
}
