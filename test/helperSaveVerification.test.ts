/** 酒馆助手状态写入验证：短暂写入异常但磁盘正文已落盘时不误报失败，正文不符时如实报错。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveHelperState, loadHelperState, HELPER_STATE_PATH, type HelperState } from '../src/state/helper.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

describe('saveHelperState verification guard', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tavern-helper-guard-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writeText 抛错但磁盘正文已匹配时吞掉异常并完成，正文不匹配时如实抛出', async () => {
    const fs = new WorkspaceFs(root, null).withFloor('session#t1')
    const sampleState: HelperState = {
      scopes: { '["chat",""]': { hp: 10 } },
      extras: {},
    }
    const raw = JSON.stringify({ version: 1, scopes: sampleState.scopes })

    // Case 1: writeText throws, but content on disk matches raw (simulating transient post-write sync error)
    const writeSpy = vi.spyOn(fs, 'writeText').mockImplementation(async (path, content) => {
      // Simulate underlying atomicWrite writing the file before throwing
      await new WorkspaceFs(root, null).writeText(path, content)
      throw new Error('EPERM: directory sync failed')
    })

    await expect(saveHelperState(fs, sampleState)).resolves.toBeUndefined()
    expect(await fs.readText(HELPER_STATE_PATH)).toBe(raw)
    writeSpy.mockRestore()

    // Case 2: writeText throws and disk content does NOT match raw (genuine failure)
    const nextState: HelperState = {
      scopes: { '["chat",""]': { hp: 20 } },
      extras: {},
    }
    const failureSpy = vi.spyOn(fs, 'writeText').mockRejectedValueOnce(new Error('Fatal I/O failure'))
    await expect(saveHelperState(fs, nextState)).rejects.toThrow('Fatal I/O failure')
    failureSpy.mockRestore()

    // Disk remains the old raw content
    expect(await fs.readText(HELPER_STATE_PATH)).toBe(raw)
  })

  it('writeText 抛错且磁盘残留截断损坏内容时，绝不吞掉异常，严格重新抛出原错误', async () => {
    const fs = new WorkspaceFs(root, null).withFloor('session#t1')
    const sampleState: HelperState = {
      scopes: { '["chat",""]': { hp: 10 } },
      extras: {},
    }

    const corruptedSpy = vi.spyOn(fs, 'writeText').mockImplementation(async (path) => {
      // 模拟写到一半崩溃，磁盘留下残缺截断的 JSON
      await new WorkspaceFs(root, null).writeText(path, '{"version":1,"scopes":{"["chat",""]":{')
      throw new Error('EIO: disk write truncated')
    })

    await expect(saveHelperState(fs, sampleState)).rejects.toThrow('EIO: disk write truncated')
    corruptedSpy.mockRestore()
  })

  it('Zero-I/O 优化：当磁盘内容已与待保存正文完全一致时，跳过 writeText', async () => {
    const fs = new WorkspaceFs(root, null).withFloor('session#t1')
    const sampleState: HelperState = {
      scopes: { '["chat",""]': { hp: 10 } },
      extras: {},
    }
    // 首次正常落盘
    await saveHelperState(fs, sampleState)

    // 第二次保存相同内容，writeText 不应被调用
    const writeSpy = vi.spyOn(fs, 'writeText')
    await saveHelperState(fs, sampleState)
    expect(writeSpy).not.toHaveBeenCalled()
    writeSpy.mockRestore()
  })

  it('未绑定楼层时同步拒绝保存，抛出"酒馆助手剧情写入必须绑定楼层"', async () => {
    const fsWithoutFloor = new WorkspaceFs(root, null)
    const sampleState: HelperState = { scopes: {}, extras: {} }
    await expect(saveHelperState(fsWithoutFloor, sampleState)).rejects.toThrow('酒馆助手剧情写入必须绑定楼层')
  })

  it('超过 4MB 预算时拒绝保存，并抛出"酒馆助手状态文件超限"', async () => {
    const fs = new WorkspaceFs(root, null).withFloor('session#t1')
    // 生成单个巨型表，超过 4MB
    const bigString = 'x'.repeat(4 * 1024 * 1024 + 10)
    const oversizedState: HelperState = {
      scopes: { '["chat",""]': { payload: bigString } },
      extras: {},
    }
    await expect(saveHelperState(fs, oversizedState)).rejects.toThrow(/酒馆助手(数据超过预算|状态文件超限)/)
  })
})
