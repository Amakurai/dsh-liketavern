/**
 * 角色卡 Core 与 State 层审计回归测试：
 * 1. V1 卡经 applyCharacterPatch 写入 V2 包装 raw 时同步升级 spec，且对历史已失步的旧卡（spec=v1 + raw=v2/v3）
 *    在 characterDataExtras、withoutEmbeddedCharacterBook 与 cardToStJson 中防御性识别包装层，同时保留纯 V1 自定义 data 字段。
 * 2. parsePngCard 的多块 zTXt/iTXt 累计解压预算（8MB 上限）与已满足关键字短路跳过（ccv3 优先、重复 chara 不重复解压）。
 * 3. assemblePrompt 不对 promptOnly 正则规则（timing 含 assemble 与 send）在 prompt/assemble 与 prompt/send 两阶段重复执行。
 * 4. cardToStJson 从 V2/V3 envelopeExtras 剔除全部陈旧 V1 顶层镜像字段，保留真正的厂商外层扩展。
 * 5. applyCharacterPatch 归一化 depthPrompt（空白归 null、规范键序与 -0 归零），消除重载后的假修订号冲突。
 * 6. embedCardInPng 仅在 pngBytes === null 时回退占位图，非空但不足 8 字节的损坏字节抛 CardParseError。
 * 7. inspectCharacterCompatibility 对 card.depthPrompt 与 extensions.depth_prompt 去重，同时保留对额外扩展字段的扫描。
 * 8. workspace.ts:deleteCharacter 持有 withWorkspaceLock(root) 与并发写串行，且与外层已持锁调用重入不死锁。
 */

import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assemblePrompt, defaultPreset } from '../src/core/assemble.js'
import { inspectCharacterCompatibility } from '../src/core/characterCompatibility.js'
import { characterDataExtras } from '../src/core/characterData.js'
import { compileCardRegexScripts, compilePresetRegexScripts } from '../src/core/regex.js'
import type { CharacterCard, RegexRule } from '../src/core/types.js'
import {
  CardParseError,
  applyCharacterPatch,
  cardToStJson,
  createBlankCard,
  embedCardInPng,
  hydrateStoredCard,
  parseJsonCard,
  parsePngCard,
  serializeStoredCard,
  withoutEmbeddedCharacterBook,
} from '../src/state/card.js'
import { characterEditRevision } from '../src/state/characterRevision.js'
import { deleteCharacter, importCard, loadCharacter } from '../src/state/workspace.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { withWorkspaceLock } from '../src/state/workspaceLock.js'

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IHDR = { type: 'IHDR', data: new Uint8Array(13) }

function buildPng(chunks: Array<{ type: string; data: Uint8Array }>): Uint8Array {
  const parts: Uint8Array[] = [PNG_SIGNATURE]
  for (const { type, data } of [...chunks, { type: 'IEND', data: new Uint8Array(0) }]) {
    const header = new Uint8Array(8)
    new DataView(header.buffer).setUint32(0, data.length)
    for (let i = 0; i < 4; i++) header[4 + i] = type.charCodeAt(i)
    parts.push(header, data, new Uint8Array(4))
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function tEXtChunk(keyword: string, json: unknown): { type: string; data: Uint8Array } {
  const b64 = Buffer.from(JSON.stringify(json), 'utf8').toString('base64')
  return { type: 'tEXt', data: Buffer.from(`${keyword}\0${b64}`, 'latin1') }
}

function zTXtChunk(keyword: string, compressed: Uint8Array): { type: string; data: Uint8Array } {
  return { type: 'zTXt', data: Buffer.concat([Buffer.from(`${keyword}\0\0`, 'latin1'), compressed]) }
}

function compressedITXtChunk(keyword: string, compressed: Uint8Array): { type: string; data: Uint8Array } {
  return {
    type: 'iTXt',
    data: Buffer.concat([
      Buffer.from(`${keyword}\0`, 'latin1'),
      Buffer.from([1, 0]),
      Buffer.from('\0\0', 'latin1'),
      compressed,
    ]),
  }
}

/** 构造尾部 Adler-32 校验损坏的 zlib 压缩载荷（会在完整解压出接近原始大小后才抛 Z_DATA_ERROR）。 */
function corruptTrailerDeflate(uncompressedBytes: number, fill = 0x41): Uint8Array {
  const packed = Buffer.from(deflateSync(Buffer.alloc(uncompressedBytes, fill)))
  packed[packed.length - 1] = (packed[packed.length - 1]! ^ 0xff) & 0xff
  return packed
}

describe('1. V1 卡 spec 与 V2 包装 raw 一致性及历史失步兼容', () => {
  it('applyCharacterPatch 将 V1 与 unknown 卡同步升级为 chara_card_v2，保留 V1 自定义字段与自定义 data 字段', () => {
    const v1 = parseJsonCard({
      spec: 'chara_card_v1',
      name: 'V1 角色',
      description: '旧描述',
      custom_direct: 'keep-me',
      data: { customRootData: 42 },
      extensions: { nested_ext: true },
    })
    expect(v1.spec).toBe('chara_card_v1')

    const patchedOnce = applyCharacterPatch(v1, { description: '新描述' })
    expect(patchedOnce.spec).toBe('chara_card_v2')
    const rawOnce = patchedOnce.raw as { spec: string; spec_version: string; data: Record<string, unknown> & { extensions: Record<string, unknown> } }
    expect(rawOnce.spec).toBe('chara_card_v2')
    expect(rawOnce.spec_version).toBe('2.0')
    expect(rawOnce.data.description).toBe('新描述')
    expect(rawOnce.data.custom_direct).toBe('keep-me')
    expect(rawOnce.data.data).toEqual({ customRootData: 42 })
    expect(rawOnce.data.extensions).toEqual({ nested_ext: true })

    // 二次打补丁与导出仍把自定义字段留在 data 根上，不漂移进 data.extensions。
    const patchedTwice = applyCharacterPatch(patchedOnce, { description: '再编辑' })
    expect(patchedTwice.spec).toBe('chara_card_v2')
    const exported = cardToStJson(patchedTwice) as { spec: string; data: Record<string, unknown> & { extensions: Record<string, unknown> } }
    expect(exported.data.description).toBe('再编辑')
    expect(exported.data.custom_direct).toBe('keep-me')
    expect(exported.data.data).toEqual({ customRootData: 42 })
    expect(exported.data.extensions).toEqual({ nested_ext: true })

    // unknown spec 经补丁同样升级为 V2，V3 保持 V3。
    const unknownCard = hydrateStoredCard({ spec: 'unknown', name: '未知版本卡', description: 'a' })
    const patchedUnknown = applyCharacterPatch(unknownCard, { description: 'b' })
    expect(patchedUnknown.spec).toBe('chara_card_v2')
    expect((patchedUnknown.raw as { spec: string }).spec).toBe('chara_card_v2')

    const v3Card = parseJsonCard({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'V3 卡', nickname: '小三' } })
    const patchedV3 = applyCharacterPatch(v3Card, { description: 'V3 编辑' })
    expect(patchedV3.spec).toBe('chara_card_v3')
    expect((patchedV3.raw as { spec: string; spec_version: string }).spec).toBe('chara_card_v3')
    expect((patchedV3.raw as { spec: string; spec_version: string }).spec_version).toBe('3.0')
  })

  it('历史落盘失步卡（card.spec=chara_card_v1 但 raw 为 V2/V3 包装）在 characterDataExtras 与 withoutEmbeddedCharacterBook 正常识别 raw.data', () => {
    const book = { name: '遗留书', entries: [{ keys: ['k'], content: 'c' }] }
    const legacyDesynced: CharacterCard = hydrateStoredCard({
      spec: 'chara_card_v1',
      name: '历史失步卡',
      description: '旧版编辑过',
      characterBook: book,
      extensions: {
        custom_direct: 'direct-val',
        nested_keep: 1,
        world: book,
      },
      raw: {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        vendor_meta: { origin: 'legacy' },
        data: {
          name: '历史失步卡',
          description: '旧版编辑过',
          custom_direct: 'direct-val',
          character_book: book,
          extensions: {
            nested_keep: 1,
            world: book,
          },
        },
      },
    })

    const extras = characterDataExtras(legacyDesynced)
    expect(extras.fields).toEqual({ custom_direct: 'direct-val' })
    expect(extras.fields).not.toHaveProperty('data')
    expect(extras.extensions).toEqual({ nested_keep: 1, world: book })

    const cleaned = withoutEmbeddedCharacterBook(legacyDesynced)
    expect(cleaned.characterBook).toBeNull()
    expect(cleaned.extensions).toEqual({ custom_direct: 'direct-val', nested_keep: 1 })
    expect(cleaned.extensions).not.toHaveProperty('world')
    const cleanedRaw = cleaned.raw as { data: Record<string, unknown> & { extensions: Record<string, unknown> } }
    expect(cleanedRaw.data).not.toHaveProperty('character_book')
    expect(cleanedRaw.data.extensions).toEqual({ nested_keep: 1 })

    const exported = cardToStJson(cleaned) as { spec: string; vendor_meta?: unknown; data: Record<string, unknown> & { extensions: Record<string, unknown> } }
    expect(exported.spec).toBe('chara_card_v2')
    expect(exported.vendor_meta).toEqual({ origin: 'legacy' })
    expect(exported.data.custom_direct).toBe('direct-val')
    expect(exported.data.extensions).toEqual({ nested_keep: 1 })
  })

  it('纯 V1 卡携带自定义 data 字段（raw.spec=chara_card_v1）不被误判为 V2 包装', () => {
    const pureV1 = parseJsonCard({
      spec: 'chara_card_v1',
      name: '纯 V1 卡',
      data: { customField: 'stay' },
      lorebook: { name: 'V1Book', entries: [{ keys: ['k'], content: 'v' }] },
    })
    const extras = characterDataExtras(pureV1)
    expect(extras.fields).toEqual({ data: { customField: 'stay' } })
    const stripped = withoutEmbeddedCharacterBook(pureV1)
    expect(stripped.characterBook).toBeNull()
    expect(stripped.extensions).toEqual({ data: { customField: 'stay' } })
  })
})

describe('2. parsePngCard 多块 zTXt/iTXt 累计解压预算与短路跳过', () => {
  it('多块接近单块上限的损坏压缩块累计超过 8MB 时快速拒绝为压缩炸弹', () => {
    const chunkA = zTXtChunk('chara', corruptTrailerDeflate(3.5 * 1024 * 1024, 0x41))
    const chunkB = compressedITXtChunk('chara', corruptTrailerDeflate(3.5 * 1024 * 1024, 0x42))
    const validCard = deflateSync(Buffer.from(Buffer.from(JSON.stringify({ name: '晚到的合法卡', description: 'x'.repeat(2 * 1024 * 1024) })).toString('base64'), 'latin1'))
    const chunkC = zTXtChunk('chara', validCard)
    const png = buildPng([IHDR, chunkA, chunkB, chunkC])

    expect(() => parsePngCard(png)).toThrow(CardParseError)
    expect(() => parsePngCard(png)).toThrow(/累计解压超过 8MB.*压缩炸弹/)
  })

  it('已拿到 ccv3 后跳过后续 zTXt/iTXt（含压缩炸弹块），不浪费同步解压', () => {
    const validV3 = tEXtChunk('ccv3', { spec: 'chara_card_v3', data: { name: '优先 V3' } })
    const trailingCharaBomb = zTXtChunk('chara', deflateSync(Buffer.alloc(5 * 1024 * 1024, 0x41)))
    const trailingV3Bomb = compressedITXtChunk('ccv3', deflateSync(Buffer.alloc(5 * 1024 * 1024, 0x42)))
    const png = buildPng([IHDR, validV3, trailingCharaBomb, trailingV3Bomb])

    const card = parsePngCard(png)
    expect(card.spec).toBe('chara_card_v3')
    expect(card.name).toBe('优先 V3')
  })

  it('已拿到 chara 后跳过重复的 chara 压缩块，仍继续识别后面的 ccv3', () => {
    const firstChara = tEXtChunk('chara', { name: '首个 V2' })
    const dupCharaBomb = zTXtChunk('chara', deflateSync(Buffer.alloc(5 * 1024 * 1024, 0x43)))
    const validV3 = tEXtChunk('ccv3', { spec: 'chara_card_v3', data: { name: '后续 V3' } })
    const png = buildPng([IHDR, firstChara, dupCharaBomb, validV3])

    const card = parsePngCard(png)
    expect(card.spec).toBe('chara_card_v3')
    expect(card.name).toBe('后续 V3')
  })

  it('合法双块（大体积 zTXt chara + 大体积 iTXt ccv3，单块 <= 4MB、合计 <= 8MB）正常通过', () => {
    // base64 约膨胀 4/3，2.2MB 字符 JSON 的 base64 约 2.93MB，两块合计 ~5.86MB <= 8MB。
    const pad = 'A'.repeat(2_200_000)
    const charaB64 = Buffer.from(JSON.stringify({ spec: 'chara_card_v2', data: { name: '双块旧版', description: pad } }), 'utf8').toString('base64')
    const ccv3B64 = Buffer.from(JSON.stringify({ spec: 'chara_card_v3', data: { name: '双块新版', description: pad } }), 'utf8').toString('base64')
    const png = buildPng([
      IHDR,
      zTXtChunk('chara', deflateSync(Buffer.from(charaB64, 'latin1'))),
      compressedITXtChunk('ccv3', deflateSync(Buffer.from(ccv3B64, 'utf8'))),
    ])

    const card = parsePngCard(png)
    expect(card.spec).toBe('chara_card_v3')
    expect(card.name).toBe('双块新版')
    expect(card.description.length).toBe(2_200_000)
  })
})

describe('3. assemblePrompt 不重复执行 promptOnly 正则规则', () => {
  const assembleWith = (regexRules: RegexRule[], history: Array<{ role: 'user' | 'assistant'; content: string }>) =>
    assemblePrompt({
      card: createBlankCard('Alice'),
      preset: defaultPreset(),
      personaDescription: '',
      macroCtx: { char: 'Alice', user: 'Bob' },
      history,
      wi: null,
      memories: [],
      worldDeltas: [],
      regexRules,
      estimateTokens: (text) => text.length,
      budget: { maxTokens: 4096, reserveForOutput: 256 },
    })

  it('compilePresetRegexScripts 生成的 promptOnly 包裹规则只包裹一次，不出现双层标签', () => {
    const [wrapRule] = compilePresetRegexScripts(
      [{
        id: 'wrap-latest',
        scriptName: '包裹最新互动',
        findRegex: '^([\\s\\S]*)$',
        replaceString: '<最新互动>\n$1\n</最新互动>',
        placement: [1],
        disabled: false,
        promptOnly: true,
        maxDepth: 0,
      }],
      'preset-1',
    )
    expect(wrapRule!.timing).toEqual(['assemble', 'send'])

    const res = assembleWith([wrapRule!], [
      { role: 'user', content: '旧台词' },
      { role: 'assistant', content: '回应' },
      { role: 'user', content: '新台词' },
    ])
    expect(res.history.map((m) => m.content)).toEqual([
      '旧台词',
      '回应',
      '<最新互动>\n新台词\n</最新互动>',
    ])
  })

  it('markdownOnly + promptOnly（timing 含 render/assemble/send）在入模历史中同样只执行一次', () => {
    const [dualRule] = compilePresetRegexScripts(
      [{
        id: 'dual-wrap',
        scriptName: '双面包裹',
        findRegex: '^([\\s\\S]*)$',
        replaceString: '[WRAP]$1[/WRAP]',
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: true,
      }],
      'preset-1',
    )
    expect([...dualRule!.timing].sort()).toEqual(['assemble', 'render', 'send'])

    const res = assembleWith([dualRule!], [{ role: 'assistant', content: '你好' }])
    expect(res.history.map((m) => m.content)).toEqual(['[WRAP]你好[/WRAP]'])
  })

  it('仅含 timing=["send"] 的 prompt 规则照常在第二阶段执行，且与 promptOnly 规则共存时各执行一次', () => {
    const [poRule] = compileCardRegexScripts(
      [{
        id: 'card-po',
        findRegex: 'hello',
        replaceString: 'world',
        placement: [1],
        promptOnly: true,
      }],
      'card-1',
    )
    const enabledPo: RegexRule = { ...poRule!, enabled: true }
    const sendOnlyRule: RegexRule = {
      id: 'prompt-send-only',
      name: '仅发送阶段',
      find: '^world$',
      replace: 'WORLD!',
      enabled: true,
      scopes: ['prompt'],
      timing: ['send'],
      minDepth: null,
      maxDepth: null,
      substituteRegex: 0,
      source: 'user',
    }

    const res = assembleWith([enabledPo, sendOnlyRule], [{ role: 'user', content: 'hello' }])
    expect(res.history.map((m) => m.content)).toEqual(['WORLD!'])
  })

  it('timing 同时含 assemble 与 send 的非法正则只记录一条 regex-error', () => {
    const badBoth: RegexRule = {
      id: 'bad-po',
      name: '坏正则',
      find: '/(unclosed/g',
      replace: '',
      enabled: true,
      scopes: ['prompt'],
      timing: ['assemble', 'send'],
      minDepth: null,
      maxDepth: null,
      substituteRegex: 0,
      source: 'preset',
    }
    const res = assembleWith([badBoth], [{ role: 'user', content: 'hi' }])
    const errors = res.log.filter((entry) => entry.kind === 'regex-error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.detail).toContain('bad-po:')
  })
})

describe('4. cardToStJson 剥离陈旧 V1 顶层镜像，保留厂商外层字段', () => {
  it('编辑后导出不包含编辑前的 V1 顶层镜像字段，保留 vendor_meta 与 create_date', () => {
    const imported = parseJsonCard({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      // 模拟 ST 导出卡常见的顶层 V1 镜像字段
      name: '旧名',
      description: '旧描述',
      personality: '旧性格',
      scenario: '旧场景',
      first_mes: '旧开场',
      alternate_greetings: ['旧备选'],
      mes_example: '旧示例',
      system_prompt: '旧系统',
      post_history_instructions: '旧后置',
      creator_notes: '旧备注',
      creatorcomment: '旧 ST 备注镜像',
      creator: '旧作者',
      character_version: '0.1',
      tags: ['old-tag'],
      extensions: { stale: true },
      regex_scripts: [{ findRegex: 'old', replaceString: 'x' }],
      regexScripts: [{ findRegex: 'old2', replaceString: 'y' }],
      depth_prompt: { prompt: '旧深度', depth: 4, role: 'system' },
      // 真正的厂商外层元数据
      vendor_meta: { exporter: 'st-exporter', keep: true },
      create_date: '2026-01-01 @00h 00m 00s',
      data: {
        name: '旧名',
        description: '旧描述',
        personality: '旧性格',
        scenario: '旧场景',
        first_mes: '旧开场',
        alternate_greetings: ['旧备选'],
        mes_example: '旧示例',
        system_prompt: '旧系统',
        post_history_instructions: '旧后置',
        creator_notes: '旧备注',
        creator: '旧作者',
        character_version: '0.1',
        tags: ['old-tag'],
        extensions: { talkativeness: 0.6 },
      },
    })

    const patched = applyCharacterPatch(imported, {
      name: '新名',
      description: '新描述',
      creatorNotes: '新备注',
      tags: ['new-tag'],
      depthPrompt: { prompt: '新深度', depth: 2, role: 'user' },
    })
    const exported = cardToStJson(patched) as Record<string, unknown> & { data: Record<string, unknown> }

    expect(exported.spec).toBe('chara_card_v2')
    expect(exported.spec_version).toBe('2.0')
    expect(exported.vendor_meta).toEqual({ exporter: 'st-exporter', keep: true })
    expect(exported.create_date).toBe('2026-01-01 @00h 00m 00s')
    expect(exported.data.name).toBe('新名')
    expect(exported.data.description).toBe('新描述')
    expect(exported.data.creator_notes).toBe('新备注')
    expect(exported.data.tags).toEqual(['new-tag'])

    for (const staleKey of [
      'name',
      'description',
      'personality',
      'scenario',
      'first_mes',
      'alternate_greetings',
      'mes_example',
      'system_prompt',
      'post_history_instructions',
      'creator_notes',
      'creatorcomment',
      'creator',
      'character_version',
      'tags',
      'extensions',
      'regex_scripts',
      'regexScripts',
      'depth_prompt',
      'character_book',
      'lorebook',
      'characterBook',
      'world',
    ]) {
      expect(exported, `顶层不应残留镜像键 ${staleKey}`).not.toHaveProperty(staleKey)
    }
  })
})

describe('5. applyCharacterPatch 归一化 depthPrompt 消除假修订冲突', () => {
  it('空白 depthPrompt.prompt 归零为 null，落盘重载后修订号完全一致', () => {
    const base = applyCharacterPatch(createBlankCard('深度角色'), {
      depthPrompt: { prompt: '有效提示', depth: 2, role: 'user' },
    })
    const cleared = applyCharacterPatch(base, {
      depthPrompt: { prompt: '   \n\t  ', depth: 2, role: 'user' },
    })
    expect(cleared.depthPrompt).toBeNull()
    expect(cleared.extensions).not.toHaveProperty('depth_prompt')
    expect((cleared.raw as { data: { extensions: Record<string, unknown> } }).data.extensions).not.toHaveProperty('depth_prompt')

    const { pngBytes: _png, ...stored } = cleared
    const reloaded = hydrateStoredCard(JSON.parse(serializeStoredCard(stored)) as Record<string, unknown>)
    expect(reloaded.depthPrompt).toBeNull()
    expect(characterEditRevision(reloaded)).toBe(characterEditRevision(cleared))
  })

  it('非规范键序与 -0 深度的 depthPrompt 在保存前归一化，落盘重载后修订号一致', () => {
    const base = createBlankCard('键序角色')
    const patched = applyCharacterPatch(base, {
      depthPrompt: { role: 'assistant', depth: -0, prompt: '保持顺序' } as CharacterCard['depthPrompt'],
    })
    expect(patched.depthPrompt).toEqual({ prompt: '保持顺序', depth: 0, role: 'assistant' })
    expect(Object.keys(patched.depthPrompt!)).toEqual(['prompt', 'depth', 'role'])
    expect(Object.is(patched.depthPrompt!.depth, 0)).toBe(true)

    const { pngBytes: _png, ...stored } = patched
    const reloaded = hydrateStoredCard(JSON.parse(serializeStoredCard(stored)) as Record<string, unknown>)
    expect(characterEditRevision(reloaded)).toBe(characterEditRevision(patched))
  })

  it('空白 prompt 但 depth/role 非法时仍按校验拒绝，不静默转 null', () => {
    const base = createBlankCard('非法深度角色')
    expect(() =>
      applyCharacterPatch(base, { depthPrompt: { prompt: '   ', depth: -1, role: 'system' } }),
    ).toThrow(CardParseError)
  })
})

describe('6. embedCardInPng 拒绝非空但短于 8 字节的损坏 PNG', () => {
  it('仅 pngBytes === null 回退占位图；0..7 字节损坏输入均抛 CardParseError', () => {
    const json = cardToStJson(createBlankCard('导出卡'))
    const fromNull = embedCardInPng(null, json, 'chara_card_v2')
    expect(parsePngCard(fromNull).name).toBe('导出卡')

    for (const corrupt of [
      new Uint8Array(0),
      new Uint8Array([0x89]),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    ]) {
      expect(() => embedCardInPng(corrupt, json, 'chara_card_v2'), `len=${corrupt.length}`).toThrow(CardParseError)
      expect(() => embedCardInPng(corrupt, json, 'chara_card_v2'), `len=${corrupt.length}`).toThrow('不是有效的 PNG 文件：文件签名不匹配')
    }
  })
})

describe('7. inspectCharacterCompatibility 对 depthPrompt 与 extensions.depth_prompt 去重', () => {
  it('depth_prompt 里的模板/HTML/网络信号只计数一次且不重复累加 scannedChars', () => {
    const promptText = '<% getvar("hp") %><div>HUD</div>fetch("https://example.invalid")'
    const card = parseJsonCard({
      spec: 'chara_card_v2',
      data: {
        name: '深度去重卡',
        extensions: {
          depth_prompt: { prompt: promptText, depth: 3, role: 'system' },
        },
      },
    })
    const report = inspectCharacterCompatibility(card)
    for (const code of ['templates', 'html', 'network'] as const) {
      const finding = report.findings.find((item) => item.code === code)
      expect(finding, code).toBeDefined()
      expect(finding!.count, code).toBe(1)
      expect(finding!.locations, code).toEqual(['depthPrompt.prompt'])
    }
    expect(report.scannedChars).toBe(promptText.length + 'system'.length)
  })

  it('extensions.depth_prompt 带数字 role 或额外厂商字段时仍去重 prompt 且不漏扫额外字段', () => {
    const numericRoleCard = parseJsonCard({
      spec: 'chara_card_v2',
      data: {
        name: '数字角色卡',
        extensions: {
          depth_prompt: { prompt: '<div>banner</div>', depth: 1, role: 1 },
        },
      },
    })
    const numericReport = inspectCharacterCompatibility(numericRoleCard)
    expect(numericReport.findings.find((item) => item.code === 'html')).toMatchObject({
      count: 1,
      locations: ['depthPrompt.prompt'],
    })

    const extraFieldCard = parseJsonCard({
      spec: 'chara_card_v2',
      data: {
        name: '带额外字段卡',
        extensions: {
          depth_prompt: {
            prompt: '<div>banner</div>',
            depth: 2,
            role: 'system',
            vendor_script: 'parent.document.body',
          },
        },
      },
    })
    const extraReport = inspectCharacterCompatibility(extraFieldCard)
    expect(extraReport.findings.find((item) => item.code === 'html')).toMatchObject({
      count: 1,
      locations: ['depthPrompt.prompt'],
    })
    expect(extraReport.findings.find((item) => item.code === 'parentAccess')).toMatchObject({
      count: 1,
      locations: ['extensions.depth_prompt.vendor_script'],
    })
  })
})

describe('8. workspace.ts:deleteCharacter 持工作区锁且支持重入', () => {
  let root: string
  let charactersDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'audit-card-ws-'))
    charactersDir = join(root, 'characters')
    await mkdir(charactersDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('deleteCharacter 等待同工作区在途锁任务完成后再删除目录，不与其并发交错', async () => {
    const ws = await importCard(charactersDir, createBlankCard('锁测试角色'))
    const fs = new WorkspaceFs(ws.root, null)
    const events: string[] = []
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()

    const writer = withWorkspaceLock(ws.root, async () => {
      events.push('writer:enter')
      entered.resolve()
      await release.promise
      await fs.writeText('journal.md', '写入完成')
      expect(await readFile(join(ws.root, 'journal.md'), 'utf8')).toBe('写入完成')
      events.push('writer:exit')
    })

    await entered.promise
    const deleting = deleteCharacter(charactersDir, ws.cardId).then(() => {
      events.push('delete:done')
    })
    // 给事件循环若干轮机会：若 deleteCharacter 未加锁，这里目录会被提前删除。
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(events).toEqual(['writer:enter'])
    await expect(stat(ws.root)).resolves.toBeDefined()

    release.resolve()
    await Promise.all([writer, deleting])

    expect(events).toEqual(['writer:enter', 'writer:exit', 'delete:done'])
    expect(await loadCharacter(charactersDir, ws.cardId)).toBeNull()
  })

  it('外层已持有 withWorkspaceLock(root) 时调用 deleteCharacter 可重入且不死锁', async () => {
    const ws = await importCard(charactersDir, createBlankCard('重入锁角色'))
    await withWorkspaceLock(ws.root, async () => {
      await deleteCharacter(charactersDir, ws.cardId)
    })
    expect(await loadCharacter(charactersDir, ws.cardId)).toBeNull()
  })
})
