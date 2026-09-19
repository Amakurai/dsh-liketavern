/** 真实 Session 与手写请求验证预设布局载体恢复、消息身份/附件/工具保真、跨步固定边界和压缩来源映射。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId,
  type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import { Config as DeepSeekConfig, DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { validateStoredEvents } from '@deepseek-ai/dsh-session-persistence'
import { joinContextSections } from '@deepseek-ai/dsh-system-prompt'
import { BOUND_DISCIPLINE, TURN_PLAYBOOK } from '../src/core/dshPrompt.js'
import { estimateTokens } from '../src/core/tokenize.js'
import type { PromptLayoutEntry } from '../src/core/promptLayout.js'
import { attachPresetPlanMessage, createPresetPlanMessage, createPresetRequestProjector, PRESET_PLAN_MESSAGE_TEXT, projectPresetRequest,
  type PresetProjectionDiagnostic, type PresetRequestPlan } from '../src/node/presetRequestProjection.js'

const hostPlugin = '@deepseek-ai/dsh-system-prompt'
const textOf = (message: Message) => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const entry = (key: string, role: Message['role'], placement: PromptLayoutEntry['placement']): PromptLayoutEntry =>
  ({ key, role, content: key, sourceKeys: [key], turnLocal: true, placement })

function factory() {
  const session = Session.create(SessionId('preset-projection'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const standingText = `${BOUND_DISCIPLINE}\n\nLEGACY-STANDING`
  const contextText = `${TURN_PLAYBOOK}\n\nLEGACY-TURN`
  session.append('system/message', { turn: 1, step: 1,
    message: createSystemMessage(`HOST-TOOLS\n\n${standingText}\n\nHOST-END`, hostPlugin) }, { surfaceOp: 'append' })
  const first = user('重复的用户台词')
  session.append('user/message', first, { surfaceOp: 'append' })
  const answer = createAssistantMessage({ source: { provider: 'factory', model: 'factory', replayState: { opaque: ['keep'] } },
    content: [{ type: 'text', text: '旧回复正文' }] })
  session.append('assistant/message', { turn: 1, step: 1, message: answer, stream: [] }, { surfaceOp: 'append' })
  const current = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '重复的用户台词' },
    { type: 'image', attachment: { attachmentId: AttachmentId('a'.repeat(64)), mediaType: 'image/png', bytes: 32, width: 1, height: 1, name: 'factory.png' } }] })
  session.append('user/message', current, { surfaceOp: 'append' })
  const sections = [{ name: 'other-plugin', text: 'FOREIGN-CONTEXT' }, { name: 'tavern:turn', text: contextText }]
  const snapshot = createUserMessage({ source: { kind: 'plugin', plugin: hostPlugin, form: 'snapshot', sections },
    content: [{ type: 'text', text: joinContextSections(sections) }] })
  session.append('user/message', snapshot, { surfaceOp: 'append' })
  const history = [first, answer, current].map((message, inputIndex) => ({ inputIndex, messageId: message.id, role: message.role, chat: true }))
  const record: PresetRequestPlan = { version: 1, sessionId: session.id, turn: 1, standingText, contextText,
    layout: { version: 1, history, entries: [entry('MAIN', 'system', { kind: 'before-history', anchor: history[0]! }),
      entry('DEPTH-1-USER', 'user', { kind: 'depth', depth: 1, order: 20, previous: history[1]!, next: history[2]! }),
      entry('DEPTH-0-SYSTEM', 'system', { kind: 'depth', depth: 0, order: 20, previous: history[2]! }),
      entry('ASSISTANT-PREFILL', 'assistant', { kind: 'after-history', anchor: history[2]! })] } }
  const publish = () => {
    const carrier = createPresetPlanMessage(record)
    session.append('user/message', carrier, { surfaceOp: 'append' })
    return carrier
  }
  const request = (): GenerateOptions => ({ provider: 'factory', model: 'factory', sessionId: session.id,
    messages: session.deriveMessages(), tools: [{ name: 'factory_tool', description: 'test', parameters: {} }], temperature: 0.3, stop: ['STOP'] })
  return { session, first, answer, current, snapshot, record, publish, request }
}

it('来源元数据载体经真实 Session、磁盘 JSON 与持久化验证恢复；正文只含短标记', async () => {
  const f = factory()
  const carrier = f.publish()
  expect(textOf(carrier)).toBe(PRESET_PLAN_MESSAGE_TEXT)
  expect(textOf(carrier)).not.toContain('LEGACY-STANDING')
  expect(carrier.source.kind).toBe('tavern-prompt-plan')
  const dir = await mkdtemp(join(tmpdir(), 'tavern-plan-restore-'))
  try {
    const path = join(dir, 'session.json')
    await writeFile(path, JSON.stringify({ header: f.session.header, events: f.session.snapshotEvents() }))
    const data = JSON.parse(await readFile(path, 'utf8'))
    const events = validateStoredEvents(data.header, data.events)
    const restored = Session.create(f.session.id, events, data.header)
    const output = projectPresetRequest({ ...f.request(), messages: restored.deriveMessages() }, restored)
    expect(textOf(output.messages.at(-1)!)).toBe('ASSISTANT-PREFILL')
    expect(output.messages.some(message => message.source.kind === 'tavern-prompt-plan')).toBe(false)
    expect(restored.snapshotEvents().some(event => event.type === 'user/message' && event.data.id === carrier.id)).toBe(true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('附加布局保留原消息 ID、角色、正文和 source.kind，真实恢复后只剥私有元数据', () => {
  const f = factory()
  const attached = attachPresetPlanMessage(f.snapshot, f.record)
  expect(attached.id).toBe(f.snapshot.id)
  expect(attached.role).toBe(f.snapshot.role)
  expect(attached.content).toEqual(f.snapshot.content)
  expect(attached.source.kind).toBe(f.snapshot.source.kind)
  expect('tavernPromptPlan' in f.snapshot.source).toBe(false)
  const events = JSON.parse(JSON.stringify(f.session.snapshotEvents().map(event =>
    event.type === 'user/message' && event.data.id === f.snapshot.id ? { ...event, data: attached } : event)))
  const restored = Session.create(f.session.id, validateStoredEvents(f.session.header, events), f.session.header)
  const output = projectPresetRequest({ ...f.request(), messages: restored.deriveMessages() }, restored)
  const retained = output.messages.find(message => message.id === f.snapshot.id)!
  expect(retained.role).toBe('user')
  expect(retained.source).toEqual({ kind: 'plugin', plugin: hostPlugin, form: 'snapshot', sections: [{ name: 'other-plugin', text: 'FOREIGN-CONTEXT' }] })
  expect(textOf(retained)).toContain('FOREIGN-CONTEXT')
  expect(textOf(output.messages.at(-1)!)).toBe('ASSISTANT-PREFILL')
  expect(output.messages.some(message => 'tavernPromptPlan' in message.source)).toBe(false)
})

it('附在真实用户上的计划保留图片内容块，并将尾条放在该用户消息之后', () => {
  const f = factory()
  f.record.layout.history = [{ inputIndex: 0, messageId: f.current.id, role: 'user', chat: true }]
  f.record.layout.entries = [entry('TAIL', 'assistant', { kind: 'after-history', anchor: f.record.layout.history[0]! })]
  const session = Session.create(f.session.id)
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', { turn: 1, step: 1, message: createSystemMessage(f.record.standingText, hostPlugin) }, { surfaceOp: 'append' })
  session.append('user/message', attachPresetPlanMessage(f.current, f.record), { surfaceOp: 'append' })
  const request = { ...f.request(), messages: session.deriveMessages() }
  const output = projectPresetRequest(request, session)
  const retained = output.messages.find(message => message.id === f.current.id)!
  expect(retained.source).toEqual({ kind: 'user' })
  expect(retained.content).toBe(request.messages.at(-1)!.content)
  expect(retained.content).toEqual(f.current.content)
  expect(output.messages.at(-2)?.id).toBe(f.current.id)
  expect(textOf(output.messages.at(-1)!)).toBe('TAIL')
})

it('官方 DeepSeek HTTP 序列化忽略附加 source 元数据，未投影路由发送原正文且不泄漏布局 JSON', async () => {
  const f = factory()
  f.record.layout.entries[0]!.content = 'PRIVATE-METADATA-ONLY'
  const attached = attachPresetPlanMessage(user('仅发送这句原始用户正文'), f.record)
  const bodies: string[] = []
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
    bodies.push(String(init?.body))
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }))
  try {
    const adapter = new DeepSeekAdapter({ options: () => resolveAdapterOptions(DeepSeekConfig({ baseURL: 'https://factory.invalid/v1',
      apiKeyEnv: 'FACTORY_KEY', models: [{ id: 'factory', contextWindow: 64_000 }] })), resolveApiKey: async () => 'factory-key',
      resolveUserId: () => 'factory-user' as AnonymousUserId, prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) })
    const frames = []
    for await (const frame of adapter.stream({ provider: 'deepseek-official', model: 'factory', messages: [attached] })) frames.push(frame)
    expect(frames.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0]!).messages).toEqual([{ role: 'user', content: '仅发送这句原始用户正文' }])
    expect(bodies[0]).not.toContain('tavernPromptPlan')
    expect(bodies[0]).not.toContain('PRIVATE-METADATA-ONLY')
    expect(bodies[0]).not.toContain(PRESET_PLAN_MESSAGE_TEXT)
  } finally { vi.unstubAllGlobals() }
})

it('按 ID 区分同文用户，保留图片、原始 source、模型回放状态与请求选项，不修改冻结输入', () => {
  const f = factory(); f.publish()
  const request = Object.freeze({ ...f.request(), messages: Object.freeze(f.request().messages) as unknown as Message[] })
  const before = JSON.stringify(request)
  const output = projectPresetRequest(request, f.session)
  expect(output).not.toBe(request)
  expect(output.messages).not.toBe(request.messages)
  expect(JSON.stringify(request)).toBe(before)
  expect(output.tools).toBe(request.tools)
  expect(output.stop).toBe(request.stop)
  expect(output.temperature).toBe(0.3)
  for (const original of [f.first, f.answer, f.current]) {
    expect(output.messages.find(message => message.id === original.id)).toBe(request.messages.find(message => message.id === original.id))
  }
  const order = output.messages.map(message => message.id)
  const depth = output.messages.find(message => textOf(message) === 'DEPTH-1-USER')!
  expect(order.indexOf(depth.id)).toBeGreaterThan(order.indexOf(f.answer.id))
  expect(order.indexOf(depth.id)).toBeLessThan(order.indexOf(f.current.id))
  expect(output.messages.at(-1)?.role).toBe('assistant')
  expect(textOf(output.messages.at(-1)!)).toBe('ASSISTANT-PREFILL')
  expect(output.messages.map(textOf).join('\n')).not.toContain('LEGACY-')
  expect(output.messages[0]?.id).toBe(request.messages[0]?.id)
  expect(textOf(output.messages[0]!)).toBe(`HOST-TOOLS\n\n${BOUND_DISCIPLINE}\n\nHOST-END`)
  expect(output.messages.filter(message => textOf(message).includes(TURN_PLAYBOOK))).toHaveLength(1)
  const retainedContext = output.messages.find(message => message.id === f.snapshot.id)!
  expect(textOf(retainedContext)).toContain('FOREIGN-CONTEXT')
  expect(retainedContext.source).toEqual({ kind: 'plugin', plugin: hostPlugin, form: 'snapshot', sections: [{ name: 'other-plugin', text: 'FOREIGN-CONTEXT' }] })
})

it('仅保留最新完整宿主 system，保留其它来源的 system 消息及其它 runtime sections', () => {
  const f = factory()
  const foreign = createSystemMessage('FOREIGN-SYSTEM', 'foreign')
  f.session.append('system/message', { turn: 1, step: 1, message: foreign }, { surfaceOp: 'append' })
  const newer = createSystemMessage(`NEW-HOST-TOOLS\n\n${f.record.standingText}`, hostPlugin)
  f.session.append('system/message', { turn: 1, step: 1, message: newer }, { surfaceOp: 'append' })
  f.publish()
  const output = projectPresetRequest(f.request(), f.session)
  expect(output.messages[0]!.id).toBe(newer.id)
  expect(textOf(output.messages[0]!)).toBe(`NEW-HOST-TOOLS\n\n${BOUND_DISCIPLINE}`)
  expect(output.messages.filter(message => message.role === 'system' && message.source.kind === 'plugin' && message.source.plugin === hostPlugin)).toHaveLength(1)
  expect(output.messages.find(message => message.id === foreign.id)).toEqual(foreign)
})

it('后续工具步骤重放原输入边界和固定插件 ID，工具调用与并行结果保持原对象与顺序', () => {
  const f = factory(); f.publish()
  const first = projectPresetRequest(f.request(), f.session)
  const callIds = [ToolCallId('call-a'), ToolCallId('call-b')]
  const call = createAssistantMessage({ source: { provider: 'factory', model: 'factory', replayState: { keep: true } },
    content: callIds.map(id => ({ type: 'tool-call', id, name: 'factory_tool', arguments: '{}' })) })
  f.session.append('assistant/message', { turn: 1, step: 1, message: call, stream: [] }, { surfaceOp: 'append' })
  for (const callId of callIds) f.session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: `RESULT-${callId}` }], isError: false }) }, { surfaceOp: 'append' })
  const request = f.request()
  const second = projectPresetRequest(request, f.session)
  const prefill = second.messages.findIndex(message => textOf(message) === 'ASSISTANT-PREFILL')
  const toolIndex = second.messages.findIndex(message => message.id === call.id)
  expect(toolIndex).toBe(prefill + 1)
  expect(second.messages.slice(toolIndex)).toEqual(request.messages.slice(request.messages.findIndex(message => message.id === call.id)))
  for (const message of second.messages.slice(toolIndex)) expect(message).toBe(request.messages.find(original => original.id === message.id))
  const pluginIds = (messages: Message[]) => messages.filter(message => message.id.startsWith('tavern-prompt-')).map(message => message.id)
  expect(pluginIds(second.messages)).toEqual(pluginIds(first.messages))
})

it('历史相对插入落在整个工具批次之后，不穿过两个工具结果', () => {
  const f = factory()
  const callId = ToolCallId('historical-call')
  const call = createAssistantMessage({ source: { provider: 'factory', model: 'factory' },
    content: [{ type: 'tool-call', id: callId, name: 'factory_tool', arguments: '{}' }] })
  f.session.append('assistant/message', { turn: 1, step: 1, message: call, stream: [] }, { surfaceOp: 'append' })
  const result = createToolResultMessage({ callId, content: [{ type: 'text', text: 'RESULT' }], isError: false })
  f.session.append('tool/result', { turn: 1, step: 1, message: result }, { surfaceOp: 'append' })
  const anchor = { inputIndex: 3, messageId: call.id, role: 'assistant' as const, chat: false }
  f.record.layout.history.push(anchor)
  f.record.layout.entries = [entry('AFTER-BATCH', 'system', { kind: 'history-relative', anchor, side: 'after' })]
  f.publish()
  const output = projectPresetRequest(f.request(), f.session)
  const callIndex = output.messages.findIndex(message => message.id === call.id)
  expect(output.messages[callIndex + 1]?.id).toBe(result.id)
  expect(textOf(output.messages[callIndex + 2]!)).toBe('AFTER-BATCH')
})

it('工具结果前的插入退到完整批次之前，未完成工具调用后的插入明确失败', () => {
  const f = factory()
  const callId = ToolCallId('unfinished-call')
  const call = createAssistantMessage({ source: { provider: 'factory', model: 'factory' },
    content: [{ type: 'tool-call', id: callId, name: 'factory_tool', arguments: '{}' }] })
  f.session.append('assistant/message', { turn: 1, step: 1, message: call, stream: [] }, { surfaceOp: 'append' })
  const anchor = { inputIndex: 3, messageId: call.id, role: 'assistant' as const, chat: false }
  f.record.layout.history.push(anchor)
  f.record.layout.entries = [entry('AFTER-UNFINISHED', 'system', { kind: 'history-relative', anchor, side: 'after' })]
  f.publish()
  expect(() => projectPresetRequest(f.request(), f.session)).toThrow('未完成的工具调用')
  const result = createToolResultMessage({ callId, content: [{ type: 'text', text: 'RESULT' }], isError: false })
  f.session.append('tool/result', { turn: 1, step: 1, message: result }, { surfaceOp: 'append' })
  const resultAnchor = { inputIndex: 4, messageId: result.id, role: 'user' as const, chat: false }
  f.record.layout.history.push(resultAnchor)
  f.record.layout.entries = [entry('BEFORE-RESULT', 'system', { kind: 'history-relative', anchor: resultAnchor, side: 'before' })]
  f.publish()
  const output = projectPresetRequest(f.request(), f.session)
  const callIndex = output.messages.findIndex(message => message.id === call.id)
  expect(textOf(output.messages[callIndex - 1]!)).toBe('BEFORE-RESULT')
  expect(output.messages[callIndex + 1]?.id).toBe(result.id)
})

it('INSERT 对插件片段递归定位并保持同边界顺序，循环布局明确失败', () => {
  const f = factory()
  f.record.layout.entries = [entry('BASE', 'assistant', { kind: 'after-history', anchor: f.record.layout.history[2]! }),
    entry('BEFORE-1', 'system', { kind: 'entry-relative', entryKey: 'BASE', side: 'before' }),
    entry('BEFORE-2', 'user', { kind: 'entry-relative', entryKey: 'BASE', side: 'before' }),
    entry('AFTER-1', 'assistant', { kind: 'entry-relative', entryKey: 'BASE', side: 'after' }),
    entry('AFTER-2', 'assistant', { kind: 'entry-relative', entryKey: 'BASE', side: 'after' })]
  f.publish()
  expect(projectPresetRequest(f.request(), f.session).messages.slice(-5).map(textOf)).toEqual(['BEFORE-1', 'BEFORE-2', 'BASE', 'AFTER-1', 'AFTER-2'])
  f.record.layout.entries[0]!.placement = { kind: 'entry-relative', entryKey: 'AFTER-2', side: 'after' }
  f.publish()
  expect(() => projectPresetRequest(f.request(), f.session)).toThrow('循环')
})

it('长历史的大批尾条与同锚点 INSERT 保持完整顺序，只投影一次且不改原消息', () => {
  const f = factory()
  for (let index = 0; index < 2048; index++) {
    f.session.append('user/message', user(`历史-${index}`), { surfaceOp: 'append' })
  }
  const count = 4096
  const tail = Array.from({ length: count }, (_, index) => entry(`TAIL-${index}`, 'assistant',
    { kind: 'after-history', anchor: f.record.layout.history[2]! }))
  const inserts = Array.from({ length: count }, (_, index) => entry(`INSERT-${index}`, 'user',
    { kind: 'entry-relative', entryKey: 'TAIL-0', side: 'before' }))
  f.record.layout.entries = [...tail, ...inserts]
  const carrier = f.publish()
  const request = f.request(), original = JSON.stringify(request)
  const output = projectPresetRequest(request, f.session)
  expect(output.messages.slice(-count * 2).map(textOf)).toEqual([...inserts, ...tail].map(item => item.content))
  expect(new Set(output.messages.map(message => message.id)).size).toBe(output.messages.length)
  expect(output.messages.some(message => message.id === carrier.id)).toBe(false)
  expect(JSON.stringify(request)).toBe(original)
  expect(output.messages.find(message => message.id === f.current.id)).toBe(request.messages.find(message => message.id === f.current.id))
})

it('空 outlet 片段仍能作为 INSERT 身份锚点，但不发出空角色消息', () => {
  const f = factory()
  const base = entry('EMPTY', 'assistant', { kind: 'after-history', anchor: f.record.layout.history[2]! })
  base.content = ''
  f.record.layout.entries = [base, entry('BEFORE', 'user', { kind: 'entry-relative', entryKey: 'EMPTY', side: 'before' }),
    entry('AFTER', 'assistant', { kind: 'entry-relative', entryKey: 'EMPTY', side: 'after' })]
  f.publish()
  const output = projectPresetRequest(f.request(), f.session)
  expect(output.messages.slice(-2).map(textOf)).toEqual(['BEFORE', 'AFTER'])
  expect(output.messages.some(message => !textOf(message).trim())).toBe(false)
})

function compact(f: ReturnType<typeof factory>, targets: readonly SessionEvent[], text: string, plugin = 'compact') {
  const message = createUserMessage({ source: { kind: 'plugin', plugin }, content: [{ type: 'text', text }] })
  return f.session.append('user/message', message, { surfaceOp: { op: 'replace', startSeq: targets[0]!.seq, endSeq: targets.at(-1)!.seq },
    sourceEventSeqs: targets.map(event => event.seq) })
}

it('真实压缩链将消失的历史锚点收敛到存活摘要边界并报告诊断，绝不复活正文', () => {
  const f = factory(); f.publish()
  const targets = f.session.snapshotEvents().filter(event => (event.type === 'user/message' && event.data.id === f.first.id)
    || (event.type === 'assistant/message' && event.data.message.id === f.answer.id))
  const firstSummary = compact(f, targets, 'FIRST-SUMMARY')
  const secondSummary = compact(f, [firstSummary], 'FINAL-SUMMARY')
  const diagnostics: PresetProjectionDiagnostic[] = []
  const output = projectPresetRequest(f.request(), f.session, { onDiagnostic: item => diagnostics.push(item) })
  expect(output.messages.some(message => message.id === f.first.id || message.id === f.answer.id)).toBe(false)
  expect(output.messages.find(message => message.id === secondSummary.data.id)).toBe(f.request().messages.find(message => message.id === secondSummary.data.id))
  expect(output.messages.map(textOf).join('\n')).not.toContain('旧回复正文')
  expect(diagnostics).toEqual(expect.arrayContaining([{ kind: 'compaction-clamp', messageId: f.first.id, summaryMessageId: secondSummary.data.id },
    { kind: 'compaction-clamp', messageId: f.answer.id, summaryMessageId: secondSummary.data.id }]))
  expect(textOf(output.messages.at(-1)!)).toBe('ASSISTANT-PREFILL')
})

it('落在同一摘要内部的 depth 边界收敛到摘要后，任意编辑替换不能冒充压缩', () => {
  const f = factory()
  f.record.layout.entries = [entry('INSIDE-SUMMARY', 'system', { kind: 'depth', depth: 2, order: 20,
    previous: f.record.layout.history[0]!, next: f.record.layout.history[1]! })]
  f.publish()
  const targets = f.session.snapshotEvents().filter(event => (event.type === 'user/message' && event.data.id === f.first.id)
    || (event.type === 'assistant/message' && event.data.message.id === f.answer.id))
  const summary = compact(f, targets, 'SUMMARY')
  const output = projectPresetRequest(f.request(), f.session)
  const summaryIndex = output.messages.findIndex(message => message.id === summary.data.id)
  expect(textOf(output.messages[summaryIndex + 1]!)).toBe('INSIDE-SUMMARY')
  compact(f, [summary], 'EDITED', 'editor')
  expect(() => projectPresetRequest(f.request(), f.session)).toThrow('没有合法压缩映射')
})

it('载体被压缩时可读日志取回计划，但当前轮输入 frontier 依赖必须明确失败', () => {
  const f = factory(); const carrier = f.publish()
  const event = f.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === carrier.id)!
  compact(f, [event], 'CARRIER-SUMMARY')
  expect(() => projectPresetRequest(f.request(), f.session)).toThrow('首次输入边界已被压缩')
  f.record.layout.entries = [entry('ONLY-PREFIX', 'system', { kind: 'before-history', anchor: f.record.layout.history[0]! })]
  // 日志来源的纯前置布局不依赖首次输入尾边界，允许载体被正常压缩。
  const replacement = createPresetPlanMessage(f.record)
  f.session.append('user/message', replacement, { surfaceOp: 'append' })
  const second = f.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === replacement.id)!
  compact(f, [second], 'SECOND-CARRIER-SUMMARY')
  expect(projectPresetRequest(f.request(), f.session).messages.map(textOf)).toContain('ONLY-PREFIX')
})

it('缺失、过期、跨会话及无 ID 布局均明确失败；不会从相同正文猜锚点', () => {
  const f = factory()
  expect(() => projectPresetRequest(f.request(), f.session)).toThrow('缺少当前会话')
  f.record.turn = 0; f.publish()
  expect(() => projectPresetRequest(f.request(), f.session)).toThrow('旧轮次')
  f.record.turn = 1; f.record.sessionId = 'another-session'; f.publish()
  expect(() => projectPresetRequest(f.request(), f.session)).toThrow('缺少当前会话')
  f.record.sessionId = f.session.id
  delete f.record.layout.history[0]!.messageId
  f.record.layout.entries[0]!.placement = { kind: 'before-history', anchor: f.record.layout.history[0]! }
  f.publish()
  expect(() => projectPresetRequest(f.request(), f.session)).toThrow('历史锚点已缺失')
})

it('拒绝不精确模板降级和 standing 不匹配，辅助调用保持原请求语义', () => {
  const f = factory(); f.record.layout.entries[0]!.compatibilityFallback = true; f.publish()
  expect(() => projectPresetRequest(f.request(), f.session)).toThrow('模板精确位置')
  delete f.record.layout.entries[0]!.compatibilityFallback
  f.record.standingText += '\nMISMATCH'; f.publish()
  expect(() => projectPresetRequest(f.request(), f.session)).toThrow('standing 与冻结布局不匹配')
  const auxiliary = { ...f.request(), purpose: 'compaction' as const }
  expect(projectPresetRequest(auxiliary, f.session)).toEqual(auxiliary)
})

it('适配器投影每次读取 SessionStore 当前会话，拒绝无会话及下一轮旧计划', async () => {
  const f = factory(); f.publish()
  const ctx = new Context()
  new SessionStore(ctx)
  try {
    const session = ctx.sessions.create(f.session.id, { seed: f.session.snapshotEvents() })
    const projector = createPresetRequestProjector(ctx)
    expect(textOf(projector.project({ ...f.request(), messages: session.deriveMessages() }, {}).messages.at(-1)!)).toBe('ASSISTANT-PREFILL')
    session.append('turn/start', { turn: 2 })
    expect(() => projector.project({ ...f.request(), messages: session.deriveMessages() }, {})).toThrow('第 2 轮')
    expect(() => projector.project({ ...f.request(), sessionId: SessionId('missing') }, {})).toThrow('找不到当前 Session')
  } finally { await ctx.fiber.dispose() }
})

it('拒绝超量来源元数据，避免把无界计划写进会话日志', () => {
  const f = factory()
  f.record.layout.entries = Array.from({ length: 9 }, (_, index) => ({ ...entry(`large-${index}`, 'system', { kind: 'before-history' }), content: 'x'.repeat(1024 * 1024) }))
  expect(() => createPresetPlanMessage(f.record)).toThrow('8 MiB')
})

it('in-history 每条 system 都是完整快照，尾条不覆盖 SDK 或先前规则，原历史不变', () => {
  const f = factory(); f.publish()
  const request = f.request(), original = JSON.stringify(request)
  const output = projectPresetRequest(request, f.session, { model: { systemPromptUpdate: 'in-history' } })
  const systems = output.messages.filter(message => message.role === 'system')
  for (const system of systems) expect(textOf(system)).toContain('HOST-TOOLS')
  const latest = textOf(systems.at(-1)!)
  for (const text of [BOUND_DISCIPLINE, TURN_PLAYBOOK, 'MAIN', 'DEPTH-0-SYSTEM', 'HOST-END']) expect(latest).toContain(text)
  expect(latest.match(/HOST-TOOLS/g)).toHaveLength(1)
  expect(latest).not.toContain('LEGACY-STANDING')
  expect(JSON.stringify(request)).toBe(original)
  expect(output.messages.indexOf(systems.at(-1)!)).toBeGreaterThan(output.messages.indexOf(f.current))
})

it('只支持首条 system 的模型合并系统预设，保留其它角色及图片并明确报告能力差异', () => {
  const f = factory(); f.publish()
  const diagnostics: PresetProjectionDiagnostic[] = []
  const request = f.request()
  const output = projectPresetRequest(request, f.session, { model: {}, onDiagnostic: item => diagnostics.push(item) })
  expect(output.messages.filter(message => message.role === 'system')).toHaveLength(1)
  for (const text of ['HOST-TOOLS', TURN_PLAYBOOK, 'MAIN', 'DEPTH-0-SYSTEM']) expect(textOf(output.messages[0]!)).toContain(text)
  expect(output.messages.find(message => message.id === f.current.id)).toBe(request.messages.find(message => message.id === f.current.id))
  expect(output.messages.find(message => textOf(message) === 'DEPTH-1-USER')?.role).toBe('user')
  expect(output.messages.at(-1)?.role).toBe('assistant')
  expect(diagnostics).toEqual([{ kind: 'leading-system-only' }, expect.objectContaining({ kind: 'text-budget' })])
})

it('相邻自有 system 合并后再累计，保留宿主 system 边界、稳定首条 ID 及冻结逻辑布局', () => {
  const f = factory()
  const foreign = createSystemMessage('FOREIGN-SYSTEM', 'foreign')
  f.session.append('system/message', { turn: 1, step: 1, message: foreign }, { surfaceOp: 'append' })
  const anchor = { inputIndex: 3, messageId: foreign.id, role: 'system' as const, chat: false }
  f.record.layout.history.push(anchor)
  f.record.layout.entries = [entry('A', 'system', { kind: 'before-history' }), entry('B', 'system', { kind: 'before-history' }),
    entry('C', 'system', { kind: 'history-relative', anchor, side: 'before' }), entry('D', 'system', { kind: 'history-relative', anchor, side: 'before' }),
    entry('E', 'system', { kind: 'history-relative', anchor, side: 'after' }), entry('F', 'system', { kind: 'history-relative', anchor, side: 'after' })]
  f.publish()
  const request = f.request(), original = JSON.stringify(request)
  const logical = projectPresetRequest(request, f.session)
  const output = projectPresetRequest(request, f.session, { model: { systemPromptUpdate: 'in-history' } })
  const systems = output.messages.filter(message => message.role === 'system')
  expect(systems).toHaveLength(5)
  expect(textOf(systems[1]!)).toContain('A\n\nB')
  expect(textOf(systems[2]!)).toContain('C\n\nD')
  expect(systems[2]!.id).toBe(logical.messages.find(message => textOf(message) === 'C')!.id)
  expect(systems[3]!.id).toBe(foreign.id)
  expect(systems[3]!.source).toEqual(foreign.source)
  expect(textOf(systems[3]!)).not.toContain('\n\nE')
  expect(textOf(systems[4]!)).toContain('E\n\nF')
  expect(textOf(systems[4]!)).toContain('HOST-TOOLS')
  expect(JSON.stringify(request)).toBe(original)
  expect(f.record.layout.entries).toHaveLength(6)
})

it('文本预算诊断使用同代模型窗口和输出预留，超量提示不按粗估拒绝消息或计入图片工具编码', () => {
  const f = factory(); f.publish()
  const diagnostics: PresetProjectionDiagnostic[] = []
  const request = { ...f.request(), maxTokens: 20, system: '旧式 system' }
  const output = projectPresetRequest(request, f.session, { model: { systemPromptUpdate: 'in-history', context: { contextWindow: 100 }, defaultMaxTokens: 30 },
    onDiagnostic: diagnostic => diagnostics.push(diagnostic) })
  const tokens = (messages: readonly Message[]) => estimateTokens(request.system) + messages.reduce((total, message) => total
    + message.content.reduce((count, block) => count + (block.type === 'text' ? estimateTokens(block.text) : 0), 0), 0)
  expect(diagnostics).toEqual([{ kind: 'text-budget', beforeTextTokens: tokens(request.messages), afterTextTokens: tokens(output.messages),
    contextWindow: 100, reservedOutputTokens: 20, availableTextTokens: 80, exceedsAvailable: true }])
  expect(output.messages.find(message => message.id === f.current.id)?.content).toEqual(f.current.content)
  expect(output.tools).toBe(request.tools)
})

it('完整 system 快照膨胀在分配超量结果前明确失败', () => {
  const f = factory()
  f.record.layout.entries = Array.from({ length: 7 }, (_, index) => [
    { ...entry(`large-${index}`, 'system', { kind: 'before-history' }), content: 'x'.repeat(1024 * 1024) },
    entry(`separator-${index}`, 'user', { kind: 'before-history' }),
  ]).flat()
  f.publish()
  expect(() => projectPresetRequest(f.request(), f.session, { model: { systemPromptUpdate: 'in-history' } })).toThrow('16 MiB')
})
