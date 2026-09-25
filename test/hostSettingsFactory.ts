/** 设置工厂：真实 Loader、volatile 配置与 SettingsForms；仅 profile 编辑存储替换为临时 JSON 文件。 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Context, resolveConfig } from '@deepseek-ai/cordis'
import { Loader, type Entry } from '@deepseek-ai/cordis-plugin-loader'
import { SettingsForms } from '@deepseek-ai/dsh-settings'
import type { ConfigEditor } from '@deepseek-ai/dsh-config-editor'
import type z from '@deepseek-ai/schemastery'

export class FileSettings {
  readonly loader: Loader
  readonly forms: SettingsForms
  constructor(private readonly ctx: Context, private readonly file: string) {
    this.loader = new Loader(ctx)
    ctx.provide('profileContext', { home: dirname(file) } as Context['profileContext'])
    const editor = {
      entries: () => [...this.loader.entries()],
      configuration: () => [...this.loader.entries()].map(entry => ({ entry, inherited: {}, override: entry.options.config ?? {} })),
      edit: async (entry: Entry, change: (raw: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => {
        const next = change(entry.options.config ?? {}, {})
        resolveConfig(entry.fiber!.runtime!, next)
        const saved = JSON.parse(await readFile(file, 'utf8'))
        await writeFile(file, JSON.stringify({ ...saved, [entry.options.id]: next }))
        await this.loader.update(entry.id, { config: next })
      },
    }
    ctx.provide('configEditor', editor as ConfigEditor)
    this.forms = new SettingsForms(ctx)
  }
  async register<T>(ns: string, schema: z<T>, options: { base?: object } = {}) {
    const saved = JSON.parse(await readFile(this.file, 'utf8'))
    const plugin = { Config: schema, apply: () => {} }
    this.loader.builtins[ns] = plugin
    await this.loader.root.update([...this.loader.root.data, { id: ns, name: `cordis:${ns}`, config: { ...options.base, ...saved[ns] } }])
    await this.loader.await()
    return { get: () => this.get(ns) as T, update: (patch: object) => this.forms.update(ns, patch) }
  }
  get(ns: string): unknown { return this.forms.describe().find(item => item.ns === ns)?.value }
  describe() { return this.forms.describe() }
}
