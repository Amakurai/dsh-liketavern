/**
 * 宿主提示词插值保真：tavern:standing 与 tavern:turn 声明 interpolate: false。
 * 宿主默认会把段内 {{name}} 当提示词变量：未注册名让整次渲染抛错，cwd/model/provider
 * 被静默替换。角色卡原文（未知宏、Handlebars、代码示例）必须原样入模，不改写成全角括号。
 * 真实 SystemPrompt / AgentLoop / 文件系统，未调用模型。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt, renderContextSections, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply as applyAgent } from '../src/agent.js'
import { resolveConfig } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'

const LITERAL = '口头禅模板 {{未知宏}}，工作目录写作 {{cwd}}，界面绑定 {{ item.name }}。'
let root: string, ctx: Context, state: TavernState, agent: Agent

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-prompt-interpolation-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  const { cardId } = await state.createCharacter('插值保真')
  await state.saveCharacter(cardId, { description: LITERAL })
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  agent = await new AgentLoop(ctx, AgentLoop.Config({ agents: [] })).create(SessionId('prompt-interpolation'))
  agent.session.append('agent-preset/selected', { agentPreset: 'tavern' })
  await state.saveBinding({ sessionId: agent.id, cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null,
    interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  ctx.provide('tavern', { state }); applyAgent(agent.ctx)
})
afterEach(async () => { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }) })

it('角色卡原文里的 {{…}} 原样进入 standing，不抛错、不被宿主变量替换、不改成全角', async () => {
  const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))
  const standing = assembly.sections.find(section => section.name === 'tavern:standing')!
  expect(standing.interpolate).toBe(false)
  const rendered = renderPrompt(assembly)
  expect(rendered).toContain(LITERAL)
  expect(rendered).not.toContain('｛｛')
  expect(assembly.contexts.find(context => context.name === 'tavern:turn')?.interpolate ?? false).toBe(false)
  expect(() => renderContextSections(assembly)).not.toThrow()
})
