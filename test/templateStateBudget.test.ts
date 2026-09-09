/** 模板状态预算回归：以 UTF-8 字节限制中文快照，超限读取与写入都明确失败，原文件和 WAL 不变。 */
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadTemplateState, saveTemplateState, TEMPLATE_STATE_PATH, templateTextHash, type TemplateState } from '../src/state/template.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { Wal } from '../src/state/wal.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const state = (text: string): TemplateState => ({ version: 1, variables: { global: {}, local: {}, message: {} }, outputs: { '1': { hash: templateTextHash(text), text } } })

describe('模板状态字节上限', () => {
  it('中文超限写入不覆盖原状态，也不污染楼层日志', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tavern-state-budget-')); roots.push(root)
    const wal = new Wal(join(root, '.wal')), fs = new WorkspaceFs(root, wal)
    await wal.beginFloor('s1#t1')
    const valid = state('已有快照')
    await saveTemplateState(fs.withFloor('s1#t1'), valid)
    await wal.commitFloor('s1#t1')
    const before = await fs.readText(TEMPLATE_STATE_PATH), floors = await wal.listFloors()
    const oversized = state('界'.repeat(Math.ceil(4 * 1024 * 1024 / 3)))
    const raw = JSON.stringify(oversized)
    expect(raw.length).toBeLessThan(4 * 1024 * 1024)
    expect(Buffer.byteLength(raw)).toBeGreaterThan(4 * 1024 * 1024)
    await expect(saveTemplateState(fs.withFloor('s1#t2'), oversized)).rejects.toThrow(/4 MiB/)
    expect(await fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
    expect(await wal.listFloors()).toEqual(floors)
    expect(await loadTemplateState(fs)).toEqual(valid)
  })

  it('外部写入的中文超限状态被拒绝，文件保持可供手工恢复', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tavern-state-budget-')); roots.push(root)
    const fs = new WorkspaceFs(root, null)
    const raw = JSON.stringify(state('界'.repeat(Math.ceil(4 * 1024 * 1024 / 3))))
    await fs.writeText(TEMPLATE_STATE_PATH, raw)
    await expect(loadTemplateState(fs)).rejects.toThrow(/4 MiB/)
    expect(await fs.readText(TEMPLATE_STATE_PATH)).toBe(raw)
  })
})
