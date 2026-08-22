/**
 * Tavern agent 预设安装器。
 * 覆盖：
 * - escapeYamlSingleQuoted：撇号按 YAML 单引号规则加倍，其余字符原样；
 * - 模板替换：安装路径含撇号（如 C:\Users\O'Brien）时写出的仍是合法单引号标量，
 *   能原样还原成 file:// URL；不转义则标量提前闭合，YAML 坏掉；
 * - installTavernPreset：真实落盘的 agent.cordis.yml 可还原出 agentModulePath()，
 *   内容一致时二次安装跳过。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentModulePath, escapeYamlSingleQuoted, installTavernPreset } from '../src/node/presetInstall.js'

const TEMPLATE_URL = new URL('../presets/tavern/agent.cordis.yml', import.meta.url)

/**
 * 极简 YAML 单引号标量读取：取 `name: '…'` 的值并把 `''` 还原成 `'`。
 * 正则只接受合法标量（内部撇号必须成对），未转义的撇号会让标量提前闭合从而匹配失败——
 * 这正是要验的失败模式，所以不借助宽松的 YAML 库。
 */
function readSingleQuotedName(yaml: string): string {
  const match = /^\s*name:\s*'((?:[^']|'')*)'\s*$/m.exec(yaml)
  if (!match) throw new Error('agent.cordis.yml 缺少合法的单引号 name 标量')
  return match[1]!.replaceAll("''", "'")
}

describe('escapeYamlSingleQuoted', () => {
  it('撇号加倍，其余字符不动', () => {
    expect(escapeYamlSingleQuoted("O'Brien")).toBe("O''Brien")
    expect(escapeYamlSingleQuoted("a'b'c")).toBe("a''b''c")
    expect(escapeYamlSingleQuoted('file:///C:/dsh/lib/agent.js')).toBe('file:///C:/dsh/lib/agent.js')
    expect(escapeYamlSingleQuoted('')).toBe('')
  })
})

describe('__AGENT_MODULE__ 替换', () => {
  it('pathToFileURL 不编码撇号，必须由调用方转义', async () => {
    const href = pathToFileURL(join(tmpdir(), "O'Brien", 'agent.js')).href
    expect(href).toContain("'")

    const template = await readFile(TEMPLATE_URL, 'utf8')
    // 未转义：标量在撇号处提前闭合，写出的是坏 YAML
    expect(() => readSingleQuotedName(template.replaceAll('__AGENT_MODULE__', href))).toThrow()
    // 转义后原样还原
    expect(readSingleQuotedName(template.replaceAll('__AGENT_MODULE__', escapeYamlSingleQuoted(href)))).toBe(href)
  })
})

describe('installTavernPreset', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'preset-install-test-'))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('落盘的 agent.cordis.yml 能还原出 agent 入口 URL', async () => {
    const result = await installTavernPreset(home)
    expect(result.written).toEqual(['preset.yml', 'agent.cordis.yml'])

    const yaml = await readFile(join(result.dir, 'agent.cordis.yml'), 'utf8')
    expect(yaml).not.toContain('__AGENT_MODULE__')
    expect(readSingleQuotedName(yaml)).toBe(agentModulePath())
  })

  it('内容一致时二次安装跳过', async () => {
    await installTavernPreset(home)
    const again = await installTavernPreset(home)
    expect(again.written).toEqual([])
    expect(again.skipped).toEqual(['preset.yml', 'agent.cordis.yml'])
  })
})
