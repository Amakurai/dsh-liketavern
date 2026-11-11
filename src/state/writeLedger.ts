/**
 * 工作区写入登记：按根目录记下本进程经 WorkspaceFs 写过或删过哪些文件。
 *
 * 缓存靠磁盘指纹（mtime + size）判断文件是否变过，但同一时间刻度内长度相同的两次写入分不出来——
 * 楼层回滚把「北门未开」写回成等长的「北门已开」就是这种情况。WorkspaceFs 的每次写入、删除都在这里记一笔，
 * 读的一方（记忆存储）据此重读，不依赖 mtime 精度。工具写入、面板编辑、归并归档、WAL 回滚都经过 WorkspaceFs，
 * 所以都被覆盖；别的进程或外部编辑器的改动不经过这里，仍只能靠磁盘指纹或显式作废。
 *
 * 只有读的一方打开过登记的根目录才会记录：分支准备时的临时目录没有读者，不必为它们留账。
 */
import { sep } from 'node:path'
import { caseIdentity, rootIdentity } from './pathIdentity.js'

const MAX_TRACKED_FILES = 4096
const MAX_TRACKED_DIRS = 1024

export interface WriteLedger {
  /** 显式作废的次数；变化时读的一方清空全部缓存。 */
  epoch: number
  /** 单调递增的写入序号。 */
  counter: number
  /** 文件身份 → 最近一次写入的序号。 */
  readonly files: Map<string, number>
  /** 目录身份 → 其直接子文件最近一次写入的序号。 */
  readonly dirs: Map<string, number>
}

const ledgers = new Map<string, WriteLedger>()
/** 全局单调 epoch：closeLedger 删除后再在同一路径重建目录，新账本也不会撞上旧缓存的 epoch。 */
let nextLedgerEpoch = 0

/** 相对路径的身份：正斜杠、去掉空段与 `.`；Windows 上文件名不分大小写。 */
export function ledgerKey(relPath: string): string {
  const key = relPath.replace(/\\/g, '/').split('/').filter((segment) => segment !== '' && segment !== '.').join('/')
  return caseIdentity(key)
}

/** 读的一方打开登记；此后这个根目录下的写入才会被记录。 */
export function openLedger(root: string): WriteLedger {
  const key = rootIdentity(root)
  let ledger = ledgers.get(key)
  if (!ledger) {
    ledger = { epoch: ++nextLedgerEpoch, counter: 0, files: new Map(), dirs: new Map() }
    ledgers.set(key, ledger)
  }
  return ledger
}

/**
 * 记一次写入或删除。必须在落盘之后调用：先登记的话，读的一方可能在落盘前读到旧内容却记成已是最新。
 * 没有读者打开过的根目录直接忽略。
 */
export function noteWrite(root: string, relPath: string): void {
  const ledger = ledgers.get(rootIdentity(root))
  if (!ledger) return
  if (ledger.files.size >= MAX_TRACKED_FILES || ledger.dirs.size >= MAX_TRACKED_DIRS) {
    nextLedgerEpoch = Math.max(nextLedgerEpoch, ledger.epoch) + 1
    ledger.epoch = nextLedgerEpoch
    ledger.files.clear()
    ledger.dirs.clear()
  }
  const key = ledgerKey(relPath)
  const order = ++ledger.counter
  ledger.files.set(key, order)
  const slash = key.lastIndexOf('/')
  ledger.dirs.set(slash < 0 ? '' : key.slice(0, slash), order)
}

/** 释放临时草稿或已删除工作区的写入登记；推进 epoch 使仍持有引用的读取方一并失效。 */
export function closeLedger(root: string, options?: { prefix?: boolean }): void {
  const target = rootIdentity(root)
  const prefix = target + sep
  for (const [key, ledger] of [...ledgers]) {
    if (key === target || (options?.prefix && key.startsWith(prefix))) {
      nextLedgerEpoch = Math.max(nextLedgerEpoch, ledger.epoch) + 1
      ledger.epoch = nextLedgerEpoch
      ledger.files.clear()
      ledger.dirs.clear()
      ledgers.delete(key)
    }
  }
}

/** 给定序号之后，这个文件是否又被本进程写过。 */
export function writtenSince(ledger: WriteLedger, relPath: string, revision: number): boolean {
  return (ledger.files.get(ledgerKey(relPath)) ?? 0) > revision
}

/** 给定序号之后，这个目录的直接子文件是否又被本进程写过。 */
export function dirWrittenSince(ledger: WriteLedger, relDir: string, revision: number): boolean {
  return (ledger.dirs.get(ledgerKey(relDir)) ?? 0) > revision
}
