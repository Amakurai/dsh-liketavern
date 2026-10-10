/**
 * 名字正好由功能字组成的角色：经真实剧情文件与组装管线，验证角色名、人设名在自动入模的检索里照常起作用。
 * 「七」是数词、「月」是泛义字，平时不作单字词；它们是这张卡或这个人设的名字时，不需要写进记忆的 keys。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveConfig } from '../src/node/config.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { TavernState } from '../src/node/state.js'

let root: string
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function story(cardName: string, personaName?: string) {
  root = await mkdtemp(join(tmpdir(), 'memory-named-'))
  const config = resolveConfig({ memory: { halfLifeDays: 0 } })
  const state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'),
    presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions') }, () => config)
  await state.init()
  const cardId = (await state.createCharacter(cardName)).cardId
  let personaId: string | null = null
  if (personaName) {
    personaId = 'factory-persona'
    await state.savePersona({ id: personaId, name: personaName, description: '', avatar: null })
  }
  await state.saveBinding({ sessionId: 'named', cardId, presetId: null, personaId, lorebookIds: [],
    characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  const ws = await state.storyWorkspace(cardId, (await state.loadBinding('named'))!.storyId)
  const injected = async (input: string): Promise<string> => {
    const result = await runTavernPipeline({ state, sessionId: 'named', agent: null, mode: 'preview',
      historyOverride: [{ role: 'user', content: input }] })
    expect(result).not.toBeNull()
    return result!.turnContext
  }
  return { ws, injected }
}

const FACTS = ['七三年前在南方的码头失踪，至今下落不明。', '月把那封信藏进了琴盒的夹层。', '北门每晚亥时落锁。', '灯塔的看守人是个哑巴老人。', '七天后补给船才会到港。']

it('角色名是数词「七」：问起七时，提到七的记忆入模', async () => {
  const { ws, injected } = await story('七')
  for (const body of FACTS) await ws.memory.write({ body })
  const context = await injected('七后来找到了吗')
  expect(context).toContain(FACTS[0])
  // 别的名字没有被连带声明
  expect(context).not.toContain(FACTS[1])
  expect(context).not.toContain(FACTS[2])
})

it('人设名是「月」：问起月时，提到月的记忆入模；换一张不叫这个名字的卡则不会', async () => {
  const named = await story('雾港巡夜人', '月')
  for (const body of FACTS) await named.ws.memory.write({ body })
  expect(await named.injected('月把信放哪了')).toContain(FACTS[1])
  await rm(root, { recursive: true, force: true })
  const plain = await story('雾港巡夜人')
  for (const body of FACTS) await plain.ws.memory.write({ body })
  // 没有人叫「月」时它只是个泛义字；这句话里其余的词也不在记忆里
  expect(await plain.injected('月亮今晚很圆')).not.toContain(FACTS[1])
})

it('人设名叫「我」不算声明：不会让每句带「我」的话都带出记忆', async () => {
  const { ws, injected } = await story('雾港巡夜人', '我')
  await ws.memory.write({ body: '我把钥匙交给了守卫。' })
  await ws.memory.write({ body: '北门每晚亥时落锁。' })
  expect(await injected('我今天好累啊')).not.toContain('我把钥匙交给了守卫。')
})
