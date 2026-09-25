/** Tavern 声明预设：解析随包模板，通过宿主注册表安装，保留 Windows URL 与 YAML 转义。 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { entryListProblem, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { parse } from 'yaml'

export const TAVERN_PRESET_ID = 'tavern'

function packageRoot(): string {
  // 本文件编译后位于 lib/node/presetInstall.js，源码期位于 src/node/presetInstall.ts
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', '..')
}

/** 推导 agent 入口的 file:// URL（Windows 下 loader 只接受合法 ESM URL）。 */
export function agentModulePath(): string {
  const url = import.meta.url
  const filePath = fileURLToPath(url)
  const match = /(index|presetInstall)\.(ts|js)$/.exec(filePath)
  if (!match) throw new Error(`无法从 ${filePath} 推导 agent 入口路径`)
  const target = filePath.replace(/(node)[/\\](index|presetInstall)\.(ts|js)$/, `agent.$3`)
  return pathToFileURL(target).href
}

/**
 * YAML 单引号标量转义：只需把 `'` 写成 `''`。
 * 模板里 `__AGENT_MODULE__` 位于单引号标量内，而 pathToFileURL 不会编码撇号
 * （安装路径形如 `C:\Users\O'Brien\...` 时 href 里就带着裸撇号），不转义会写出
 * 语法坏掉的 YAML —— 预设挂不上且没有任何诊断。
 */
export function escapeYamlSingleQuoted(value: string): string {
  return value.replaceAll("'", "''")
}

/** 新宿主从声明注册预设，不再扫描 .agent-presets；注册跟随插件生命周期撤销。 */
export async function installTavernPreset(ctx: Pick<Context, 'agentPresets'>): Promise<() => Promise<void>> {
  const templateDir = join(packageRoot(), 'presets', TAVERN_PRESET_ID)
  const plugins: unknown = parse((await readFile(join(templateDir, 'agent.cordis.yml'), 'utf8'))
    .replaceAll('__AGENT_MODULE__', escapeYamlSingleQuoted(agentModulePath())))
  const problem = entryListProblem(plugins)
  if (problem) throw new Error(problem)
  const meta = parse(await readFile(join(templateDir, 'preset.yml'), 'utf8')) as Record<string, unknown>
  if (typeof meta.name !== 'string' || typeof meta.description !== 'string' || typeof meta.order !== 'number') throw new Error('Tavern 预设元数据无效')
  return ctx.agentPresets.register({ id: TAVERN_PRESET_ID, name: meta.name, description: meta.description,
    order: meta.order, plugins: plugins as PresetDefinition['plugins'] })
}
