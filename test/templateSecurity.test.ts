/**
 * Markdown 引擎替换后的安全回归：旧 Showdown 不再装载，不生成完整文档或标题 ID，
 * 含原始 HTML 的结果只交给卡面沙箱；公开漏洞形状在可终止 worker 内处理，
 * 主线程仍可响应，超时后的普通消息仍可渲染。所有输入为手写数据。
 */
import { describe, expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { isolated } from '../src/node/isolated.js'

const context = (): TemplateContext => ({
  variables: emptyTemplateScopes(), char: 'A', user: 'B', card: {}, entries: [],
  presets: [], history: [], now: 1000, seed: 1, phase: 'render',
})

function format(markdown: string) {
  return isolated('template', {
    context: context(), texts: [`<%= ${JSON.stringify(markdown)} %>`], decorateOutput: true,
  })
}

describe('Markdown 格式化安全边界', () => {
  it('隔离模板不再装载 Showdown 或暴露 Markdown 引擎的全局配置', async () => {
    const result=await isolated('template',{context:{...context(),phase:'generate'},texts:[
      '<%= typeof __TavernTemplateLibraries.showdown %>|<%= typeof __TavernTemplateLibraries.markdownit %>',
    ]})
    expect(result.texts).toEqual(['undefined|undefined'])
  })

  it('metadata 标题载荷不会生成完整文档，原始 HTML 仍只进入沙箱片段', async () => {
    // GHSA-cr32-g25g-vxjj：完整文档标题不能未经转义拼接 frontmatter。
    const result = await format('---\ntitle: </title><script>globalThis.titleProbe=1</script>\n---\n# 正文')
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

  it('表头不会生成 ID，含注入形状的表格保持沙箱交付', async () => {
    // GHSA-22g5-r2x5-97cx：原始表头不能被拼入 id 属性。
    const result = await format('| "><svg/onload=globalThis.tableProbe=1> | 正常列 |\n|---|---|\n| 甲 | 乙 |')
    const output = result.texts[0]!
    expect(output).toContain('<table>')
    expect(output).toContain('正常列')
    expect(output).not.toMatch(/<th\s+[^>]*\bid\s*=/i)
    expect(output).not.toMatch(/<(?:!doctype|html|head|title)(?:\s|>)/i)
    expect(result.parts[0]).toEqual([{ kind: 'html', text: output }])
  })

  it('嵌套链接只会完整返回或明确超限；无限循环可终止，随后消息仍能渲染', async () => {
    // GHSA-rmmh-p597-ppvv / TRA-2024-05：不能在测试主线程直接调用官方解析器处理此输入。
    const normal = '<p><strong>正常消息</strong></p>'
    expect((await format('**正常消息**')).texts).toEqual([normal])
    const small='['.repeat(2000)
    expect((await format(small)).texts).toEqual([`<p>${small}</p>`])
    let heartbeats = 0
    const timer = setInterval(() => { heartbeats++ }, 10)
    try {
      const brackets='['.repeat(90_000)
      // 大输入是否耗尽既有墙钟预算依赖机器速度；不能接受半成品或其它解析错误。
      const stress=await format(brackets).then(value=>({value,error:null}),error=>({value:null,error}))
      if(stress.error) expect(String(stress.error)).toMatch(/超时|interrupted/i)
      else expect(stress.value?.texts).toEqual([`<p>${brackets}</p>`])
      await expect(isolated('template', {context:context(),texts:['<% while(true) {} %>'],decorateOutput:true})).rejects.toThrow(/超时|interrupted/i)
      expect(heartbeats).toBeGreaterThan(0)
    } finally { clearInterval(timer) }
    expect((await format('**正常消息**')).texts).toEqual([normal])
  })
})
