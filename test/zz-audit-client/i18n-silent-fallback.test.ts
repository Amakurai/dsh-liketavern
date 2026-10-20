/**
 * 修复后行为（C6）：动态拼接的 locale 键改为静态映射表（characters.tsx 的 COMPATIBILITY_KEYS、
 * scripts.tsx 的 RUNTIME_STATE_KEYS），core 枚举新增而漏配时编译期报错。
 * 本文件补齐运行时回归网：`hasTavernKey` 核对全部 code/state 键齐全，
 * 并固化 `t()` 对未知键仍是静默回退键名（不会抛错，故必须靠测试拦漏译）。
 */
import { expect, it } from 'vitest'
import { CHARACTER_COMPATIBILITY_CODES, type CharacterCompatibilityStatus } from '../../src/core/characterCompatibility.js'
import { hasTavernKey, setTavernLocale, t } from '../../src/client/i18n.js'

it('缺失键静默回退为键名，不抛错也不报警（因此必须有静态映射与测试拦截）', () => {
  setTavernLocale('en')
  expect(t('characters.compatibility.__missing__.title')).toBe('characters.compatibility.__missing__.title')
  expect(hasTavernKey('characters.compatibility.__missing__.title')).toBe(false)
  setTavernLocale('zh')
  expect(t('characters.compatibility.__missing__.title')).toBe('characters.compatibility.__missing__.title')
})

it('动态键族在字典中齐全（与静态映射表逐项对应）', () => {
  const statuses: CharacterCompatibilityStatus[] = ['supported', 'unsupported', 'review']
  for (const code of CHARACTER_COMPATIBILITY_CODES) {
    for (const field of ['title', 'desc'] as const) {
      const key = `characters.compatibility.${code}.${field}`
      expect(hasTavernKey(key), `缺 ${key}`).toBe(true)
    }
  }
  for (const status of statuses) {
    const key = `characters.compatibility.status.${status}`
    expect(hasTavernKey(key), `缺 ${key}`).toBe(true)
  }
  for (const state of ['loading', 'disabled', 'waiting', 'running', 'error', 'ready', 'incompatible']) {
    const key = `settings.scripts.runtime.${state}`
    expect(hasTavernKey(key), `缺 ${key}`).toBe(true)
  }
  // 已接线到静态映射表的键确实能取到文案（不是回退成键名）。
  setTavernLocale('zh')
  expect(t('characters.compatibility.cardFields.title')).not.toContain('characters.compatibility')
  expect(t('settings.scripts.runtime.incompatible')).not.toContain('settings.scripts.runtime')
})
