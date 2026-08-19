/**
 * assistant 消息操作条（slot conversation.chat.assistant-actions，session 作用域）。
 *
 * 视觉对齐 dsh 原生 IconActions（28px 图标钮 + Tooltip）。
 * 整组用 margin-left:auto 靠右，开场白 swipe（‹ n/m ›）在这一侧。
 * 行为：
 * - 仅在 Tavern 模式且已绑定角色卡时渲染（普通 dsh 会话不出现任何 Tavern 按钮）；
 * - 开场白楼层只给 swipe（对话开始后连 swipe 也收起），不提供重新生成/编辑；
 * - 三个楼层操作均按「这一层」生效（slot owner 提供 messageId，host 端据此定位楼层）；
 * - 成功后自动 sessions.open(分支子会话)，续跑的流式过程在分支里原生可见。
 */
import { useEffect, useState } from 'react'
import { IconBranchOutline16, IconChevronLeftOutline14, IconChevronRightOutline14, IconEditOutline16, IconLoadingOutline16, IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import { isTavernSession, type UseSessions } from './mode.js'
import { openChildSession } from './openChild.js'
import type { Envelope, TavernRemote } from './types.js'
import { Btn, Dialog, Err, textarea, useLoader } from './util.js'
import './styles.js'

function IconAction(props: { label: string; disabled?: boolean; busy?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={props.label} side="bottom">
      <button type="button" aria-label={props.label} className="dsh-tavern-action" disabled={props.disabled} onClick={props.onClick}>
        {props.busy ? (
          <span className="dsh-tavern-spin">
            <IconLoadingOutline16 />
          </span>
        ) : (
          props.children
        )}
      </button>
    </Tooltip>
  )
}

/** 绑定变更广播（chip 保存绑定后 dispatch，操作条据此显隐）。 */
export const BINDING_CHANGED_EVENT = 'dsh-tavern:binding-changed'

/** 查询会话是否已绑定角色卡；null = 尚未加载完成（先不渲染，避免闪烁）。非 Tavern 不打 remote。 */
function useTavernBound(remote: TavernRemote, sessionId: string, enabled: boolean): boolean | null {
  const [bound, setBound] = useState<boolean | null>(null)
  useEffect(() => {
    if (!enabled) {
      setBound(false)
      return
    }
    let alive = true
    const load = () =>
      remote
        .getSessionBinding({ sessionId })
        .then((r) => {
          if (alive) setBound(r.ok ? r.value.binding !== null : null)
        })
        .catch(() => {
          if (alive) setBound(null)
        })
    void load()
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<string>).detail === sessionId) void load()
    }
    window.addEventListener(BINDING_CHANGED_EVENT, onChanged)
    return () => {
      alive = false
      window.removeEventListener(BINDING_CHANGED_EVENT, onChanged)
    }
  }, [remote, sessionId, enabled])
  return bound
}

export interface FloorActionsProps {
  remote: TavernRemote
  sessionId: string
  sessions: { open(id: string): void; refresh?: () => Promise<void> }
  /** slot owner 传入的 assistant 消息 id。 */
  messageId?: string
  useSessions?: UseSessions
}

type FloorOperation = 'regenerate' | 'rollback' | 'load-edit' | 'submit-edit' | 'swipe-prev' | 'swipe-next' | null

export function TavernFloorActions(props: FloorActionsProps) {
  const { remote, sessionId, sessions, messageId } = props
  const tavern = isTavernSession(props.useSessions, sessionId)
  const bound = useTavernBound(remote, sessionId, tavern)
  const [operation, setOperation] = useState<FloorOperation>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [editFailure, setEditFailure] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ turn: number; text: string } | null>(null)
  const swipeLoader = useLoader(
    () => remote.getGreetingSwipe({ sessionId, messageId: messageId! }),
    [sessionId, messageId],
    bound === true && Boolean(messageId),
  )
  useEffect(() => {
    if (bound !== true || !messageId) return
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<string>).detail === sessionId) swipeLoader.reload()
    }
    window.addEventListener(BINDING_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(BINDING_CHANGED_EVENT, onChanged)
    // reload 随 loader render 更新；事件回调只需跟会话、消息和启用状态重挂。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bound, messageId, sessionId])
  const greetState = swipeLoader.state.status === 'ready' ? swipeLoader.state.value : null
  const swipe = greetState?.swipe ?? null
  const isGreeting = greetState?.isGreeting === true
  const started = greetState?.started === true

  /** 跑一个产生分支会话的操作；成功后直接跳转到分支（续跑过程在分支里原生流式可见）。 */
  const run = async (
    kind: Exclude<FloorOperation, 'load-edit' | 'submit-edit' | null>,
    op: () => Promise<Envelope<{ childSessionId: string }>>,
  ) => {
    setOperation(kind)
    setFailure(null)
    try {
      const r = await op()
      if (r.ok) await openChildSession(sessions, r.value.childSessionId)
      else setFailure(r.error.message)
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e))
    } finally {
      setOperation(null)
    }
  }

  if (!tavern || bound !== true || !messageId) return null

  const busy = operation !== null
  const onRegenerate = () => void run('regenerate', () => remote.regenerate({ sessionId, messageId }))
  const onRollback = () => void run('rollback', () => remote.rollbackToFloor({ sessionId, messageId }))
  const onSwipe = (delta: number) => {
    if (!swipe || busy) return
    const next = ((swipe.index + delta) % swipe.total + swipe.total) % swipe.total
    void run(delta < 0 ? 'swipe-prev' : 'swipe-next', () => remote.swipeGreeting({ sessionId, index: next }))
  }

  const onEdit = async () => {
    setOperation('load-edit')
    setFailure(null)
    setEditFailure(null)
    try {
      const r = await remote.getFloorUserMessage({ sessionId, messageId })
      if (r.ok) setEdit({ turn: r.value.turn, text: r.value.text })
      else setFailure(r.error.message)
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e))
    } finally {
      setOperation(null)
    }
  }

  const submitEdit = async () => {
    const draft = edit
    if (!draft) return
    setOperation('submit-edit')
    setEditFailure(null)
    try {
      const r = await remote.editUserMessage({ sessionId, messageId, text: draft.text })
      if (r.ok) {
        setEdit(null)
        await openChildSession(sessions, r.value.childSessionId)
      } else {
        setEditFailure(r.error.message)
      }
    } catch (e) {
      setEditFailure(e instanceof Error ? e.message : String(e))
    } finally {
      setOperation(null)
    }
  }

  return (
    <span className="dsh-tavern-actionGroup">
      {swipe && (
        <>
          <IconAction label="上一条开场白" disabled={busy} busy={operation === 'swipe-prev'} onClick={() => onSwipe(-1)}>
            <IconChevronLeftOutline14 />
          </IconAction>
          <span className="dsh-tavern-swipeIdx">
            {swipe.index + 1}/{swipe.total}
          </span>
          <IconAction label="下一条开场白" disabled={busy} busy={operation === 'swipe-next'} onClick={() => onSwipe(1)}>
            <IconChevronRightOutline14 />
          </IconAction>
        </>
      )}
      {!isGreeting && (
        <IconAction label="重新生成这一层" disabled={busy} busy={operation === 'regenerate'} onClick={onRegenerate}>
          <IconRefreshOutline16 />
        </IconAction>
      )}
      {!isGreeting && (
        <IconAction label="编辑这一层的用户消息" disabled={busy} busy={operation === 'load-edit'} onClick={() => void onEdit()}>
          <IconEditOutline16 />
        </IconAction>
      )}
      {(!isGreeting || started) && (
        <IconAction label="回退到这一层（丢弃其后楼层）" disabled={busy} busy={operation === 'rollback'} onClick={onRollback}>
          <IconBranchOutline16 />
        </IconAction>
      )}
      {failure !== null && (
        <span role="status" style={{ fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #ec1313)', paddingLeft: 4 }}>
          {failure}
        </span>
      )}
      {edit !== null && (
        <Dialog open title={`编辑第 ${edit.turn} 层的用户消息`} onClose={() => { if (!busy) setEdit(null) }}>
          <textarea
            style={{ ...textarea, minHeight: 120 }}
            value={edit.text}
            onChange={(e) => setEdit({ ...edit, text: e.target.value })}
          />
          <Err message={editFailure} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
            <Btn disabled={busy} onClick={() => setEdit(null)}>取消</Btn>
            <Btn disabled={busy || !edit.text.trim()} onClick={() => void submitEdit()}>
              {operation === 'submit-edit' ? '保存中…' : '保存并重跑'}
            </Btn>
          </div>
        </Dialog>
      )}
    </span>
  )
}
