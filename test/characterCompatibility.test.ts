/** 导入兼容报告的纯函数行为：识别现有边界、保留原文、不执行第三方代码，并对巨大/深层数据明确报告扫描不完整。 */
import { describe, expect, it } from 'vitest'
import { CHARACTER_COMPATIBILITY_CODES, inspectCharacterCompatibility } from '../src/core/characterCompatibility.js'
import { parseJsonCard } from '../src/state/card.js'
import { zh, en } from '../src/client/locales/characters.js'

const inspect = (data: Record<string, unknown>) => inspectCharacterCompatibility(parseJsonCard({ spec: 'chara_card_v2', data: { name: '预检工厂', ...data } }))
const script = (content: string, id = 'script') => ({ id, type: 'script', name: '测试脚本', enabled: true, content })

describe('角色卡只读静态兼容报告', () => {
  it('普通卡只声明已解析基础字段，不宣称整体兼容或运行通过', () => {
    expect(inspect({ first_mes: '你好' })).toEqual({ version: 1, complete: true, scannedChars: 2,
      findings: [{ code: 'cardFields', status: 'supported', count: 1, locations: ['card'] }] })
  })

  it('在卡字段、正则替换、世界书和脚本中汇总能力，报告不携带代码且不修改输入', () => {
    const card = parseJsonCard({ name: '混合卡', description: '<% throw new Error("must not execute") %>',
      first_mes: '<div><img src="https://example.invalid/a.png"></div>',
      extensions: { regex_scripts: [{ findRegex: '/(a+)+$/', replaceString: '<script>generateRaw(); fetch("https://example.invalid"); parent.document.body</script>' }],
        tavern_helper: { scripts: [script('getWorldbook("a"); replaceVariables({}); getScriptTrees();')] } },
      character_book: { entries: [{ content: '设定', extensions: { vectorized: true } }] } })
    const before = JSON.stringify(card)
    const report = inspectCharacterCompatibility(card)
    expect(report.complete).toBe(true)
    expect(report.findings.map(row => row.code)).toEqual(expect.arrayContaining([
      'cardFields', 'regex', 'templates', 'html', 'scripts', 'unsupportedApi', 'parentAccess', 'network', 'externalMedia', 'vectorLore',
    ]))
    expect(report.findings.find(row => row.code === 'unsupportedApi')?.locations).toEqual(['regexScripts[0].replaceString'])
    expect(report.findings.find(row => row.code === 'vectorLore')?.status).toBe('unsupported')
    expect(JSON.stringify(report)).not.toContain('must not execute')
    expect(JSON.stringify(report)).not.toContain('example.invalid')
    expect(JSON.stringify(card)).toBe(before)
  })

  it.each([
    { tavern_helper: { scripts: [script("import 'https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';")] } },
    { TavernHelper_scripts: [script('import "https://fastly.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js"')] },
    { tavern_helper: [['scripts', [script("import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js'")]]] },
  ])('支持已有三种脚本库格式的纯官方入口，不误报该入口必须下载外链框架：%j', extensions => {
    const findings = inspect({ extensions }).findings
    expect(findings.find(row => row.code === 'nativeMvu')).toMatchObject({ status: 'supported', count: 1 })
    expect(findings.some(row => row.code === 'customMvu' || row.code === 'externalScript' || row.code === 'invalidScripts')).toBe(false)
  })

  it('官方 URL 附带额外代码仍按自定义模块报告，外链原文和已有 API 不被修改', () => {
    const findings = inspect({ extensions: { tavern_helper: { scripts: [script(
      "import 'https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js'; parent.Vue.createApp({}); Mvu.getMvuData();",
    )] } } }).findings
    expect(findings.map(row => row.code)).toEqual(expect.arrayContaining(['customMvu', 'externalScript', 'parentAccess']))
    expect(findings.some(row => row.code === 'nativeMvu' || row.code === 'unsupportedApi')).toBe(false)
  })

  it('非法脚本库显示无法加载的结构问题，禁用脚本也纳入静态检查', () => {
    expect(inspect({ extensions: { tavern_helper: { scripts: [script(''), script('')] } } }).findings)
      .toContainEqual(expect.objectContaining({ code: 'invalidScripts', status: 'unsupported' }))
    expect(inspect({ extensions: { tavern_helper: { scripts: [{ ...script('injectPrompts([])'), enabled: false }] } } }).findings)
      .toContainEqual(expect.objectContaining({ code: 'unsupportedApi', status: 'unsupported' }))
  })

  it('MVU 支持声明只来自有效库的真实脚本正文，同名变量字段不能冒充框架入口', () => {
    const official = "import 'https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js'"
    for (const scripts of [
      [script(official), script(official)],
      [{ ...script(''), data: { content: official } }],
    ]) expect(inspect({ extensions: { tavern_helper: { scripts } } }).findings.some(row => row.code === 'nativeMvu')).toBe(false)
  })

  it('父窗口美元符号别名和 Markdown 外部图片也列出，不发起请求', () => {
    const report = inspect({ first_mes: '![头像](https://example.invalid/image.png)', extensions: { tavern_helper: {
      scripts: [script('parent.$("#send_textarea");')],
    } } })
    expect(report.findings.map(row => row.code)).toEqual(expect.arrayContaining(['parentAccess', 'externalMedia']))
  })

  it('普通变量里的 vectorized 不等同于世界书向量标记；已实现的现代桥接口不误报', () => {
    const report = inspect({ extensions: { vectorized: true, tavern_helper: { scripts: [script(
      'getWorldbook("a"); replaceWorldbook("a", []); deleteChatMessages([0]); getScriptTrees(); replaceScriptTrees([]); getChatMessages(); setChatMessages([]);',
    )] } } })
    expect(report.findings.some(row => row.status === 'unsupported')).toBe(false)
  })

  it('大字符串、过多节点和过深结构明确不完整，计数/位置/扫描长度有界', () => {
    for (const data of [
      { description: 'x'.repeat(256 * 1024 + 1) },
      { alternate_greetings: Array.from({ length: 17000 }, () => 'parent.document') },
      { extensions: Array.from({ length: 30 }).reduce<Record<string, unknown>>(inner => ({ nested: inner }), { text: 'fetch("hidden")' }) },
      { alternate_greetings: Array.from({ length: 10 }, () => 'x'.repeat(256 * 1024)) },
    ]) {
      const report = inspect(data)
      expect(report.complete).toBe(false)
      expect(report.scannedChars).toBeLessThanOrEqual(2 * 1024 * 1024)
      expect(report.findings.find(row => row.code === 'scanLimit')).toMatchObject({ status: 'review' })
      expect(report.findings.every(row => row.locations.length <= 3 && row.locations.every(path => path.length <= 240))).toBe(true)
    }
  })

  it('每种报告信号在两种语言均有完整说明', () => {
    for (const code of CHARACTER_COMPATIBILITY_CODES) for (const suffix of ['title', 'desc']) {
      const key = `characters.compatibility.${code}.${suffix}` as keyof typeof zh
      expect(zh[key], key).toBeTruthy()
      expect(en[key], key).toBeTruthy()
    }
  })
})
