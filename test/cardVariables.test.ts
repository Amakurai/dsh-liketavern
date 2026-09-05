/** 卡内变量行为：执行实际注入脚本，验证隔离、合并、备份恢复及超限/污染输入不破坏旧数据。 */
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { installCardVariables, restoreCardVariableBackup, type CardVariableLabels } from '../src/core/cardVariables.js'
import { buildCardSrcDoc } from '../src/core/cardFrame.js'

const labels: CardVariableLabels = { title: '临时数据', note: '刷新前备份', backup: '备份', text: '备份内容' }
class Element {
  id = ''
  textContent = ''
  value = ''
  style: Record<string, string> = {}
  children: Element[] = []
  onclick?: () => void
  append(...nodes: Element[]) { this.children.push(...nodes) }
  prepend(node: Element) { this.children.unshift(node) }
  setAttribute() {}
  focus() {}
  select() {}
}
type Variables = {
  getVariables(option?: unknown): Record<string, unknown>
  replaceVariables(value: unknown, option?: unknown): Record<string, unknown>
  insertOrAssignVariables(value: unknown, option?: unknown): Record<string, unknown>
  insertVariables(value: unknown, option?: unknown): Record<string, unknown>
}
function frame(seed?: string) {
  const body = new Element()
  const window = {} as Variables
  const postMessage = vi.fn()
  const context = { window, labels, TextEncoder, parent: { postMessage }, document: {
    readyState: 'complete', body, getElementById: (id: string) => body.children.find((n) => n.id === id), createElement: () => new Element(),
  } }
  const install = () => runInNewContext(`(${installCardVariables.toString()})(labels)`, context)
  if (seed) runInNewContext(seed, context)
  install()
  return { api: window, body, install, postMessage }
}

describe('隔离的卡内变量', () => {
  it('兼容 character 预设写入/读取；返回副本，嵌套合并且数组整体替换', () => {
    const { api } = frame()
    api.insertOrAssignVariables({ presets: ['old', 'old2'], hero: { name: '工厂角色', level: 1 } }, { type: 'character' })
    api.insertOrAssignVariables({ presets: ['new'], hero: { level: 2 } }, { type: 'character' })
    const read = api.getVariables({ type: 'character' })
    expect(read).toEqual({ presets: ['new'], hero: { name: '工厂角色', level: 2 } })
    ;(read.presets as string[]).push('not saved')
    expect(api.getVariables({ type: 'character' }).presets).toEqual(['new'])
  })
  it('不同 frame 和作用域互不共享，调用不触碰宿主桥', () => {
    const a = frame(), b = frame()
    a.api.replaceVariables({ name: 'A' }, { type: 'global' })
    a.api.replaceVariables({ name: 'floor' }, { type: 'message', message_id: 1 })
    expect(a.api.getVariables({ type: 'chat' })).toEqual({})
    expect(a.api.getVariables({ type: 'message', message_id: 2 })).toEqual({})
    expect(b.api.getVariables({ type: 'global' })).toEqual({})
    expect(a.postMessage).not.toHaveBeenCalled()
  })
  it('仅插入缺少的字段，替换则清除未保留字段', () => {
    const { api } = frame()
    api.replaceVariables({ hero: { level: 2 }, choices: [1] })
    api.insertVariables({ hero: { level: 3, name: '灯塔' }, choices: [2] })
    expect(api.getVariables()).toEqual({ hero: { level: 2, name: '灯塔' }, choices: [1] })
    api.replaceVariables({ fresh: true })
    expect(api.getVariables()).toEqual({ fresh: true })
  })
  it('document.write 重装脚本保留当前 frame 数据且不复制备份入口', () => {
    const { api, install, body } = frame()
    api.replaceVariables({ round: 2 })
    install()
    expect(api.getVariables()).toEqual({ round: 2 })
    expect(body.children).toHaveLength(1)
  })
  it('非法/污染/超量写入保留旧表，拒绝把 primitive 伪装成对象', () => {
    const { api } = frame()
    api.replaceVariables({ kept: true })
    for (const value of [null, [], 'bad', JSON.parse('{"__proto__":{"polluted":true}}'), { text: '界'.repeat(400_000) }, { toJSON: () => 1 }]) {
      expect(() => api.insertOrAssignVariables(value)).toThrow()
      expect(api.getVariables()).toEqual({ kept: true })
    }
    expect(() => api.replaceVariables({}, { type: 'other' })).toThrow()
    expect(() => api.replaceVariables({}, { type: 'message', message_id: Infinity })).toThrow()
    expect(() => api.replaceVariables({}, { type: { toString: () => 'chat' } })).toThrow()
    expect(Object.prototype).not.toHaveProperty('polluted')
  })
  it('导出文本能在新 frame 手动恢复，无效备份不覆盖已有表', () => {
    const a = frame()
    a.api.replaceVariables({ presets: [{ name: '测试预设' }] }, { type: 'character' })
    const [, , backupA, textA] = a.body.children[0]!.children
    backupA!.onclick!()
    const original = buildCardSrcDoc('<p>工厂卡</p>', { greetings: [], greetingIndex: 0 })
    const restored = restoreCardVariableBackup(original, textA!.value)
    const seed = /<script>([\s\S]*?)<\/script>/.exec(restored)![1]!
    const b = frame(seed)
    expect(b.api.getVariables({ type: 'character' })).toEqual({ presets: [{ name: '测试预设' }] })
    expect(() => restoreCardVariableBackup(original, '{"version":1,"scopes":{"bad":{}}}')).toThrow()
    expect(b.api.getVariables({ type: 'character' }).presets).toHaveLength(1)
  })
  it('恢复入口拒绝非法结构、污染键和超量备份，HTML 结束标签只能作为变量文本', () => {
    const original = buildCardSrcDoc('<p>工厂卡</p>', { greetings: [], greetingIndex: 0 })
    for (const bad of ['null', '{"version":2,"scopes":{}}', '{"version":1,"scopes":[]}', '{"__proto__":{}}', ' '.repeat(1024 * 1024 + 1)]) {
      expect(() => restoreCardVariableBackup(original, bad)).toThrow()
    }
    const payload = '</script><script>throw new Error("injected")</script>'
    const restored = restoreCardVariableBackup(original, JSON.stringify({ version: 1, scopes: { '["character",""]': { payload } } }))
    expect(restored).not.toContain(payload)
    const b = frame(/<script>([\s\S]*?)<\/script>/.exec(restored)![1]!)
    expect(b.api.getVariables({ type: 'character' }).payload).toBe(payload)
    expect(restored.indexOf('Content-Security-Policy')).toBeLessThan(restored.indexOf('window.__dshTavernVariables='))
  })
  it('不使用变量的普通 HTML 装饰卡不显示备份工具', () => {
    expect(frame().body.children).toHaveLength(0)
  })
})
