/**
 * TavernState：host 侧运行时中枢。
 * 聚合数据目录、设置、各资产存储与工作区句柄，供 remote 服务、工具与组装管线共用。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LlmResolvedModelInfo, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { estimateTokens } from '../core/tokenize.js'
import { EMPTY_TIMER_STATE, type CharacterCard, type MemoryEntry, type PromptPreset, type RegexRule, type WIEngineResult, type WITimerState, type WorldDelta, type WorldInfoEntry } from '../core/types.js'
import { compileCardRegexScripts, compilePresetRegexScripts } from '../core/regex.js'
import { normalizeBook, parseJsonCard, parsePngCard, regexScriptsOf, applyCharacterPatch, cardToStJson, createBlankCard, embedCardInPng } from '../state/card.js'
import { parseLorebook } from '../state/lorebook.js'
import { MemoryStore } from '../state/memory.js'
import { Wal } from '../state/wal.js'
import { WorldDeltaStore } from '../state/worlddelta.js'
import {
  deleteCharacter as deleteCharacterFromDisk,
  importCard as importCardToWorkspace,
  assertValidCardId,
  listCharacters,
  loadCharacter,
  rebuildIndex,
  type CharacterWorkspace,
} from '../state/workspace.js'
import { WorkspaceFs } from '../state/workspaceFs.js'
import { resolveStaleBinding } from '../core/binding.js'
import { pickPersona } from '../core/persona.js'
import { pinStandingText, type StandingPin } from '../core/standingPin.js'
import { clearBindingsForCard, deleteBinding, loadBinding, saveBinding, type SessionBinding } from './bindings.js'
import type { TavernConfig } from './config.js'
import { ensurePaths, type TavernPaths } from './paths.js'

export interface Persona {
  id: string
  name: string
  description: string
  /** 头像文件名（personas/<id>.png），无则 null。 */
  avatar: string | null
  /** 挂接的世界书库文件名；空/缺省 = 无人设书。 */
  lorebookId?: string | null
}

interface WorkspaceHandle {
  fs: WorkspaceFs
  wal: Wal
  memory: MemoryStore
  deltas: WorldDeltaStore
}

export class TavernState {
  private readonly workspaces = new Map<string, WorkspaceHandle>()
  readonly triggerLogs = new Map<string, { at: string; lines: string[] }>()
  /** 会话当前 turn 号（session/event 的 turn/start 维护；WI/记忆检索按 turn 缓存）。 */
  readonly currentTurns = new Map<string, number>()
  /** 当前 turn 内的 step（pre-step / step/start 维护；turn 开始时为 1）。 */
  readonly currentSteps = new Map<string, number>()
  /** 每 turn 一次的 WI/记忆/变化层评估缓存（turn/end 清除）。 */
  readonly wiCache = new Map<string, { turn: number; wi: WIEngineResult; memories: string[]; deltas: WorldDelta[] }>()
  /** 已入 inbox 尚未入日志的用户输入文本（agent/inbox/inserted 维护；turn/end 清除）。 */
  readonly pendingInputs = new Map<string, string[]>()
  /** 会话 standing 钉死（绑定指纹不变则复用第一次写入的字节）。 */
  readonly standingPins = new Map<string, StandingPin>()
  /** standing 依赖资产的进程内修订号：经本类写方法编辑/删除即 bump，standing 指纹随内容变化失效重算。 */
  private readonly assetRevs = new Map<string, number>()
  /** 模型元数据进程内缓存：resolveModelInfo 每步被调（reasoningEffort / 上下文窗口），适配器目录运行期不变。 */
  private readonly modelInfoCache = new Map<string, Promise<LlmResolvedModelInfo>>()
  /** 待异步压缩的角色工作区（memory_write 超容量时标记；idle 期 runMaintenance 消费，见 memoryMaintenance.ts）。 */
  readonly pendingMemoryCompress = new Set<string>()
  /**
   * 会话事件副作用串行队列。session/event 与 inbox 回调本身不能阻塞平台事件派发，
   * 但 beginFloor / 开场白 / commitFloor / idle maintenance 必须保持事件发生顺序。
   */
  private readonly sessionTaskTails = new Map<string, Promise<void>>()

  constructor(
    readonly paths: TavernPaths,
    private readonly getConfig: () => TavernConfig,
  ) {}

  async init(): Promise<void> {
    await ensurePaths(this.paths)
  }

  get config(): TavernConfig {
    return this.getConfig()
  }

  /**
   * 把一个副作用接到同会话队尾；前一任务失败不会毒死后续队列，调用方仍会收到本次异常。
   * 不同会话互不等待，避免把全局运行时退化成单线程。
   */
  enqueueSessionTask<T>(sessionId: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.sessionTaskTails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(task)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.sessionTaskTails.set(sessionId, tail)
    void tail.finally(() => {
      if (this.sessionTaskTails.get(sessionId) === tail) this.sessionTaskTails.delete(sessionId)
    })
    return result
  }

  /** 等待调用时已经排入该会话的副作用完成。 */
  async waitForSessionTasks(sessionId: string): Promise<void> {
    await (this.sessionTaskTails.get(sessionId) ?? Promise.resolve())
  }

  // ── 角色工作区 ────────────────────────────────────────────────────────────

  async workspace(cardId: string): Promise<WorkspaceHandle> {
    // 工作区根必须始终是 characters/ 下的单层目录；否则 WorkspaceFs 自身的
    // 相对路径保护只会约束在错误根目录内，挡不住 `cardId=..` 先把根挪出去。
    assertValidCardId(cardId)
    const cached = this.workspaces.get(cardId)
    if (cached) return cached
    const root = join(this.paths.characters, cardId)
    const wal = new Wal(join(root, 'state', 'wal'))
    const fs = new WorkspaceFs(root, wal)
    const handle: WorkspaceHandle = { fs, wal, memory: new MemoryStore(fs), deltas: new WorldDeltaStore(fs) }
    this.workspaces.set(cardId, handle)
    return handle
  }

  async listCharacters() {
    return listCharacters(this.paths.characters)
  }

  async loadCharacter(cardId: string): Promise<CharacterWorkspace | null> {
    return loadCharacter(this.paths.characters, cardId)
  }

  /** 删除角色卡工作区、清掉指向它的会话绑定，并逐出缓存句柄。cascadeDeleteEmbeddedBook=false 时先把内嵌书抢救到世界书库。 */
  async deleteCharacter(cardId: string): Promise<{ salvagedLorebook: string | null }> {
    let salvagedLorebook: string | null = null
    if (!this.config.cascadeDeleteEmbeddedBook) {
      const book = await this.loadCharacterLorebookRaw(cardId)
      if (book) {
        salvagedLorebook = await this.salvageLorebookName(book.name)
        await this.saveLorebook(salvagedLorebook, book.json)
      }
    }
    await deleteCharacterFromDisk(this.paths.characters, cardId)
    await clearBindingsForCard(this.paths, cardId)
    this.workspaces.delete(cardId)
    return { salvagedLorebook }
  }

  /** 抢救内嵌书到世界书库时的去重文件名（与 saveLorebook 同一套净化规则）。 */
  private async salvageLorebookName(base: string): Promise<string> {
    const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_一-鿿.-]/g, '_')
    const clean = sanitize(base.trim() || 'embedded-book')
    const existing = new Set(await this.listLorebooks())
    if (!existing.has(clean)) return clean
    for (let i = 2; i < 100; i++) {
      const candidate = `${clean}-${i}`
      if (!existing.has(candidate)) return candidate
    }
    return `${clean}-${Date.now()}`
  }

  /** 删除角色卡内嵌世界书（assets/character-book.json + card.json 的 characterBook 置空）。非楼层写入，不记 WAL。 */
  async deleteCharacterLorebook(cardId: string): Promise<void> {
    const charWs = await this.loadCharacter(cardId)
    if (!charWs) throw new Error(`角色 ${cardId} 不存在`)
    const handle = await this.workspace(cardId)
    await handle.fs.delete('assets/character-book.json')
    const cardJson: Record<string, unknown> = { ...charWs.card, characterBook: null }
    delete cardJson.pngBytes
    await handle.fs.writeText('card.json', JSON.stringify(cardJson, null, 2) + '\n')
    this.bumpAssetRev(`charlore:${cardId}`)
  }

  /** 导入角色卡（PNG/JSON 字节），落盘工作区并初始化索引。 */
  async importCharacter(fileName: string, bytes: Uint8Array, opts?: { importWorldBook?: boolean }): Promise<CharacterWorkspace> {
    const card: CharacterCard = /\.png$/i.test(fileName) ? parsePngCard(bytes) : parseJsonCard(JSON.parse(new TextDecoder().decode(bytes)))
    const ws = await importCardToWorkspace(this.paths.characters, card, opts)
    const handle = await this.workspace(ws.cardId)
    await rebuildIndex(handle.fs, estimateTokens)
    return ws
  }

  /**
   * 读取角色卡内嵌世界书原文（card.characterBook 优先，否则 assets/character-book.json）。
   * 供组装管线、工具与设置面板共用，避免只认 library/lorebooks 而漏掉卡内书。
   */
  async loadCharacterLorebookRaw(cardId: string): Promise<{ name: string; json: unknown; entryCount: number } | null> {
    const charWs = await this.loadCharacter(cardId)
    if (!charWs) return null
    const book = charWs.card.characterBook
    if (book && book.entries.length > 0) {
      const json = book.raw ?? { name: book.name ?? charWs.card.name, entries: book.entries }
      return { name: book.name ?? charWs.card.name, json, entryCount: book.entries.length }
    }
    const handle = await this.workspace(cardId)
    const file = await handle.fs.readText('assets/character-book.json')
    if (file === null) return null
    try {
      const json: unknown = JSON.parse(file)
      const normalized = normalizeBook(json)
      if (!normalized || normalized.entries.length === 0) return null
      return { name: normalized.name ?? charWs.card.name, json, entryCount: normalized.entries.length }
    } catch {
      return null
    }
  }

  async saveCharacterLorebook(cardId: string, json: unknown): Promise<{ name: string; entryCount: number }> {
    const book = normalizeBook(json)
    if (!book || book.entries.length === 0) throw new Error('内嵌世界书缺少条目')
    const charWs = await this.loadCharacter(cardId)
    if (!charWs) throw new Error(`角色 ${cardId} 不存在`)
    const handle = await this.workspace(cardId)
    await handle.fs.writeText('assets/character-book.json', JSON.stringify(json, null, 2) + '\n')
    const cardJson: Record<string, unknown> = { ...charWs.card, characterBook: book }
    delete cardJson.pngBytes
    await handle.fs.writeText('card.json', JSON.stringify(cardJson, null, 2) + '\n')
    this.bumpAssetRev(`charlore:${cardId}`)
    return { name: book.name ?? charWs.card.name, entryCount: book.entries.length }
  }

  async saveCharacter(
    cardId: string,
    patch: Parameters<typeof applyCharacterPatch>[1],
  ): Promise<{ cardId: string; name: string }> {
    const charWs = await this.loadCharacter(cardId)
    if (!charWs) throw new Error(`角色 ${cardId} 不存在`)
    if (patch.name !== undefined && !patch.name.trim()) throw new Error('角色名不能为空')
    const next = applyCharacterPatch(charWs.card, patch)
    const handle = await this.workspace(cardId)
    const { pngBytes: _png, ...cardJson } = next
    await handle.fs.writeText('card.json', JSON.stringify(cardJson, null, 2) + '\n')
    this.bumpAssetRev(`card:${cardId}`)
    return { cardId, name: next.name }
  }

  async createCharacter(name: string): Promise<CharacterWorkspace> {
    const card = createBlankCard(name)
    const ws = await importCardToWorkspace(this.paths.characters, card)
    const handle = await this.workspace(ws.cardId)
    await rebuildIndex(handle.fs, estimateTokens)
    this.bumpAssetRev(`card:${ws.cardId}`)
    return ws
  }

  async exportCharacter(cardId: string): Promise<{ json: unknown; pngBase64: string; name: string }> {
    const charWs = await this.loadCharacter(cardId)
    if (!charWs) throw new Error(`角色 ${cardId} 不存在`)
    const json = cardToStJson(charWs.card)
    const handle = await this.workspace(cardId)
    const png = await handle.fs.readBytes('card.png')
    const embedded = embedCardInPng(png, json, charWs.card.spec)
    return { json, pngBase64: Buffer.from(embedded).toString('base64'), name: charWs.card.name }
  }

  async getJournal(cardId: string): Promise<string> {
    const handle = await this.workspace(cardId)
    return (await handle.fs.readText('journal.md')) ?? ''
  }

  async saveJournal(cardId: string, text: string): Promise<void> {
    const handle = await this.workspace(cardId)
    await handle.fs.writeText('journal.md', text)
    await rebuildIndex(handle.fs, estimateTokens)
  }

  async getChatLorebook(cardId: string): Promise<unknown> {
    const handle = await this.workspace(cardId)
    const raw = await handle.fs.readText('assets/chat-lorebook.json')
    if (raw === null) return { entries: {} }
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return { entries: {} }
    }
  }

  async saveChatLorebook(cardId: string, json: unknown): Promise<void> {
    parseLorebook(json, { source: 'chat', sourceRef: 'chat-lorebook' })
    const handle = await this.workspace(cardId)
    await handle.fs.writeText('assets/chat-lorebook.json', JSON.stringify(json, null, 2) + '\n')
    this.bumpAssetRev(`chatlore:${cardId}`)
  }

  // ── 世界书库 ─────────────────────────────────────────────────────────────

  async listLorebooks(): Promise<string[]> {
    const fs = await this.rootFs()
    return (await fs.list('library/lorebooks')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
  }

  /** 读取世界书原始 JSON（供设置面板编辑）；不存在或损坏返回 null。 */
  async loadLorebookJson(name: string): Promise<unknown | null> {
    const safe = name.replace(/[^A-Za-z0-9_一-鿿.-]/g, '_')
    const fs = await this.rootFs()
    const raw = await fs.readText(`library/lorebooks/${safe}.json`)
    if (raw === null) return null
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return null
    }
  }

  async loadLorebookEntries(name: string, source: WorldInfoEntry['source']): Promise<WorldInfoEntry[]> {
    const fs = await this.rootFs()
    const raw = await fs.readText(`library/lorebooks/${name}.json`)
    if (raw === null) return []
    return parseLorebook(JSON.parse(raw), { source, sourceRef: name })
  }

  async saveLorebook(name: string, json: unknown): Promise<void> {
    const safe = name.replace(/[^A-Za-z0-9_一-鿿.-]/g, '_')
    const fs = await this.rootFs()
    await fs.writeText(`library/lorebooks/${safe}.json`, JSON.stringify(json, null, 2) + '\n')
    this.bumpAssetRev(`lore:${name}`)
  }

  async deleteLorebook(name: string): Promise<void> {
    const fs = await this.rootFs()
    await fs.delete(`library/lorebooks/${name}.json`)
    this.bumpAssetRev(`lore:${name}`)
  }

  // ── 预设库 ────────────────────────────────────────────────────────────────

  async listPresets(): Promise<string[]> {
    const fs = await this.rootFs()
    return (await fs.list('library/presets')).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
  }

  async listPresetSummaries(): Promise<Array<{ id: string; name: string; regexCount: number }>> {
    const ids = await this.listPresets()
    const out: Array<{ id: string; name: string; regexCount: number }> = []
    for (const id of ids) {
      const preset = await this.loadPreset(id)
      out.push({
        id,
        name: preset?.name?.trim() || id,
        regexCount: preset?.regexScripts?.length ?? 0,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  }

  async loadPreset(id: string): Promise<PromptPreset | null> {
    const fs = await this.rootFs()
    const raw = await fs.readText(`library/presets/${id}.json`)
    return raw === null ? null : (JSON.parse(raw) as PromptPreset)
  }

  async savePreset(preset: PromptPreset): Promise<void> {
    const safe = preset.identifier.replace(/[^A-Za-z0-9_一-鿿.-]/g, '_')
    const fs = await this.rootFs()
    await fs.writeText(`library/presets/${safe}.json`, JSON.stringify(preset, null, 2) + '\n')
    this.bumpAssetRev(`preset:${preset.identifier}`)
  }

  async deletePreset(id: string): Promise<void> {
    const fs = await this.rootFs()
    await fs.delete(`library/presets/${id}.json`)
    this.bumpAssetRev(`preset:${id}`)
  }

  // ── 人设 ─────────────────────────────────────────────────────────────────

  async listPersonas(): Promise<Persona[]> {
    const fs = await this.rootFs()
    const files = (await fs.list('personas')).filter((f) => f.endsWith('.json'))
    const out: Persona[] = []
    for (const file of files) {
      try {
        out.push(JSON.parse((await fs.readText(`personas/${file}`))!) as Persona)
      } catch {
        // 坏文件跳过
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async loadPersona(id: string | null): Promise<Persona | null> {
    if (!id) return null
    const fs = await this.rootFs()
    const raw = await fs.readText(`personas/${id}.json`)
    if (raw === null) return null
    try {
      return JSON.parse(raw) as Persona
    } catch {
      return null
    }
  }

  /**
   * 本会话实际用人设：绑定指定 > 默认页 > 库里只剩一条。
   * 只建了人设、没在芯片/默认页勾选时，{{user}} 仍应展开成人设名而不是 User。
   */
  async resolvePersona(personaId: string | null): Promise<Persona | null> {
    const bound = await this.loadPersona(personaId)
    const fallback = await this.loadPersona(this.config.defaults.personaId || null)
    if (bound || fallback) return pickPersona(bound, fallback, [])
    return pickPersona(null, null, await this.listPersonas())
  }

  async savePersona(persona: Persona): Promise<void> {
    const fs = await this.rootFs()
    await fs.writeText(`personas/${persona.id}.json`, JSON.stringify(persona, null, 2) + '\n')
  }

  async deletePersona(id: string): Promise<void> {
    const fs = await this.rootFs()
    await fs.delete(`personas/${id}.json`)
  }

  // ── 全局正则 ──────────────────────────────────────────────────────────────

  async listRegexRules(): Promise<RegexRule[]> {
    const fs = await this.rootFs()
    const raw = await fs.readText('regex/rules.json')
    if (raw === null) return []
    try {
      return JSON.parse(raw) as RegexRule[]
    } catch {
      return []
    }
  }

  async saveRegexRules(rules: RegexRule[]): Promise<void> {
    const fs = await this.rootFs()
    await fs.writeText('regex/rules.json', JSON.stringify(rules, null, 2) + '\n')
  }

  /** 某会话生效的全部正则（全局 + 当前角色卡内嵌 + 当前预设内嵌）。 */
  async rulesFor(binding: SessionBinding): Promise<RegexRule[]> {
    const global = await this.listRegexRules()
    const ws = await this.workspace(binding.cardId)
    const raw = await ws.fs.readText('assets/regex-scripts.json')
    let cardRules: RegexRule[] = []
    if (raw !== null) {
      try {
        cardRules = JSON.parse(raw) as RegexRule[]
      } catch {
        cardRules = []
      }
    }
    if (cardRules.length === 0) {
      const loaded = await this.loadCharacter(binding.cardId)
      if (loaded) {
        cardRules = compileCardRegexScripts(regexScriptsOf(loaded.card), binding.cardId)
        if (cardRules.length > 0) {
          await ws.fs.writeText('assets/regex-scripts.json', JSON.stringify(cardRules, null, 2) + '\n')
        }
      }
    }
    let presetRules: RegexRule[] = []
    if (binding.presetId) {
      const preset = await this.loadPreset(binding.presetId)
      if (preset?.regexScripts && preset.regexScripts.length > 0) {
        presetRules = compilePresetRegexScripts(preset.regexScripts, binding.presetId)
      }
    }
    return [...global, ...cardRules, ...presetRules]
  }

  // ── 会话绑定 ──────────────────────────────────────────────────────────────

  /**
   * 读会话绑定；若 cardId 对应工作区已删，按名字或「库里只剩一张卡」改写到新 ID。
   * 人设未绑定时，接到默认页或库里唯一一条，避免 {{user}} 落成 User。
   * 回收失败则删除绑定文件并返回 null，避免 UI 把文件夹 ID 当成角色名。
   */
  async loadBinding(sessionId: string): Promise<SessionBinding | null> {
    const parsed = await loadBinding(this.paths, sessionId)
    if (!parsed) return null
    const characters = await this.listCharacters()
    const resolved = resolveStaleBinding(parsed, characters)
    if (!resolved) {
      this.standingPins.delete(sessionId)
      await deleteBinding(this.paths, sessionId)
      return null
    }
    const persona = await this.resolvePersona(resolved.personaId)
    const personaId = persona?.id ?? null
    const next = personaId !== resolved.personaId ? { ...resolved, personaId } : resolved
    if (next.cardId !== parsed.cardId || next.cardName !== parsed.cardName || next.personaId !== parsed.personaId) {
      await saveBinding(this.paths, next)
    }
    return next
  }

  async saveBinding(binding: SessionBinding): Promise<void> {
    const ws = await this.loadCharacter(binding.cardId)
    return saveBinding(this.paths, { ...binding, cardName: ws?.card.name ?? binding.cardName })
  }

  /** 绑定不变时复用第一次 standing，避免组装抖动打穿 KV。 */
  pinStanding(sessionId: string, fingerprint: string, computed: string): string {
    return pinStandingText(this.standingPins, sessionId, fingerprint, computed)
  }

  private bumpAssetRev(key: string): void {
    this.assetRevs.set(key, (this.assetRevs.get(key) ?? 0) + 1)
  }

  /**
   * standing 指纹的资产修订标记（稳定顺序）：绑定预设 + 全局世界书 + 主世界书（库书或卡内嵌书）。
   * 编辑/删除经本类写方法 bump；运行期绕开 TavernState 手改文件不捕获（standingPins 进程内，重启即清）。
   */
  standingRevTags(binding: SessionBinding, extra?: { personaLorebookId?: string | null }): string[] {
    const presetKey = `preset:${binding.presetId ?? ''}`
    const tags = [`${presetKey}=${this.assetRevs.get(presetKey) ?? 0}`]
    for (const id of binding.lorebookIds) {
      const key = `lore:${id}`
      tags.push(`${key}=${this.assetRevs.get(key) ?? 0}`)
    }
    const charKey = binding.characterLorebookId ? `lore:${binding.characterLorebookId}` : `charlore:${binding.cardId}`
    tags.push(`${charKey}=${this.assetRevs.get(charKey) ?? 0}`)
    tags.push(`card:${binding.cardId}=${this.assetRevs.get(`card:${binding.cardId}`) ?? 0}`)
    tags.push(`chatlore:${binding.cardId}=${this.assetRevs.get(`chatlore:${binding.cardId}`) ?? 0}`)
    if (extra?.personaLorebookId) {
      const key = `lore:${extra.personaLorebookId}`
      tags.push(`${key}=${this.assetRevs.get(key) ?? 0}`)
    }
    return tags
  }

  /**
   * 模型元数据解析缓存：同 provider+model 复用一次解析结果（含 reasoning 档与上下文窗口）。
   * 失败不缓存（删掉条目让下次重试）；signal 只作用于首次真实解析。
   */
  resolveModelInfoCached(llm: LlmRuntime, provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const key = `${provider}\0${model}`
    const cached = this.modelInfoCache.get(key)
    if (cached) return cached
    const promise = llm.resolveModelInfo(provider, model, signal)
    this.modelInfoCache.set(key, promise)
    promise.catch(() => {
      if (this.modelInfoCache.get(key) === promise) this.modelInfoCache.delete(key)
    })
    return promise
  }

  /** 清掉会话绑定文件；空白新对话复用旧会话时用来去掉上次留下的角色卡。 */
  async clearBinding(sessionId: string): Promise<void> {
    this.standingPins.delete(sessionId)
    await deleteBinding(this.paths, sessionId)
  }

  // ── 世界书定时状态（工作区内，随 WAL 回滚） ───────────────────────────────

  async loadTimers(cardId: string, sessionId: string): Promise<WITimerState> {
    const ws = await this.workspace(cardId)
    const raw = await ws.fs.readText(`state/wi-timers/${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`)
    if (raw === null) return structuredClone(EMPTY_TIMER_STATE)
    try {
      return JSON.parse(raw) as WITimerState
    } catch {
      return structuredClone(EMPTY_TIMER_STATE)
    }
  }

  async saveTimers(cardId: string, sessionId: string, state: WITimerState): Promise<void> {
    const ws = await this.workspace(cardId)
    await ws.fs.writeText(`state/wi-timers/${sessionId.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`, JSON.stringify(state, null, 2) + '\n')
  }

  // ── 触发日志（内存态，最近一次组装的明细） ────────────────────────────────

  recordTriggerLog(sessionId: string, lines: string[]): void {
    const max = this.config.triggerLogMax
    this.triggerLogs.set(sessionId, { at: new Date().toISOString(), lines: lines.slice(0, max) })
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private rootFsPromise: Promise<WorkspaceFs> | null = null
  /** 数据目录根的 WorkspaceFs（library/personas/regex 等，非角色工作区，无 WAL）。 */
  private rootFs(): Promise<WorkspaceFs> {
    this.rootFsPromise ??= Promise.resolve(new WorkspaceFs(this.paths.root, null))
    return this.rootFsPromise
  }
}

export type { MemoryEntry, WorldDelta }
