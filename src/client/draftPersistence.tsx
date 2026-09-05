/** 编辑器自动草稿：内容只经 remote 存在宿主数据目录；浏览器只保留本标签页的随机标识。 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { TavernRemote } from './types.js'
import { useT } from './i18n.js'
import { Btn, Err, Skeleton } from './util.js'

type Fields = Record<string, unknown>
type Snapshot = { version: 1; fields: Fields }
type Status = { dirty: boolean; busy: boolean }
type WriteState = 'idle' | 'restored' | 'saving' | 'saved' | 'error'
interface DraftRegistry {
  restored: Fields
  field(key: string, token: object, value: unknown): void
  remove(key: string, token: object): void
  report(id: string, status: Status | null): void
  discard(): void
}
const PersistenceContext = createContext<DraftRegistry | null>(null)
const queues = new Map<string, Promise<unknown>>()
let fallbackOwner: string | undefined

function ownerId(): string {
  try {
    const key = 'dsh-tavern-editor-owner'
    const existing = window.sessionStorage.getItem(key)
    if (existing && /^[a-zA-Z0-9_-]{8,80}$/.test(existing)) return existing
    const owner = crypto.randomUUID()
    window.sessionStorage.setItem(key, owner)
    return owner
  } catch {
    // 禁用浏览器存储时仍可在当前页面暂存；不会把用户内容放进本地存储。
    return fallbackOwner ??= crypto.randomUUID()
  }
}

/** 同一页面在关闭后立即重开，先完成上一实例的写入，再读取草稿。 */
function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  queues.set(key, next)
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key) }).catch(() => {})
  return next
}

function readSnapshot(value: unknown): Snapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid editor draft')
  const draft = value as Partial<Snapshot>
  if (draft.version !== 1 || !draft.fields || typeof draft.fields !== 'object' || Array.isArray(draft.fields)) throw new Error('Unsupported editor draft')
  return { version: 1, fields: draft.fields }
}

/** 分区独立入口可复用；设置面板内的分区共用父级快照，保留页签与所选角色/剧情。 */
export function PersistentEditor(props: { remote?: TavernRemote; scope: string; children: ReactNode }) {
  const parent = useContext(PersistenceContext)
  // 未安装 remote 的隔离渲染环境仍保留普通编辑能力。
  if (parent || !props.remote?.getEditorDraft) return <>{props.children}</>
  return <DraftLoader key={props.scope} remote={props.remote} scope={props.scope}>{props.children}</DraftLoader>
}

function DraftLoader(props: { remote: TavernRemote; scope: string; children: ReactNode }) {
  const t = useT()
  const [owner] = useState(ownerId)
  const [attempt, retry] = useState(0)
  const [loaded, setLoaded] = useState<{ snapshot: Snapshot | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const queueKey = `${owner}:${props.scope}`
  useEffect(() => {
    let cancelled = false
    setError(null)
    void enqueue(queueKey, () => props.remote.getEditorDraft({ owner, key: props.scope })).then((result) => {
      if (cancelled) return
      if (!result.ok) throw new Error(result.error.message)
      setLoaded({ snapshot: result.value.draft ? readSnapshot(result.value.draft.value) : null })
    }).catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true }
  }, [props.remote, props.scope, queueKey, owner, attempt])
  if (error) return <div className="dsh-tavern-ui"><Err message={`${t('draft.loadFailed')} ${error}`} /><Btn onClick={() => retry((n) => n + 1)}>{t('action.retry')}</Btn></div>
  if (!loaded) return <Skeleton />
  return <DraftSession remote={props.remote} scope={props.scope} owner={owner} snapshot={loaded.snapshot}>{props.children}</DraftSession>
}

function DraftSession(props: { remote: TavernRemote; scope: string; owner: string; snapshot: Snapshot | null; children: ReactNode }) {
  const t = useT()
  const [writeState, setWriteState] = useState<WriteState>(props.snapshot ? 'restored' : 'idle')
  const [error, setError] = useState<string | null>(null)
  const [session] = useState(() => {
    const fields = new Map<string, { token: object; value: unknown }>()
    const statuses = new Map<string, Status>()
    const restored = { ...props.snapshot?.fields }
    let timer: ReturnType<typeof setTimeout> | undefined
    let mounted = true
    let seenDirty = false
    let last: Snapshot | null | undefined = props.snapshot ?? undefined
    let revision = 0
    let persisted = JSON.stringify(last)
    let pendingWrites = 0
    const queueKey = `${props.owner}:${props.scope}`
    const capture = () => {
      const dirty = [...statuses.values()].some((s) => s.dirty)
      const busy = [...statuses.values()].some((s) => s.busy)
      if (dirty) {
        seenDirty = true
        // JSON 归一化去掉可选 undefined；后端再次做大小、结构和污染键校验。
        last = JSON.parse(JSON.stringify({ version: 1, fields: Object.fromEntries([...fields].map(([key, f]) => [key, f.value])) })) as Snapshot
      } else if (seenDirty && !busy) last = null
    }
    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      if (last === undefined) return
      const serialized = JSON.stringify(last)
      if (serialized === persisted && pendingWrites === 0) return
      const snapshot = last
      const current = ++revision
      pendingWrites++
      if (mounted) { setWriteState('saving'); setError(null) }
      void enqueue(queueKey, async () => {
        const result = snapshot
          ? await props.remote.saveEditorDraft({ owner: props.owner, key: props.scope, value: snapshot })
          : await props.remote.deleteEditorDraft({ owner: props.owner, key: props.scope })
        if (!result.ok) throw new Error(result.error.message)
        persisted = serialized
        if (mounted && current === revision) setWriteState(snapshot ? 'saved' : 'idle')
      }).catch((cause: unknown) => {
        if (mounted && current === revision) { setWriteState('error'); setError(cause instanceof Error ? cause.message : String(cause)) }
      }).finally(() => { pendingWrites-- })
    }
    const schedule = () => {
      if (!mounted) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { capture(); flush() }, 500)
    }
    const registry: DraftRegistry = {
      restored,
      field(key, token, value) {
        fields.set(key, { token, value })
        delete restored[key]
        capture()
        schedule()
      },
      remove(key, token) { if (fields.get(key)?.token === token) fields.delete(key); schedule() },
      report(id, status) {
        if (status) { statuses.set(id, status); capture() }
        else statuses.delete(id)
        schedule()
      },
      discard() {
        for (const key of Object.keys(restored)) delete restored[key]
        last = null
        seenDirty = false
        flush()
      },
    }
    return { registry, flush, start() { mounted = true }, stop() { mounted = false; flush() } }
  })
  useEffect(() => {
    session.start()
    const flush = () => session.flush()
    if (typeof window !== 'undefined') window.addEventListener('pagehide', flush)
    return () => { if (typeof window !== 'undefined') window.removeEventListener('pagehide', flush); session.stop() }
  }, [session])
  return <PersistenceContext.Provider value={session.registry}>
    {writeState !== 'idle' && <div className="dsh-tavern-ui dsh-tavern-draftStatus" role="status">
      <span>{t(writeState === 'restored' ? 'draft.restored' : writeState === 'saving' ? 'draft.autosaving' : writeState === 'error' ? 'draft.autosaveFailed' : 'draft.autosaved')}</span>
      {error && <><Err message={error} /><Btn onClick={session.flush}>{t('action.retry')}</Btn></>}
    </div>}
    {props.children}
  </PersistenceContext.Provider>
}

/** 可动态切换字段键；切换角色/剧情时不会带入上一对象的 React state。 */
export function useDraftState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const registry = useContext(PersistenceContext)
  const initialRef = useRef(initial)
  initialRef.current = initial
  const resolve = () => Object.hasOwn(registry?.restored ?? {}, key)
    ? registry!.restored[key] as T
    : typeof initialRef.current === 'function' ? (initialRef.current as () => T)() : initialRef.current
  const [state, setState] = useState(() => ({ key, value: resolve() }))
  let value = state.value
  if (state.key !== key) { value = resolve(); setState({ key, value }) }
  const token = useRef({})
  useLayoutEffect(() => {
    registry?.field(key, token.current, value)
    return () => registry?.remove(key, token.current)
  }, [registry, key, value])
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setState((current) => ({ key, value: typeof next === 'function' ? (next as (value: T) => T)(current.value) : next }))
  }, [key])
  return [value, setValue]
}

/** 恢复标志固定在当前实例；异步资产加载只在第一次跳过草稿，保存后的刷新正常回填。 */
export function useDraftRestored(key: string): boolean {
  const registry = useContext(PersistenceContext)
  const [restored] = useState(() => Object.hasOwn(registry?.restored ?? {}, key))
  return restored
}

export function usePersistentDraftStatus(id: string, dirty: boolean, busy: boolean): (() => void) | undefined {
  const registry = useContext(PersistenceContext)
  useEffect(() => {
    registry?.report(id, { dirty, busy })
    return () => registry?.report(id, null)
  }, [registry, id, dirty, busy])
  return registry?.discard
}
