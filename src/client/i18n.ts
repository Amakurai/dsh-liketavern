/**
 * 客户端界面语言运行时：模块级 store（默认英文）+ React hook。
 *
 * 语言偏好落在宿主设置命名空间 dsh-tavern 的 `locale` 键（见 node/config.ts），
 * 只影响本插件 UI，不碰宿主界面语言。入口 apply 时经 remote.getSettings 播种；
 * 设置页切换语言后即时 setTavernLocale，所有经 useT() 取文案的组件随之重渲染。
 *
 * 组件内一律 `const t = useT()`；非 React 环境（模块顶层、一次性回调外）可用
 * 裸 t()，但它不订阅语言变化，渲染中的 JSX 不得使用。插值占位符写作 {name}。
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_LOCALE, en, zh, type TavernLocaleId } from './locales.js'

let current: TavernLocaleId = DEFAULT_LOCALE
const listeners = new Set<() => void>()

export function getTavernLocale(): TavernLocaleId {
  return current
}

export function setTavernLocale(id: TavernLocaleId): void {
  if (id === current) return
  current = id
  for (const fn of listeners) fn()
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
