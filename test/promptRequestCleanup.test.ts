/**
 * 请求副本清理：宿主身份句与工作区指令只在这次发信里被剔除。
 * 验证业务边界：历史与载体不被改写；清理开关随冻结计划生效、可逐项关闭；
 * 锚在工作区指令上的模板片段仍按原位置落位；诊断如实报告清理量；身份句只做精确删除。
 */
import { expect, it } from 'vitest'
import { createSystemMessage, createUserMessage, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { BOUND_DISCIPLINE, HARNESS_IDENTITY_TEXT, stripHarnessIdentity } from '../src/core/dshPrompt.js'
import type { PromptHistoryAnchor, PromptLayoutEntry } from '../src/core/promptLayout.js'
import { createPresetPlanMessage, projectPresetRequest, type PresetProjectionDiagnostic,
  type PresetRequestCleanup, type PresetRequestPlan } from '../src/node/presetRequestProjection.js'

const hostPlugin = '@deepseek-ai/dsh-system-prompt'
const textOf = (message: Message): string => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const entry = (key: string, role: Message['role'], placement: PromptLayoutEntry['placement']): PromptLayoutEntry =>
  ({ key, role, content: key, sourceKeys: [key], turnLocal: false, placement })

function factory(cleanup?: PresetRequestCleanup) {
  const session = Session.create(SessionId('prompt-cleanup'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const standingText = `${BOUND_DISCIPLINE}\n\nLEGACY-STANDING`
  session.append('system/message', { turn: 1, step: 1,
    message: createSystemMessage(`${HARNESS_IDENTITY_TEXT}\n\nHOST-TOOLS  \n\n\n\n${standingText}\n\nHOST-END`, hostPlugin) },
  { surfaceOp: 'append' })
  const current = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '玩家台词' }] })
  session.append('user/message', current, { surfaceOp: 'append' })
  // 工作区指令由宿主以 user 消息注入，不属于本轮对话，但仍出现在冻结历史里。
  const workspace = { ...createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'WORKSPACE-RULES' }] }),
    source: { kind: 'agent-instructions' } } as unknown as Message
  session.append('user/message', workspace as never, { surfaceOp: 'append' })
  const currentAnchor: PromptHistoryAnchor = { inputIndex: 0, messageId: current.id, role: 'user', chat: true }
  const workspaceAnchor: PromptHistoryAnchor = { inputIndex: 1, messageId: workspace.id, role: 'user', chat: false }
  const plan: PresetRequestPlan = { version: 1, sessionId: session.id, turn: 1, standingText, contextText: '',
    ...(cleanup ? { cleanup } : {}),
    layout: { version: 1, history: [currentAnchor, workspaceAnchor],
      entries: [entry('PRESET-MAIN', 'system', { kind: 'before-history', anchor: currentAnchor }),
        // 模板 GENERATE 片段可以锚在任意历史消息上，包括工作区指令。
        entry('GEN-BEFORE-WS', 'user', { kind: 'history-relative', anchor: workspaceAnchor, side: 'before' }),
        entry('GEN-AFTER-WS', 'user', { kind: 'history-relative', anchor: workspaceAnchor, side: 'after' })] } }
  session.append('user/message', createPresetPlanMessage(plan), { surfaceOp: 'append' })
  const request = (): GenerateOptions => ({ provider: 'factory', model: 'factory', sessionId: session.id,
    messages: session.deriveMessages(), tools: [], temperature: 0.3 })
  const model = { systemPromptUpdate: 'in-history' as const, context: {}, defaultMaxTokens: 0 }
  return { session, request, plan, model, workspace }
}

function project(cleanup?: PresetRequestCleanup): { messages: Message[]; diagnostics: PresetProjectionDiagnostic[]; events: unknown[] } {
  const f = factory(cleanup)
  const diagnostics: PresetProjectionDiagnostic[] = []
  const projected = projectPresetRequest(f.request(), f.session, { model: f.model,
    onDiagnostic: diagnostic => diagnostics.push(diagnostic) })
  return { messages: projected.messages, diagnostics, events: f.session.snapshotEvents() }
}

it('删掉宿主身份句时保留其余宿主段与 standing 纪律，其它字节不被清洗', () => {
  const { messages } = project({ hideHarnessIdentity: true })
  const system = textOf(messages[0]!)
  expect(system).not.toContain(HARNESS_IDENTITY_TEXT)
  expect(system.startsWith('HOST-TOOLS  \n\n\n\n')).toBe(true)
  expect(system).toContain(BOUND_DISCIPLINE)
  expect(system).toContain('HOST-END')
  expect(system).not.toContain('LEGACY-STANDING')
})

it('剔除工作区指令消息但不碰真实用户台词，锚在它前后的模板片段仍按原顺序落位', () => {
  const { messages } = project({ dropWorkspaceInstructions: true })
  const texts = messages.map(textOf)
  expect(texts.join('\n')).not.toContain('WORKSPACE-RULES')
  const user = texts.indexOf('玩家台词'), before = texts.indexOf('GEN-BEFORE-WS'), after = texts.indexOf('GEN-AFTER-WS')
  expect(user).toBeGreaterThan(0)
  expect(before).toBeGreaterThan(user)
  expect(after).toBeGreaterThan(before)
})

it('清理只作用于请求副本：诊断如实报告，日志不变，计划未开启时原样保留', () => {
  const cleaned = project({ hideHarnessIdentity: true, dropWorkspaceInstructions: true })
  const cleanup = cleaned.diagnostics.find(diagnostic => diagnostic.kind === 'request-cleanup')
  expect(cleanup).toEqual({ kind: 'request-cleanup', hideHarnessIdentity: true, droppedWorkspaceInstructions: 1 })
  expect(JSON.stringify(cleaned.events)).toContain('WORKSPACE-RULES')
  expect(JSON.stringify(cleaned.events)).toContain(HARNESS_IDENTITY_TEXT)

  // 旧计划没有 cleanup 字段：不读取当前设置，按原样发送。
  for (const untouched of [project(), project({})]) {
    expect(textOf(untouched.messages[0]!)).toContain(HARNESS_IDENTITY_TEXT)
    expect(untouched.messages.map(textOf)).toContain('WORKSPACE-RULES')
    expect(untouched.diagnostics.some(diagnostic => diagnostic.kind === 'request-cleanup')).toBe(false)
  }
})

it('身份句只做精确删除：连同段间分隔符删掉，宿主换文案时为 no-op', () => {
  expect(stripHarnessIdentity('KEEP-AS-IS')).toBe('KEEP-AS-IS')
  expect(stripHarnessIdentity(`${HARNESS_IDENTITY_TEXT}\n\nBODY`)).toBe('BODY')
  expect(stripHarnessIdentity(`HEAD\n\n${HARNESS_IDENTITY_TEXT}\n\nBODY`)).toBe('HEAD\n\nBODY')
  expect(stripHarnessIdentity(`BODY\n\n${HARNESS_IDENTITY_TEXT}`)).toBe('BODY')
  expect(stripHarnessIdentity(`${HARNESS_IDENTITY_TEXT}\n\nA  \n\n\n\nB\t\n`)).toBe('A  \n\n\n\nB\t\n')
})
