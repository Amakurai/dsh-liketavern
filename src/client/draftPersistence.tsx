/** 编辑器自动草稿：宿主持久化与本页有界未确认恢复；浏览器持久存储只保存本标签页标识。 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import type { TavernRemote } from './types.js'
import { useT } from './i18n.js'
import { Btn, ConfirmDialog, Err, Skeleton, useLoader } from './util.js'
import { randomUuid } from '../core/secureRandom.js'
import { remoteIdentity } from './remoteIdentity.js'
import { acquireDraftRecovery, confirmDraftRecovery, DRAFT_RECOVERY_SCOPE_LIMIT, DraftRecoveryTooLargeError,
  failDraftRecovery, releaseDraftRecovery, restorePreviousDraftRecovery, stageDraftRecovery, unavailableDraftRecovery,
  type DraftRecoveryChannel, type DraftRecoveryRecord } from './draftRecovery.js'

type Fields = Record<string, unknown>
type Snapshot = { version: 1; fields: Fields }
type LoadedDraft = { channel: DraftRecoveryChannel; snapshot: Snapshot | null; recovery?: DraftRecoveryRecord }
type PendingWrite = { snapshot: Snapshot | null; serialized: string; revision: number; recovery: DraftRecoveryRecord }
type Status = { dirty: boolean; busy: boolean }
type WriteState = 'idle' | 'restored' | 'local' | 'saving' | 'saved' | 'error'
interface DraftRegistry {
  remote: TavernRemote
  restored: Fields
  field(key: string, token: object, value: unknown): void
  remove(key: string, token: object): void
  report(id: string, status: Status | null): void
  discard(id?: string): void
}
const PersistenceContext = createContext<DraftRegistry | null>(null)
const remotes = new WeakMap<TavernRemote, { id: number; queues: Map<string, Promise<unknown>> }>()
let fallbackOwner: string | undefined

/** remote 决定宿主身份；相同浏览器标识与面板名不能让不同宿主共享快照或飞行请求。 */
function draftRemote(remote: TavernRemote) {
  let value = remotes.get(remote)
  if (!value) { value = { id: remoteIdentity(remote), queues: new Map() }; remotes.set(remote, value) }
  return value
}

function ownerId(): string {
  try {
    const key = 'dsh-tavern-editor-owner'
    const existing = window.sessionStorage.getItem(key)
    if (existing && /^[a-zA-Z0-9_-]{8,80}$/.test(existing)) return existing
    const owner = randomUuid()
    window.sessionStorage.setItem(key, owner)
    return owner
  } catch {
    // 禁用浏览器存储时仍可在当前页面暂存；不会把用户内容放进本地存储。
    return fallbackOwner ??= randomUuid()
  }
}

/** 写入与删除跨编辑器实例串行，保留关闭后立即重开的最终写入顺序。 */
function enqueue<T>(remote: TavernRemote, key: string, operation: () => Promise<T>): Promise<T> {
  const queues = draftRemote(remote).queues
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  queues.set(key, next)
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key) }).catch(() => {})
  return next
}

/** 读取等待此前的写入，但不占写队列；已挂起的只读请求不能挡住超时后的重试。 */
function readAfterWrites<T>(remote: TavernRemote, key: string, operation: () => Promise<T>): Promise<T> {
  return (draftRemote(remote).queues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation)
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
  if (parent && (!props.remote || parent.remote === props.remote)) return <>{props.children}</>
  // 未安装 remote 的隔离渲染环境仍保留普通编辑能力。
  if (!props.remote?.getEditorDraft) return <PersistenceContext.Provider value={null}>{props.children}</PersistenceContext.Provider>
  return <DraftLoader key={JSON.stringify([draftRemote(props.remote).id, props.scope])} remote={props.remote} scope={props.scope}>{props.children}</DraftLoader>
}

function DraftLoader(props: { remote: TavernRemote; scope: string; children: ReactNode }) {
  const t = useT()
  const [owner] = useState(ownerId)
  const queueKey = `${owner}:${props.scope}`
  const holder = useRef({}), channelRef = useRef<DraftRecoveryChannel | null>(null), alive = useRef(false)
  const [restoreConfirmation, setRestoreConfirmation] = useState(false)
  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (channelRef.current) releaseDraftRecovery(props.remote, queueKey, channelRef.current, holder.current)
    }
  }, [props.remote, queueKey])
  const loaded = useLoader<LoadedDraft>(async () => {
    if (!alive.current) throw new Error('Editor is closed')
    const channel = channelRef.current ?? acquireDraftRecovery(props.remote, queueKey, holder.current)
    if (!channel) throw new Error(t('draft.recoveryCapacity', { count: DRAFT_RECOVERY_SCOPE_LIMIT }))
    channelRef.current = channel
    const local = () => {
      const recovery = channel.pending
      if (!recovery) return null
      const snapshot = recovery.unavailable ? null : readSnapshotOrNull(recovery.serialized)
      return { ok: true as const, value: { channel, snapshot, recovery } }
    }
    // 同分区的另一编辑器可能在读取途中保存并确认，清掉 pending；仍须用代数拒绝旧回包。
    // 只自动重读一次，持续并发修改时明确重试，不产生无界读取循环。
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!alive.current) throw new Error('Editor is closed')
      const result = await readAfterWrites(props.remote, queueKey, async () => {
        const pending = local()
        if (pending) return pending
        const generation = channel.generation
        try {
          const result = await props.remote.getEditorDraft({ owner, key: props.scope })
          const latest = local()
          if (latest) return latest
          if (channel.generation !== generation) return null
          if (!result.ok) return result
          return { ok: true as const, value: { channel, snapshot: result.value.draft ? readSnapshot(result.value.draft.value) : null, recovery: undefined } }
        } catch (cause) {
          const latest = local()
          if (latest) return latest
          if (channel.generation !== generation) return null
          throw cause
        }
      })
      if (result) return result
    }
    throw new Error(t('draft.loadChanged'))
  }, [props.remote, props.scope, owner])
  if (loaded.state.status === 'error') return <div className="dsh-tavern-ui"><Err message={`${t('draft.loadFailed')} ${loaded.state.message}`} /><Btn onClick={loaded.reload}>{t('action.retry')}</Btn></div>
  if (loaded.state.status !== 'ready') return <Skeleton />
  const value = loaded.state.value
  if (value.recovery?.unavailable) return <div className="dsh-tavern-ui">
    <Err message={value.recovery.error ?? t('draft.recoveryUnavailable')} />
    <p>{t('draft.recoveryUnavailable')}</p>
    <Btn onClick={() => setRestoreConfirmation(true)}>{t('draft.recoveryPrevious')}</Btn>
    <ConfirmDialog open={restoreConfirmation} title={t('draft.recoveryPrevious')} description={t('draft.recoveryDiscardDesc')}
      confirmLabel={t('draft.recoveryDiscard')} danger onCancel={() => setRestoreConfirmation(false)} onConfirm={() => {
        setRestoreConfirmation(false)
        restorePreviousDraftRecovery(props.remote, queueKey, value.channel, value.recovery!)
        loaded.reload()
      }} />
  </div>
  return <DraftSession remote={props.remote} scope={props.scope} owner={owner} snapshot={value.snapshot} channel={value.channel} recovery={value.recovery}>{props.children}</DraftSession>
}

function readSnapshotOrNull(serialized: string | undefined): Snapshot | null {
  if (serialized === undefined) throw new Error('Invalid recovery record')
  const value: unknown = JSON.parse(serialized)
  return value === null ? null : readSnapshot(value)
}

function DraftSession(props: { remote: TavernRemote; scope: string; owner: string; snapshot: Snapshot | null; channel: DraftRecoveryChannel; recovery?: DraftRecoveryRecord; children: ReactNode }) {
  const t = useT()
  const [writeState, setWriteState] = useState<WriteState>(props.recovery ? props.recovery.error ? 'error' : 'local' : props.snapshot ? 'restored' : 'idle')
  const [error, setError] = useState<string | null>(props.recovery?.error ?? null)
  const [session] = useState(() => {
    const fields = new Map<string, { token: object; value: unknown }>()
    const statuses = new Map<string, Status>()
    const restored = { ...props.snapshot?.fields }
    let timer: ReturnType<typeof setTimeout> | undefined
    let mounted = true
    let seenDirty = false
    let last: Snapshot | null | undefined = props.recovery ? props.snapshot : props.snapshot ?? undefined
    let revision = 0
    let persisted = props.recovery ? undefined : JSON.stringify(last)
    let activeWrite: PendingWrite | undefined
    let queuedWrite: PendingWrite | undefined
    const queueKey = `${props.owner}:${props.scope}`
    const capture = () => {
      const dirty = [...statuses.values()].some((s) => s.dirty)
      const busy = [...statuses.values()].some((s) => s.busy)
      // 异步子编辑器尚未挂载时，不能丢掉未消费的恢复字段，也不能据父表单已保存而清空整份快照。
      if (dirty || (seenDirty && Object.keys(restored).length > 0)) {
        seenDirty = true
        // JSON 归一化去掉可选 undefined；后端再次做大小、结构和污染键校验。
        last = JSON.parse(JSON.stringify({ version: 1, fields: { ...restored, ...Object.fromEntries([...fields].map(([key, f]) => [key, f.value])) } })) as Snapshot
      } else if (seenDirty && !busy) last = null
    }
    const flush = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
      // 字段注册只更新引用；完整 JSON 快照在防抖、重试、pagehide 或卸载时才编码，避免每次输入复制整份大草稿。
      let serialized: string, recovery: DraftRecoveryRecord
      try {
        capture()
        if (last === undefined) return
        serialized = JSON.stringify(last)
        // 超限后缩回在途的同一正文也须重新登记，不能让旧失败标记吞掉本次合法修改。
        if (!props.channel.pending?.unavailable
          && (queuedWrite?.serialized === serialized || (!queuedWrite && activeWrite?.serialized === serialized))) return
        if (!queuedWrite && !activeWrite && serialized === persisted && !props.channel.pending) return
        recovery = stageDraftRecovery(props.channel, serialized)
      } catch (cause) {
        revision++
        const message = cause instanceof DraftRecoveryTooLargeError ? t('draft.recoveryTooLarge') : cause instanceof Error ? cause.message : String(cause)
        unavailableDraftRecovery(props.channel, message, persisted)
        if (mounted) { setWriteState('error'); setError(message) }
        return
      }
      const latest: PendingWrite = { snapshot: last, serialized, revision: ++revision, recovery }
      if (mounted) { setWriteState('saving'); setError(null) }
      // 等待中的任务始终占住原队列位置，关闭重开会在它之后读；慢请求期间只替换其快照，不积压每次编辑。
      if (queuedWrite) { Object.assign(queuedWrite, latest); return }
      const write = queuedWrite = latest
      void enqueue(props.remote, queueKey, async () => {
        queuedWrite = undefined
        activeWrite = write
        const { snapshot, serialized, revision: current } = write
        try {
          const result = snapshot
            ? await props.remote.saveEditorDraft({ owner: props.owner, key: props.scope, value: snapshot })
            : await props.remote.deleteEditorDraft({ owner: props.owner, key: props.scope })
          if (!result.ok) throw new Error(result.error.message)
          persisted = serialized
          confirmDraftRecovery(props.remote, queueKey, props.channel, write.recovery)
          if (mounted && current === revision) setWriteState(snapshot ? 'saved' : 'idle')
        } finally { if (activeWrite === write) activeWrite = undefined }
      }).catch((cause: unknown) => {
        failDraftRecovery(props.channel, write.recovery, cause instanceof Error ? cause.message : String(cause))
        if (mounted && write.revision === revision) { setWriteState('error'); setError(cause instanceof Error ? cause.message : String(cause)) }
      })
    }
    const schedule = () => {
      if (!mounted) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(flush, 500)
    }
    const registry: DraftRegistry = {
      remote: props.remote,
      restored,
      field(key, token, value) {
        fields.set(key, { token, value })
        delete restored[key]
        schedule()
      },
      remove(key, token) {
        if (fields.get(key)?.token === token) {
          fields.delete(key)
        }
        schedule()
      },
      report(id, status) {
        if (status) { statuses.set(id, status); seenDirty ||= status.dirty }
        else statuses.delete(id)
        schedule()
      },
      discard(id?: string) {
        if (id !== undefined) {
          const current = statuses.get(id)
          if (current) statuses.set(id, { ...current, dirty: false })
        } else {
          for (const [key, current] of statuses) if (current.dirty) statuses.set(key, { ...current, dirty: false })
        }
        if ([...statuses.values()].some((s) => s.dirty)) {
          schedule()
          return
        }
        for (const key of Object.keys(restored)) delete restored[key]
        last = null
        seenDirty = false
        flush()
      },
    }
    return { registry, flush, start() { mounted = true }, stop() { mounted = false; flush() } }
  })
  useLayoutEffect(() => {
    session.start()
    const flush = () => session.flush()
    if (typeof window !== 'undefined') window.addEventListener('pagehide', flush)
    return () => { if (typeof window !== 'undefined') window.removeEventListener('pagehide', flush); session.stop() }
  }, [session])
  return <PersistenceContext.Provider value={session.registry}>
    {writeState !== 'idle' && <div className="dsh-tavern-ui dsh-tavern-draftStatus" role="status">
      <span>{t(writeState === 'restored' ? 'draft.restored' : writeState === 'local' ? 'draft.localOnly' : writeState === 'saving' ? 'draft.autosaving' : writeState === 'error' ? 'draft.autosaveFailed' : 'draft.autosaved')}</span>
      {error && <Err message={error} />}
      {(error || writeState === 'local') && <Btn onClick={session.flush}>{t('action.retry')}</Btn>}
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
  const discard = useCallback(() => registry?.discard(id), [registry, id])
  return registry ? discard : undefined
}
