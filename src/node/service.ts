/**
 * TavernService：remote 方法实现（薄壳，组合 state/floors/pipeline）。
 *
 * 平台约定：方法返回裸业务值，失败抛错（FloorError.message 原样透出给 client）。
 * { ok, value | error } 信封由 typert gateway（host invokeRpc / client invoke）生成，
 * 这里不要再包一层（双层信封会让 client 的 r.value.xxx 全部读到 undefined）。
 * 每个方法的返回注解指向 ../remote.ts 的 TavernMethodResults——结果形状的单一来源，
 * client 镜像（client/types.ts）索引同一张表，两面形状漂移会立刻编译报错。
 */
import type { TavernServiceContract } from '../remote.js'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { estimateTokens } from '../core/tokenize.js'
import { isolated } from './isolated.js'
import { presentRenderedOutput } from '../core/displaySanitize.js'
import type { TemplateDisplayPart } from '../core/templateDisplay.js'
import { expandIdentityMacros } from '../core/macros.js'
import { DEFAULT_USER_NAME } from '../core/persona.js'
import { isTavernGreetingEvent } from '../core/greetingLog.js'
import type { MemoryEntry, PromptPreset, RegexRule } from '../core/types.js'
import { exportLorebook, mergeDeltasForExport, parseLorebook } from '../state/lorebook.js'
import { exportStPreset, parseStPreset } from '../state/presetStore.js'
import { rebuildIndex } from '../state/workspace.js'
import { parseSessionBinding, type SessionBinding } from './bindings.js'
import type { TavernConfigRaw } from './config.js'
import { parseJsonCard, parsePngCard } from '../state/card.js'
import { FloorError, continueFloor, editAssistantMessage, editUserMessage, enterGreetingConversation, getFloorAssistantMessage, getFloorSiblings, getFloorUserMessage, getGreetingSwipe, regenerate, rollbackToFloor, swipeGreeting } from './floors.js'
import { impersonate } from './impersonate.js'
import { loadBoundLoreEntries, runTavernPipeline } from './pipeline.js'
import { hasEjs } from '../core/template.js'
import { templateCardData } from '../core/templateAssets.js'
import { loadTemplateState, templateTextHash } from '../state/template.js'
import { loadTemplateAvatars } from './templateAvatar.js'
import { readDisplaySessionEvents } from './sessionEvents.js'
import type { Persona, TavernState } from './state.js'
import type { TavernMethodResults } from '../remote.js'
import { deleteEditorDraft, getEditorDraft, saveEditorDraft } from './editorDrafts.js'

/** 头像缓存条数上限：卡删除/再导入会产生新 cardId，旧条目无人主动清，超上限淘汰最旧（只多一次重读，无正确性影响）。 */
const AVATAR_CACHE_MAX = 32

export class TavernService extends TypertRemoteService implements TavernServiceContract {
  constructor(
    ctx: Context,
    /** 运行时中枢（agent 面插件经 ctx.tavern 访问）。 */
    readonly state: TavernState,
    private readonly settingsScope: SettingsScope<TavernConfigRaw>,
  ) {
    super(ctx, 'tavern')
  }

  /**
   * 头像 dataURL 进程内缓存：getAvatar 每次调用都全文读盘 + Base64 编码整图，
   * 与会话头/英雄区的渲染频率不匹配。指纹用 WorkspaceFs.stat('card.png') 的
   * mtimeMs+size——与 state.ts 卡级正则指纹缓存同一思路：一次 stat 不读数据，
   * 且能捕获绕开写方法直写磁盘的路径（WAL 回滚 / 外部换图）。
   */
  private readonly avatarCache = new Map<string, { fingerprint: string; dataUrl: string | null }>()

  // ── 未提交的编辑器草稿 ────────────────────────────────────────────────────

  async getEditorDraft(request: { owner: string; key: string }): Promise<TavernMethodResults['getEditorDraft']> {
    return { draft: await getEditorDraft(this.state.paths.root, request.owner, request.key) }
  }

  async saveEditorDraft(request: { owner: string; key: string; value: unknown }): Promise<TavernMethodResults['saveEditorDraft']> {
    await saveEditorDraft(this.state.paths.root, request.owner, request.key, request.value)
    return { saved: true }
  }

  async deleteEditorDraft(request: { owner: string; key: string }): Promise<TavernMethodResults['deleteEditorDraft']> {
    await deleteEditorDraft(this.state.paths.root, request.owner, request.key)
    return { deleted: true }
  }

  // ── 设置 ─────────────────────────────────────────────────────────────────

  getSettings(_request: Record<string, never>): TavernMethodResults['getSettings'] {
    return { settings: this.settingsScope.get() }
  }

  async updateSettings(request: { patch: unknown }): Promise<TavernMethodResults['updateSettings']> {
    if (!request.patch || typeof request.patch !== 'object' || Array.isArray(request.patch)) throw new FloorError('invalid-settings', '设置补丁必须是对象')
    await this.settingsScope.update(request.patch)
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
    // 回显用落盘后的实际 id（identifier 含非法字符时会被净化），UI 按它打开才与磁盘一致。
    const id = await this.state.savePreset(preset)
    return { id, warnings }
  }

  async savePreset(request: { preset: unknown }): Promise<TavernMethodResults['savePreset']> {
    const preset = request.preset as Partial<PromptPreset> | null
    if (!preset || typeof preset.identifier !== 'string' || !preset.identifier) {
      throw new FloorError('invalid-preset', '预设缺少 identifier')
    }
    // 宽松传输、严格校验：remote schema 对复杂资产是宽松形状，落盘前用现有预设解析帮手
    // 整体过一遍——经 ST 导出形态往返（exportStPreset → parseStPreset）：结构非法
    // （非对象 / entries 缺失或不是数组）直接抛错；往返后条目变少说明有缺失或重复
    // identifier 的条目被丢弃，同样拒绝。校验不过不写盘。
    try {
      const normalized = parseStPreset(exportStPreset(preset as PromptPreset)).preset
      if (normalized.entries.length !== preset.entries?.length) {
        throw new Error('预设条目缺失，或存在缺失/重复的 identifier')
      }
    } catch (error) {
      throw new FloorError('invalid-preset', error instanceof Error ? error.message : String(error))
    }
    // 回显用落盘后的实际 id（理由同 importPreset）。
    const id = await this.state.savePreset(preset as PromptPreset)
    return { id }
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
    // 先归一化验证可读性，再原样落盘；回显名以落盘后的实际 id 为准（原始名带非法字符会被净化）。
    const entries = parseLorebook(request.json, { source: 'global', sourceRef: request.name })
    const id = await this.state.saveLorebook(request.name, request.json)
    return { name: id, entryCount: entries.length }
  }

  async saveLorebook(request: { name: string; json: unknown }): Promise<TavernMethodResults['saveLorebook']> {
    parseLorebook(request.json, { source: 'global', sourceRef: request.name })
    // 回显名以落盘后的实际 id 为准（同 importLorebook）。
    const id = await this.state.saveLorebook(request.name, request.json)
    return { name: id }
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

  async getChatLorebook(request: { cardId: string; storyId?: string }): Promise<TavernMethodResults['getChatLorebook']> {
    if ((await this.state.loadCharacter(request.cardId)) === null) {
      throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`)
    }
    const json = await this.state.getChatLorebook(request.cardId, request.storyId)
    return { json }
  }

  async saveChatLorebook(request: { cardId: string; storyId?: string; json: unknown }): Promise<TavernMethodResults['saveChatLorebook']> {
    if ((await this.state.loadCharacter(request.cardId)) === null) {
      throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`)
    }
    await this.state.saveChatLorebook(request.cardId, request.json, request.storyId)
    return { saved: true }
  }

  async getJournal(request: { cardId: string; storyId?: string }): Promise<TavernMethodResults['getJournal']> {
    if ((await this.state.loadCharacter(request.cardId)) === null) {
      throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`)
    }
    return { text: await this.state.getJournal(request.cardId, request.storyId) }
  }

  async saveJournal(request: { cardId: string; storyId?: string; text: string }): Promise<TavernMethodResults['saveJournal']> {
    if ((await this.state.loadCharacter(request.cardId)) === null) {
      throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`)
    }
    await this.state.saveJournal(request.cardId, request.text ?? '', request.storyId)
    return { saved: true }
  }

  // ── 人设 ─────────────────────────────────────────────────────────────────

  async listPersonas(_request: Record<string, never>): Promise<TavernMethodResults['listPersonas']> {
    return { items: await this.state.listPersonas() }
  }

  async savePersona(request: { persona: Persona }): Promise<TavernMethodResults['savePersona']> {
    if (!request.persona?.id) throw new FloorError('invalid-persona', '人设缺少 id')
    // 回显与默认页都用落盘后的实际 id：id 被净化过时磁盘 JSON 里的 id 也一并改写，
    // 若继续用原始 id，默认页指向的净化文件与这里回显的 id 会各说各话。
    const id = await this.state.savePersona(request.persona)
    const settings = this.settingsScope.get()
    if (!settings.defaults?.personaId) {
      await this.settingsScope.update({
        defaults: { ...settings.defaults, personaId: id },
      })
    }
    return { id }
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

  /** 以已提交日志判定是否进入对话，避免客户端 blank 镜像滞后时误清绑定。 */
  private async conversationStarted(sessionId: string): Promise<boolean> {
    return (await readDisplaySessionEvents(this.ctx,sessionId)).some(
      (e) => e.type === 'turn/start' || e.type === 'assistant/message' || e.type === 'user/message',
    ) ?? false
  }

  async getSessionBinding(request: { sessionId: string }): Promise<TavernMethodResults['getSessionBinding']> {
    const binding = await this.state.loadBinding(request.sessionId)
    const persona = binding ? await this.state.resolvePersona(binding.personaId) : null
    // 异步读资产期间可能刚写入开场白，返回前再取日志状态，避免向 hero 回传旧 blank 判定。
    const session = this.ctx.sessions.get(request.sessionId as Session['id'])
    const canSwipeGreeting = Boolean(binding && session && !session.snapshotEvents().some((e) => e.type === 'user/message'))
    const conversationStarted = await this.conversationStarted(request.sessionId)
    return { binding, userName: persona?.name ?? DEFAULT_USER_NAME, canSwipeGreeting, conversationStarted }
  }

  async setSessionBinding(request: { binding: unknown }): Promise<TavernMethodResults['setSessionBinding']> {
    // 宽松传输、严格校验：绑定整体过 parseSessionBinding（缺字段/类型不符抛错，不落盘），
    // 不能只抽查 sessionId/cardId 就把客户端自报的其余字段原样写盘。
    let binding: SessionBinding
    try {
      binding = parseSessionBinding(request.binding)
    } catch (error) {
      throw new FloorError('invalid-binding', error instanceof Error ? error.message : String(error))
    }
    if ((await this.state.loadCharacter(binding.cardId)) === null) {
      throw new FloorError('card-not-found', `角色 ${binding.cardId} 不存在`)
    }
    const existing = await this.state.loadBinding(binding.sessionId)
    // fork WAL 祖先由 host 维护；同卡编辑绑定时保留，换卡则清空，不能信任客户端自报。
    // createdAt 由 parseSessionBinding 保证必填非空，无需再兜底。
    const walLineage = existing?.cardId === binding.cardId ? existing.walLineage : undefined
    await this.state.saveBinding({
      ...binding,
      storyId: existing?.cardId === binding.cardId ? existing.storyId : undefined,
      walLineage,
    })
    return { saved: true }
  }

  async clearSessionBinding(request: { sessionId: string; onlyIfBlank?: boolean }): Promise<TavernMethodResults['clearSessionBinding']> {
    if (!request.sessionId) throw new FloorError('invalid-binding', '绑定缺少 sessionId')
    if (request.onlyIfBlank === true) {
      // 与 ensureGreeting、inbox 初始化共用队列，在真正删除前重新确认状态。
      return this.state.enqueueSessionTask(request.sessionId, async () => {
        if (await this.conversationStarted(request.sessionId)) return { cleared: false }
        await this.state.clearBinding(request.sessionId)
        return { cleared: true }
      })
    }
    await this.state.clearBinding(request.sessionId)
    return { cleared: true }
  }

  // ── 开场白与楼层 ──────────────────────────────────────────────────────────

  async ensureGreeting(request: { sessionId: string }): Promise<TavernMethodResults['ensureGreeting']> {
    return this.state.enqueueSessionTask(request.sessionId, async () => ({
      created: await enterGreetingConversation(this.floorDeps(), request.sessionId),
      conversationStarted: await this.conversationStarted(request.sessionId),
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

  async renderOutputText(request: { sessionId: string; text: string; messageId?: number }): Promise<TavernMethodResults['renderOutputText']> {
    await this.state.waitForSessionTasks(request.sessionId)
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
    const displayEvents = await readDisplaySessionEvents(this.ctx,request.sessionId)
    const rules = await this.state.rulesFor(binding)
    const ws = await this.state.loadCharacter(binding.cardId)
    const persona = await this.state.resolvePersona(binding.personaId)
    const names = { char: ws?.card.name ?? 'Assistant', user: persona?.name ?? DEFAULT_USER_NAME }
    // SillyTavern：先 substituteParams 再跑展示正则，开场白里的 {{user}} 才能被按名字匹配。
    let named = expandIdentityMacros(text, names)
    let templateParts: TemplateDisplayPart[] | undefined
    const story = await this.state.storyWorkspace(binding.cardId, binding.storyId)
    const templates = await loadTemplateState(story.fs)
    const cached = request.messageId === undefined ? undefined : templates.outputs[String(request.messageId)]
    if (cached && cached.hash === templateTextHash(text)) {
      named = expandIdentityMacros(cached.text, names)
      templateParts = cached.parts
    }
    else if (hasEjs(named)) {
      const greeting = request.messageId !== undefined && displayEvents.some(event => Number(event.seq) === request.messageId && isTavernGreetingEvent(event))
      if (request.messageId !== undefined && !greeting) throw new Error('该回复的模板未成功提交或已被编辑；请查看触发日志，不会在刷新时重新执行写入')
      // 开场白/独立展示没有楼层，仅执行临时副本；浏览器传入文本永远不能落盘变量。
      const preset = binding.presetId ? await this.state.loadPreset(binding.presetId) : null
      const result = await isolated('template', { texts: [named], context: {
        variables: templates.variables, ...names, card: ws ? templateCardData(ws.card) : {name:names.char},
        ...await loadTemplateAvatars(this.state,binding.cardId,persona),
        entries: (await loadBoundLoreEntries(this.state, binding)).entries,
        presets: preset?.entries.filter(e => e.enabled) ?? [], history: [], now: Date.now(), seed: 1, phase: 'render',
        sessionId: request.sessionId, cardId: binding.cardId,
      } })
      named = result.texts[0]!
      templateParts = result.parts[0]
    }
    const parts = templateParts === undefined ? undefined : (await isolated('display', {
      parts: templateParts.map(part => ({ ...part, text: expandIdentityMacros(part.text, names) })),
      rules, macroCtx: { ...names, outlets: {} },
    })).parts
    const presented = parts === undefined
      ? presentRenderedOutput((await isolated('render', { text: named, rules, macroCtx: { ...names, outlets: {} } })).text, settings.interactiveCards)
      : { htmls: settings.interactiveCards ? parts.filter(part => part.kind === 'html').map(part => part.text) : [],
          text: parts.filter(part => part.kind === 'markdown').map(part => part.text).join('\n') || presentRenderedOutput(named, false).text }
    const htmls = presented.htmls.map((h) => expandIdentityMacros(h, names))
    const greetings = (ws ? [ws.card.firstMes, ...ws.card.alternateGreetings] : []).map((g) =>
      expandIdentityMacros(g, names),
    )
    return {
      ...(parts === undefined ? {} : { parts }),
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

  async listStories(request: { cardId: string }): Promise<TavernMethodResults['listStories']> {
    return { items: await this.state.listStories(request.cardId) }
  }

  async getMemories(request: { cardId: string; storyId?: string }): Promise<TavernMethodResults['getMemories']> {
    const ws = await this.state.storyWorkspace(request.cardId, request.storyId)
    return { items: await ws.memory.list() }
  }

  async saveMemory(request: { cardId: string; storyId?: string; id?: string; body: string; tags?: string[]; keys?: string[] }): Promise<TavernMethodResults['saveMemory']> {
    // 面板/服务层非会话写路径一律走 plainWorkspace（floor 恒 null，绝不记 WAL）：
    // 生成进行中的面板编辑若走携带楼层的实例，会被记进当前楼层 WAL、回退时静默改回旧值。
    const ws = await this.state.plainWorkspace(request.cardId, request.storyId)
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

  async deleteMemory(request: { cardId: string; storyId?: string; id: string }): Promise<TavernMethodResults['deleteMemory']> {
    // 面板写路径走 plainWorkspace（理由同 saveMemory）。
    const ws = await this.state.plainWorkspace(request.cardId, request.storyId)
    const deleted = await ws.memory.delete(request.id)
    if (deleted) await rebuildIndex(ws.fs, estimateTokens)
    return { deleted }
  }

  /** 无 LLM 的确定性归并：原文逐条保留，只减少条目数，不宣称减少 token。 */
  async compressMemories(request: { cardId: string; storyId?: string }): Promise<TavernMethodResults['compressMemories']> {
    // 面板写路径走 plainWorkspace（理由同 saveMemory）。
    const ws = await this.state.plainWorkspace(request.cardId, request.storyId)
    const batch = await ws.memory.oldest(this.state.config.memory.compressBatch)
    if (batch.length < 2) return { merged: 0 }
    const merged = batch.map((b, i) => `${i + 1}. ${b.body}`).join('\n')
    // 顺序与 memoryMaintenance.compressOldestMemories 一致：先落合并条目成功后再归档原条目——
    // 先归档的话，合并写失败会让整批从活跃库消失（丢事实）；反过来写失败批次原样保留可重试，
    // 归档中途失败的最坏结果只是新旧并存，下次压缩把残余再合并一次，有冗余但不丢事实。
    const count = await ws.memory.mergeBatch(batch, merged, 'merge')
    await rebuildIndex(ws.fs, estimateTokens)
    return { merged: count }
  }

  // ── 世界状态 ──────────────────────────────────────────────────────────────

  async getWorldDeltas(request: { cardId: string; storyId?: string }): Promise<TavernMethodResults['getWorldDeltas']> {
    const ws = await this.state.storyWorkspace(request.cardId, request.storyId)
    return { items: await ws.deltas.list({ includeRevoked: true }) }
  }

  async revokeWorldDelta(request: { cardId: string; storyId?: string; id: string }): Promise<TavernMethodResults['revokeWorldDelta']> {
    // 面板写路径走 plainWorkspace（理由同 saveMemory）。
    const ws = await this.state.plainWorkspace(request.cardId, request.storyId)
    return { revoked: await ws.deltas.revoke(request.id) }
  }

  async addWorldDelta(request: {
    cardId: string; storyId?: string
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
    // 面板写路径走 plainWorkspace（理由同 saveMemory）。
    const ws = await this.state.plainWorkspace(request.cardId, request.storyId)
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

  async exportMergedLorebook(request: { cardId: string; storyId?: string }): Promise<TavernMethodResults['exportMergedLorebook']> {
    const charWs = await this.state.loadCharacter(request.cardId)
    if (!charWs) throw new FloorError('card-not-found', `角色 ${request.cardId} 不存在`)
    const ws = await this.state.storyWorkspace(request.cardId, request.storyId)
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
      actualRequest: this.state.requestDiagnostics.get(request.sessionId) ?? null,
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
    // 指纹一致直接回缓存：一次 stat 代替全文读 + Base64 编码（指纹口径见 avatarCache 注释）。
    const info = await ws.fs.stat('card.png')
    const fingerprint = info ? `${info.mtimeMs}:${info.size}` : 'missing'
    const cached = this.avatarCache.get(request.cardId)
    if (cached && cached.fingerprint === fingerprint) return { dataUrl: cached.dataUrl }
    const bytes = info ? await ws.fs.readBytes('card.png') : null
    const dataUrl = bytes ? `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` : null
    if (this.avatarCache.size >= AVATAR_CACHE_MAX && !this.avatarCache.has(request.cardId)) {
      const oldest = this.avatarCache.keys().next().value
      if (oldest !== undefined) this.avatarCache.delete(oldest)
    }
    this.avatarCache.set(request.cardId, { fingerprint, dataUrl })
    return { dataUrl }
  }

  private floorDeps() {
    return { ctx: this.ctx, state: this.state }
  }
}

export function createTavernService(ctx: Context, state: TavernState, settingsScope: SettingsScope<TavernConfigRaw>): TavernService {
  return new TavernService(ctx, state, settingsScope)
}
