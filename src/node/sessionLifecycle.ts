/** 宿主会话事件的副作用：开启/提交剧情 WAL，维护并清理每轮缓存。调用方负责按会话排队。 */
import type { TavernState } from './state.js'

export async function onTurnStart(state: TavernState, sessionId: string, turn: number): Promise<void> {
  // turn 号先于绑定记录：turn 中途才绑卡的会话（turn/start 时无绑定，下方提前返回）
  // 也要让 pipeline 拿到真实 turn 号走「每 turn 评估一次」缓存——否则 live 且 turn=-1
  // 时 cacheable=false，每步全量重评并 saveTimers，sticky/cooldown 每步 tick 一次。
  // 这种会话本轮没有 beginFloor，pipeline 不落盘定时器，避免产生无 WAL 的轮次写入。
  state.currentTurns.set(sessionId, turn)
  state.currentSteps.set(sessionId, 1)
  const binding = await state.loadBinding(sessionId)
  if (!binding) return
  const ws = await state.storyWorkspace(binding.cardId, binding.storyId)
  // 楼层直接开在 WAL 上，不再写共享 WorkspaceFs 的可变 floor：同一张卡的并发会话
  // 各有各的楼层，turn 内的写入经 withFloor(floor) 派生实例记进各自楼层（见 tools.ts）。
  const floor = `${sessionId}#t${turn}`
  await ws.wal.beginFloor(floor)
  // 记下楼层开在哪张卡上：turn/end 必须按这张卡这个楼层提交，不能重新读绑定；
  // 工具写路径也凭这条 entry 校验「楼层确实开在当前绑定的卡上」。
  state.openFloors.set(sessionId, { cardId: binding.cardId, storyId: binding.storyId, floor })
}

export async function onTurnEnd(state: TavernState, sessionId: string): Promise<void> {
  // 不变式：谁 beginFloor 谁 commitFloor。用户中途换绑/解绑时当前绑定已经指向别的卡，
  // 按当前绑定提交会把开层那张卡的楼层永远留在未提交状态：之后同会话同 turn 号再
  // beginFloor 会抛「已存在且未提交」，该楼层也一直占着 listFloors。
  const entry = state.openFloors.get(sessionId)
  state.openFloors.delete(sessionId)
  state.currentTurns.delete(sessionId)
  state.currentSteps.delete(sessionId)
  state.stepNoticeMarks.delete(sessionId)
  state.wiCache.delete(sessionId)
  state.turnPlans.delete(sessionId)
  state.pendingInputs.delete(sessionId)
  if (!entry) return
  const ws = await state.storyWorkspace(entry.cardId, entry.storyId)
  // 提交失败由调用方 warn；entry 已先摘除，不会留下悬空楼层
  // （共享 WorkspaceFs 的 floor 恒为 null，没有 setFloor(null) 兜底的需求）。
  await ws.wal.commitFloor(entry.floor)
}
