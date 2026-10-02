/**
 * 合法长记忆文件名的原子写集成：手放真实 Markdown 工厂文件后，经 MemoryStore 与楼层句柄更新，
 * 再用全新 WAL 句柄回滚，验证正文、元数据和原始 CRLF 字节均可恢复。只使用临时目录，不调用模型。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MemoryStore } from '../src/state/memory.js'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

const FLOOR = 'long-memory#t1'
const ORIGINAL_BODY = '港口的旧守卫仍在巡逻。\n第二行保留原始事实。'
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'tavern-atomic-memory-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it.each([
  { label: 'ASCII', id: 'a'.repeat(252) },
  { label: '中文 UTF-8', id: '忆'.repeat(84) },
])('已有 $label 的 255 字节记忆文件名可更新，楼层回滚逐字节恢复原文', async ({ id }) => {
  const basename = `${id}.md`, path = `memory/${basename}`
  expect(Buffer.byteLength(basename, 'utf8')).toBe(255)
  // 初值绕过原子写手放，代表用户已有的合法记忆；CRLF 与末尾空行必须被 WAL 原样恢复。
  const before = Buffer.from([
    '---', 'created: 2026-01-01T00:00:00.000Z', 'updated: 2026-01-02T00:00:00.000Z',
    'source_range:', 'tags: ["旧标签"]', 'keys: ["港口"]', '---', '',
    ...ORIGINAL_BODY.split('\n'), '', '',
  ].join('\r\n'), 'utf8')
  await mkdir(join(root, 'memory'))
  await writeFile(join(root, path), before)
  const wal = new Wal(join(root, 'state', 'wal')), fs = new WorkspaceFs(root, wal)
  expect(await new MemoryStore(fs).get(id)).toMatchObject({ id, body: ORIGINAL_BODY, tags: ['旧标签'] })

  await wal.beginFloor(FLOOR)
  const changed = await new MemoryStore(fs.withFloor(FLOOR)).update(id, {
    body: '这一层把守卫的巡逻路线改到北门。', tags: ['本层标签'], keys: ['北门'],
  })
  expect(changed).toMatchObject({ id, body: '这一层把守卫的巡逻路线改到北门。', tags: ['旧标签', '本层标签'] })
  expect(await readFile(join(root, path))).not.toEqual(before)
  expect(await new MemoryStore(fs).get(id)).toMatchObject({ id, body: changed!.body, keys: ['港口', '北门'] })
  await wal.commitFloor(FLOOR)

  // 重建日志句柄，证明恢复只依赖已持久化的路径与镜像，不能靠更新时的内存状态成功。
  const restored = await new Wal(join(root, 'state', 'wal')).rollbackFloor(FLOOR, root)
  expect(restored).toContain(path)
  expect(await readFile(join(root, path))).toEqual(before)
  expect(await new MemoryStore(new WorkspaceFs(root, null)).get(id)).toMatchObject({
    id, body: ORIGINAL_BODY, tags: ['旧标签'], keys: ['港口'], updated: '2026-01-02T00:00:00.000Z',
  })
  expect(await readdir(join(root, 'memory'))).toEqual([basename])
})
