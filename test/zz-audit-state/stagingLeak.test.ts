/**
 * S5 回归：崩溃遗留的导入/分支草稿目录按 mtime 超龄回收，且绝不误删已发布剧情。
 *
 * 修复前：`.importing-<uuid>`（characters/ 本层）与 `.preparing-<uuid>`（stories/ 本层）只在
 * finally 里清理，崩溃后永久残留；清理入口只匹配 `.dsh-tavern-write.<uuid>.tmp` 文件，
 * 两个父目录又被 skipDir 排除。
 * 修复后：sweepOrphanTemps 支持 draftPrefixes（只在本层按前缀 + 超龄删除），
 * TavernState 在启动/开卡时分别清扫 characters 与 stories 本层。
 */
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DRAFT_PREFIXES, ORPHAN_TEMP_MAX_AGE_MS, sweepOrphanTemps } from '../../src/state/atomicWrite.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function put(path: string, body: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, body)
}

/** 把目录 mtime 调老：草稿目录的回收判据是目录自身的 mtime。 */
async function age(path: string, ageMs: number): Promise<void> {
  const at = new Date(Date.now() - ageMs)
  await utimes(path, at, at)
}

const old = ORPHAN_TEMP_MAX_AGE_MS + 60_000

describe('草稿目录回收', () => {
  it('只回收本层超龄的点号前缀草稿，保留新草稿与已发布的角色/剧情目录', async () => {
    const home = await mkdtemp(join(tmpdir(), 'audit-staging-leak-'))
    roots.push(home)
    const characters = join(home, 'characters')
    const publishedCard = join(characters, 'card-a1b2c3d4')
    const oldImport = join(characters, '.importing-6f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b')
    const freshImport = join(characters, '.importing-1e2d3c4b-5a49-4788-9a9b-0c1d2e3f4a5b')
    await put(join(publishedCard, 'card.json'), '{}')
    await age(publishedCard, old)
    await put(join(oldImport, 'state/wal/f1/records.jsonl'), '{}\n')
    await age(oldImport, old)
    await put(join(freshImport, 'card.json'), '{}')

    expect(await sweepOrphanTemps(characters, { draftPrefixes: DRAFT_PREFIXES, recursive: false })).toBe(1)
    expect((await readdir(characters)).sort()).toEqual(['.importing-1e2d3c4b-5a49-4788-9a9b-0c1d2e3f4a5b', 'card-a1b2c3d4'])
    expect(await readdir(publishedCard)).toEqual(['card.json'])

    const stories = join(publishedCard, 'stories')
    const published = join(stories, 'story-00000000-0000-4000-8000-000000000001')
    const legacy = join(stories, 'legacy-0123456789abcdef0123456789abcdef')
    const oldPrepare = join(stories, '.preparing-2e3d4c5b-6a59-4788-9a9b-0c1d2e3f4a5b')
    const freshPrepare = join(stories, '.preparing-3e4d5c6b-7a69-4788-9a9b-0c1d2e3f4a5b')
    await put(join(published, 'story.json'), '{}')
    await age(published, old)
    await put(join(legacy, 'story.json'), '{}')
    await age(legacy, old)
    await put(join(oldPrepare, 'journal.md'), '分支草稿正文')
    await age(oldPrepare, old)
    await put(join(freshPrepare, 'journal.md'), '新草稿')

    expect(await sweepOrphanTemps(stories, { draftPrefixes: DRAFT_PREFIXES, recursive: false })).toBe(1)
    expect((await readdir(stories)).sort()).toEqual([
      '.preparing-3e4d5c6b-7a69-4788-9a9b-0c1d2e3f4a5b',
      'legacy-0123456789abcdef0123456789abcdef',
      'story-00000000-0000-4000-8000-000000000001',
    ])
    // 已发布剧情目录（含 story.json）原样保留。
    expect(await readdir(published)).toEqual(['story.json'])
    expect(await readdir(legacy)).toEqual(['story.json'])
  })

  it('默认不启用草稿回收：不传 draftPrefixes 时不删除任何目录', async () => {
    const home = await mkdtemp(join(tmpdir(), 'audit-staging-default-'))
    roots.push(home)
    const characters = join(home, 'characters')
    const draft = join(characters, '.importing-6f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b')
    await put(join(draft, 'card.json'), '{}')
    await age(draft, old)
    expect(await sweepOrphanTemps(characters)).toBe(0)
    expect(await readdir(characters)).toEqual(['.importing-6f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b'])
  })
})
