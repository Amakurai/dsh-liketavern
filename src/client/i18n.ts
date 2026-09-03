/**
 * 客户端界面语言运行时：模块级 store + React hook。
 *
 * 语言偏好落在宿主设置命名空间 dsh-tavern 的 `locale` 键（见 node/config.ts）：
 * 'auto'（默认）跟随宿主界面语言（zh* → 中文，其余 → 英文），'en'/'zh' 锁定。
 * 入口 apply 时经 remote.getSettings 播种偏好、经 ctx.locale.getSnapshot/subscribe
 * 跟随宿主语言；设置页切换后即时 setTavernLocale，所有经 useT() 取文案的组件随之重渲染。
 *
 * 组件内一律 `const t = useT()`；非 React 环境（模块顶层、一次性回调外）可用
 * 裸 t()，但它不订阅语言变化，渲染中的 JSX 不得使用。插值占位符写作 {name}。
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_LOCALE, en, zh, type TavernLocaleId, type TavernLocalePreference } from './locales.js'

let preference: TavernLocalePreference = 'auto'
let hostActive = 'en'
let current: TavernLocaleId = DEFAULT_LOCALE
const listeners = new Set<() => void>()

/** auto 档的宿主语言映射：zh* → 中文，其余 → 英文（插件字典只有 zh/en 两套）。 */
function effectiveLocale(): TavernLocaleId {
  if (preference !== 'auto') return preference
  return hostActive.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function syncEffective(): void {
  const next = effectiveLocale()
  if (next === current) return
  current = next
  for (const fn of listeners) fn()
}

export function getTavernLocale(): TavernLocaleId {
  return current
}

/** 设置语言偏好（'auto' 跟随宿主）；立即按当前宿主语言重算生效语言。 */
export function setTavernLocale(id: TavernLocalePreference): void {
  if (id === preference) return
  preference = id
  syncEffective()
}

/** 宿主界面语言（0.1.2 的 LocaleRuntime 快照）变化；仅 auto 档会影响生效语言。 */
export function setTavernHostLocale(active: string): void {
  if (!active || active === hostActive) return
  hostActive = active
  syncEffective()
}

/** 取当前语言文案；en 缺失时回退 zh（字典齐全性由 test/i18n.test.ts 保证，兜底仅为防白屏）。 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict: Record<string, string> = current === 'zh' ? zh : en
  const raw = dict[key] ?? zh[key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

/** 组件内取文案的唯一入口：订阅语言切换，切语言时触发重渲染。 */
export function useT(): typeof t {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    getTavernLocale,
  )
  return t
}

/**
 * 宿主 MarkdownText 的 chrome 文案（0.1.2 起 labels 为必填 prop，缺了渲染代码围栏即崩）。
 * 键位与宿主 markdownLabels(t) 一致，文案走本插件字典。
 */
export function useMarkdownLabels(): { code: { copyLabel: string; copiedLabel: string }; footnotes: string } {
  const t = useT()
  return {
    code: { copyLabel: t('common.copy'), copiedLabel: t('common.copied') },
    footnotes: t('common.markdownFootnotes'),
  }
}
