/**
 * i18n 字典完整性：
 * - 每个片段 zh/en 键集一致、值非空（Record 类型之外的运行时兜底）；
 * - 片段之间无键碰撞（合并后键数 = 各片段键数之和）；
 * - en 值不含汉字（防漏翻；个别两语言同文的值走 ALLOW_SAME_AS_ZH）；
 * - src/client 源码里出现的字典键字面量（t('x.y') 与 labelKey: 'x.y' 两类）
 *   必须存在于 zh（防打错键；前缀集合取自 zh 键的首段）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.js'
import * as actions from '../src/client/locales/actions.js'
import * as assistant from '../src/client/locales/assistant.js'
import * as characters from '../src/client/locales/characters.js'
import * as chip from '../src/client/locales/chip.js'
import * as common from '../src/client/locales/common.js'
import * as hero from '../src/client/locales/hero.js'
import * as lorebookEditor from '../src/client/locales/lorebookEditor.js'
import * as lorebooks from '../src/client/locales/lorebooks.js'
import * as memory from '../src/client/locales/memory.js'
import * as panel from '../src/client/locales/panel.js'
import * as personas from '../src/client/locales/personas.js'
import * as presets from '../src/client/locales/presets.js'
import * as regex from '../src/client/locales/regex.js'
import * as settings from '../src/client/locales/settings.js'
import * as speech from '../src/client/locales/speech.js'
import * as util from '../src/client/locales/util.js'

const FRAGMENTS = {
  actions,
  assistant,
  characters,
  chip,
  common,
  hero,
  lorebookEditor,
  lorebooks,
  memory,
  panel,
  personas,
  presets,
  regex,
  settings,
  speech,
  util,
}

/** en 与 zh 同文属正常的键（专有名词 / 两语言通用写法）。 */
const ALLOW_SAME_AS_ZH = new Set<string>(['settings.label'])

/** 源码里形如字典键但不是字典键的字面量（slot 名等）。 */
const NOT_A_DICT_KEY = new Set<string>(['settings.section'])

const HAN = /[\u4e00-\u9fff]/

describe('i18n 字典', () => {
  it('每个片段 zh/en 键集一致且值非空', () => {
    for (const [name, fragment] of Object.entries(FRAGMENTS)) {
      const zhKeys = Object.keys(fragment.zh).sort()
      const enKeys = Object.keys(fragment.en).sort()
      expect(enKeys, `片段 ${name} 的 en 键集应与 zh 一致`).toEqual(zhKeys)
      for (const key of zhKeys) {
        expect((fragment.zh as Record<string, string>)[key]?.trim(), `${name} zh ${key} 不应为空`).toBeTruthy()
        expect((fragment.en as Record<string, string>)[key]?.trim(), `${name} en ${key} 不应为空`).toBeTruthy()
      }
    }
  })

  it('片段之间无键碰撞', () => {
    const total = Object.values(FRAGMENTS).reduce((sum, fragment) => sum + Object.keys(fragment.zh).length, 0)
    expect(Object.keys(zh).length).toBe(total)
    expect(Object.keys(en).length).toBe(total)
  })

  it('en 值不含汉字（漏翻兜底）', () => {
    const leaks = Object.entries(en).filter(([key, value]) => HAN.test(value) && !ALLOW_SAME_AS_ZH.has(key))
    expect(leaks).toEqual([])
  })

  it('源码里出现的字典键都能在 zh 中解析', () => {
    const clientDir = fileURLToPath(new URL('../src/client/', import.meta.url))
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (/\.(ts|tsx)$/.test(entry)) files.push(path)
        else if (!entry.includes('.') && !entry.startsWith('.')) {
          try {
            walk(path)
          } catch {
            // 非目录忽略
          }
        }
      }
    }
    walk(clientDir)

    const prefixes = new Set(Object.keys(zh).map((key) => key.split('.')[0]))
    const looksLikeKey = /^[a-z][a-zA-Z]*(\.[a-zA-Z][\w]*)+$/
    const missing: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/'([^'\n]+)'/g)) {
        const literal = match[1]!
        if (!looksLikeKey.test(literal)) continue
        if (NOT_A_DICT_KEY.has(literal)) continue
        if (!prefixes.has(literal.split('.')[0]!)) continue
        if (!(literal in zh)) missing.push(`${file}: ${literal}`)
      }
    }
    expect(missing).toEqual([])
  })
})
