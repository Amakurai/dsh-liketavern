/**
 * card.json 存储上限回归：运行时写入与 doctor/backup 共用 MAX_STORED_CARD_JSON_BYTES。
 * 真实文件系统构造超过通用 16 MiB JSON 上限、但在存储上限内的中文卡，确认诊断与备份可用；
 * 超出存储上限的文件仍报固定错误，写入侧在落盘前拒绝。测试数据全部由工厂生成。
 */
import { mkdtemp, readdir, rm, stat, truncate, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDoctor } from '../src/doctor.js'
import { createBackup } from '../src/node/backup.js'
import { MAX_STORED_CARD_JSON_BYTES, parseJsonCard, serializeStoredCard } from '../src/state/card.js'
import { importCard } from '../src/state/workspace.js'

const GENERIC_JSON_LIMIT = 16 * 1024 * 1024
const doctorVersions = { nodeVersion: '24.0.0', pluginVersion: '9.8.7', dshInstalledVersion: '0.2.1-rc.2', dshExpectedVersion: '0.2.1-rc.2' }

let scratch: string, home: string, characters: string
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'tavern-card-limit-'))
  home = join(scratch, 'home')
  characters = join(home, 'dsh-tavern', 'characters')
  await mkdir(characters, { recursive: true })
})
afterEach(async () => { await rm(scratch, { recursive: true, force: true }) })

/** 中文正文在 raw 与归一化字段各存一份；320 万字约 19 MB，低于导入的 8M 字符上限。 */
function largeChineseCard(): ReturnType<typeof parseJsonCard> {
  const description = '创世回廊的长篇设定'.repeat(360_000)
  return parseJsonCard({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '大卡', description, first_mes: '你好' } })
}

describe('card.json 存储上限', () => {
  it('超过 16 MiB 的合法中文卡：doctor 无错误，backup create 成功', async () => {
    const workspace = await importCard(characters, largeChineseCard())
    const size = (await stat(join(workspace.root, 'card.json'))).size
    expect(size).toBeGreaterThan(GENERIC_JSON_LIMIT)
    expect(size).toBeLessThanOrEqual(MAX_STORED_CARD_JSON_BYTES)

    const report = await runDoctor({ home, ...doctorVersions })
    expect(report.issues.filter(issue => issue.severity === 'error')).toEqual([])
    expect(report.statistics.characters).toMatchObject({ directories: 1, healthy: 1, unhealthy: 0, uninspected: 0 })
    expect(report.statistics.files).toMatchObject({ oversizedJson: 0, invalidJson: 0, scanTruncated: false })

    const backup = join(scratch, 'backup')
    await expect(createBackup({ home, backup, offline: true })).resolves.toBeTruthy()
    expect(await readdir(backup)).toContain('manifest.json')
  }, 60_000)

  it('超出存储上限的 card.json 仍报 CHARACTER_METADATA_TOO_LARGE，备份拒绝', async () => {
    const cardRoot = join(characters, 'huge-card-a1b2c3d4')
    await mkdir(cardRoot)
    const file = join(cardRoot, 'card.json')
    await writeFile(file, '')
    await truncate(file, MAX_STORED_CARD_JSON_BYTES + 1)

    const report = await runDoctor({ home, ...doctorVersions })
    expect(report.ok).toBe(false)
    expect(report.issues).toContainEqual({ code: 'CHARACTER_METADATA_TOO_LARGE', severity: 'error', count: 1 })
    await expect(createBackup({ home, backup: join(scratch, 'backup'), offline: true }))
      .rejects.toMatchObject({ code: 'STRUCTURE_INVALID' })
  })

  it('写入侧在落盘前拒绝超出存储上限的卡，不留下工作区', async () => {
    const card = parseJsonCard({ name: '小卡', description: '短' })
    const oversized = { ...card, description: 'a'.repeat(MAX_STORED_CARD_JSON_BYTES) }
    expect(() => serializeStoredCard(oversized)).toThrow(/存储上限/)
    await expect(importCard(characters, oversized)).rejects.toThrow(/存储上限/)
    expect(await readdir(characters)).toEqual([])
  }, 60_000)
})
