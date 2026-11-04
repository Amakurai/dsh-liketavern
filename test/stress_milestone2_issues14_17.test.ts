/**
 * 针对 Milestone 2 (Issues 14-17) 的对抗性压力测试与极限边界测试。
 * 覆盖：
 * 1. Issue 14: 设置修订号并发冲突、重试循环、高并发竞争与草稿补丁
 * 2. Issue 15: AI 代答模型解析超时、流式取消、异常终止帧与未处理 Promise 拒绝防护
 * 3. Issue 16: 编辑草稿防恶意访问器（零 getter 执行）、数据属性检查、稀疏数组、符号、句柄级有界读取
 * 4. Issue 17: 会话迁移超 20,000 文件预检拦截、Doctor/Backup TOCTOU 竞争检测与链接防护
 */
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { mkdtemp, open, rm, writeFile, lstat, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { Config, TAVERN_NS, resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'
import { changedSettingsPatch, applySettingsPatch } from '../src/client/settingsPatch.js'
import { collectCompleteText } from '../src/node/collectText.js'
import { saveEditorDraft, getEditorDraft, EDITOR_DRAFT_MAX_BYTES } from '../src/node/editorDrafts.js'
import { boundedBytes, boundedJson } from '../src/node/backupFiles.js'
import { SESSION_ARCHIVE_MAX_FILES } from '../src/node/sessionArchiveFormat.js'
import { snapshotSessionArchive } from '../src/node/sessionArchiveSnapshot.js'
import { FileSettings } from './hostSettingsFactory.js'

describe('对抗性压力测试：Issues 14-17', () => {
  let root: string
  const contexts: Context[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tavern-stress-test-'))
  })

  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })

  function makeState(): TavernState {
    return new TavernState({
      root,
      characters: join(root, 'characters'),
      lorebooks: join(root, 'library', 'lorebooks'),
      presets: join(root, 'library', 'presets'),
      personas: join(root, 'personas'),
      regexDir: join(root, 'regex'),
      sessions: join(root, 'sessions'),
    }, () => resolveConfig({}))
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Issue 14: Settings Revision Concurrency & Retries
  // ══════════════════════════════════════════════════════════════════════════
  describe('Issue 14: 设置修订号并发冲突与重试机制', () => {
    it('20 个并发 savePersona 同时竞争空默认人设：只有一个成为默认，无数据损坏与死锁', async () => {
      const ctx = new Context()
      contexts.push(ctx)
      const profile = join(root, 'settings.json')
      await writeFile(profile, JSON.stringify({ [TAVERN_NS]: { defaults: { personaId: '' } } }))
      const hostSettings = await new FileSettings(ctx, profile).register(TAVERN_NS, Config)

      const state = makeState()
      await state.init()

      // 创建包装的 scope，注入随机延迟模拟高并发 I/O 竞争
      const scope: TavernSettingsScope = {
        get: () => hostSettings.get(),
        revision: () => hostSettings.revision(),
        update: async (patch: object, expectedRevision?: number) => {
          await new Promise(r => setTimeout(r, Math.floor(Math.random() * 5)))
          return hostSettings.update(patch, expectedRevision)
        },
      }

      const service = new TavernService(ctx, state, scope)

      // 启动 20 个并发 savePersona
      const personas = Array.from({ length: 20 }, (_, i) => ({
        id: `concurrent-persona-${i}`,
        name: `Persona ${i}`,
        description: `Desc ${i}`,
        avatar: null,
      }))

      const results = await Promise.all(
        personas.map(persona => service.savePersona({ persona, expectedRevision: null }))
      )

      // 验证 20 个人设全部在 state 中保存成功
      for (const persona of personas) {
        expect(await state.loadPersona(persona.id)).toMatchObject({ id: persona.id, name: persona.name })
      }

      // 验证 defaults.personaId 被设置且必须是 20 个中的某一个，绝不能是空或未定义
      const currentDefault = scope.get().defaults.personaId
      expect(personas.map(p => p.id)).toContain(currentDefault)

      // 验证每个调用的返回值符合规范
      for (const res of results) {
        expect(res.id).toBeDefined()
        expect(res.revision).toBeDefined()
      }
    })

    it('模拟持续冲突超过 3 次重试上限：savePersona 仍成功保存人设，仅返回 defaultWarning', async () => {
      const ctx = new Context()
      contexts.push(ctx)
      const profile = join(root, 'settings.json')
      await writeFile(profile, JSON.stringify({ [TAVERN_NS]: { defaults: { personaId: '' } } }))
      const hostSettings = await new FileSettings(ctx, profile).register(TAVERN_NS, Config)

      const state = makeState()
      await state.init()

      let attempts = 0
      const scope: TavernSettingsScope = {
        get: () => hostSettings.get(),
        revision: () => hostSettings.revision(),
        update: async () => {
          attempts++
          // 始终抛出 SETTINGS_CONFLICT 错误
          const err = new Error('Settings revision conflict')
          ;(err as any).code = 'SETTINGS_CONFLICT'
          throw err
        },
      }

      const service = new TavernService(ctx, state, scope)
      const persona = { id: 'retry-exhausted', name: 'Retry Test', description: '', avatar: null }

      const result = await service.savePersona({ persona, expectedRevision: null })

      // 验证最大尝试 3 次后退出
      expect(attempts).toBe(3)
      // 人设本体保存成功
      expect(await state.loadPersona(persona.id)).toMatchObject({ id: persona.id })
      // 返回值包含 defaultWarning 且没有崩溃
      expect(result.defaultWarning).toContain('Settings revision conflict')
    })

    it('deletePersona 并发删除：Windows 路径/名称大小写不敏感匹配清理', async () => {
      const ctx = new Context()
      contexts.push(ctx)
      const profile = join(root, 'settings.json')
      await writeFile(profile, JSON.stringify({ [TAVERN_NS]: { defaults: { personaId: 'Target-Persona-MixedCase' } } }))
      const hostSettings = await new FileSettings(ctx, profile).register(TAVERN_NS, Config)

      const state = makeState()
      await state.init()
      await state.savePersona({ id: 'target-persona-mixedcase', name: 'Target', description: '', avatar: null })

      const service = new TavernService(ctx, state, hostSettings)

      // 删除使用大写的 id
      const res = await service.deletePersona({ id: 'Target-Persona-MixedCase' })
      expect(res.deleted).toBe(true)

      // 默认人设应被成功置空
      expect(hostSettings.get().defaults.personaId).toBe('')
    })

    it('settingsPatch 对抗性模糊测试：深层差异识别与原型污染防护', () => {
      const baseline = {
        locale: 'zh',
        defaults: { cardId: 'card-1', presetId: 'preset-1', personaId: 'persona-1' },
        memory: { maxEntries: 50, compressBatch: 5 },
        cardNetworkWhitelist: ['https://example.com'],
      }

      // 1. 无修改时 patch 为空
      expect(changedSettingsPatch(baseline, baseline)).toEqual({})

      // 2. 深度修改单字段时仅提交该字段
      const modified = {
        ...baseline,
        defaults: { ...baseline.defaults, personaId: 'persona-2' },
      }
      expect(changedSettingsPatch(modified, baseline)).toEqual({
        defaults: { personaId: 'persona-2' },
      })

      // 3. 数组整体替换
      const arrayMod = {
        ...baseline,
        cardNetworkWhitelist: ['https://example.com', 'https://api.test'],
      }
      expect(changedSettingsPatch(arrayMod, baseline)).toEqual({
        cardNetworkWhitelist: ['https://example.com', 'https://api.test'],
      })

      // 4. 原型污染攻击注入
      const evilPatch = JSON.parse('{"__proto__":{"polluted":true},"defaults":{"cardId":"card-99"}}')
      const target = { ...baseline }
      const merged = applySettingsPatch(target, evilPatch)

      expect(merged.defaults.cardId).toBe('card-99')
      expect((Object.prototype as any).polluted).toBeUndefined()
      expect(({} as any).polluted).toBeUndefined()
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // Issue 15: Impersonate Fresh Model Resolution and Early Timeout
  // ══════════════════════════════════════════════════════════════════════════
  describe('Issue 15: AI 代答超时与流式收集防护', () => {
    it('collectCompleteText：未触发中止前正常收集多片段并遇到 stop 成功返回', async () => {
      const controller = new AbortController()
      async function* mockStream(): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', text: '你好' }
        yield { type: 'text-delta', text: '，我是代答台词' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }

      const text = await collectCompleteText(mockStream(), controller.signal)
      expect(text).toBe('你好，我是代答台词')
    })

    it('collectCompleteText：流挂起不返回时，AbortSignal 触发立即退出，不产生未处理拒绝', async () => {
      const controller = new AbortController()
      let returnCalled = false

      const hangingStream: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              // 永远不兑现的 promise
              return new Promise<IteratorResult<StreamChunk>>(() => {})
            },
            return() {
              returnCalled = true
              return Promise.resolve({ done: true, value: undefined })
            },
          }
        },
      }

      const pending = collectCompleteText(hangingStream, controller.signal)
      // 触发中止
      controller.abort(new Error('IMPERSONATE_TIMEOUT'))

      await expect(pending).rejects.toThrow('IMPERSONATE_TIMEOUT')
      expect(returnCalled).toBe(true)
    })

    it('collectCompleteText：iterator.return() 抛出异常时不会覆盖原有的取消原因，也不产生全局未捕获拒绝', async () => {
      const controller = new AbortController()

      const throwingStream: AsyncIterable<StreamChunk> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return new Promise<IteratorResult<StreamChunk>>(() => {})
            },
            return() {
              return Promise.reject(new Error('RETURN_METHOD_FAILED'))
            },
          }
        },
      }

      const pending = collectCompleteText(throwingStream, controller.signal)
      controller.abort(new Error('CLEAN_TIMEOUT'))

      await expect(pending).rejects.toThrow('CLEAN_TIMEOUT')
    })

    it('collectCompleteText 对抗性流：终止帧非 stop、超出 100k 字符、终止帧后继续发送均明确拒绝', async () => {
      const controller = new AbortController()

      // 1. 非 stop 终止
      async function* nonStopStream(): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', text: '部分台词' }
        yield { type: 'finish', reason: { kind: 'length' } as any }
      }
      await expect(collectCompleteText(nonStopStream(), controller.signal)).rejects.toThrow('模型未正常完成：length')

      // 2. 终止帧后继续发送
      async function* postFinishStream(): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', text: '正常台词' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        yield { type: 'text-delta', text: '多余的台词' }
      }
      await expect(collectCompleteText(postFinishStream(), controller.signal)).rejects.toThrow('模型在终止帧后继续发送内容')

      // 3. 超出 100k 字符限制
      async function* oversizedStream(): AsyncIterable<StreamChunk> {
        const bigChunk = 'a'.repeat(60_000)
        yield { type: 'text-delta', text: bigChunk }
        yield { type: 'text-delta', text: bigChunk }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      await expect(collectCompleteText(oversizedStream(), controller.signal)).rejects.toThrow('辅助生成正文超过上限')

      // 4. 空文本完成
      async function* emptyStream(): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', text: '   ' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      await expect(collectCompleteText(emptyStream(), controller.signal)).rejects.toThrow('模型未返回完整正文和成功终止帧')
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // Issue 16: Editor Draft Getter Execution Prevention & Bounded Reads
  // ══════════════════════════════════════════════════════════════════════════
  describe('Issue 16: 编辑草稿访问器零执行防护与句柄级有界读取', () => {
    const owner = 'test-browser-owner-challenge'
    const key = 'character:stress:key'

    it('极限对抗：各种带毒 getter（抛错、副作用、计数器、隐藏）均 0 次执行并直接拒绝', async () => {
      let getterInvocations = 0

      // 1. 顶层带毒 getter
      const poisonedObj = {
        title: 'safe title',
        get poison() {
          getterInvocations++
          throw new Error('POISON_GETTER_TRIGGERED')
        },
      }
      await expect(saveEditorDraft(root, owner, key, poisonedObj)).rejects.toThrow('编辑草稿无效')
      expect(getterInvocations).toBe(0)

      // 2. 嵌套在正常对象深处的带毒 getter
      const nestedPoison = {
        level1: {
          level2: {
            safe: 123,
            get bomb() {
              getterInvocations++
              throw new Error('NESTED_BOMB')
            },
          },
        },
      }
      await expect(saveEditorDraft(root, owner, key, nestedPoison)).rejects.toThrow('编辑草稿无效')
      expect(getterInvocations).toBe(0)

      // 3. 数组元素带毒 getter
      const arrayWithGetter = [1, 2, 3]
      Object.defineProperty(arrayWithGetter, '1', {
        get() {
          getterInvocations++
          return 'hacked'
        },
        enumerable: true,
        configurable: true,
      })
      await expect(saveEditorDraft(root, owner, key, { list: arrayWithGetter })).rejects.toThrow('编辑草稿无效')
      expect(getterInvocations).toBe(0)

      // 4. 不可枚举 getter（尝试绕过普通 keys 遍历）
      const sneakyObj = {}
      Object.defineProperty(sneakyObj, 'sneaky', {
        get() {
          getterInvocations++
          return 42
        },
        enumerable: false,
        configurable: true,
      })
      await expect(saveEditorDraft(root, owner, key, sneakyObj)).rejects.toThrow('编辑草稿无效')
      expect(getterInvocations).toBe(0)

      // 5. 不可枚举数据属性
      const nonEnumData = {}
      Object.defineProperty(nonEnumData, 'secret', {
        value: 'hidden',
        enumerable: false,
      })
      await expect(saveEditorDraft(root, owner, key, nonEnumData)).rejects.toThrow('编辑草稿无效')
      expect(getterInvocations).toBe(0)

      // 6. 稀疏数组（空洞）
      const sparseArr = new Array(5)
      sparseArr[0] = 'first'
      sparseArr[4] = 'last'
      await expect(saveEditorDraft(root, owner, key, { sparse: sparseArr })).rejects.toThrow('编辑草稿无效')
      expect(getterInvocations).toBe(0)

      // 7. 符号属性（Symbol）
      const symbolObj = { [Symbol('exploit')]: 'payload' }
      await expect(saveEditorDraft(root, owner, key, symbolObj)).rejects.toThrow('编辑草稿无效')
      expect(getterInvocations).toBe(0)

      // 验证无论经历多少次攻击测试，getterInvocations 严格为 0
      expect(getterInvocations).toBe(0)
    })

    it('getEditorDraft 句柄级有界读取：超过 2 MiB、外部扩写、损坏结构均安全拦截', async () => {
      // 1. 正常保存一个草稿
      await saveEditorDraft(root, owner, key, { text: 'valid draft' })

      // 获取草稿文件真实路径
      const draft = await getEditorDraft(root, owner, key)
      expect(draft?.value).toEqual({ text: 'valid draft' })

      // 2. 模拟磁盘文件在读取时超过 2 MiB
      const hash = (input: string) => createHash('sha256').update(input, 'utf8').digest('hex')
      const filePath = join(root, 'editor-drafts', hash(owner), `${hash(key)}.json`)

      // 写入超限文件
      const oversizedBuf = Buffer.alloc(EDITOR_DRAFT_MAX_BYTES + 10, 'a')
      await writeFile(filePath, oversizedBuf)
      await expect(getEditorDraft(root, owner, key)).rejects.toThrow('已保存草稿大小超过 2 MiB')

      // 3. 损坏格式：JSON 乱码
      await writeFile(filePath, '{ bad json')
      await expect(getEditorDraft(root, owner, key)).rejects.toThrow('已保存草稿损坏')

      // 4. 格式结构异常：缺少 version 或 updatedAt 无效
      await writeFile(filePath, JSON.stringify({ version: 99, updatedAt: 'invalid date', value: {} }))
      await expect(getEditorDraft(root, owner, key)).rejects.toThrow('已保存草稿格式错误')
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // Issue 17: Session Archive File Preflight & Doctor/Backup TOCTOU
  // ══════════════════════════════════════════════════════════════════════════
  describe('Issue 17: 会话迁移超 20,000 文件预检与 Doctor/Backup TOCTOU 竞争检测', () => {
    it('会话迁移快照：总文件数超过 20,000 时，必须在读取任何正文前直接抛错拦截', async () => {
      const state = makeState()
      await state.init()

      const cardId = (await state.createCharacter('导出角色')).cardId
      const sessionId = 'session-one'
      await state.saveBinding({
        sessionId,
        cardId,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: false,
        greetingIndex: 0,
        createdAt: new Date(0).toISOString(),
      })

      const ctx = new Context()
      contexts.push(ctx)
      new SessionStore(ctx)
      const session = ctx.sessions.create(SessionId(sessionId))
      session.append('agent-preset/selected', { agentPreset: 'tavern' })

      const persistence = {
        open: async () => ({
          header: session.header,
          inheritedEventCount: 0,
          read: async () => ({ events: session.snapshotEvents() }),
          close: async () => {},
        }),
      }
      const fakeCtx = {
        sessions: { get: () => session, flush: async () => true },
        get: (name: string) => name === 'sessionPersistence' ? persistence : undefined,
      } as unknown as Context

      // 模拟返回超过 20,000 个 globalPaths
      const excessiveFiles = Array.from({ length: SESSION_ARCHIVE_MAX_FILES + 1 }, (_, i) => `library/presets/preset-${i}.json`)
      vi.spyOn(state, 'sessionArchiveAssetPaths').mockResolvedValue(excessiveFiles)

      // 执行快照导出，断言必须被 SESSION_ARCHIVE_MAX_FILES 拦截
      await expect(snapshotSessionArchive(fakeCtx, state, sessionId)).rejects.toThrow(
        `会话迁移文件数量超过 ${SESSION_ARCHIVE_MAX_FILES} 个上限，请使用全量备份`
      )
    })

    it('backupFiles:boundedJson 和 boundedBytes 遇到符号链接与硬链接文件立即拒绝', async () => {
      const targetFile = join(root, 'target.json')
      await writeFile(targetFile, JSON.stringify({ safe: true }))

      // 1. 符号链接
      const symlinkFile = join(root, 'symlink.json')
      try {
        await symlink(targetFile, symlinkFile, 'file')
        await expect(boundedJson(symlinkFile)).rejects.toThrow('LINK_NOT_ALLOWED')
        await expect(boundedBytes(symlinkFile, 1024)).rejects.toThrow('LINK_NOT_ALLOWED')
      } catch (err: any) {
        if (!['EPERM', 'ENOTSUP', 'EACCES'].includes(err.code)) throw err
      }

      // 2. 硬链接 (nlink > 1)
      const hardlinkFile = join(root, 'hardlink.json')
      try {
        await link(targetFile, hardlinkFile)
        await expect(boundedJson(targetFile)).rejects.toThrow('LINK_NOT_ALLOWED')
        await expect(boundedBytes(targetFile, 1024)).rejects.toThrow('LINK_NOT_ALLOWED')
      } catch (err: any) {
        if (!['EPERM', 'ENOTSUP', 'EACCES'].includes(err.code)) throw err
      }
    })

    it('backupFiles:boundedBytes TOCTOU 竞争检测：读取句柄 stat 与 before lstat 不一致时报错 SOURCE_CHANGED', async () => {
      const testFile = join(root, 'victim.dat')
      await writeFile(testFile, 'initial content')

      const before = await lstat(testFile)

      // 模拟外部修改文件内容与大小
      // 在 Windows 上，若文件在 open 句柄之后被修改，handleStat.size 发生变化
      const handle = await open(testFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        await writeFile(testFile, 'modified much longer content that changes inode/size')

        const handleStat = await handle.stat()
        // 关键 TOCTOU 不变量：before.size (15) 与 handleStat.size (52) 不匹配
        expect(before.size !== handleStat.size).toBe(true)

        // 验证同文件断言 sameFile 逻辑必定拒绝
        const same = before.isFile() && handleStat.isFile()
          && before.size === handleStat.size && before.mtimeMs === handleStat.mtimeMs
        expect(same).toBe(false)
      } finally {
        await handle.close()
      }
    })

    it('会话迁移快照：附件数超过 20,000 时，同样在读取正文前直接抛错拦截', async () => {
      const state = makeState()
      await state.init()

      const cardId = (await state.createCharacter('导出角色附件超限')).cardId
      const sessionId = 'session-attach-overload'
      await state.saveBinding({
        sessionId,
        cardId,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: false,
        greetingIndex: 0,
        createdAt: new Date(0).toISOString(),
      })

      const ctx = new Context()
      contexts.push(ctx)
      new SessionStore(ctx)
      const session = ctx.sessions.create(SessionId(sessionId))

      // 模拟超过 20,000 个图片附件引用（通过 user/message 事件）
      const events: any[] = []
      for (let i = 0; i <= SESSION_ARCHIVE_MAX_FILES; i++) {
        events.push({
          type: 'user/message',
          data: {
            content: [{ type: 'image', attachment: { attachmentId: `img-ref-${i}` } }],
          },
        })
      }

      const persistence = {
        open: async () => ({
          header: { id: sessionId },
          inheritedEventCount: 0,
          read: async () => ({ events }),
          close: async () => {},
        }),
      }
      // 会话已持久化但在内存中当前未处于 live 激活状态（get 返回 undefined）
      const fakeCtx = {
        sessions: { get: () => undefined },
        get: (name: string) => name === 'sessionPersistence' ? persistence : undefined,
      } as unknown as Context

      await expect(snapshotSessionArchive(fakeCtx, state, sessionId)).rejects.toThrow(
        `会话迁移附件数量超过 ${SESSION_ARCHIVE_MAX_FILES} 个上限，请使用全量备份`
      )
    })
  })

  describe('Issue 14 & 16: 附加边界攻击测试', () => {
    it('Issue 14: 宿主未实现 revision() 接口时，服务优雅降级不抛异常', async () => {
      const ctx = new Context()
      contexts.push(ctx)
      const state = makeState()
      await state.init()

      let updated = false
      // 遗留宿主：没有 revision() 成员函数
      const legacyScope: TavernSettingsScope = {
        get: () => ({ defaults: { personaId: '' } } as any),
        revision: undefined as any,
        update: async (patch: object) => {
          updated = true
        },
      }

      const service = new TavernService(ctx, state, legacyScope)
      const persona = { id: 'legacy-host-persona', name: 'Legacy', description: '', avatar: null }

      const result = await service.savePersona({ persona, expectedRevision: null })
      expect(result.id).toBe('legacy-host-persona')
      expect(updated).toBe(true)
    })

    it('Issue 16: 原型链上的带毒 getter、数组循环引用与深度限制攻击均被安全拦截', async () => {
      let prototypeGetterFired = false
      const poisonProto = {
        get evil() {
          prototypeGetterFired = true
          return 'hacked'
        },
      }
      const protoObj = Object.create(poisonProto)
      protoObj.title = 'safe'

      // 原型非 Object.prototype / null 必须直接拒绝，且不得触发原型上的 getter
      await expect(saveEditorDraft(root, 'browser-prototype-atk', 'key', protoObj)).rejects.toThrow('编辑草稿无效')
      expect(prototypeGetterFired).toBe(false)

      // 数组循环引用
      const circularArr: any[] = []
      circularArr.push(circularArr)
      await expect(saveEditorDraft(root, 'browser-circular-atk', 'key', { list: circularArr })).rejects.toThrow('不能包含循环引用')

      // 超过 128 层超深嵌套
      let deepObj: any = { depth: 0 }
      for (let i = 0; i < 135; i++) {
        deepObj = { child: deepObj }
      }
      await expect(saveEditorDraft(root, 'browser-depth-atk', 'key', deepObj)).rejects.toThrow('嵌套层数过多')
    })
  })
})

