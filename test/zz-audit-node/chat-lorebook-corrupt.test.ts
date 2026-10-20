/**
 * 修复回归：损坏的聊天世界书按路径分流。
 * - 组装/模型输入（loadBoundLoreEntries 默认 throw）：明确失败，不静默当空书；
 * - 只读展示与 tavern_lore_read（onCorruptChatBook:'report'）：降级跳过整本书，但必须带
 *   chatBookCorrupt / hint / 展示正文标记，不能与「这本书本来就是空的」不可区分；
 * - 修复后两条路径都恢复。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { TavernConfigSchema, resolveConfig, type TavernConfigRaw, type TavernSettingsScope } from '../../src/node/config.js'
import type { TavernPaths } from '../../src/node/paths.js'
import { loadBoundLoreEntries } from '../../src/node/pipeline.js'
import { TavernService } from '../../src/node/service.js'
import { TavernState } from '../../src/node/state.js'
import { registerTavernTools } from '../../src/node/tools.js'

let root: string
let state: TavernState

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'audit-chat-lorebook-'))
  const paths: TavernPaths = {
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
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

async function boundStory() {
  const { cardId } = await state.createCharacter('聊天书角色')
  await state.saveBinding({
    sessionId: 'chat-book', cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, useEmbeddedLorebook: false, interactiveCards: null, greetingIndex: 0,
    createdAt: new Date(0).toISOString(),
  })
  const binding = (await state.loadBinding('chat-book'))!
  const ws = await state.storyWorkspace(cardId, binding.storyId!)
  return { binding, ws }
}

describe('损坏的聊天世界书', () => {
  it('组装路径（默认 throw）明确失败，不静默缺少整本书', async () => {
    const { binding, ws } = await boundStory()
    await ws.fs.writeText('assets/chat-lorebook.json', '{broken')
    await expect(loadBoundLoreEntries(state, binding)).rejects.toThrow(/聊天世界书损坏/)
    await ws.fs.writeText('assets/chat-lorebook.json', JSON.stringify(42))
    await expect(loadBoundLoreEntries(state, binding)).rejects.toThrow(/聊天世界书损坏/)
  })

  it('report 路径降级但返回 chatBookCorrupt 标记；修复后恢复为 false', async () => {
    const { binding, ws } = await boundStory()
    await ws.fs.writeText('assets/chat-lorebook.json', '{broken')
    const degraded = await loadBoundLoreEntries(state, binding, { onCorruptChatBook: 'report' })
    expect(degraded.chatBookCorrupt).toBe(true)
    expect(degraded.entries.filter((entry) => entry.source === 'chat')).toEqual([])

    await ws.fs.writeText('assets/chat-lorebook.json', JSON.stringify({ entries: {} }))
    const healed = await loadBoundLoreEntries(state, binding, { onCorruptChatBook: 'report' })
    expect(healed.chatBookCorrupt).toBe(false)
    expect(healed.entries.filter((entry) => entry.source === 'chat')).toEqual([])
  })

  it('tavern_lore_read 降级并在 hint 里显式标记；修复后标记消失', async () => {
    const { binding, ws } = await boundStory()
    const tools = new Map<string, ToolDefinition>()
    registerTavernTools({ tools: { register: (def: ToolDefinition) => tools.set(def.name, def) } } as unknown as Context, state)
    const exec = { agent: { id: binding.sessionId, inject: vi.fn() } } as unknown as ToolRunContext

    await ws.fs.writeText('assets/chat-lorebook.json', '{broken')
    const catalog = await tools.get('tavern_lore_read')!.execute({}, exec) as { ok: boolean; hint?: string }
    expect(catalog.ok).toBe(true)
    expect(catalog.hint).toContain('聊天世界书损坏')
    const content = await tools.get('tavern_lore_read')!.execute({ query: '任意' }, exec) as { ok: boolean; hint?: string }
    expect(content.hint).toContain('聊天世界书损坏')

    await ws.fs.writeText('assets/chat-lorebook.json', JSON.stringify({ entries: {} }))
    const healed = await tools.get('tavern_lore_read')!.execute({}, exec) as { ok: boolean; hint?: string }
    expect(healed.hint ?? '').not.toContain('聊天世界书损坏')
  })

  it('只读展示渲染降级：正文带可见标记且不因坏书整条失败；修复后标记消失', async () => {
    const { binding, ws } = await boundStory()
    const config = (TavernConfigSchema as (input: unknown) => TavernConfigRaw)({})
    const ctx = {
      reflect: { provide: () => {} },
      get: () => undefined,
      sessions: { get: () => undefined },
      logger: { warn: vi.fn(), info: vi.fn() },
    } as unknown as Context
    const service = new TavernService(ctx, state, { get: () => config } as unknown as TavernSettingsScope)

    await ws.fs.writeText('assets/chat-lorebook.json', '{broken')
    const degraded = await service.renderOutputText({ sessionId: binding.sessionId, text: '<%= 1 + 1 %>' })
    expect(degraded.text).toContain('2')
    expect(degraded.text).toContain('聊天世界书损坏')

    await ws.fs.writeText('assets/chat-lorebook.json', JSON.stringify({ entries: {} }))
    const healed = await service.renderOutputText({ sessionId: binding.sessionId, text: '<%= 1 + 1 %>' })
    expect(healed.text).toContain('2')
    expect(healed.text).not.toContain('聊天世界书损坏')
  })
})
