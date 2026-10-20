/** 审计复核：确认 presetInstall.agentModulePath() 在源码与 lib 两种运行形态下都指向真实存在的 agent 入口。 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { agentModulePath } from '../../src/node/presetInstall.js'

describe('presetInstall agentModulePath 复核', () => {
  it('指向的入口文件真实存在', () => {
    const href = agentModulePath()
    const file = fileURLToPath(href)
    console.log('AGENT_MODULE =', file, 'exists =', existsSync(file))
    expect(existsSync(file), file).toBe(true)
  })
})
