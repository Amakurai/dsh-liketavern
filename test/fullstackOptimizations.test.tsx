/** 全栈性能与边界优化回归：覆盖核心分词与组装预算、状态存储缓存与 WAL/记忆回滚一致性、宿主代理去重与缓存清理、以及前端对话框与长列表增量渲染。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReactNode } from 'react'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assemblePrompt } from '../src/core/assemble.js'
import { installCardPersistence } from '../src/core/cardPersistence.js'
import { helperJson } from '../src/core/helperRuntime.js'
import { budgetMemorySearch } from '../src/core/memoryToolBudget.js'
import { analyzeText, estimateTokens, tokenize } from '../src/core/tokenize.js'
import type { CharacterCard, MemoryEntry, PresetEntry, PromptPreset } from '../src/core/types.js'
import { embedCardInPng, parseJsonCard, parsePngCard } from '../src/state/card.js'
import { serializeMemory } from '../src/state/memory.js'
import { expandAffectedMemories } from '../src/state/memoryRollback.js'
import { loadTemplateMetadata, loadTemplateState, saveTemplateState } from '../src/state/template.js'
import { templatePreloadRevision } from '../src/state/templateContinuation.js'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { installTavernModelSelectionCompat } from '../src/node/modelRoute.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'
import { attachCardBridgeRuntime, attachHelperEvents, hasHelperEventAudience } from '../src/client/helperEventRouter.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { PresetsSection } from '../src/client/panel/presets.js'
import type { Envelope, TavernRemote } from '../src/client/types.js'
import { ConfirmDialog, Dialog } from '../src/client/util.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={props.onClick} disabled={props.disabled}>{props.children}</button>
  ),
  Modal: (props: { open: boolean; className?: string; children?: ReactNode; footer?: ReactNode }) => (
    props.open ? <div role="dialog" data-classname={props.className}>{props.children}{props.footer}</div> : null
  ),
  Menu: (props: { anchor?: ReactNode }) => <>{props.anchor}</>,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Toast: () => null,
  IconChevronDownOutlineMedium: () => null,
  IconSearchOutlineMedium: () => null,
  IconUserOutlineMedium: () => null,
  IconArchiveOutlineMedium: () => null,
  IconDownloadOutlineMedium: () => null,
  IconEditOutlineMedium: () => null,
  IconFolderOpenOutlineMedium: () => null,
  IconListPenOutlineMedium: () => null,
  IconTrashOutlineMedium: () => null,
  IconPlusOutlineMedium: () => null,
  IconRefreshOutlineMedium: () => null,
}))

const directories: string[] = []
const mounted: ReactTestRenderer[] = []
const ok = <T,>(value: T): Envelope<T> => ({ ok: true, value })

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  directories.push(dir)
  return dir
}

async function render(node: ReactNode): Promise<ReactTestRenderer> {
  let view!: ReactTestRenderer
  await act(async () => {
    view = create(node)
  })
  mounted.push(view)
  return view
}

function makeCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    id: 'card-opt',
    spec: 'chara_card_v2',
    name: 'Alice',
    description: 'Calm investigator',
    personality: 'Sharp',
    scenario: 'Harbor night',
    firstMessage: 'Good evening.',
    alternateGreetings: [],
    exampleMessages: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    creator: 'tester',
    version: '1',
    tags: [],
    extensions: {},
    depthPrompt: null,
    regexScripts: [],
    pngBytes: null,
    ...overrides,
  }
}

function makePreset(entries: PresetEntry[], name = 'OptPreset'): PromptPreset {
  return {
    identifier: 'opt-preset',
    name,
    sampling: { temperature: 1, maxTokens: 2048 },
    entries,
  }
}

beforeEach(() => {
  setTavernLocale('zh')
})

afterEach(async () => {
  for (const view of mounted.splice(0)) {
    await act(async () => {
      view.unmount()
    })
  }
  while (directories.length > 0) {
    await rm(directories.pop()!, { recursive: true, force: true })
  }
})

describe('Core optimizations', () => {
  it('tokenize matches analyzeText terms without divergent edge cases', () => {
    const samples = [
      '',
      '   \t\n  ',
      'Alice met Bob at Café_01 for long-term check.',
      '她带着《月影》进入第3区，与Alice讨论apple派。',
      "It's Bob's plan — don't reveal M or T's secret!",
      'ひらがな カタカナ 한글 test_2',
    ]
    for (const sample of samples) {
      expect(tokenize(sample)).toEqual(analyzeText(sample).terms)
    }
  })

  it('budgetMemorySearch keeps exact serialized tokensUsed within tight limit and drops undefined sourceRange', () => {
    const hits: Array<{ entry: MemoryEntry; score: number }> = [
      {
        score: 9.2,
        entry: {
          id: 'mem-1',
          file: 'mem-1.md',
          archived: false,
          sourceRange: undefined as unknown as string,
          tags: ['harbor', 'clue', 'night', 'witness'],
          keys: ['key1', 'key2', 'key3'],
          created: '2026-01-01T00:00:00.000Z',
          updated: '2026-01-01T00:00:00.000Z',
          body: 'Detailed clue body '.repeat(20),
        },
      },
      {
        score: 7.4,
        entry: {
          id: 'mem-2',
          file: 'archive/mem-2.md',
          archived: true,
          sourceRange: 'merge:mem-src-1,mem-src-2',
          tags: ['t1', 't2'],
          keys: ['k1', 'k2'],
          created: '2026-01-02T00:00:00.000Z',
          updated: '2026-01-02T00:00:00.000Z',
          body: 'Second clue body '.repeat(15),
        },
      },
    ]

    for (const budget of [120, 260, 1000]) {
      const response = budgetMemorySearch(hits, budget)
      expect(response.ok).toBe(true)
      expect(response.tokensUsed).toBeLessThanOrEqual(budget)
      expect(response.tokensUsed).toBe(estimateTokens(JSON.stringify(response, null, 2)))
      if (response.results!.length > 0) {
        expect('sourceRange' in JSON.parse(JSON.stringify(response.results![0]!))).toBe(false)
      }
      if (budget >= 1000) {
        expect(response.results!.length).toBeGreaterThan(0)
      }
      if (response.results!.length > 1 && !response.results![1]!.sourceRangeOmitted) {
        expect(response.results![1]!.sourceRange).toBe('merge:mem-src-1,mem-src-2')
      }
    }

    const empty = budgetMemorySearch([], 150, { emptyHint: 'try synonym' })
    expect(empty.ok).toBe(true)
    expect(empty.hint).toBe('try synonym')
    expect(empty.tokensUsed).toBe(estimateTokens(JSON.stringify(empty, null, 2)))
  })

  it('assemblePrompt preserves multi-depth insertion and history trimming order', () => {
    const preset = makePreset([
      { identifier: 'main', name: 'Main', role: 'system', enabled: true, position: 'relative', order: 10, depth: 4, marker: false, content: 'SYS_MAIN' },
      { identifier: 'chatHistory', name: 'History', role: 'system', enabled: true, position: 'relative', order: 20, depth: 4, content: '', marker: true },
      { identifier: 'd2b', name: 'D2B', role: 'system', enabled: true, position: 'in-chat', order: 20, depth: 2, marker: false, content: 'DEPTH_2_SECOND' },
      { identifier: 'd2a', name: 'D2A', role: 'user', enabled: true, position: 'in-chat', order: 5, depth: 2, marker: false, content: 'DEPTH_2_FIRST' },
      { identifier: 'd0', name: 'D0', role: 'system', enabled: true, position: 'in-chat', order: 1, depth: 0, marker: false, content: 'DEPTH_0_AFTER' },
    ])
    const history = [
      { role: 'user' as const, content: 'M1 oldest '.repeat(25) },
      { role: 'assistant' as const, content: 'M2 reply' },
      { role: 'user' as const, content: 'M3 turn' },
      { role: 'assistant' as const, content: 'M4 latest' },
    ]
    const result = assemblePrompt({
      preset,
      card: makeCard(),
      personaDescription: '',
      history,
      wi: null,
      memories: [],
      worldDeltas: [],
      macroCtx: { char: 'Alice', user: 'Bob', description: '', personality: '', scenario: '', persona: '', mesExamples: '', worldInfoBefore: '', worldInfoAfter: '', authorNote: '', chatHistory: history, outlets: new Map(), variables: new Map(), turnVariables: new Map(), messageCount: history.length },
      regexRules: [],
      estimateTokens: (text) => Math.max(1, Math.ceil(text.length / 4)),
      budget: { maxTokens: 70, reserveForOutput: 5 },
    })

    const contents = result.messages.map((m) => m.content)
    expect(contents).toContain('SYS_MAIN')
    expect(contents).toContain('DEPTH_0_AFTER')
    expect(contents.indexOf('DEPTH_2_FIRST')).toBeGreaterThan(-1)
    expect(contents.indexOf('DEPTH_2_SECOND')).toBeGreaterThan(contents.indexOf('DEPTH_2_FIRST'))
    expect(contents.indexOf('M4 latest')).toBeGreaterThan(contents.indexOf('DEPTH_2_SECOND'))
    expect(contents.indexOf('DEPTH_0_AFTER')).toBeGreaterThan(contents.indexOf('M4 latest'))
    expect(result.stats.trimmedSections).toContain('history')
    expect(result.history.length).toBeLessThan(history.length)
  })

  it('helperJson and installCardPersistence serialized bodies stay self-contained via new Function', () => {
    const serializedHelperJson = new Function(`return (${helperJson.toString()})`)() as typeof helperJson
    expect(serializedHelperJson({ ok: '你好世界', arr: [1, true, null] }, 1024)).toEqual({ ok: '你好世界', arr: [1, true, null] })
    expect(() => serializedHelperJson({ text: 'a'.repeat(300) }, 64)).toThrow()

    const dispatched: unknown[] = []
    const mockWindow = {
      __dshTavernEventRuntimeId: 'rt-self',
      addEventListener: () => {},
      removeEventListener: () => {},
      parent: { postMessage: (msg: unknown) => dispatched.push(msg) },
    }
    const serializedInstall = new Function('window', `return (${installCardPersistence.toString()})`)(mockWindow) as typeof installCardPersistence
    const dispose = serializedInstall(
      {
        storyId: 's1',
        historyRevision: 'h1',
        currentMessageId: 0,
        writable: true,
        scopes: { chat: { hp: 10, drop: undefined, items: ['sword'] } },
        messages: [],
      },
      'test',
      { saving: 'saving', saved: 'saved', failed: 'failed' },
    )
    expect(typeof dispose).toBe('function')
    expect(dispatched).toHaveLength(0)
    dispose()
  })
})

describe('State optimizations', () => {
  it('templateStorage inline warm read skips template-data stats and invalidates on disk tamper', async () => {
    const root = await tempDir('tavern-tpl-opt-')
    const wal = new Wal(join(root, 'state', 'wal'))
    await wal.beginFloor('f1')
    const fs = new WorkspaceFs(root, wal).withFloor('f1')
    await saveTemplateState(fs, {
      version: 1,
      variables: { global: { a: 1 }, local: { hp: 20 }, message: {} },
      outputs: { 0: { hash: 'a'.repeat(64), text: 'hello' } },
    })

    const statSpy = vi.spyOn(fs, 'stat')
    const meta = await loadTemplateMetadata(fs)
    expect(meta.variables).toEqual({ global: { a: 1 }, local: { hp: 20 }, message: {} })
    const full = await loadTemplateState(fs)
    expect(full.outputs[0]?.text).toBe('hello')
    const templateDataStats = statSpy.mock.calls.filter(([path]) => path.startsWith('state/template-data'))
    expect(templateDataStats).toHaveLength(0)
    statSpy.mockRestore()

    await writeFile(join(root, 'state', 'template.json'), '{"bad":true}\n')
    await expect(loadTemplateMetadata(fs)).rejects.toThrow()

    const frozenCtx = Object.freeze({
      phase: 'generate' as const,
      charName: 'Alice',
      userName: 'Bob',
      chatStartIndex: 0,
      variables: Object.freeze({ a: 1 }),
      entries: Object.freeze([]),
      presets: Object.freeze([]),
    })
    expect(templatePreloadRevision(frozenCtx)).toBe(templatePreloadRevision(frozenCtx))
  })

  it('Wal batches recordChanges and detects same-length in-place records corruption', async () => {
    const root = await tempDir('tavern-wal-opt-')
    const wal = new Wal(join(root, 'state', 'wal'))
    await wal.beginFloor('f1')
    const fs = new WorkspaceFs(root, wal).withFloor('f1')
    await fs.writeText('notes/a.txt', 'v1')
    await fs.writeText('notes/b.txt', 'v2')
    await wal.commitFloor('f1')

    const listed = await wal.listFloors()
    expect(listed.map((f) => [f.floor, f.committed])).toEqual([['f1', true]])

    const recordsFile = join(root, 'state', 'wal', 'f1', 'records.jsonl')
    const original = await readFile(recordsFile, 'utf8')
    const badJsonSameLen = '{' + ' '.repeat(original.indexOf('\n') - 1) + original.slice(original.indexOf('\n'))
    expect(Buffer.byteLength(badJsonSameLen)).toBe(Buffer.byteLength(original))
    await writeFile(recordsFile, badJsonSameLen, 'utf8')
    await expect(wal.rollbackFloor('f1', root)).rejects.toThrow()
  })

  it('expandAffectedMemories restores archived sources and deletes dependent summary while preserving unrelated summaries', async () => {
    const root = await tempDir('tavern-mem-rollback-')
    const fs = new WorkspaceFs(root, null)
    await fs.writeText('memory/archive/src-shared.md', serializeMemory({ created: '2026-01-01', updated: '2026-01-01', sourceRange: '', tags: ['t'], keys: ['k'] }, 'shared'))
    await fs.writeText('memory/archive/src-only.md', serializeMemory({ created: '2026-01-01', updated: '2026-01-01', sourceRange: '', tags: ['t'], keys: ['k'] }, 'only'))
    await fs.writeText('memory/sum-rolled.md', serializeMemory({ created: '2026-01-01', updated: '2026-01-01', sourceRange: 'merge:src-shared,src-only', tags: ['t'], keys: ['k'] }, 'rolled'))
    await fs.writeText('memory/sum-other.md', serializeMemory({ created: '2026-01-01', updated: '2026-01-01', sourceRange: 'merge:src-other', tags: ['t'], keys: ['k'] }, 'other'))

    await expandAffectedMemories(root, ['memory/src-only.md'])
    expect(await fs.exists('memory/src-only.md')).toBe(true)
    expect(await fs.exists('memory/src-shared.md')).toBe(true)
    expect(await fs.exists('memory/archive/src-only.md')).toBe(false)
    expect(await fs.exists('memory/archive/src-shared.md')).toBe(false)
    expect(await fs.exists('memory/sum-rolled.md')).toBe(false)
    expect(await fs.exists('memory/sum-other.md')).toBe(true)
  })

  it('embedCardInPng round-trips via zlib crc32 and parseJsonCard rejects cycles and >8MB inputs', () => {
    const stJson = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'CRCAlice', description: '海港', first_mes: 'Hi' } }
    const png = embedCardInPng(null, stJson, 'chara_card_v2')
    const parsed = parsePngCard(png)
    expect(parsed.name).toBe('CRCAlice')
    expect(parsed.description).toBe('海港')

    const cyclic: Record<string, unknown> = { data: {} }
    ;(cyclic.data as Record<string, unknown>).self = cyclic
    expect(() => parseJsonCard(cyclic)).toThrow(/循环/)

    const huge = { data: { name: 'Big', description: 'x'.repeat(8 * 1024 * 1024 + 32) } }
    expect(() => parseJsonCard(huge)).toThrow(/8MB/)
  })
})

describe('Node optimizations', () => {
  it('installTavernModelSelectionCompat unwraps Cordis Proxy so register wraps once and runs only on request/header', () => {
    const registerSpy = vi.fn((_def: unknown) => () => {})
    const underlyingProjections = {
      registrations: new Map<string, { def?: Record<string, unknown> }>(),
      register: registerSpy,
    }
    const listeners: Array<(session: { id: string }, event: { type?: string; data?: unknown }) => void> = []
    const rootCtx = {
      get: (name: string) => {
        if (name !== 'sessionProjections') return undefined
        return new Proxy(underlyingProjections, {
          get(target, prop) {
            if (prop === symbols.original) return target
            return Reflect.get(target, prop)
          },
        })
      },
      on: (_event: string, listener: (session: { id: string }, event: { type?: string; data?: unknown }) => void) => {
        listeners.push(listener)
      },
    }
    ;(rootCtx as unknown as { root: unknown }).root = rootCtx

    installTavernModelSelectionCompat(rootCtx as unknown as Context)
    const wrappedOnce = underlyingProjections.register
    listeners[0]!({ id: 's1' }, { type: 'assistant/message' })
    listeners[0]!({ id: 's1' }, { type: 'request/header', data: {} })
    listeners[0]!({ id: 's1' }, { type: 'request/header', data: {} })
    expect(underlyingProjections.register).toBe(wrappedOnce)
  })

  it('TavernState.deleteLorebook evicts global cache and helper script libraries return isolated clones', async () => {
    const root = await tempDir('tavern-node-opt-')
    const state = new TavernState(
      { root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') },
      () => resolveConfig({}),
    )
    await state.init()

    const book = { entries: { 0: { uid: 0, key: ['dragon'], content: 'Old dragon', comment: 'd1', disable: false } } }
    await state.saveLorebook('WorldOne', book)
    expect((await state.loadLorebookEntries('WorldOne', 'global:WorldOne'))[0]?.content).toBe('Old dragon')
    await state.deleteLorebook('WorldOne')
    expect(await state.loadLorebookEntries('WorldOne', 'global:WorldOne')).toEqual([])
    await state.saveLorebook('WorldOne', { entries: { 0: { uid: 0, key: ['dragon'], content: 'New dragon', comment: 'd1', disable: false } } })
    expect((await state.loadLorebookEntries('WorldOne', 'global:WorldOne'))[0]?.content).toBe('New dragon')

    const initialGlobal = await state.getHelperScriptLibrary({ type: 'global' })
    expect(initialGlobal.trees).toEqual([])
    const saved = await state.saveHelperScriptLibrary({ type: 'global' }, initialGlobal.revision, [
      { id: 'script-1', type: 'script', name: 'Greet', enabled: true, content: 'console.log(1)', info: '', data: { nested: 1 }, button: { enabled: false, buttons: [] } },
    ])
    const readA = await state.getHelperScriptLibrary({ type: 'global' })
    expect(readA.revision).toBe(saved.revision)
    readA.trees[0]!.name = 'MutatedOutside'
    const readB = await state.getHelperScriptLibrary({ type: 'global' })
    expect(readB.trees[0]!.name).toBe('Greet')

    const cardId = (await state.createCharacter('ScriptChar')).cardId
    const charLib = await state.getCharacterHelperScripts(cardId)
    expect(charLib.trees).toEqual([])
    await state.archiveCharacter(cardId)
    await state.deleteCharacter(cardId)
    await expect(state.getCharacterHelperScripts(cardId)).rejects.toThrow(/不存在/)
  })
})

describe('Client & UX optimizations', () => {
  it('Dialog and ConfirmDialog attach dsh-tavern-ui className to outer Modal', async () => {
    const view = await render(
      <>
        <Dialog open title="D1" onClose={() => {}}>body</Dialog>
        <ConfirmDialog open title="D2" description="desc" confirmLabel="OK" onConfirm={() => {}} onCancel={() => {}} />
      </>,
    )
    const modals = view.root.findAllByType('div').filter((node) => node.props.role === 'dialog')
    expect(modals).toHaveLength(2)
    expect(modals[0]!.props['data-classname']).toContain('dsh-tavern-ui')
    expect(modals[1]!.props['data-classname']).toContain('dsh-tavern-ui')
  })

  it('hasHelperEventAudience recognizes live session listeners and ignores previews', () => {
    expect(hasHelperEventAudience('sess-audience')).toBe(false)
    const preview = attachCardBridgeRuntime(() => {})
    expect(hasHelperEventAudience('sess-audience')).toBe(false)
    const live = attachHelperEvents('sess-audience', 'story-1', () => {})
    expect(hasHelperEventAudience('sess-audience')).toBe(true)
    live.dispose()
    preview.dispose()
    expect(hasHelperEventAudience('sess-audience')).toBe(false)
  })

  it('PresetsSection paginates >40 presets & >40 entries and auto-expands on addEntry', async () => {
    const root = await tempDir('tavern-presets-page-')
    const state = new TavernState(
      { root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'), presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') },
      () => resolveConfig({}),
    )
    await state.init()
    const entries: PresetEntry[] = Array.from({ length: 45 }, (_, i) => ({
      identifier: `entry-${i}`,
      name: `Entry ${String(i).padStart(2, '0')}`,
      role: 'system',
      enabled: true,
      position: 'relative',
      order: i * 10,
      depth: 4,
      marker: false,
      content: `content-${i}`,
    }))
    for (let i = 0; i < 45; i++) {
      await state.savePresetSnapshot({ identifier: `preset-${i}`, name: `Preset ${String(i).padStart(2, '0')}`, sampling: { temperature: 1, maxTokens: 2048 }, entries: i === 0 ? entries : [] })
    }
    const service = new TavernService({ reflect: { provide: () => {} } } as unknown as Context, state, {} as TavernSettingsScope)
    const remote = {
      listPresets: vi.fn(async (req: unknown) => ok(await service.listPresets(req as never))),
      getPreset: vi.fn(async (req: { id: string }) => ok(await service.getPreset(req))),
    } as unknown as TavernRemote

    const view = await render(<PresetsSection remote={remote} />)
    await act(async () => {
      await vi.waitFor(() => expect(view.root.findAll((n) => n.props.className === 'dsh-tavern-tile')).toHaveLength(40))
    })

    const loadMoreBtn = view.root.findAllByType('button').find((b) => b.props.children === t('common.loadMore'))!
    await act(async () => {
      loadMoreBtn.props.onClick({ stopPropagation: () => {} })
    })
    expect(view.root.findAll((n) => n.props.className === 'dsh-tavern-tile')).toHaveLength(45)

    const firstTile = view.root.findAll((n) => n.props.className === 'dsh-tavern-tile')[0]!
    await act(async () => {
      firstTile.props.onClick()
      await vi.waitFor(() => expect(view.root.findAllByType('fieldset')).toHaveLength(1))
    })
    expect(view.root.findAll((n) => n.props.className === 'dsh-tavern-entry')).toHaveLength(40)

    const addEntryBtn = view.root.findAllByType('button').find((b) => b.props.children === t('presets.addEntry'))!
    await act(async () => {
      addEntryBtn.props.onClick({ stopPropagation: () => {} })
    })
    expect(view.root.findAll((n) => n.props.className === 'dsh-tavern-entry')).toHaveLength(46)
  })
})
