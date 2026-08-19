/**
 * Tavern 预设安装器：把 presets/tavern/ 模板写入 `$DSH_HOME/.agent-presets/tavern/`。
 *
 * agent.cordis.yml 中的 `__AGENT_MODULE__` 占位符替换为本包 agent 入口的 file:// URL
 * （从 import.meta.url 推导：开发期是 src/agent.ts，构建后是 lib/agent.js；
 * cordis loader 两种都支持）。预设目录已存在且内容一致时跳过；不一致时覆盖
 * （该预设由插件托管，README 有说明）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

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

export interface PresetInstallResult {
  dir: string
  written: string[]
  skipped: string[]
}

export async function installTavernPreset(home?: string): Promise<PresetInstallResult> {
  const dir = home ? join(home, '.agent-presets', TAVERN_PRESET_ID) : dshHomePath('.agent-presets', TAVERN_PRESET_ID)
  const templateDir = join(packageRoot(), 'presets', TAVERN_PRESET_ID)
  const agentPath = agentModulePath()
  const files: Array<{ name: string; render: (text: string) => string }> = [
    { name: 'preset.yml', render: (t) => t },
    { name: 'agent.cordis.yml', render: (t) => t.replaceAll('__AGENT_MODULE__', agentPath) },
  ]
  const result: PresetInstallResult = { dir, written: [], skipped: [] }
  await mkdir(dir, { recursive: true })
  for (const file of files) {
    const target = join(dir, file.name)
    const content = file.render(await readFile(join(templateDir, file.name), 'utf8'))
    if (existsSync(target) && readFileSync(target, 'utf8') === content) {
      result.skipped.push(file.name)
      continue
    }
    await writeFile(target, content, 'utf8')
    result.written.push(file.name)
  }
  return result
}
