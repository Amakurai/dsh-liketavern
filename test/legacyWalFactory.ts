/**
 * 测试工厂：按旧版 Wal.record()/recordAfter() 的磁盘格式直接写 records.jsonl。
 *
 * 遗留后补快照 API 已删除（共享句柄楼层恒为 null，正式写入一律经 withFloor + recordChanges），
 * 但读取与回滚仍须兼容历史日志：没有 after 的 before-only 行、`binary-base64:` 前缀、
 * 以及事后补写 after 的整份重写。这里逐字段复现旧实现落盘的 JSON 形状与换行，
 * 不经过任何运行时写入路径；调用方须先用 wal.beginFloor 开层。
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type Encoding = 'utf8' | 'base64'

function recordsFile(walDir: string, floor: string): string {
  return join(walDir, floor.replace(/[^A-Za-z0-9_.-]/g, '_'), 'records.jsonl')
}

async function readOrEmpty(file: string): Promise<string> {
  return readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
}

/**
 * 旧 record()：追加一行 `{seq,path,before[,beforeEncoding]}`，序号接续已有非空行。
 * 旧实现只在 before 非 null 且给出编码时写 beforeEncoding；反斜杠归一为正斜杠。
 */
export async function appendLegacyRecord(walDir: string, floor: string, path: string,
  before: string | null, beforeEncoding?: Encoding): Promise<void> {
  const file = recordsFile(walDir, floor)
  const seq = (await readOrEmpty(file)).split('\n').filter((line) => line.trim()).length + 1
  const line = { seq, path: path.replace(/\\/g, '/'), before, ...(beforeEncoding && before !== null ? { beforeEncoding } : {}) }
  await appendFile(file, JSON.stringify(line) + '\n', 'utf8')
}

/**
 * 旧 recordAfter()：给同路径的记录补上 `after[,afterEncoding]` 后整份重写（split/join 保留原换行）。
 * 旧实现要求该路径恰有一条记录；这里同样只在找到时改写，便于测试构造旧日志。
 */
export async function patchLegacyAfter(walDir: string, floor: string, path: string,
  after: string | null, afterEncoding?: Encoding): Promise<void> {
  const file = recordsFile(walDir, floor)
  const normPath = path.replace(/\\/g, '/')
  let found = false
  const lines = (await readFile(file, 'utf8')).split('\n').map((line) => {
    if (!line.trim()) return line
    const record = JSON.parse(line) as { path: string }
    if (record.path !== normPath) return line
    found = true
    return JSON.stringify({ ...record, after, ...(afterEncoding && after !== null ? { afterEncoding } : {}) })
  })
  if (!found) throw new Error(`测试工厂：楼层 ${floor} 没有路径 ${normPath} 的旧记录`)
  await writeFile(file, lines.join('\n'))
}
