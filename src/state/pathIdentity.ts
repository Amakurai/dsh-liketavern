/**
 * 路径与资产 ID 的大小写身份。
 *
 * Windows 文件系统默认不区分大小写，同一文件可用不同大小写访问；其它平台按原样比较。
 * 工作区锁、写入登记、模板缓存和资产键都必须用同一规则折叠，否则同一目录会拿到
 * 不同的锁或缓存，破坏「完整读改写共用工作区锁」的约束。
 */
import { resolve } from 'node:path'

/** Windows 上转小写，其它平台原样返回。 */
export function caseIdentity(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/** 根目录身份：先 resolve 成绝对路径，再按平台折叠大小写。 */
export function rootIdentity(root: string): string {
  return caseIdentity(resolve(root))
}
