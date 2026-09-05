/** 同目录临时文件落盘后替换目标，避免正文或 WAL 被截断；失败保留原文件。 */
import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, 'wx')
    try {
      await file.writeFile(data)
      await file.sync()
    } finally { await file.close() }
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}
