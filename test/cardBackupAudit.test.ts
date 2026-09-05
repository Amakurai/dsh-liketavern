/** 卡内备份边界审查：大量小字段的已接受变量必须仍能从实际导出文本恢复。 */
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { buildCardSrcDoc } from '../src/core/cardFrame.js'
import { installCardVariables, restoreCardVariableBackup } from '../src/core/cardVariables.js'

class BackupElement {
  id = ''
  value = ''
  children: BackupElement[] = []
  onclick?: () => void
  append(...nodes: BackupElement[]) { this.children.push(...nodes) }
  prepend(node: BackupElement) { this.children.unshift(node) }
  setAttribute() {}
  focus() {}
  select() {}
}

it('接受的多字段变量导出后可直接恢复，不因缩进超过自身恢复预算', () => {
  const body = new BackupElement()
  const api = {} as { replaceVariables(value: unknown): unknown }
  runInNewContext(`(${installCardVariables.toString()})({ title: '备份', note: '', backup: '导出', text: '内容' })`, {
    window: api, TextEncoder,
    document: { readyState: 'complete', body, getElementById: (id: string) => body.children.find((node) => node.id === id),
      createElement: () => new BackupElement() },
  })
  const variables = Object.fromEntries(Array.from({ length: 50_000 }, (_, index) => [`field${index}`, '']))
  expect(() => api.replaceVariables(variables)).not.toThrow()
  const [, , exportButton, textarea] = body.children[0]!.children
  exportButton!.onclick!()
  const srcDoc = buildCardSrcDoc('<p>工厂卡片</p>', { greetings: [], greetingIndex: 0 })
  expect(() => restoreCardVariableBackup(srcDoc, textarea!.value)).not.toThrow()
})
