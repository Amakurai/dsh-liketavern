/** 剧情模板状态与已处理回复共用单文件事务；预览只读，楼层写入先 WAL，分支按文件快照继承。 */
import { createHash } from 'node:crypto'
import { emptyTemplateScopes, parseTemplateScopes, type TemplateScopes } from '../core/template.js'
import { EMPTY_TIMER_STATE, type WITimerState } from '../core/types.js'
import type { WorkspaceFs } from './workspaceFs.js'
import { withWorkspaceLock } from './workspaceLock.js'
import { parseTemplateGeneration, type TemplateGeneration } from './templateGeneration.js'
import { parseTemplateDisplayParts, type TemplateDisplayPart } from '../core/templateDisplay.js'
import { parseTemplateContinuation,resolveTemplateContinuation } from './templateContinuation.js'
import { parseTemplateMessageVariables, type TemplateMessageVariables } from '../core/templateMessageVariables.js'
import type { TemplateContinuation } from '../core/templateContinuation.js'

export const TEMPLATE_STATE_PATH = 'state/template.json'
export interface TemplateState {
  version: 1
  variables: TemplateScopes
  messageVariables?:TemplateMessageVariables
  continuation?:TemplateContinuation
  outputs: Record<string, { hash: string; text: string; parts?:TemplateDisplayPart[] }>
  /** 与生成变量在同一次原子替换中提交；缺字段的旧状态继续读取独立定时文件。 */
  wiTimers?: Record<string, WITimerState>
  /** 未完成轮的闭包重放与冻结计划；完成后缩成归属回执，防止重启重复执行。 */
  generation?: TemplateGeneration
}
export const templateTextHash = (text: string): string => createHash('sha256').update(text).digest('hex')

export async function loadTemplateState(fs: WorkspaceFs): Promise<TemplateState> {
  const raw = await fs.readText(TEMPLATE_STATE_PATH)
  if (raw === null) return { version: 1, variables: emptyTemplateScopes(), outputs: {} }
  if (raw.length > 4 * 1024 * 1024) throw new Error('模板状态超过 4 MiB 上限')
  const data: unknown = JSON.parse(raw)
  if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1
    || !('variables' in data) || !('outputs' in data) || !data.outputs || typeof data.outputs !== 'object' || Array.isArray(data.outputs)) throw new Error('模板状态文件损坏')
  const variables = parseTemplateScopes(data.variables)
  const outputs: TemplateState['outputs'] = {}
  for (const [key, value] of Object.entries(data.outputs)) {
    if (!/^\d+$/.test(key) || !value || typeof value !== 'object' || !('hash' in value) || typeof value.hash !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.hash) || !('text' in value) || typeof value.text !== 'string') throw new Error('模板回复快照损坏')
    outputs[key] = { hash: value.hash, text: value.text, ...('parts' in value ? {parts:parseTemplateDisplayParts(value.parts)} : {}) }
  }
  let wiTimers: TemplateState['wiTimers']
  if ('wiTimers' in data) {
    if (!data.wiTimers || typeof data.wiTimers !== 'object' || Array.isArray(data.wiTimers)) throw new Error('模板定时状态损坏')
    wiTimers = Object.fromEntries(Object.entries(data.wiTimers).map(([id, timers]) => [id, parseTimerState(timers)]))
  }
  const generation = 'generation' in data ? parseTemplateGeneration(data.generation) : undefined
  const continuation='continuation' in data ? parseTemplateContinuation(data.continuation) : undefined
  const messageVariables='messageVariables' in data ? parseTemplateMessageVariables(data.messageVariables) : undefined
  const state:TemplateState={ version: 1, variables, outputs, ...(messageVariables ? {messageVariables} : {}), ...(wiTimers ? { wiTimers } : {}), ...(generation ? {generation} : {}),...(continuation ? {continuation} : {}) }
  resolveTemplateContinuation(state)
  return state
}

export async function saveTemplateState(fs: WorkspaceFs, state: TemplateState): Promise<void> {
  if (!fs.currentFloor) throw new Error('模板持久化需要已开启的剧情楼层')
  await writeTemplateState(fs, state)
}

async function writeTemplateState(fs: WorkspaceFs, state: TemplateState): Promise<void> {
  if (state.version!==1 || !state.outputs || typeof state.outputs!=='object' || Array.isArray(state.outputs)) throw new Error('模板状态文件损坏')
  parseTemplateScopes(state.variables)
  if(state.messageVariables) state.messageVariables=parseTemplateMessageVariables(state.messageVariables)
  if(state.continuation) {parseTemplateContinuation(state.continuation);resolveTemplateContinuation(state)}
  if (state.wiTimers!==undefined && (!state.wiTimers || typeof state.wiTimers!=='object' || Array.isArray(state.wiTimers))) throw new Error('模板定时状态损坏')
  for (const timers of Object.values(state.wiTimers ?? {})) parseTimerState(timers)
  for (const [key,output] of Object.entries(state.outputs)) {
    if (!/^\d+$/.test(key) || !output || typeof output!=='object' || typeof output.hash!=='string'
      || !/^[a-f0-9]{64}$/.test(output.hash) || typeof output.text!=='string') throw new Error('模板回复快照损坏')
    if (output.parts!==undefined) parseTemplateDisplayParts(output.parts)
  }
  const raw = JSON.stringify(state)
  if (raw.length > 4 * 1024 * 1024) throw new Error('模板状态超过 4 MiB 上限')
  if (state.generation) parseTemplateGeneration(JSON.parse(raw).generation)
  if (raw !== await fs.readText(TEMPLATE_STATE_PATH)) {
    try { await fs.writeText(TEMPLATE_STATE_PATH, raw) }
    catch (error) {
      // 某些文件系统在 rename 已完成后仍报告失败；读回确认提交结果，防重试重复增量。
      if (await fs.readText(TEMPLATE_STATE_PATH) !== raw) throw error
    }
  }
}

function parseTimerState(value: unknown): WITimerState {
  if (!value || typeof value !== 'object' || !('stickyLeft' in value) || !('cooldownLeft' in value)) throw new Error('模板定时状态损坏')
  const map = (input: unknown): Record<string, number> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('模板定时状态损坏')
    return Object.fromEntries(Object.entries(input).map(([key, left]) => {
      if (typeof left !== 'number' || !Number.isFinite(left) || left < 0) throw new Error('模板定时状态损坏')
      return [key, left]
    }))
  }
  return { stickyLeft: map(value.stickyLeft), cooldownLeft: map(value.cooldownLeft) }
}

const legacyTimerPath = (sessionId: string): string => `state/wi-timers/${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`

/** 新状态优先；旧文件保留为迁移来源和回滚旧楼层所需的历史数据。 */
export async function loadTemplateTimers(fs: WorkspaceFs, sessionId: string): Promise<WITimerState> {
  const state = await loadTemplateState(fs)
  if (state.wiTimers && Object.hasOwn(state.wiTimers, sessionId)) return state.wiTimers[sessionId]!
  const raw = await fs.readText(legacyTimerPath(sessionId))
  if (raw === null) return structuredClone(EMPTY_TIMER_STATE)
  try { return parseTimerState(JSON.parse(raw)) } catch { return structuredClone(EMPTY_TIMER_STATE) }
}

/** 普通计时更新与分支复制只改变计时字段；未迁移会话保留原路径，不创建空模板文件。 */
export async function saveTemplateTimers(fs: WorkspaceFs, sessionId: string, timers: WITimerState): Promise<void> {
  await withWorkspaceLock(fs.root, async () => {
    const state = await loadTemplateState(fs)
    const parsed = parseTimerState(timers)
    if (state.wiTimers && Object.hasOwn(state.wiTimers, sessionId)) {
      await writeTemplateState(fs, { ...state, wiTimers: { ...state.wiTimers, [sessionId]: parsed } })
    } else {
      await fs.writeText(legacyTimerPath(sessionId), JSON.stringify(parsed, null, 2) + '\n')
    }
  })
}

/** 分支草稿把边界定时器复制到子会话旧路径；不改祖先模板镜像，跨分支 WAL 才能逐层撤销。 */
export async function copyTemplateTimers(fs: WorkspaceFs, fromSessionId: string, toSessionId: string): Promise<void> {
  await withWorkspaceLock(fs.root, async () => {
    const state = await loadTemplateState(fs)
    if (state.wiTimers && Object.hasOwn(state.wiTimers, fromSessionId)) {
      await fs.writeText(legacyTimerPath(toSessionId), JSON.stringify(state.wiTimers[fromSessionId]!, null, 2) + '\n')
    } else {
      const raw = await fs.readText(legacyTimerPath(fromSessionId))
      if (raw !== null) await fs.writeText(legacyTimerPath(toSessionId), raw)
    }
  })
}
