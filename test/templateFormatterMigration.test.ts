/** 格式化器升级边界：真实剧情文件和 worker 拒绝旧活动日志，保留已完成片段，并覆盖外显哈希看不到的闭包捕获。 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { saveBinding } from '../src/node/bindings.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { parseJsonCard } from '../src/state/card.js'
import { importCard } from '../src/state/workspace.js'
import { loadTemplateState, TEMPLATE_STATE_PATH, type TemplateState } from '../src/state/template.js'
import { parseTemplateReplay } from '../src/state/templateGeneration.js'
import type { TemplateReplay } from '../src/core/templateReplay.js'
import { isolated } from '../src/node/isolated.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const shared = `<% if(!getvar('registered')) {let n=0;activateRegex(/word/g,()=>String(++n),{message:true,sticky:4,uuid:'shared'});setvar('registered',true)} incvar('rounds'); %>`
function event(type: string, data: unknown, seq: number): SessionEvent { return { type, data, seq, time: 0 } as unknown as SessionEvent }
async function fixture(description = shared) {
  const root = await mkdtemp(join(tmpdir(), 'tavern-formatter-upgrade-')); roots.push(root)
  const paths = { root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }
  const fresh = async () => { const state = new TavernState(paths, () => resolveConfig({})); await state.init(); return state }
  const state = await fresh(), card = parseJsonCard({ name: 'Alice', description })
  const { cardId } = await importCard(paths.characters, card)
  await saveBinding(paths, { sessionId: 's1', cardId, cardName: card.name, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  const binding = (await state.loadBinding('s1'))!, ws = await state.storyWorkspace(cardId, binding.storyId)
  const messages: Message[] = [], events: SessionEvent[] = []
  const agent = () => ({ options: {}, session: { id: 's1', snapshotEvents: () => events, deriveMessages: () => messages } } as unknown as Agent)
  const begin = async (turn: number, runtime = state) => {
    events.push(event('turn/start', { turn }, events.length)); await onTurnStart(runtime, 's1', turn)
    const message = createUserMessage({source:{kind:'user'}, content: [{ type: 'text', text: `next ${turn}` }] }); messages.push(message)
    events.push(event('user/message', message, events.length))
  }
  const run = (runtime = state) => runTavernPipeline({ state: runtime, sessionId: 's1', agent: agent(), mode: 'live' })
  const end = async (turn: number, runtime = state, text = 'word') => {
    const message = createAssistantMessage({source:{provider:'factory',model:'factory'}, content: [{ type: 'text', text }] }); messages.push(message)
    const seq = events.length
    events.push(event('assistant/message', { stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }], turn, step: 1, message }, seq))
    events.push(event('turn/end', { turn, reason: { kind: 'completed' } }, events.length))
    await onTurnEnd(runtime, 's1', { id: 's1' as Session['id'], snapshotEvents: () => events })
    return seq
  }
  const raw = async (): Promise<TemplateState> => JSON.parse((await ws.fs.readText(TEMPLATE_STATE_PATH))!) as TemplateState
  const write = (value: TemplateState) => ws.fs.writeText(TEMPLATE_STATE_PATH, JSON.stringify(value))
  return { state, ws, fresh, begin, run, end, raw, write }
}

describe('格式化器持久化版本', () => {
  it('新版本标记覆盖生成与跨轮日志，真实 worker 在重启后继续同一闭包', async () => {
    const f = await fixture(); await f.begin(1); await f.run()
    const prepared = (await loadTemplateState(f.ws.fs)).generation
    expect(prepared?.status === 'prepared' && prepared.replay.formatterVersion).toBe(2)
    const first = await f.end(1)
    const stored = await loadTemplateState(f.ws.fs)
    expect(stored.continuation?.replay?.formatterVersion).toBe(2)
    const restarted = await f.fresh(); await f.begin(2, restarted); await f.run(restarted); const second = await f.end(2, restarted)
    const continued = await loadTemplateState(f.ws.fs)
    expect(continued.outputs[String(first)]?.text).toBe('1')
    expect(continued.outputs[String(second)]?.text).toBe('2')
    expect(continued.variables.message.rounds).toBe(2)
  })

  it('没有活动重放的已完成旧历史照常推进，并原样保留已提交 HTML parts', async () => {
    const f = await fixture('<% incvar("rounds") %>CARD'); await f.begin(1); await f.run(); const seq = await f.end(1, f.state, 'old display')
    const old = await f.raw()
    expect(old.continuation?.replay).toBeUndefined()
    const parts = [{ kind: 'html' as const, text: '<h1>Heading</h1>', title: 'frozen legacy display' }]
    old.outputs[String(seq)]!.parts = parts
    await f.write(old)
    const before = (await loadTemplateState(f.ws.fs)).outputs[String(seq)]
    const restarted = await f.fresh(); await f.begin(2, restarted); await f.run(restarted); await f.end(2, restarted, 'new display')
    expect((await loadTemplateState(f.ws.fs)).outputs[String(seq)]).toEqual(before)
    expect((await loadTemplateState(f.ws.fs)).variables.message.rounds).toBe(2)
  })

  it('旧 prepared 日志在重建前拒绝收口，磁盘状态、WAL 与历史片段不变', async () => {
    const f = await fixture(); await f.begin(1); await f.run()
    const old = await f.raw()
    if (old.generation?.status !== 'prepared') throw Error('fixture has no prepared generation')
    delete old.generation.replay.formatterVersion
    await f.write(old)
    const before = await f.ws.fs.readText(TEMPLATE_STATE_PATH), walBefore = await f.ws.fs.readText('state/wal/s1_t1/records.jsonl')
    const metaBefore = await f.ws.fs.readText('state/wal/s1_t1/meta.json')
    await expect(f.end(1, await f.fresh())).rejects.toThrow(/消息格式化器已更新.*已拒绝执行和提交.*备份.*旧版本/)
    expect(await f.ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
    expect(await f.ws.fs.readText('state/wal/s1_t1/records.jsonl')).toBe(walBefore)
    expect(await f.ws.fs.readText('state/wal/s1_t1/meta.json')).toBe(metaBefore)
    expect((await f.ws.wal.listFloors()).find(floor => floor.floor === 's1#t1')?.committed).toBe(false)
  })

  it('新轮开始前拒绝旧 prepared，不能先终止旧记录或新建 WAL', async () => {
    const f = await fixture('CARD'); await f.begin(1); await f.run()
    const old = await f.raw()
    if (old.generation?.status !== 'prepared') throw Error('fixture has no prepared generation')
    delete old.generation.replay.formatterVersion
    await f.write(old)
    const before = await f.ws.fs.readText(TEMPLATE_STATE_PATH), walBefore = await f.ws.fs.readText('state/wal/s1_t1/records.jsonl')
    const metaBefore = await f.ws.fs.readText('state/wal/s1_t1/meta.json')
    await expect(f.begin(2, await f.fresh())).rejects.toThrow(/消息格式化器已更新/)
    expect(await f.ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
    expect(await f.ws.fs.readText('state/wal/s1_t1/records.jsonl')).toBe(walBefore)
    expect(await f.ws.fs.readText('state/wal/s1_t1/meta.json')).toBe(metaBefore)
    expect((await f.ws.wal.listFloors()).map(floor => floor.floor)).toEqual(['s1#t1'])
  })

  it('无宿主事件但确有开层时仍禁止旧日志 WAL 提交，纯清理入口不能绕过保护', async () => {
    const f = await fixture(); await f.begin(1); await f.run()
    const old = await f.raw()
    if (old.generation?.status !== 'prepared') throw Error('fixture has no prepared generation')
    delete old.generation.replay.formatterVersion
    await f.write(old)
    const before = await f.ws.fs.readText(TEMPLATE_STATE_PATH), walBefore = await f.ws.fs.readText('state/wal/s1_t1/records.jsonl')
    const metaBefore = await f.ws.fs.readText('state/wal/s1_t1/meta.json')
    await expect(onTurnEnd(f.state, 's1')).rejects.toThrow(/消息格式化器已更新/)
    expect(await f.ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
    expect(await f.ws.fs.readText('state/wal/s1_t1/records.jsonl')).toBe(walBefore)
    expect(await f.ws.fs.readText('state/wal/s1_t1/meta.json')).toBe(metaBefore)
  })

  it('宿主重启直接恢复旧 prepared 的后续步骤也拒绝，不能先发布旧入模计划', async () => {
    const f = await fixture(); await f.begin(1); await f.run()
    const old = await f.raw()
    if (old.generation?.status !== 'prepared') throw Error('fixture has no prepared generation')
    delete old.generation.replay.formatterVersion
    await f.write(old)
    const before = await f.ws.fs.readText(TEMPLATE_STATE_PATH), walBefore = await f.ws.fs.readText('state/wal/s1_t1/records.jsonl')
    const metaBefore = await f.ws.fs.readText('state/wal/s1_t1/meta.json'), restarted = await f.fresh()
    await expect(f.run(restarted)).rejects.toThrow(/消息格式化器已更新/)
    expect(restarted.turnPlans.size).toBe(0)
    expect(await f.ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
    expect(await f.ws.fs.readText('state/wal/s1_t1/records.jsonl')).toBe(walBefore)
    expect(await f.ws.fs.readText('state/wal/s1_t1/meta.json')).toBe(metaBefore)
  })

  it('预检之后旧状态被换回时，最终提交锁内仍复核，不能把旧 WAL 当普通模板失败提交', async () => {
    const f = await fixture(); await f.begin(1); await f.run()
    const old = await f.raw()
    if (old.generation?.status !== 'prepared') throw Error('fixture has no prepared generation')
    delete old.generation.replay.formatterVersion
    const replacement = JSON.stringify(old)
    const walBefore = await f.ws.fs.readText('state/wal/s1_t1/records.jsonl'), metaBefore = await f.ws.fs.readText('state/wal/s1_t1/meta.json')
    // 定点故障注入发生在错误上报之后、最终剧情锁之前，真实磁盘保存一份较旧的活动描述。
    vi.spyOn(f.state, 'recordTriggerLog').mockImplementationOnce(() => { writeFileSync(join(f.ws.fs.root, TEMPLATE_STATE_PATH), replacement) })
    await expect(f.end(1, f.state, '<% throw Error("output failed") %>')).rejects.toThrow(/消息格式化器已更新/)
    expect(await f.ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(replacement)
    expect(await f.ws.fs.readText('state/wal/s1_t1/records.jsonl')).toBe(walBefore)
    expect(await f.ws.fs.readText('state/wal/s1_t1/meta.json')).toBe(metaBefore)
  })

  it('旧跨轮闭包即使当前所有操作哈希仍可匹配也明确拒绝，不能默默升级版本或丢弃日志', async () => {
    const f = await fixture(); await f.begin(1); await f.run(); await f.end(1)
    const old = await f.raw(); expect(old.continuation?.replay).toBeDefined()
    delete old.continuation!.replay!.formatterVersion
    await f.write(old)
    const restarted = await f.fresh()
    const before = await f.ws.fs.readText(TEMPLATE_STATE_PATH), walBefore = await f.ws.fs.readText('state/wal/s1_t1/records.jsonl')
    const metaBefore = await f.ws.fs.readText('state/wal/s1_t1/meta.json')
    await expect(f.begin(2, restarted)).rejects.toThrow(/消息格式化器已更新.*跨轮闭包/)
    expect(await f.ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
    expect(await f.ws.fs.readText('state/wal/s1_t1/records.jsonl')).toBe(walBefore)
    expect(await f.ws.fs.readText('state/wal/s1_t1/meta.json')).toBe(metaBefore)
    expect((await f.ws.wal.listFloors()).map(floor => floor.floor)).toEqual(['s1#t1'])
    expect(restarted.turnPlans.size).toBe(0)
  })

  it('嵌套格式化仅捕获到词法变量时外显 render 哈希仍为 ROOT，旧记录也在执行前拒绝', async () => {
    const f = await fixture('CARD'); await f.begin(1); await f.run()
    // 旧 Showdown 2.1.0 对 #Heading 产生 <h1>Heading</h1>；新引擎产生 <p>#Heading</p>。
    // 差异藏在闭包捕获值里，操作返回值却都只是 ROOT，不能凭外显哈希声明无损迁移。
    const source = `<% const captured=await evalTemplate('<'+'%= "#Heading" %'+'>');activateRegex(/word/g,()=>captured,{message:true,sticky:4,uuid:'hidden-format'}); %>ROOT`
    await f.end(1, f.state, source)
    const old = await f.raw(), replay = old.continuation?.replay
    expect(replay).toBeDefined()
    expect(replay!.operations.find(operation => operation.kind === 'render' && operation.text === source)?.hash).toBe(hash('ROOT'))
    expect(replay!.operations.filter(operation => operation.kind === 'format')).toEqual([])
    delete replay!.formatterVersion
    await f.write(old)
    const restarted = await f.fresh()
    const before = await f.ws.fs.readText(TEMPLATE_STATE_PATH), walBefore = await f.ws.fs.readText('state/wal/s1_t1/records.jsonl')
    const metaBefore = await f.ws.fs.readText('state/wal/s1_t1/meta.json')
    await expect(f.begin(2, restarted)).rejects.toThrow(/消息格式化器已更新/)
    expect(await f.ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
    expect(await f.ws.fs.readText('state/wal/s1_t1/records.jsonl')).toBe(walBefore)
    expect(await f.ws.fs.readText('state/wal/s1_t1/meta.json')).toBe(metaBefore)
  })

  it('旧日志仍可只读解析和备份，直接 worker 重建也在执行任何旧操作前拒绝', async () => {
    const f = await fixture(); await f.begin(1); await f.run()
    const stored = await f.raw()
    if (stored.generation?.status !== 'prepared') throw Error('fixture has no replay')
    const replay = structuredClone(stored.generation.replay)
    delete replay.formatterVersion
    const operation = replay.operations.find(candidate => candidate.kind === 'render')
    if (!operation || operation.kind !== 'render') throw Error('fixture has no render operation')
    operation.text = '<% throw Error("old-code-must-not-execute") %>'
    expect(parseTemplateReplay(replay).formatterVersion).toBeUndefined()
    await expect(isolated('template', { texts: ['reply'], replay,
      context: { ...replay.context, variables: stored.variables, phase: 'render' } })).rejects.toThrow(/消息格式化器已更新/)
  })

  it.each([0, 1, 3, '2', null])('未知格式化器版本 %s 在存储和 worker 边界拒绝', async formatterVersion => {
    const f = await fixture(); await f.begin(1); await f.run()
    const stored = await f.raw()
    if (stored.generation?.status !== 'prepared') throw Error('fixture has no replay')
    const replay = { ...stored.generation.replay, formatterVersion }
    expect(() => parseTemplateReplay(replay)).toThrow()
    await expect(isolated('template', { texts: ['must not run'], replay: replay as TemplateReplay,
      context: { ...stored.generation.replay.context, variables: stored.variables, phase: 'render' } })).rejects.toThrow(/格式化器版本不兼容/)
    Object.assign(stored.generation.replay, { formatterVersion })
    await f.write(stored)
    const before = await f.ws.fs.readText(TEMPLATE_STATE_PATH)
    await expect(loadTemplateState(f.ws.fs)).rejects.toThrow()
    expect(await f.ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
  })
})
