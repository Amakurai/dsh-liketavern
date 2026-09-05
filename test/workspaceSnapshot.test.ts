/** 工作区字节快照回归：覆盖带 UTF-8 BOM 文件的改写、删除及多次写入后的完整回滚。 */
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let wal: Wal
let fs: WorkspaceFs
const floor = 'snapshot#t1'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-snapshot-'))
  wal = new Wal(join(root, 'state', 'wal'))
  await wal.beginFloor(floor)
  fs = new WorkspaceFs(root, wal).withFloor(floor)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('WAL 快照保留 UTF-8 BOM', () => {
  it.each(['overwrite', 'delete'] as const)('%s 后重启回滚恢复原始字节', async (operation) => {
    const original = Buffer.from('\uFEFF原始正文\r\n第二行')
    await writeFile(join(root, 'journal.md'), original)
    if (operation === 'overwrite') await fs.writeText('journal.md', '修改后的正文')
    else await fs.delete('journal.md')
    await wal.commitFloor(floor)

    await new Wal(join(root, 'state', 'wal')).rollbackFloor(floor, root)

    expect(await readFile(join(root, 'journal.md'))).toEqual(original)
  })

  it('同层中间版本含 BOM 时仍能撤销全部写入，不把中间版本误判为人工修订', async () => {
    const original = Buffer.from('楼层开始前的正文')
    await writeFile(join(root, 'journal.md'), original)
    await fs.writeText('journal.md', '\uFEFF模型第一稿')
    await fs.writeText('journal.md', '模型第二稿')
    await wal.commitFloor(floor)

    await wal.rollbackFloor(floor, root)

    expect(await readFile(join(root, 'journal.md'))).toEqual(original)
  })
})
