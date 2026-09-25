/**
 * 全局角色提示词偏好回归：真实宿主 SettingsProvider、临时文件与 TavernService 验证默认、部分更新、
 * schema 拒绝非法布尔值及重启回读；这些设置属于全局命名空间，不写入提示词预设。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileSettings } from './hostSettingsFactory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { TAVERN_NS, Config, resolveConfig } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'

/** 存储适配器只把宿主通过验证的命名空间写到测试目录，合并与验证仍走真实 SettingsProvider。 */

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('全局提示词偏好', () => {
  it('缺省与部分设置保持 ST 默认，两个开关互不影响，错型明确拒绝', () => {
    expect(resolveConfig({}).prompts).toEqual({ preferCharacterPrompt: true, preferCharacterInstructions: true })
    expect(resolveConfig({ prompts: { preferCharacterPrompt: false } }).prompts)
      .toEqual({ preferCharacterPrompt: false, preferCharacterInstructions: true })
    expect(resolveConfig({ prompts: { preferCharacterInstructions: false } }).prompts)
      .toEqual({ preferCharacterPrompt: true, preferCharacterInstructions: false })
    expect(() => resolveConfig({ prompts: { preferCharacterPrompt: 'false' } })).toThrow()
    expect(() => resolveConfig({ prompts: { preferCharacterInstructions: 0 } })).toThrow()
  })

  it('服务保存经宿主 schema 校验并落盘，部分补丁保留其它设置，重启后仍保留关闭偏好', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tavern-prompt-preferences-'))
    roots.push(root)
    const file = join(root, 'settings.json')
    await writeFile(file, JSON.stringify({ [TAVERN_NS]: { sampling: { temperature: 0.7 } } }))
    const ctx = new Context()
    contexts.push(ctx)
    const provider = new FileSettings(ctx, file)
      const scope = await provider.register(TAVERN_NS, Config)
    const state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
      presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') },
    () => resolveConfig(scope.get()))
    const service = new TavernService(ctx, state, scope)
    expect(service.getSettings({}).settings.prompts).toEqual({ preferCharacterPrompt: true, preferCharacterInstructions: true })
    await service.updateSettings({ patch: { prompts: { preferCharacterPrompt: false } } })
    expect(state.config.prompts).toEqual({ preferCharacterPrompt: false, preferCharacterInstructions: true })
    const saved = await service.updateSettings({ patch: { prompts: { preferCharacterInstructions: false } } })
    expect(saved.settings.prompts).toEqual({ preferCharacterPrompt: false, preferCharacterInstructions: false })
    expect(saved.settings.sampling.temperature).toBe(0.7)
    const persisted = await readFile(file, 'utf8')
    expect(JSON.parse(persisted)).toEqual({ [TAVERN_NS]: { sampling: { temperature: 0.7 },
      prompts: { preferCharacterPrompt: false, preferCharacterInstructions: false } } })

    await expect(service.updateSettings({ patch: { prompts: { preferCharacterPrompt: 'false' } } })).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(persisted)
    expect(scope.get().prompts).toEqual(saved.settings.prompts)

    const restartedCtx = new Context()
    contexts.push(restartedCtx)
    const restarted = new FileSettings(restartedCtx, file)
      const restored = await restarted.register(TAVERN_NS, Config)
    expect(restored.get().prompts).toEqual(saved.settings.prompts)
    expect(resolveConfig(restored.get()).prompts).toEqual(state.config.prompts)
  })
})
