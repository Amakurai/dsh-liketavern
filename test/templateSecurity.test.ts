/**
 * Showdown 已知漏洞的业务边界回归：危险全局默认项不能重开完整文档或标题 ID，
 * 含原始 HTML 的格式化结果只交给卡面沙箱；恶意嵌套链接在可终止 worker 内失败，
 * 主线程仍可响应，失败后的普通消息仍可正常渲染。所有输入为公开漏洞形状的手写数据。
 */
import { describe, expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { isolated } from '../src/node/isolated.js'

const context = (): TemplateContext => ({
  variables: emptyTemplateScopes(), char: 'A', user: 'B', card: {}, entries: [],
  presets: [], history: [], now: 1000, seed: 1, phase: 'render',
})

/** 模板在同一沙箱内可以调整库默认项，宿主格式化器的安全选项必须显式覆盖它们。 */
const unsafeDefaults = `<%
  __TavernTemplateLibraries.showdown.setFlavor('github');
  __TavernTemplateLibraries.showdown.setOption('metadata', true);
  __TavernTemplateLibraries.showdown.setOption('completeHTMLDocument', true);
%>`

function format(markdown: string, defaults = '') {
  return isolated('template', {
    context: context(), texts: [`${defaults}<%= ${JSON.stringify(markdown)} %>`], decorateOutput: true,
  })
}

describe('Showdown 安全边界', () => {
  it('metadata 标题载荷不能借全局默认项生成完整文档，原始 HTML 仍只进入沙箱片段', async () => {
    // GHSA-cr32-g25g-vxjj：完整文档标题不能未经转义拼接 frontmatter。
    const result = await format('---\ntitle: </title><script>globalThis.titleProbe=1</script>\n---\n# 正文', unsafeDefaults)
    const output = result.texts[0]!
    expect(output).toContain('正文')
    expect(output).not.toMatch(/<(?:!doctype|html|head|title)(?:\s|>)/i)
    expect(output).not.toMatch(/<h[1-6]\s+[^>]*\bid\s*=/i)
    // 交互卡允许原始 HTML；禁止把此处的选项保护误当成 HTML 清洗或放入主页面的许可。
    const parts = result.parts[0]!
    expect(parts.length).toBeGreaterThan(0)
    expect(parts.every(part => part.kind === 'html')).toBe(true)
    expect(parts.map(part => part.text).join('\n')).toContain('<script>globalThis.titleProbe=1</script>')
  })

  it('github 全局风格不能重开表头 ID，含注入形状的表格保持沙箱交付', async () => {
    // GHSA-22g5-r2x5-97cx：原始表头不能被拼入 id 属性。
    const result = await format('| "><svg/onload=globalThis.tableProbe=1> | 正常列 |\n|---|---|\n| 甲 | 乙 |', unsafeDefaults)
    const output = result.texts[0]!
    expect(output).toContain('<table>')
    expect(output).toContain('正常列')
    expect(output).not.toMatch(/<th\s+[^>]*\bid\s*=/i)
    expect(output).not.toMatch(/<(?:!doctype|html|head|title)(?:\s|>)/i)
    expect(result.parts[0]).toEqual([{ kind: 'html', text: output }])
  })

  it('恶意嵌套链接超时不会阻塞主线程，结束后下一条普通消息仍可渲染', async () => {
    // GHSA-rmmh-p597-ppvv / TRA-2024-05：不能在测试主线程直接调用官方解析器处理此输入。
    const normal = '<p><strong>正常消息</strong></p>'
    expect((await format('**正常消息**')).texts).toEqual([normal])
    let heartbeats = 0
    const timer = setInterval(() => { heartbeats++ }, 10)
    try {
      await expect(format('['.repeat(90_000))).rejects.toThrow(/超时|interrupted/i)
      expect(heartbeats).toBeGreaterThan(0)
    } finally { clearInterval(timer) }
    expect((await format('**正常消息**')).texts).toEqual([normal])
  })
})
