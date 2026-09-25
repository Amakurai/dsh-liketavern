/**
 * remote 契约（src/remote.ts）覆盖点：
 * - 描述符形态：三处同步的方法集齐全、id/service/namespace/method 与 codec 模式正确。
 * - zod/mini 迁移守卫：每个参数 codec 的 schema 必须有可调用的 `.parse`
 *   （gateway 两面都只用这一个方法：client 侧 parseInput、host 侧 decode）。
 * - 校验语义：非空串、正整数 turn、可选字段缺省放行、枚举与数组类型拒绝错值。
 * - 收紧后的结构化入参（SessionBinding / Persona / RegexRule / saveMemory.id / swipeGreeting.index）：
 *   缺字段、错类型、坏枚举拒绝，未知字段按 zod strip 丢弃。
 * - 宽松传输仅留给复杂资产（卡/预设/世界书 JSON、设置补丁），由存储层归一化严格校验。
 * - host / client 两份贡献共享同一批描述符实例。
 */
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it } from 'vitest'
import { TYPERT_HOST, TYPERT_REMOTE } from '../src/remote.js'

type Codec = (typeof TYPERT_REMOTE.descriptors)[number]["parameters"][number]["codec"]
const descriptors = TYPERT_REMOTE.descriptors
const byMethod = new Map(descriptors.map((d) => [d.method, d]))

function requestCodec(method: string): Codec {
  const descriptor = byMethod.get(method)
  expect(descriptor, `缺少 remote 方法 ${method}`).toBeDefined()
  const parameter = descriptor!.parameters[0]!
  expect(parameter.wire).toBe('request')
  return parameter.codec
}

describe('remote 契约描述符', () => {
  it('真实宿主注册器接受所有 strict 工厂并完整撤销贡献', async () => {
    const ctx = new Context()
    const registry = new TypertRegistry(ctx)
    const dispose = registry.register(TYPERT_HOST)
    try {
      expect(registry.local.list()).toHaveLength(descriptors.length)
      const codec = registry.local.get('tavern/getFloorUserMessage')!.parameters[0]!.codec
      expect(codec.mode).toBe('strict')
      if (codec.mode !== 'strict') throw new Error('strict boundary missing')
      expect(() => codec.create().parse({ sessionId: '', messageId: 'm' })).toThrow()
      expect(codec.create().parse({ sessionId: 's', messageId: 'm' })).toEqual({ sessionId: 's', messageId: 'm' })
    } finally {
      await dispose()
      expect(registry.local.list()).toHaveLength(0)
      await ctx.fiber.dispose()
    }
  })
  it('每个方法都是 direct 调用 + 单个 request 参数 + strict codec', () => {
    expect(descriptors.length).toBeGreaterThan(50)
    for (const d of descriptors) {
      expect(d.id).toBe(`dsh-liketavern#tavern/${d.method}`)
      expect(d.service).toBe('tavern')
      expect(d.namespace).toBe('tavern')
      expect(d.invocation.kind).toBe('direct')
      expect(d.parameters).toHaveLength(1)
      expect(d.parameters[0]!.codec.mode).toBe('strict')
      expect(d.result.mode).toBe('strict')
    }
  })

  it('host 与 client 两份贡献共享同一批描述符', () => {
    expect(TYPERT_HOST.invocations).toBe(TYPERT_REMOTE.descriptors)
    expect(TYPERT_HOST.package).toBe('dsh-liketavern')
    expect(TYPERT_HOST.face).toBe('host')
  })

  it('model 里每个 service 成员都对应一个描述符', () => {
    const members = TYPERT_HOST.model.services[0]!.members.map((m) => m.name)
    expect(new Set(members)).toEqual(new Set(descriptors.map((d) => d.method)))
    for (const m of TYPERT_HOST.model.services[0]!.members) {
      expect(m.summary.length).toBeGreaterThan(0)
    }
  })
})

describe('请求 schema 校验（gateway 只调用 .parse）', () => {
  it('每个方法的 request schema 都暴露可调用的 parse', () => {
    for (const d of descriptors) {
      expect(typeof d.parameters[0]!.codec.create().parse, d.method).toBe('function')
      expect(typeof d.result.create().parse, d.method).toBe('function')
    }
  })

  it('sessionId / cardId / messageId 必须非空', () => {
    const codec = requestCodec('getFloorUserMessage')
    expect(codec.create().parse({ sessionId: 's1', messageId: 'm1' })).toEqual({ sessionId: 's1', messageId: 'm1' })
    expect(() => codec.create().parse({ sessionId: '', messageId: 'm1' })).toThrow()
    expect(() => codec.create().parse({ sessionId: 's1', messageId: '' })).toThrow()
    expect(() => codec.create().parse({ sessionId: 's1' })).toThrow()
  })

  it('收纳、恢复与永久删除共用非空 cardId 边界', () => {
    for (const method of ['archiveCharacter', 'restoreCharacter', 'deleteCharacter']) {
      const codec = requestCodec(method)
      expect(codec.create().parse({ cardId: 'card-a1b2c3d4' })).toEqual({ cardId: 'card-a1b2c3d4' })
      expect(() => codec.create().parse({ cardId: '' }), method).toThrow()
      expect(() => codec.create().parse({}), method).toThrow()
    }
    expect(requestCodec('listArchivedCharacters').create().parse({})).toEqual({})
  })

  it('楼层 turn 是可选正整数，messageId 也可缺省', () => {
    const codec = requestCodec('regenerate')
    expect(codec.create().parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' })
    expect(codec.create().parse({ sessionId: 's1', turn: 3 })).toEqual({ sessionId: 's1', turn: 3 })
    expect(() => codec.create().parse({ sessionId: 's1', turn: 0 })).toThrow()
    expect(() => codec.create().parse({ sessionId: 's1', turn: 1.5 })).toThrow()
  })

  it('可选字段缺省放行、类型错误拒绝（saveCharacter 的 depthPrompt 可空）', () => {
    const codec = requestCodec('saveCharacter')
    expect(codec.create().parse({ cardId: 'c1' })).toEqual({ cardId: 'c1' })
    expect(codec.create().parse({ cardId: 'c1', depthPrompt: null })).toEqual({ cardId: 'c1', depthPrompt: null })
    expect(
      codec.create().parse({ cardId: 'c1', depthPrompt: { prompt: 'p', depth: 4, role: 'system' }, tags: ['a'] }),
    ).toEqual({ cardId: 'c1', depthPrompt: { prompt: 'p', depth: 4, role: 'system' }, tags: ['a'] })
    expect(() => codec.create().parse({ cardId: 'c1', depthPrompt: { prompt: 'p', depth: 4, role: 'bogus' } })).toThrow()
    expect(() => codec.create().parse({ cardId: 'c1', tags: 'a' })).toThrow()
  })

  it('枚举字段只接受公布的取值（addWorldDelta.type）', () => {
    const codec = requestCodec('addWorldDelta')
    expect(codec.create().parse({ cardId: 'c1', type: 'update', content: 'x' })).toMatchObject({ type: 'update' })
    expect(() => codec.create().parse({ cardId: 'c1', type: 'remove', content: 'x' })).toThrow()
    expect(() => codec.create().parse({ cardId: 'c1', type: 'add', content: '' })).toThrow()
  })

  it('宽松资产字段（预设/世界书 JSON、设置补丁）放行任意 JSON，由存储层归一化严格校验', () => {
    const lore = requestCodec('saveLorebook')
    expect(lore.create().parse({ name: 'book', json: { entries: { 0: { key: ['k'] } } } })).toBeTruthy()
    expect(lore.create().parse({ name: 'book', json: null })).toBeTruthy()
    const preset = requestCodec('importPreset')
    expect(preset.create().parse({ name: 'p', json: { anything: true } })).toBeTruthy()
    const settings = requestCodec('updateSettings')
    expect(settings.create().parse({ patch: { worldInfo: { tokenBudget: 1024 } } })).toBeTruthy()
  })

  it('setSessionBinding 按 SessionBinding 字段全集收紧：缺字段/错类型拒绝，未知字段 strip', () => {
    const codec = requestCodec('setSessionBinding')
    const binding = {
      sessionId: 's1',
      cardId: 'card-abc12345',
      presetId: null,
      personaId: null,
      lorebookIds: ['book.json'],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: '2025-01-01T00:00:00.000Z',
    }
    expect(codec.create().parse({ binding })).toEqual({ binding })
    // 可选字段与 walLineage 透传；未知字段被 strip（对齐 parseSessionBinding 的丢弃行为）
    expect(
      codec.create().parse({
        binding: {
          ...binding,
          cardName: '角色',
          authorNote: '笔记',
          injectJournal: true,
          interactiveCards: false,
          walLineage: [{ sessionId: 's0', throughTurn: 2 }],
          futureField: 1,
        },
      }),
    ).toEqual({
      binding: {
        ...binding,
        cardName: '角色',
        authorNote: '笔记',
        injectJournal: true,
        interactiveCards: false,
        walLineage: [{ sessionId: 's0', throughTurn: 2 }],
      },
    })
    const { presetId: _presetId, ...missingPresetId } = binding
    expect(() => codec.create().parse({ binding: missingPresetId })).toThrow()
    expect(() => codec.create().parse({ binding: { ...binding, lorebookIds: 'book.json' } })).toThrow()
    expect(() => codec.create().parse({ binding: { ...binding, greetingIndex: -1 } })).toThrow()
    expect(() => codec.create().parse({ binding: { ...binding, greetingIndex: 0.5 } })).toThrow()
    expect(() => codec.create().parse({ binding: { ...binding, interactiveCards: 'yes' } })).toThrow()
    expect(() =>
      codec.create().parse({ binding: { ...binding, walLineage: [{ sessionId: 's0', throughTurn: -1 }] } }),
    ).toThrow()
    expect(() => codec.create().parse({ binding: null })).toThrow()
  })

  it('savePersona 按 Persona 形状校验（avatar 可 null，lorebookId 可缺省）', () => {
    const codec = requestCodec('savePersona')
    const persona = { id: 'persona-1', name: '旅人', description: '', avatar: null, lorebookId: null }
    expect(codec.create().parse({ persona })).toEqual({ persona })
    const { lorebookId: _lorebookId, ...withoutLorebookId } = persona
    expect(codec.create().parse({ persona: withoutLorebookId })).toEqual({ persona: withoutLorebookId })
    const { avatar: _avatar, ...missingAvatar } = persona
    expect(() => codec.create().parse({ persona: missingAvatar })).toThrow()
    expect(() => codec.create().parse({ persona: { ...persona, avatar: 1 } })).toThrow()
    expect(() => codec.create().parse({ persona: { ...persona, id: '' } })).toThrow()
  })

  it('saveRegexRules 按 RegexRule 形状校验（枚举/可空深度/0-2 的 substituteRegex）', () => {
    const codec = requestCodec('saveRegexRules')
    const rule = {
      id: 'rule-1',
      name: 'r',
      find: 'a',
      replace: 'b',
      enabled: true,
      scopes: ['prompt'],
      timing: ['send'],
      minDepth: null,
      maxDepth: null,
      substituteRegex: 0,
      source: 'user',
    }
    expect(codec.create().parse({ rules: [rule] })).toEqual({ rules: [rule] })
    expect(
      codec.create().parse({ rules: [{ ...rule, roles: ['user', 'assistant'], trimStrings: ['x'], trimStringsRegex: ['y'] }] }),
    ).toBeTruthy()
    expect(() => codec.create().parse({ rules: [{ ...rule, scopes: ['bogus'] }] })).toThrow()
    expect(() => codec.create().parse({ rules: [{ ...rule, timing: ['bogus'] }] })).toThrow()
    expect(() => codec.create().parse({ rules: [{ ...rule, source: 'bogus' }] })).toThrow()
    expect(() => codec.create().parse({ rules: [{ ...rule, substituteRegex: 3 }] })).toThrow()
    expect(() => codec.create().parse({ rules: [{ ...rule, enabled: 'yes' }] })).toThrow()
  })

  it('saveMemory 的 id 可缺省但一旦给出必须非空', () => {
    const codec = requestCodec('saveMemory')
    expect(codec.create().parse({ cardId: 'c1', body: 'x' })).toEqual({ cardId: 'c1', body: 'x' })
    expect(codec.create().parse({ cardId: 'c1', id: 'm1', body: 'x' })).toBeTruthy()
    expect(() => codec.create().parse({ cardId: 'c1', id: '', body: 'x' })).toThrow()
    expect(() => codec.create().parse({ cardId: 'c1', body: '' })).toThrow()
  })

  it('swipeGreeting 的 index 是非负整数', () => {
    const codec = requestCodec('swipeGreeting')
    expect(codec.create().parse({ sessionId: 's1', index: 0 })).toEqual({ sessionId: 's1', index: 0 })
    expect(() => codec.create().parse({ sessionId: 's1', index: -1 })).toThrow()
    expect(() => codec.create().parse({ sessionId: 's1', index: 1.5 })).toThrow()
  })

  it('getFloorSiblings 的结果 schema 校验 swipe 形状', () => {
    const schema = byMethod.get('getFloorSiblings')!.result.create()
    expect(schema.parse({ swipe: null })).toEqual({ swipe: null })
    expect(schema.parse({ swipe: { turn: 2, index: 0, total: 3, siblings: ['a', 'b', 'c'] } })).toBeTruthy()
    expect(() => schema.parse({ swipe: { turn: 2, index: 0, total: 3 } })).toThrow()
  })
})

it('脚本库请求固定目标类型与资产身份，拒绝缺少预设/角色 ID 的请求',()=>{
  const codec=requestCodec('saveHelperScriptLibrary')
  for(const target of [{type:'global'},{type:'preset',presetId:'p'},{type:'character',cardId:'c'}])expect(codec.create().parse({target,revision:'r',trees:[]})).toMatchObject({target})
  for(const target of [{type:'preset'},{type:'character',cardId:''},{type:'file',path:'private.json'}])expect(()=>codec.create().parse({target,revision:'r',trees:[]})).toThrow()
})

it('世界书重绑只能使用声明的选择类型，会话新字段通过同一请求契约',()=>{
  const binding={sessionId:'s',cardId:'card-test1234',presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:'factory',useEmbeddedLorebook:false,characterLorebookIds:['extra']}
  expect(requestCodec('setSessionBinding').create().parse({binding})).toEqual({binding})
  const request={sessionId:'s',messageId:1,storyId:'story',bindingRevision:'rev',kind:'chat',selection:null}
  expect(requestCodec('rebindHelperWorldbooks').create().parse(request)).toEqual(request)
  expect(()=>requestCodec('rebindHelperWorldbooks').create().parse({...request,kind:'file'})).toThrow()
})
