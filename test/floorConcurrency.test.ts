/**
 * 楼层并发隔离测试（事务层重构：同一张卡的并发会话各有独立楼层，问题1/问题2修复）。
 * 覆盖：
 * - 同卡两会话交错 begin/写/commit：WAL 快照各归各楼层互不污染，共享句柄 floor 恒为 null，
 *   回滚其中一会话的楼层只撤销该会话的写入，另一会话的写入原样保留；
 * - saveTimers 传 floor 记进该楼层 WAL、缺省不记 WAL（fork 复制/未开楼层会话的语义保持）；
 * - 写工具的事务边界（tools.ts resolveCtx）：楼层未开启报 floor-not-open；
 *   生成中换绑（openFloors entry 的卡 ≠ 当前绑定卡）报 binding-changed 拒绝写入；
 *   楼层卡与绑定卡一致时正常落盘并记进本会话楼层 WAL；
 * - tavern_asset_list 遍历时跳过 state/wal 与 memory/archive（问题9：不再整棵走完再过滤）。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { EMPTY_TIMER_STATE, type CharacterCard } from '../src/core/types.js'
import { loadBinding, saveBinding, type SessionBinding } from '../src/node/bindings.js'
import { resolveConfig } from '../src/node/config.js'
import type { TavernPaths } from '../src/node/paths.js'
import { TavernState } from '../src/node/state.js'
import { registerTavernTools } from '../src/node/tools.js'
import { importCard } from '../src/state/workspace.js'

let root: string
let paths: TavernPaths
let state: TavernState

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'floor-concurrency-test-'))
  paths = {
    root,
    characters: join(root, 'characters'),
    lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'),
    personas: join(root, 'personas'),
    regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions'),
  }
  state = new TavernState(paths, () => resolveConfig({}))
  await state.init()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    spec: 'chara_card_v2',
    name: '测试角色',
    description: '描述',
    personality: '',
    scenario: '',
    firstMes: '你好',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    creator: 'tester',
    characterVersion: '1',
    tags: [],
    characterBook: null,
    regexScripts: [],
    extensions: {},
    pngBytes: null,
    raw: {},
    depthPrompt: null,
    ...overrides,
  }
}

function makeBinding(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    sessionId: 'sess-1',
    cardId: 'c1',
    cardName: '测试角色',
    presetId: null,
    personaId: null,
    lorebookIds: [],
    characterLorebookId: null,
    interactiveCards: null,
    greetingIndex: 0,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  }
}

/** 与 host（index.ts onTurnStart）同形的开层动作：wal.beginFloor + openFloors 记 entry。 */
async function openFloor(sessionId: string, cardId: string, turn: number): Promise<string> {
  const binding = await state.loadBinding(sessionId)
  const storyId = binding?.cardId === cardId ? binding.storyId : undefined
  const ws = await state.storyWorkspace(cardId, storyId)
  const floor = `${sessionId}#t${turn}`
  await ws.wal.beginFloor(floor)
  state.openFloors.set(sessionId, { cardId, storyId, floor })
  return floor
}

/** WAL 目录名与 sanitizeFloor 同形（# → _）。 */
function walDirOf(cardId: string, floor: string): string {
  const storyId = state.openFloors.get(floor.split('#t')[0]!)?.storyId
  return join(paths.characters, cardId, ...(storyId ? ['stories', storyId] : []), 'state', 'wal', floor.replace(/[^A-Za-z0-9_.-]/g, '_'))
}

async function recordPaths(cardId: string, floor: string): Promise<string[]> {
  const raw = await readFile(join(walDirOf(cardId, floor), 'records.jsonl'), 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => (JSON.parse(line) as { path: string }).path)
}

/** 注册 7 个工具并按名字取用（绕过宿主注册表，直接驱动 execute）。 */
function collectTools(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: {
      register: (def: ToolDefinition) => {
        tools.set(def.name, def)
      },
    },
  }
  registerTavernTools(ctx as unknown as Context, state)
  return tools
}

function execOf(sessionId: string): ToolRunContext {
  return { agent: { id: sessionId, inject: vi.fn() } } as unknown as ToolRunContext
}

describe('同卡并发会话的楼层隔离', () => {
  it('两会话交错 begin/写/commit：WAL 各归各楼层，回滚只撤本会话写入', async () => {
    const { cardId } = await importCard(paths.characters, makeCard())
    const ws = await state.workspace(cardId)
    // 楼层开启前的既有内容（非会话写入，floor=null 不记 WAL）
    await ws.fs.writeText('journal.md', '旧日志')

    const floorA = await openFloor('sess-a', cardId, 1)
    const floorB = await openFloor('sess-b', cardId, 1)
    // 共享句柄不再携带楼层：并发会话不可能互相覆盖 floor
    expect(ws.fs.currentFloor).toBeNull()

    // 两个楼层都未提交时交错写入：A 改既有文件 + 新建文件，B 写另一个文件
    const fsA = ws.fs.withFloor(floorA)
    const fsB = ws.fs.withFloor(floorB)
    await fsA.writeText('journal.md', '会话 A 的改写')
    await fsB.writeText('assets/chat-lorebook.json', '{"entries":{}}\n')
    await fsA.writeText('memory/only-a.md', '---\ncreated: 2026-01-01\n---\n\n只有 A 写过\n')

    // B 先提交、A 后提交：提交顺序不影响归属
    await ws.wal.commitFloor(floorB)
    await ws.wal.commitFloor(floorA)

    // 快照各归各楼层：A 的楼层没有 B 的路径，反之亦然
    expect((await recordPaths(cardId, floorA)).sort()).toEqual(['journal.md', 'memory/only-a.md'])
    expect(await recordPaths(cardId, floorB)).toEqual(['assets/chat-lorebook.json'])

    // 回滚 A 的楼层：只撤销 A 的写入，B 的写入原样保留
    const restored = await ws.wal.rollbackFloor(floorA, join(paths.characters, cardId))
    expect(restored.sort()).toEqual(['journal.md', 'memory/only-a.md'])
    expect(await ws.fs.readText('journal.md')).toBe('旧日志')
    expect(await ws.fs.readText('memory/only-a.md')).toBeNull()
    expect(await ws.fs.readText('assets/chat-lorebook.json')).toBe('{"entries":{}}\n')
  })

  it('saveTimers 传 floor 记进该楼层 WAL；缺省 floor 不记 WAL', async () => {
    const { cardId } = await importCard(paths.characters, makeCard())
    const ws = await state.workspace(cardId)
    const floorA = await openFloor('sess-a', cardId, 1)

    // turn 流程（pipeline 首次评估）：经 openFloors entry 的 floor 写入 → 记 WAL
    const entry = state.openFloors.get('sess-a')!
    await state.saveTimers(cardId, 'sess-a', structuredClone(EMPTY_TIMER_STATE), entry.cardId === cardId ? entry.floor : null)
    // 非会话写路径（fork 复制/未开楼层会话）：缺省 floor → 不记 WAL
    await state.saveTimers(cardId, 'sess-b', structuredClone(EMPTY_TIMER_STATE))

    expect(await recordPaths(cardId, floorA)).toEqual(['state/wi-timers/sess-a.json'])
    // sess-b 的定时器照常落盘，只是不进任何楼层
    expect(await ws.fs.readText('state/wi-timers/sess-b.json')).not.toBeNull()
    expect(await ws.wal.listFloors()).toHaveLength(1)
  })
})

describe('写工具的事务边界（resolveCtx）', () => {
  it('楼层未开启：floor-not-open；生成中换绑：binding-changed；同卡：正常写入记 WAL', async () => {
    const cardA = await importCard(paths.characters, makeCard({ name: '卡A' }))
    const cardB = await importCard(paths.characters, makeCard({ name: '卡B' }))
    await saveBinding(paths, makeBinding({ sessionId: 'sess-1', cardId: cardA.cardId, cardName: '卡A' }))
    const tools = collectTools()
    const memoryWrite = tools.get('tavern_memory_write')!
    const exec = execOf('sess-1')
    type Result = { ok: boolean; error?: string; id?: string }

    // 楼层未开启（turn 未开始或 beginFloor 失败）：拒绝写入
    const noFloor = (await memoryWrite.execute({ body: '卡A 的事实' }, exec)) as Result
    expect(noFloor.ok).toBe(false)
    expect(noFloor.error).toContain('floor-not-open')

    // 楼层开在卡 A 上、绑定也在卡 A：正常写入，快照记进本会话楼层
    const floor = await openFloor('sess-1', cardA.cardId, 1)
    const written = (await memoryWrite.execute({ body: '卡A 的事实' }, exec)) as Result
    expect(written.ok).toBe(true)
    const pathsA = await recordPaths(cardA.cardId, floor)
    expect(pathsA.some((p) => p.startsWith('memory/'))).toBe(true)
    expect(pathsA).toContain('index.json')

    // 生成中换绑到卡 B：楼层还开在卡 A 上，拒绝写入（跨卡记 WAL 会让回滚边界错乱）
    await saveBinding(paths, makeBinding({ sessionId: 'sess-1', cardId: cardB.cardId, cardName: '卡B' }))
    const rebound = (await memoryWrite.execute({ body: '换绑后的事实' }, exec)) as Result
    expect(rebound.ok).toBe(false)
    expect(rebound.error).toContain('binding-changed')
    // 被拒绝的写入没有在卡 B 工作区落盘
    const wsB = await state.workspace(cardB.cardId)
    expect(await wsB.fs.list('memory')).toEqual([])
  })
})

describe('tavern_asset_list 遍历跳过只增不查目录', () => {
  it('files 不含 state/wal 与 memory/archive，其余可读白名单文件仍在', async () => {
    const { cardId } = await importCard(paths.characters, makeCard())
    await saveBinding(paths, makeBinding({ sessionId: 'sess-1', cardId, cardName: '测试角色' }))
    const binding = await state.loadBinding('sess-1')
    const ws = await state.storyWorkspace(cardId, binding!.storyId)
    // 只增不查的目录：WAL 楼层（含回滚残留）与记忆归档
    const floor = await openFloor('sess-1', cardId, 1)
    await ws.fs.withFloor(floor).writeText('journal.md', '记进楼层的改写')
    await ws.wal.commitFloor(floor)
    await ws.memory.write({ body: '活跃记忆' })
    await ws.fs.writeText('memory/archive/m-old.md', '---\ncreated: 2025-01-01\n---\n\n已归档\n')
    // state/ 下其余可读文件（非 wal）：变化层 jsonl
    await ws.deltas.append({ type: 'add', ref: null, content: '一条世界状态', keys: [], order: 100, sourceRange: 't1', expires: null })

    const tools = collectTools()
    const assetList = tools.get('tavern_asset_list')!
    const result = (await assetList.execute({}, execOf('sess-1'))) as { ok: boolean; files: string[] }
    expect(result.ok).toBe(true)
    expect(result.files).toContain('journal.md')
    expect(result.files.some((p) => p.startsWith('memory/') && !p.startsWith('memory/archive/'))).toBe(true)
    // state/wal 与 memory/archive 在遍历阶段就被跳过，不进入目录
    expect(result.files.some((p) => p.startsWith('state/wal'))).toBe(false)
    expect(result.files.some((p) => p.startsWith('memory/archive/'))).toBe(false)
    // state/ 下其余可读文件仍在白名单口径内（list 与 asset_read 一致）
    expect(result.files).toContain('state/world-delta.jsonl')
  })
})
