/**
 * Tavern agent 预设安装器。
 * 覆盖：
 * - escapeYamlSingleQuoted：撇号按 YAML 单引号规则加倍，其余字符原样；
 * - 模板替换：安装路径含撇号（如 C:\Users\O'Brien）时写出的仍是合法单引号标量，
 *   能原样还原成 file:// URL；不转义则标量提前闭合，YAML 坏掉；
 * - installTavernPreset：新注册器收到合法模板、agent URL，生命周期撤销与失败传播。
 */
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { agentModulePath, escapeYamlSingleQuoted, installTavernPreset } from '../src/node/presetInstall.js'

const TEMPLATE_URL = new URL('../presets/tavern/agent.cordis.yml', import.meta.url)

/**
 * 极简 YAML 单引号标量读取：取 `name: '…'` 的值并把 `''` 还原成 `'`。
 * 正则只接受合法标量（内部撇号必须成对），未转义的撇号会让标量提前闭合从而匹配失败——
 * 这正是要验的失败模式，所以不借助宽松的 YAML 库。
 */
function readSingleQuotedName(yaml: string): string {
  const match = /^- id: tavern\r?\n\s*name:\s*'((?:[^']|'')*)'\s*$/m.exec(yaml)
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
  it('向新注册表提供合法模板及 agent URL，并返回生命周期释放句柄', async () => {
    const dispose = vi.fn(async () => {})
    const register = vi.fn(async () => dispose)
    const ctx = { agentPresets: { register } } as unknown as Pick<Context, 'agentPresets'>
    const release = await installTavernPreset(ctx)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ id: 'tavern', plugins: [
      { id: 'tavern', name: agentModulePath() },
      { id: 'tool-presentation', name: '@deepseek-ai/dsh-agent-tool-presentation', config: { mode: 'ptc' } },
    ] }))
    expect(dispose).not.toHaveBeenCalled()
    await release()
    expect(dispose).toHaveBeenCalledOnce()
  })
  it('注册失败向调用者传播，不把没有安装的预设报告为成功', async () => {
    const ctx = { agentPresets: { register: async () => { throw new Error('注册失败') } } } as unknown as Pick<Context, 'agentPresets'>
    await expect(installTavernPreset(ctx)).rejects.toThrow('注册失败')
  })
})
