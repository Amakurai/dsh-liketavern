/**
 * 审计回归（C2 修复后）：展示净化不得改写 Markdown 代码示例，
 * 围栏外的机读块与小部件仍照常收起。
 */
import { expect, it } from 'vitest'
import { stripDisplayMeta } from '../../src/core/displaySanitize.js'

it('围栏内的 <style> 代码示例原样保留，后续正文不被切掉', () => {
  const input = [
    '给你一个 CSS 示例：',
    '```css',
    '<style>',
    '.a { color: red }',
    '</style>',
    '```',
    '注意：只在内层作用域生效。',
  ].join('\n')
  expect(stripDisplayMeta(input)).toBe(input)
})

it('围栏内的 <details> 示例原样保留', () => {
  const input = ['示例：', '```html', '<details><summary>问</summary>答</details>', '```', '以上。'].join('\n')
  expect(stripDisplayMeta(input)).toBe(input)
})

it('围栏内的协议标签与机读标签示例原样保留', () => {
  const input = ['示例：', '```html', '<world_status>ok</world_status>', '<UpdateVariable>v</UpdateVariable>', '```', '以上。'].join('\n')
  expect(stripDisplayMeta(input)).toBe(input)
})

it('行内代码里的机读标签与注释原样保留', () => {
  for (const input of ['写法是 `<UpdateVariable>x</UpdateVariable>`。', '写法是 `<!--注释-->`。']) {
    expect(stripDisplayMeta(input)).toBe(input)
  }
})

it('围栏外的机读块、注释与未闭合小部件仍照常收起', () => {
  const input = '可见\n<UpdateVariable>secret</UpdateVariable>\n<!--注释-->\n```js\nconst tag = "<UpdateVariable>";\n```\n尾'
  const output = stripDisplayMeta(input)
  expect(output).toBe('可见\n\n```js\nconst tag = "<UpdateVariable>";\n```\n尾')
  expect(output).not.toContain('secret')
  expect(output).toContain('const tag = "<UpdateVariable>";')
})

it('思考块里的未闭合围栏不能吞掉 </think> 与后续正文', () => {
  const input = '<think>\n先想想\n```js\n草稿\n</think>\n角色正文'
  expect(stripDisplayMeta(input)).toContain('角色正文')
  expect(stripDisplayMeta(input)).not.toContain('先想想')
})

it('跨过 </think> 配对的反引号不吞掉正文', () => {
  const input = '<think>\n用 ` 号\n</think>\n他说 `你好` 然后离开'
  expect(stripDisplayMeta(input)).toContain('然后离开')
})

it('未闭合围栏内的半截机读标签不触发截断', () => {
  const input = '示例：\n```html\n<UpdateVariable>还没写完'
  expect(stripDisplayMeta(input)).toBe(input)
})
