/**
 * 角色卡解析单测：手工构造最小 PNG（签名 + IHDR + tEXt/zTXt/iTXt + IEND），
 * chunk 长度字段按实填写，CRC 填 0（解析器不校验）。覆盖 depth_prompt、空白卡、
 * PNG 往返导出与导出侧截断拒绝（源图缺 IEND 时 embedCardInPng 抛错）、
 * 导入硬上限（PNG 文件 32MB / 内嵌与独立 JSON 8MB / zTXt+iTXt 解压输出 4MB 压缩炸弹拒绝）。
 */

import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  CardParseError,
  applyCharacterPatch,
  cardToStJson,
  createBlankCard,
  embedCardInPng,
  parseJsonCard,
  parsePngCard,
} from '../src/state/card.js'

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

interface PngChunk {
  type: string
  data: Uint8Array
}

/** 拼接最小 PNG：签名 + 给定 chunks + IEND。 */
function buildPng(chunks: PngChunk[]): Uint8Array {
  const parts: Uint8Array[] = [PNG_SIGNATURE]
  for (const { type, data } of [...chunks, { type: 'IEND', data: new Uint8Array(0) }]) {
    const header = new Uint8Array(8)
    new DataView(header.buffer).setUint32(0, data.length)
    for (let i = 0; i < 4; i++) header[4 + i] = type.charCodeAt(i)
    parts.push(header, data, new Uint8Array(4)) // CRC 填 0
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** 13 字节内容随意的 IHDR。 */
const IHDR: PngChunk = { type: 'IHDR', data: new Uint8Array(13) }

/** 构造 keyword + 0x00 + base64(JSON) 的 tEXt chunk。 */
function textChunk(keyword: string, json: unknown): PngChunk {
  const b64 = Buffer.from(JSON.stringify(json), 'utf-8').toString('base64')
  return { type: 'tEXt', data: Buffer.from(keyword + '\0' + b64, 'latin1') }
}

const V2_DATA = {
  name: '艾莉丝',
  description: '一位旅人',
  personality: '冷静而健谈',
  scenario: '边境酒馆',
  first_mes: '你好，旅人。',
  alternate_greetings: ['又见面了。', '欢迎光临。'],
  mes_example: '{{user}}: 你好\n{{char}}: 你好',
  system_prompt: '始终保持角色。',
  post_history_instructions: '总结上文。',
  creator_notes: '测试用卡',
  creator: 'tester',
  character_version: '1.2',
  tags: ['fantasy', 'tavern'],
  character_book: {
    name: '旅人百科',
    entries: [{ keys: ['酒馆'], content: '热闹的地方' }],
  },
  regex_scripts: [
    { scriptName: '去前缀', findRegex: '^\\w+:', replaceString: '', placement: [2] },
  ],
  extensions: { talkativeness: 0.5 },
}

const V2_JSON = { spec: 'chara_card_v2', spec_version: '2.0', data: V2_DATA }

describe('parsePngCard', () => {
  it('解析 V2 PNG 卡全部字段', () => {
    const png = buildPng([IHDR, textChunk('chara', V2_JSON)])
    const card = parsePngCard(png)

    expect(card.spec).toBe('chara_card_v2')
    expect(card.name).toBe('艾莉丝')
    expect(card.description).toBe('一位旅人')
    expect(card.personality).toBe('冷静而健谈')
    expect(card.scenario).toBe('边境酒馆')
    expect(card.firstMes).toBe('你好，旅人。')
    expect(card.alternateGreetings).toEqual(['又见面了。', '欢迎光临。'])
    expect(card.mesExample).toBe('{{user}}: 你好\n{{char}}: 你好')
    expect(card.systemPrompt).toBe('始终保持角色。')
    expect(card.postHistoryInstructions).toBe('总结上文。')
    expect(card.creatorNotes).toBe('测试用卡')
    expect(card.creator).toBe('tester')
    expect(card.characterVersion).toBe('1.2')
    expect(card.tags).toEqual(['fantasy', 'tavern'])
    expect(card.characterBook?.name).toBe('旅人百科')
    expect(card.characterBook?.entries).toHaveLength(1)
    expect(card.extensions.talkativeness).toBe(0.5)
    expect(card.pngBytes).toEqual(png)
    expect(card.raw).toEqual(V2_JSON)
  })

  it('识别 ccv3 关键字为 V3 卡', () => {
    const v3Json = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { name: 'V3 角色', first_mes: '嗯。', assets: [{ type: 'icon' }] },
    }
    const card = parsePngCard(buildPng([IHDR, textChunk('ccv3', v3Json)]))

    expect(card.spec).toBe('chara_card_v3')
    expect(card.name).toBe('V3 角色')
    expect(card.firstMes).toBe('嗯。')
    // V3 额外字段进 extensions
    expect(card.extensions.assets).toEqual([{ type: 'icon' }])
  })

  it('ccv3 与 chara 同时存在时优先 ccv3', () => {
    const png = buildPng([
      IHDR,
      textChunk('chara', { name: '旧卡' }),
      textChunk('ccv3', { spec: 'chara_card_v3', data: { name: '新卡' } }),
    ])
    const card = parsePngCard(png)

    expect(card.spec).toBe('chara_card_v3')
    expect(card.name).toBe('新卡')
  })

  it('非 PNG 输入报 CardParseError', () => {
    expect(() => parsePngCard(new Uint8Array([1, 2, 3, 4]))).toThrow(CardParseError)
    expect(() => parsePngCard(new Uint8Array([1, 2, 3, 4]))).toThrow(/PNG/)
  })

  it('无 chara/ccv3 块的 PNG 报错', () => {
    expect(() => parsePngCard(buildPng([IHDR]))).toThrow(CardParseError)
    expect(() => parsePngCard(buildPng([IHDR]))).toThrow(/chara/)
  })

  it('解析 zTXt 压缩块', () => {
    const b64 = Buffer.from(JSON.stringify(V2_JSON), 'utf-8').toString('base64')
    const compressed = deflateSync(Buffer.from(b64, 'latin1'))
    const data = Buffer.concat([Buffer.from('chara\0\0', 'latin1'), compressed])
    const card = parsePngCard(buildPng([IHDR, { type: 'zTXt', data }]))
    expect(card.name).toBe('艾莉丝')
  })

  it('解析未压缩 iTXt 块', () => {
    const b64 = Buffer.from(JSON.stringify(V2_JSON), 'utf-8').toString('base64')
    const data = Buffer.concat([
      Buffer.from('chara\0', 'latin1'),
      Buffer.from([0, 0]),
      Buffer.from('\0\0', 'latin1'),
      Buffer.from(b64, 'utf8'),
    ])
    const card = parsePngCard(buildPng([IHDR, { type: 'iTXt', data }]))
    expect(card.name).toBe('艾莉丝')
  })

  it('embedCardInPng 后再 parsePngCard 还原', () => {
    const json = cardToStJson(parseJsonCard(V2_JSON))
    const png = embedCardInPng(null, json, 'chara_card_v2')
    const card = parsePngCard(png)
    expect(card.name).toBe('艾莉丝')
    expect(card.description).toBe('一位旅人')
  })

  it('源 PNG 缺 IEND（截断）时 embedCardInPng 抛 CardParseError，不产出废图', () => {
    // parsePngCard 不要求 IEND：chara 块后被截断的卡仍可导入
    const truncated = buildPng([IHDR, textChunk('chara', { name: 'x' })]).slice(0, -12)
    expect(parsePngCard(truncated).name).toBe('x')
    // 但导出必须拒绝：否则循环静默 break，产出无卡数据也无 IEND 的废图且无任何提示
    expect(() => embedCardInPng(truncated, { name: 'x' }, 'chara_card_v2')).toThrow(CardParseError)
    expect(() => embedCardInPng(truncated, { name: 'x' }, 'chara_card_v2')).toThrow(/IEND/)
  })

  it('防御畸形 chunk 长度（截断）', () => {
    const good = buildPng([IHDR, textChunk('chara', { name: 'x' })])
    // 篡改 IHDR 长度字段为超大值，制造截断
    const bad = good.slice()
    new DataView(bad.buffer).setUint32(8, 0x7fffffff)
    expect(() => parsePngCard(bad)).toThrow(CardParseError)
    expect(() => parsePngCard(bad)).toThrow(/截断|畸形/)
  })

  it('zTXt 压缩炸弹：解压输出超 4MB 上限抛 CardParseError（5MB 重复字符 deflate 后仅 ~5KB）', () => {
    const packed = deflateSync(Buffer.alloc(5 * 1024 * 1024, 0x41))
    expect(packed.length).toBeLessThan(64 * 1024) // 确实压得很小，纯靠解压膨胀
    const data = Buffer.concat([Buffer.from('chara\0\0', 'latin1'), packed])
    const png = buildPng([IHDR, { type: 'zTXt', data }])
    expect(() => parsePngCard(png)).toThrow(CardParseError)
    expect(() => parsePngCard(png)).toThrow(/压缩炸弹/)
  })

  it('iTXt 压缩块同样受 4MB 解压上限约束', () => {
    const packed = deflateSync(Buffer.alloc(5 * 1024 * 1024, 0x61))
    const data = Buffer.concat([
      Buffer.from('chara\0', 'latin1'),
      Buffer.from([1, 0]), // compression_flag=1, compression_method=0
      Buffer.from('\0\0', 'latin1'), // language \0 translated \0
      packed,
    ])
    const png = buildPng([IHDR, { type: 'iTXt', data }])
    expect(() => parsePngCard(png)).toThrow(CardParseError)
    expect(() => parsePngCard(png)).toThrow(/压缩炸弹/)
  })

  it('上限内的 zTXt 正常解压（不回归既有能力）', () => {
    const b64 = Buffer.from(JSON.stringify(V2_JSON), 'utf-8').toString('base64')
    const compressed = deflateSync(Buffer.from(b64, 'latin1'))
    const data = Buffer.concat([Buffer.from('ccv3\0\0', 'latin1'), compressed])
    const card = parsePngCard(buildPng([IHDR, { type: 'zTXt', data }]))
    expect(card.name).toBe('艾莉丝')
  })

  it('PNG 文件超过 32MB 直接拒绝，不逐 chunk 扫描', () => {
    const fat: PngChunk = { type: 'IDAT', data: new Uint8Array(33 * 1024 * 1024) }
    const png = buildPng([IHDR, fat, textChunk('chara', { name: 'x' })])
    expect(() => parsePngCard(png)).toThrow(CardParseError)
    expect(() => parsePngCard(png)).toThrow(/32MB/)
  })

  it('PNG 内嵌 JSON 文本超过 8MB 拒绝（tEXt 不压缩也受文本上限约束）', () => {
    const bigJson = { name: 'x', description: 'A'.repeat(8 * 1024 * 1024) }
    const png = buildPng([IHDR, textChunk('chara', bigJson)])
    expect(() => parsePngCard(png)).toThrow(CardParseError)
    expect(() => parsePngCard(png)).toThrow(/8MB/)
  })
})

describe('parseJsonCard', () => {
  it('V1 顶层平铺映射为归一化结构', () => {
    const card = parseJsonCard({
      name: '老式角色',
      description: '描述',
      personality: '性格',
      scenario: '场景',
      first_mes: '第一句',
      mes_example: '例子',
    })

    expect(card.spec).toBe('chara_card_v1')
    expect(card.name).toBe('老式角色')
    expect(card.description).toBe('描述')
    expect(card.personality).toBe('性格')
    expect(card.scenario).toBe('场景')
    expect(card.firstMes).toBe('第一句')
    expect(card.mesExample).toBe('例子')
    // 其余字段空默认
    expect(card.alternateGreetings).toEqual([])
    expect(card.systemPrompt).toBe('')
    expect(card.postHistoryInstructions).toBe('')
    expect(card.tags).toEqual([])
    expect(card.characterBook).toBeNull()
    expect(card.regexScripts).toEqual([])
    expect(card.pngBytes).toBeNull()
  })

  it('V2 data 缺失时回退顶层平铺', () => {
    const card = parseJsonCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      name: '平铺卡',
      first_mes: '你好',
      tags: ['a'],
    })

    expect(card.spec).toBe('chara_card_v2')
    expect(card.name).toBe('平铺卡')
    expect(card.firstMes).toBe('你好')
    expect(card.tags).toEqual(['a'])
  })

  it('character_book entries 对象 map 转数组', () => {
    const card = parseJsonCard({
      name: '带书卡',
      character_book: {
        entries: {
          '0': { keys: ['甲'], content: '内容甲' },
          '1': { keys: ['乙'], content: '内容乙' },
        },
      },
    })

    expect(card.characterBook?.entries).toEqual([
      { keys: ['甲'], content: '内容甲' },
      { keys: ['乙'], content: '内容乙' },
    ])
    expect(card.characterBook?.raw).toBeDefined()
  })

  it('character_book 顶层即为条目数组', () => {
    const card = parseJsonCard({
      name: '数组书',
      character_book: [{ keys: ['剑'], content: '断剑' }],
    })
    expect(card.characterBook?.entries).toEqual([{ keys: ['剑'], content: '断剑' }])
  })

  it('V2 data 缺 character_book 时回退顶层 / lorebook 别名', () => {
    const fromTop = parseJsonCard({
      spec: 'chara_card_v2',
      data: { name: '顶层书' },
      character_book: { name: '外置', entries: [{ keys: ['门'], content: '门后' }] },
    })
    expect(fromTop.characterBook?.name).toBe('外置')
    expect(fromTop.characterBook?.entries).toHaveLength(1)

    const fromAlias = parseJsonCard({
      spec: 'chara_card_v2',
      data: { name: '别名书', lorebook: { entries: [{ keys: ['窗'], content: '窗外' }] } },
    })
    expect(fromAlias.characterBook?.entries).toHaveLength(1)
  })

  it('缺少 name 报 CardParseError', () => {
    expect(() => parseJsonCard({ description: '无名氏' })).toThrow(CardParseError)
    expect(() => parseJsonCard({ description: '无名氏' })).toThrow(/name/)
  })

  it('JSON 卡序列化后超过 8MB 拒绝（remote 直传超大对象的兜底闸）', () => {
    const big = { name: 'x', description: 'A'.repeat(8 * 1024 * 1024) }
    expect(() => parseJsonCard(big)).toThrow(CardParseError)
    expect(() => parseJsonCard(big)).toThrow(/8MB/)
  })

  it('alternate_greetings 缺失时默认 []', () => {
    const card = parseJsonCard({ name: 'x' })
    expect(card.alternateGreetings).toEqual([])
  })

  it('regex_scripts 原样保留', () => {
    const scripts = [
      { scriptName: '去前缀', findRegex: '^\\w+:', replaceString: '', placement: [2] },
    ]
    const card = parseJsonCard({ spec: 'chara_card_v2', data: { name: 'x', regex_scripts: scripts } })
    expect(card.regexScripts).toEqual(scripts)
  })

  it('从 extensions.regex_scripts 读取（V3 卡常见落点）', () => {
    const scripts = [{ scriptName: 'html-cover', findRegex: '\\[cover\\]', replaceString: '<html></html>', placement: [2] }]
    const card = parseJsonCard({
      spec: 'chara_card_v3',
      data: { name: 'x', extensions: { regex_scripts: scripts } },
    })
    expect(card.regexScripts).toEqual(scripts)
  })

  it('非 string 字段容错转换', () => {
    const card = parseJsonCard({ name: 42, description: { nested: true }, personality: null })
    expect(card.name).toBe('42')
    expect(card.description).toBe('{"nested":true}')
    expect(card.personality).toBe('')
  })

  it('解析 extensions.depth_prompt', () => {
    const card = parseJsonCard({
      spec: 'chara_card_v2',
      data: { name: 'x', extensions: { depth_prompt: { prompt: 'DEPTH', depth: 2, role: 'user' } } },
    })
    expect(card.depthPrompt).toEqual({ prompt: 'DEPTH', depth: 2, role: 'user' })
  })

  it('createBlankCard / applyCharacterPatch 保留 cardId 无关字段并写出 depth_prompt', () => {
    const blank = createBlankCard('旅人')
    expect(blank.name).toBe('旅人')
    expect(blank.firstMes).toContain('旅人')
    const patched = applyCharacterPatch(blank, {
      description: '描述',
      depthPrompt: { prompt: 'DP', depth: 3, role: 'system' },
    })
    expect(patched.description).toBe('描述')
    expect(patched.depthPrompt).toEqual({ prompt: 'DP', depth: 3, role: 'system' })
    const json = cardToStJson(patched) as { data: { extensions: { depth_prompt: unknown } } }
    expect(json.data.extensions.depth_prompt).toEqual({ prompt: 'DP', depth: 3, role: 'system' })
  })
})
