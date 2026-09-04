/**
 * TavernService：remote 方法实现（薄壳，组合 state/floors/pipeline）。
 *
 * 平台约定：方法返回裸业务值，失败抛错（FloorError.message 原样透出给 client）。
 * { ok, value | error } 信封由 typert gateway（host invokeRpc / client invoke）生成，
 * 这里不要再包一层（双层信封会让 client 的 r.value.xxx 全部读到 undefined）。
 * 每个方法的返回注解指向 ../remote.ts 的 TavernMethodResults——结果形状的单一来源，
 * client 镜像（client/types.ts）索引同一张表，两面形状漂移会立刻编译报错。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { estimateTokens } from '../core/tokenize.js'
import { applyRegexRules } from '../core/regex.js'
import { presentRenderedOutput } from '../core/displaySanitize.js'
import { expandIdentityMacros } from '../core/macros.js'
import { DEFAULT_USER_NAME } from '../core/persona.js'
import type { MemoryEntry, PromptPreset, RegexRule } from '../core/types.js'
import { exportLorebook, mergeDeltasForExport, parseLorebook } from '../state/lorebook.js'
import { parseStPreset } from '../state/presetStore.js'
import { rebuildIndex } from '../state/workspace.js'
import type { SessionBinding } from './bindings.js'
import type { TavernConfigRaw } from './config.js'
import { parseJsonCard, parsePngCard } from '../state/card.js'
import { FloorError, continueFloor, editAssistantMessage, editUserMessage, enterGreetingConversation, getFloorAssistantMessage, getFloorSiblings, getFloorUserMessage, getGreetingSwipe, regenerate, rollbackToFloor, swipeGreeting } from './floors.js'
import { impersonate } from './impersonate.js'
import { runTavernPipeline } from './pipeline.js'
import type { Persona, TavernState } from './state.js'
import type { TavernMethodResults } from '../remote.js'

export class TavernService extends TypertRemoteService {
  constructor(
    ctx: Context,
    /** 运行时中枢（agent 面插件经 ctx.tavern 访问）。 */
    readonly state: TavernState,
    private readonly settingsScope: SettingsScope<TavernConfigRaw>,
  ) {
    super(ctx, 'tavern')
  }

  // ── 设置 ─────────────────────────────────────────────────────────────────

  getSettings(_request: Record<string, never>): TavernMethodResults['getSettings'] {
    return { settings: this.settingsScope.get() }
  }

  async updateSettings(request: { patch: object }): Promise<TavernMethodResults['updateSettings']> {
    await this.settingsScope.update(request.patch ?? {})
    return { settings: this.settingsScope.get() }
  }

  // ── 角色 ─────────────────────────────────────────────────────────────────

  async listCharacters(_request: Record<string, never>): Promise<TavernMethodResults['listCharacters']> {
    return { items: await this.state.listCharacters() }
  }

  async inspectCharacter(request: { name: string; dataBase64: string }): Promise<TavernMethodResults['inspectCharacter']> {
    try {
      const bytes = Buffer.from(request.dataBase64, 'base64')
      const card = /\.png$/i.test(request.name)
        ? parsePngCard(bytes)
        : parseJsonCard(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
      const bookEntries = card.characterBook?.entries
      const entryCount = Array.isArray(bookEntries) ? bookEntries.length : 0
      return {
        name: card.name,
        hasAvatar: Boolean(card.pngBytes && card.pngBytes.length > 0),
        hasCharacterBook: entryCount > 0,
        characterBookName: card.characterBook?.name ?? null,
        entryCount,
      }
    } catch (error) {
      throw new FloorError('invalid-card', error instanceof Error ? error.message : String(error))
    }
  }

  async importCharacter(request: { name: string; dataBase64: string; importWorldBook?: boolean }): Promise<TavernMethodResults['importCharacter']> {
    const bytes = Buffer.from(request.dataBase64, 'base64')
    const ws = await this.state.importCharacter(request.name, bytes, { importWorldBook: request.importWorldBook !== false })
    return { cardId: ws.cardId, name: ws.card.name }
  }

  async deleteCharacter(request: { cardId: string }): Promise<TavernMethodResults['deleteCharacter']> {
    const { salvagedLorebook } = await this.state.deleteCharacter(request.cardId)
    return { deleted: true, salvagedLorebook }
  }

  async getCharacterDetail(request: { cardId: string }): Promise<TavernMethodResults['getCharacterDetail']> {
    const ws = await this.state.loadCharacter(request.cardId)
    if (!ws) throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`)
    const handle = await this.state.workspace(request.cardId)
    const { card } = ws
    return {
      cardId: ws.cardId,
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      firstMes: card.firstMes,
      alternateGreetings: card.alternateGreetings,
      mesExample: card.mesExample,
      systemPrompt: card.systemPrompt,
      postHistoryInstructions: card.postHistoryInstructions,
      creatorNotes: card.creatorNotes,
      creator: card.creator,
      characterVersion: card.characterVersion,
      tags: card.tags,
      spec: card.spec,
      hasCharacterBook: card.characterBook !== null && card.characterBook.entries.length > 0,
      characterBookName: card.characterBook?.name ?? null,
      characterBookEntryCount: card.characterBook?.entries.length ?? 0,
      hasAvatar: await handle.fs.exists('card.png'),
      depthPrompt: card.depthPrompt,
      extensions: card.extensions,
    }
  }

  async saveCharacter(request: {
    cardId: string
    name?: string
    description?: string
    personality?: string
    scenario?: string
    firstMes?: string
    alternateGreetings?: string[]
    mesExample?: string
    systemPrompt?: string
    postHistoryInstructions?: string
    creatorNotes?: string
    creator?: string
    characterVersion?: string
    tags?: string[]
    depthPrompt?: { prompt: string; depth: number; role: 'system' | 'user' | 'assistant' } | null
  }): Promise<TavernMethodResults['saveCharacter']> {
    try {
      return await this.state.saveCharacter(request.cardId, {
        name: request.name,
        description: request.description,
        personality: request.personality,
        scenario: request.scenario,
        firstMes: request.firstMes,
        alternateGreetings: request.alternateGreetings,
        mesExample: request.mesExample,
        systemPrompt: request.systemPrompt,
        postHistoryInstructions: request.postHistoryInstructions,
        creatorNotes: request.creatorNotes,
        creator: request.creator,
        characterVersion: request.characterVersion,
        tags: request.tags,
        depthPrompt: request.depthPrompt,
      })
    } catch (error) {
      throw new FloorError('invalid-card', error instanceof Error ? error.message : String(error))
    }
  }

  async createCharacter(request: { name: string }): Promise<TavernMethodResults['createCharacter']> {
    const name = request.name?.trim()
    if (!name) throw new FloorError('invalid-card', '角色名不能为空')
    const ws = await this.state.createCharacter(name)
    return { cardId: ws.cardId, name: ws.card.name }
  }

  async exportCharacter(request: { cardId: string }): Promise<TavernMethodResults['exportCharacter']> {
    try {
      return await this.state.exportCharacter(request.cardId)
    } catch (error) {
      throw new FloorError('card-not-found', error instanceof Error ? error.message : String(error))
    }
  }

  // ── 预设 ─────────────────────────────────────────────────────────────────

  async listPresets(_request: Record<string, never>): Promise<TavernMethodResults['listPresets']> {
    return { items: await this.state.listPresetSummaries() }
  }

  async importPreset(request: { name: string; json: unknown }): Promise<TavernMethodResults['importPreset']> {
    const { preset, warnings } = parseStPreset(request.json)
    if (request.name && preset.name === '未命名预设') preset.name = request.name
    await this.state.savePreset(preset)
    return { id: preset.identifier, warnings }
  }

  async savePreset(request: { preset: PromptPreset }): Promise<TavernMethodResults['savePreset']> {
    if (!request.preset || typeof request.preset.identifier !== 'string' || !request.preset.identifier) {
      throw new FloorError('invalid-preset', '预设缺少 identifier')
    }
    await this.state.savePreset(request.preset)
    return { id: request.preset.identifier }
  }

  async deletePreset(request: { id: string }): Promise<TavernMethodResults['deletePreset']> {
    await this.state.deletePreset(request.id)
    return { deleted: true }
  }

  async getPreset(request: { id: string }): Promise<TavernMethodResults['getPreset']> {
    const preset = await this.state.loadPreset(request.id)
    if (!preset) throw new FloorError('preset-not-found', `预设 ${request.id} 不存在`)
    return { preset }
  }

  // ── 世界书库 ──────────────────────────────────────────────────────────────

  async listLorebooks(_request: Record<string, never>): Promise<TavernMethodResults['listLorebooks']> {
    return { items: await this.state.listLorebooks() }
  }

  async getLorebook(request: { name: string }): Promise<TavernMethodResults['getLorebook']> {
    const json = await this.state.loadLorebookJson(request.name)
    if (json === null) throw new FloorError('lorebook-not-found', `世界书 ${request.name} 不存在`)
    return { json }
  }

  async importLorebook(request: { name: string; json: unknown }): Promise<TavernMethodResults['importLorebook']> {
    // 先归一化验证可读性，再原样落盘
    const entries = parseLorebook(request.json, { source: 'global', sourceRef: request.name })
    await this.state.saveLorebook(request.name, request.json)
    return { name: request.name, entryCount: entries.length }
  }

  async saveLorebook(request: { name: string; json: unknown }): Promise<TavernMethodResults['saveLorebook']> {
    parseLorebook(request.json, { source: 'global', sourceRef: request.name })
    await this.state.saveLorebook(request.name, request.json)
    return { name: request.name }
  }

  async deleteLorebook(request: { name: string }): Promise<TavernMethodResults['deleteLorebook']> {
    await this.state.deleteLorebook(request.name)
    return { deleted: true }
  }

  async getCharacterLorebook(request: { cardId: string }): Promise<TavernMethodResults['getCharacterLorebook']> {
    const book = await this.state.loadCharacterLorebookRaw(request.cardId)
    if (!book) throw new FloorError('lorebook-not-found', `角色 ${request.cardId} 没有内嵌世界书`)
    return book
  }

  async saveCharacterLorebook(request: { cardId: string; json: unknown }): Promise<TavernMethodResults['saveCharacterLorebook']> {
    parseLorebook(request.json, { source: 'character', sourceRef: request.cardId })
    return this.state.saveCharacterLorebook(request.cardId, request.json)
  }

  async deleteEmbeddedLorebook(request: { cardId: string }): Promise<TavernMethodResults['deleteEmbeddedLorebook']> {
    await this.state.deleteCharacterLorebook(request.cardId)
    return { deleted: true }
  }

  async getChatLorebook(request: { cardId: string }): Promise<TavernMethodResults['getChatLorebook']> {
    if ((await this.state.loadCharacter(request.cardId)) === null) {
      throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`)
    }
    const json = await this.state.getChatLorebook(request.cardId)
    return { json }
  }

  async saveChatLorebook(request: { cardId: string; json: unknown }): Promise<TavernMethodResults['saveChatLorebook']> {
    if ((await this.state.loadCharacter(request.cardId)) === null) {
      throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`)
    }
    await this.state.saveChatLorebook(request.cardId, request.json)
    return { saved: true }
  }

  async getJournal(request: { cardId: string }): Promise<TavernMethodResults['getJournal']> {
    if ((await this.state.loadCharacter(request.cardId)) === null) {
      throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`)
    }
    return { text: await this.state.getJournal(request.cardId) }
  }

  async saveJournal(request: { cardId: string; text: string }): Promise<TavernMethodResults['saveJournal']> {
    if ((await this.state.loadCharacter(request.cardId)) === null) {
      throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`)
    }
    await this.state.saveJournal(request.cardId, request.text ?? '')
    return { saved: true }
  }

  // ── 人设 ─────────────────────────────────────────────────────────────────

  async listPersonas(_request: Record<string, never>): Promise<TavernMethodResults['listPersonas']> {
    return { items: await this.state.listPersonas() }
  }

  async savePersona(request: { persona: Persona }): Promise<TavernMethodResults['savePersona']> {
    if (!request.persona?.id) throw new FloorError('invalid-persona', '人设缺少 id')
    await this.state.savePersona(request.persona)
    const settings = this.settingsScope.get()
    if (!settings.defaults?.personaId) {
      await this.settingsScope.update({
        defaults: { ...settings.defaults, personaId: request.persona.id },
      })
    }
    return { id: request.persona.id }
  }

  async deletePersona(request: { id: string }): Promise<TavernMethodResults['deletePersona']> {
    await this.state.deletePersona(request.id)
    const settings = this.settingsScope.get()
    if (settings.defaults?.personaId === request.id) {
      await this.settingsScope.update({
        defaults: { ...settings.defaults, personaId: '' },
      })
    }
    return { deleted: true }
  }

  // ── 正则 ─────────────────────────────────────────────────────────────────

  async listRegexRules(_request: Record<string, never>): Promise<TavernMethodResults['listRegexRules']> {
    return { rules: await this.state.listRegexRules() }
  }

  async saveRegexRules(request: { rules: RegexRule[] }): Promise<TavernMethodResults['saveRegexRules']> {
    const rules = Array.isArray(request.rules) ? request.rules : []
    await this.state.saveRegexRules(rules)
    return { count: rules.length }
  }

  // ── 会话绑定 ──────────────────────────────────────────────────────────────

  async getSessionBinding(request: { sessionId: string }): Promise<TavernMethodResults['getSessionBinding']> {
    const session = this.ctx.sessions.get(request.sessionId as Session['id'])
    const canSwipeGreeting = Boolean(session && !session.snapshotEvents().some((e) => e.type === 'user/message'))
    const binding = await this.state.loadBinding(request.sessionId)
    if (!binding) return { binding: null, userName: DEFAULT_USER_NAME, canSwipeGreeting: false }
    const persona = await this.state.resolvePersona(binding.personaId)
    return { binding, userName: persona?.name ?? DEFAULT_USER_NAME, canSwipeGreeting }
  }

  async setSessionBinding(request: { binding: SessionBinding }): Promise<TavernMethodResults['setSessionBinding']> {
    const binding = request.binding
    if (!binding?.sessionId || !binding.cardId) throw new FloorError('invalid-binding', '绑定缺少 sessionId 或 cardId')
    if ((await this.state.loadCharacter(binding.cardId)) === null) {
      throw new FloorError('card-not-found', `角色 ${binding.cardId} 不存在`)
    }
    const existing = await this.state.loadBinding(binding.sessionId)
    // fork WAL 祖先由 host 维护；同卡编辑绑定时保留，换卡则清空，不能信任客户端自报。
    const walLineage = existing?.cardId === binding.cardId ? existing.walLineage : undefined
    await this.state.saveBinding({
      ...binding,
      walLineage,
      createdAt: binding.createdAt ?? new Date().toISOString(),
    })
    return { saved: true }
  }

  async clearSessionBinding(request: { sessionId: string }): Promise<TavernMethodResults['clearSessionBinding']> {
    if (!request.sessionId) throw new FloorError('invalid-binding', '绑定缺少 sessionId')
    await this.state.clearBinding(request.sessionId)
    return { cleared: true }
  }

  // ── 开场白与楼层 ──────────────────────────────────────────────────────────

  async ensureGreeting(request: { sessionId: string }): Promise<TavernMethodResults['ensureGreeting']> {
    return this.state.enqueueSessionTask(request.sessionId, async () => ({
      created: await enterGreetingConversation(this.floorDeps(), request.sessionId),
    }))
  }

  async swipeGreeting(request: { sessionId: string; index: number }): Promise<TavernMethodResults['swipeGreeting']> {
    return this.state.enqueueSessionTask(request.sessionId, () =>
      swipeGreeting(this.floorDeps(), request.sessionId, request.index),
    )
  }

  async getGreetingSwipe(request: { sessionId: string; messageId: string }): Promise<TavernMethodResults['getGreetingSwipe']> {
    return getGreetingSwipe(this.floorDeps(), request.sessionId, request.messageId)
  }

  /** 分支兄弟导航是只读查询：等排队中的楼层任务落定即可，不进串行队列。 */
  async getFloorSiblings(request: { sessionId: string; messageId?: string; turn?: number }): Promise<TavernMethodResults['getFloorSiblings']> {
    await this.state.waitForSessionTasks(request.sessionId)
    return getFloorSiblings(this.floorDeps(), request.sessionId, request.messageId, request.turn)
  }

  async renderOutputText(request: { sessionId: string; text: string }): Promise<TavernMethodResults['renderOutputText']> {
    const text = request.text ?? ''
    const settings = this.settingsScope.get()
    const whitelist = [...settings.cardNetworkWhitelist]
    const session = this.ctx.sessions.get(request.sessionId as Session['id'])
    const canSwipeGreeting = Boolean(session && !session.snapshotEvents().some((e) => e.type === 'user/message'))
    const binding = await this.state.loadBinding(request.sessionId)
    if (!binding) {
      const presented = presentRenderedOutput(text, settings.interactiveCards)
      return {
        ...presented,
        interactiveCards: settings.interactiveCards,
        whitelist,
        greetings: [] as string[],
        greetingIndex: 0,
        canSwipeGreeting: false,
      }
    }
    const rules = await this.state.rulesFor(binding)
    const ws = await this.state.loadCharacter(binding.cardId)
    const persona = await this.state.resolvePersona(binding.personaId)
    const names = { char: ws?.card.name ?? 'Assistant', user: persona?.name ?? DEFAULT_USER_NAME }
    // SillyTavern：先 substituteParams 再跑展示正则，开场白里的 {{user}} 才能被按名字匹配。
    const named = expandIdentityMacros(text, names)
    const rendered = applyRegexRules(
      named,
      rules,
      { scope: 'output', timing: 'render' },
      { ...names, outlets: {} },
    )
    const presented = presentRenderedOutput(rendered.text, settings.interactiveCards)
    const htmls = presented.htmls.map((h) => expandIdentityMacros(h, names))
    const greetings = (ws ? [ws.card.firstMes, ...ws.card.alternateGreetings] : []).map((g) =>
      expandIdentityMacros(g, names),
    )
    return {
      html: htmls[0] ?? null,
      htmls,
      text: expandIdentityMacros(presented.text, names),
      interactiveCards: settings.interactiveCards,
      whitelist,
      greetings,
      greetingIndex: binding.greetingIndex,
      canSwipeGreeting,
    }
  }

  regenerate(request: { sessionId: string; messageId?: string; turn?: number }): Promise<TavernMethodResults['regenerate']> {
    return this.state.enqueueSessionTask(request.sessionId, () =>
      regenerate(this.floorDeps(), request.sessionId, request.messageId, request.turn),
    )
  }

  rollbackToFloor(request: { sessionId: string; messageId?: string; turn?: number }): Promise<TavernMethodResults['rollbackToFloor']> {
    return this.state.enqueueSessionTask(request.sessionId, () =>
      rollbackToFloor(this.floorDeps(), request.sessionId, request.messageId, request.turn),
    )
  }

  async getFloorUserMessage(request: { sessionId: string; messageId: string }): Promise<TavernMethodResults['getFloorUserMessage']> {
    await this.state.waitForSessionTasks(request.sessionId)
    return getFloorUserMessage(this.floorDeps(), request.sessionId, request.messageId)
  }

  editUserMessage(request: { sessionId: string; messageId: string; text: string }): Promise<TavernMethodResults['editUserMessage']> {
    return this.state.enqueueSessionTask(request.sessionId, () =>
      editUserMessage(this.floorDeps(), request.sessionId, request.messageId, request.text),
    )
  }

  async getFloorAssistantMessage(request: { sessionId: string; messageId: string }): Promise<TavernMethodResults['getFloorAssistantMessage']> {
    await this.state.waitForSessionTasks(request.sessionId)
    return getFloorAssistantMessage(this.floorDeps(), request.sessionId, request.messageId)
  }

  editAssistantMessage(request: { sessionId: string; messageId: string; text: string }): Promise<TavernMethodResults['editAssistantMessage']> {
    return this.state.enqueueSessionTask(request.sessionId, () =>
      editAssistantMessage(this.floorDeps(), request.sessionId, request.messageId, request.text),
    )
  }

  continueFloor(request: { sessionId: string; messageId: string }): Promise<TavernMethodResults['continueFloor']> {
    return this.state.enqueueSessionTask(request.sessionId, () =>
      continueFloor(this.floorDeps(), request.sessionId, request.messageId),
    )
  }

  /** impersonate 是带外一次性调用，不进会话串行队列（不改会话状态）。 */
  impersonate(request: { sessionId: string }): Promise<TavernMethodResults['impersonate']> {
    return impersonate({ ctx: this.ctx, state: this.state }, request.sessionId)
  }

  // ── 记忆 ─────────────────────────────────────────────────────────────────

  async getMemories(request: { cardId: string }): Promise<TavernMethodResults['getMemories']> {
    const ws = await this.state.workspace(request.cardId)
    return { items: await ws.memory.list() }
  }

  async saveMemory(request: { cardId: string; id?: string; body: string; tags?: string[]; keys?: string[] }): Promise<TavernMethodResults['saveMemory']> {
    const ws = await this.state.workspace(request.cardId)
    let entry: MemoryEntry | null
    if (request.id) {
      entry = await ws.memory.update(
        request.id,
        { body: request.body, tags: request.tags, keys: request.keys },
        { listMode: 'replace' },
      )
      if (!entry) throw new FloorError('memory-not-found', `记忆 ${request.id} 不存在`)
    } else {
      entry = await ws.memory.write({ body: request.body, tags: request.tags, keys: request.keys })
    }
    await rebuildIndex(ws.fs, estimateTokens)
    return { id: entry.id }
  }

  async deleteMemory(request: { cardId: string; id: string }): Promise<TavernMethodResults['deleteMemory']> {
    const ws = await this.state.workspace(request.cardId)
    const deleted = await ws.memory.delete(request.id)
    if (deleted) await rebuildIndex(ws.fs, estimateTokens)
    return { deleted }
  }

  /** 无 LLM 的确定性归并：原文逐条保留，只减少条目数，不宣称减少 token。 */
  async compressMemories(request: { cardId: string }): Promise<TavernMethodResults['compressMemories']> {
    const ws = await this.state.workspace(request.cardId)
    const batch = await ws.memory.oldest(this.state.config.memory.compressBatch)
    if (batch.length < 2) return { merged: 0 }
    const merged = batch.map((b, i) => `${i + 1}. ${b.body}`).join('\n')
    await ws.memory.archive(batch.map((b) => b.id))
    await ws.memory.write({
      body: merged,
      tags: [...new Set(['merged', ...batch.flatMap((entry) => entry.tags)])],
      keys: [...new Set(batch.flatMap((entry) => entry.keys))],
      sourceRange: `merge:${batch.map((b) => b.id).join(',')}`,
    })
    await rebuildIndex(ws.fs, estimateTokens)
    return { merged: batch.length }
  }

  // ── 世界状态 ──────────────────────────────────────────────────────────────

  async getWorldDeltas(request: { cardId: string }): Promise<TavernMethodResults['getWorldDeltas']> {
    const ws = await this.state.workspace(request.cardId)
    return { items: await ws.deltas.list({ includeRevoked: true }) }
  }

  async revokeWorldDelta(request: { cardId: string; id: string }): Promise<TavernMethodResults['revokeWorldDelta']> {
    const ws = await this.state.workspace(request.cardId)
    return { revoked: await ws.deltas.revoke(request.id) }
  }

  async addWorldDelta(request: {
    cardId: string
    type: 'add' | 'update' | 'invalidate'
    content: string
    ref?: string | null
    keys?: string[]
    order?: number
  }): Promise<TavernMethodResults['addWorldDelta']> {
    if (!request.content?.trim()) throw new FloorError('invalid-delta', '世界状态内容不能为空')
    if ((await this.state.loadCharacter(request.cardId)) === null) {
      throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`)
    }
    const ws = await this.state.workspace(request.cardId)
    const delta = await ws.deltas.append({
      type: request.type,
      ref: request.ref ?? null,
      content: request.content.trim(),
      keys: request.keys ?? [],
      order: request.order ?? 100,
      sourceRange: 'manual',
      expires: null,
    })
    await rebuildIndex(ws.fs, estimateTokens)
    return { id: delta.id }
  }

  async exportMergedLorebook(request: { cardId: string }): Promise<TavernMethodResults['exportMergedLorebook']> {
    const charWs = await this.state.loadCharacter(request.cardId)
    if (!charWs) throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`)
    const ws = await this.state.workspace(request.cardId)
    const book = await this.state.loadCharacterLorebookRaw(request.cardId)
    const originals = book ? parseLorebook(book.json, { source: 'character', sourceRef: request.cardId }) : []
    const deltas = await ws.deltas.list()
    const merged = mergeDeltasForExport(originals, deltas)
    return { json: exportLorebook(merged, charWs.card.name) }
  }

  // ── 调试 ─────────────────────────────────────────────────────────────────

  getTriggerLog(request: { sessionId: string }): TavernMethodResults['getTriggerLog'] {
    return { log: this.state.triggerLogs.get(request.sessionId) ?? null }
  }

  async previewPrompt(request: { sessionId: string }): Promise<TavernMethodResults['previewPrompt']> {
    const agent = this.ctx.agents.get(request.sessionId as Session['id'])
    if (!agent) throw new FloorError('session-not-live', `会话 ${request.sessionId} 不在线，无法预览（请先打开该会话）`)
    const llm = this.ctx.get('llm') as LlmRuntime | undefined
    const result = await runTavernPipeline({ state: this.state, sessionId: request.sessionId, agent, llm, mode: 'preview' })
    if (!result) throw new FloorError('no-binding', '当前会话未绑定 Tavern 角色卡')
    return {
      standing: result.standing,
      turnContext: result.turnContext,
      system: result.system,
      messages: result.messages,
      logLines: result.logLines,
      worldInfoBudget: result.wiBudget,
      assembleBudget: result.assembled.stats,
    }
  }

  /**
   * 上下文占用（宿主 rc.2 起 sessionProjections.stateOf 只读 token-meter 投影）。
   * 会话不在线、宿主未挂投影或尚无数据时 usage=null，调用方按未知处理。
   */
  getContextUsage(request: { sessionId: string }): TavernMethodResults['getContextUsage'] {
    const session = this.ctx.sessions.get(request.sessionId as Session['id'])
    if (!session) return { usage: null }
    const projections = this.ctx.get('sessionProjections') as
      | { stateOf?(s: Session, key: string): unknown }
      | undefined
    const pressure = projections?.stateOf?.(session, 'contextPressure') as
      | { contextWindow?: number; pressureTokens?: number; surfaceTokens?: number }
      | undefined
    if (!pressure || typeof pressure.surfaceTokens !== 'number') return { usage: null }
    const breakdown = projections?.stateOf?.(session, 'contextBreakdown') as
      | { systemTokens?: number; toolsTokens?: number; messageTokens?: number }
      | undefined
    const percent =
      typeof pressure.pressureTokens === 'number' && typeof pressure.contextWindow === 'number' && pressure.contextWindow > 0
        ? Math.round((pressure.pressureTokens / pressure.contextWindow) * 100)
        : null
    return {
      usage: {
        surfaceTokens: pressure.surfaceTokens,
        pressureTokens: pressure.pressureTokens ?? null,
        contextWindow: pressure.contextWindow ?? null,
        percent,
        systemTokens: breakdown?.systemTokens ?? null,
        toolsTokens: breakdown?.toolsTokens ?? null,
        messageTokens: breakdown?.messageTokens ?? null,
      },
    }
  }

  /** Tavern 数据目录（$DSH_HOME/dsh-tavern），设置面板展示用。 */
  getDataInfo(_request: Record<string, never>): TavernMethodResults['getDataInfo'] {
    return { dataHome: this.state.paths.root }
  }

  async getAvatar(request: { cardId: string }): Promise<TavernMethodResults['getAvatar']> {
    const charWs = await this.state.loadCharacter(request.cardId)
    if (!charWs) return { dataUrl: null }
    const ws = await this.state.workspace(request.cardId)
    const bytes = await ws.fs.readBytes('card.png')
    if (!bytes) return { dataUrl: null }
    const base64 = Buffer.from(bytes).toString('base64')
    return { dataUrl: `data:image/png;base64,${base64}` }
  }

  private floorDeps() {
    return { ctx: this.ctx, state: this.state }
  }
}

export function createTavernService(ctx: Context, state: TavernState, settingsScope: SettingsScope<TavernConfigRaw>): TavernService {
  return new TavernService(ctx, state, settingsScope)
}
