/**
 * 工作区事务文件面（WorkspaceFs）。
 *
 * 插件对角色工作区的一切写入都必须经过本类。仅当实例携带会话楼层时才向 WAL
 * 记录快照，供 roll/回退逆序回放。导入角色卡、设置面板直接编辑等非会话期写入
 * floor 为 null：照常落盘、不记 WAL——这类写入不该随对话回滚。
 *
 * 楼层隔离模型（问题1修复）：每卡一个共享句柄（TavernState.workspace），其 floor
 * 恒为 null；会话楼层写入一律走 `withFloor(floor)` 派生的独立实例——同一张卡的
 * 并发会话各有各的楼层实例，互不覆盖，回滚边界按 `sessionId#tN` 各自回放。
 * host 在 turn/start 直接 `wal.beginFloor(floor)`，turn/end 按 openFloors 记录的
 * entry 提交，不再触碰共享句柄的 floor。
 */
import { Buffer } from 'node:buffer'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, normalize, resolve, sep } from 'node:path'
import type { Wal } from './wal.js'
import { atomicWrite } from './atomicWrite.js'
import { withWorkspaceLock } from './workspaceLock.js'

/** 历史占位：旧版曾把非会话写入记入名为 non-floor 的 WAL 单元。现已不再使用。 */
export const NON_FLOOR = 'non-floor'

/** 严格 UTF-8 解码器：非法字节序列抛错，用于区分文本与二进制快照口径。 */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * 字节 → WAL 快照：文本按 UTF-8 保存，二进制按 base64 保存并显式记录编码。
 */
function snapshotOf(bytes: Uint8Array): { value: string; encoding?: 'utf8' | 'base64' } {
  try {
    return { value: STRICT_UTF8.decode(bytes), encoding: 'utf8' }
  } catch {
    return { value: Buffer.from(bytes).toString('base64'), encoding: 'base64' }
  }
}

export class WorkspaceFs {
  /** 本实例的楼层；null 表示非会话期写入（不走 WAL）。构造后只能经 withFloor 派生改出。 */
  private floor: string | null = null

  constructor(
    readonly root: string,
    private readonly wal: Wal | null,
  ) { this.root = resolve(root) }

  /**
   * 遗留兼容：直接改本实例的 floor。host 路径已改用 withFloor 派生实例 +
   * wal.beginFloor/commitFloor（见文件头「楼层隔离模型」）；保留仅为既有测试与
   * 旧调用点不 break，新代码不要再用——共享句柄上的可变 floor 会让同卡并发会话
   * 互相覆盖楼层上下文。
   */
  setFloor(floor: string | null): void {
    this.floor = floor
  }

  get currentFloor(): string | null {
    return this.floor
  }

  /**
   * 派生一个共享 root 与 wal、floor 独立的新实例。会话楼层（含读路径口径统一）
   * 用它在楼层内读写：快照记进本实例的 floor，不影响共享句柄与其它会话的实例。
   */
  withFloor(floor: string | null): WorkspaceFs {
    const scoped = new WorkspaceFs(this.root, this.wal)
    scoped.floor = floor
    return scoped
  }

  private abs(relPath: string): string {
    // 段级消毒：任何 '..' 段一律拒绝。只看根目录前缀挡不住
    // 'personas/../regex/rules.json' 这类「不出根但跨子树」的越权——人设/世界书/预设 id
    // 经 RPC 直达存储层时可能带 '..'，把包容性做成 fs 的性质，而不是指望每个调用方各自消毒。
    if (relPath.split(/[/\\]/).some((seg) => seg === '..')) {
      throw new Error(`工作区路径越界: ${relPath}`)
    }
    const abs = normalize(join(this.root, relPath))
    if (abs !== this.root && !abs.startsWith(this.root + sep)) {
      throw new Error(`工作区路径越界: ${relPath}`)
    }
    return abs
  }

  async readText(relPath: string): Promise<string | null> {
    try {
      return await readFile(this.abs(relPath), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** 判断路径是否存在（文件或目录）。 */
  async exists(relPath: string): Promise<boolean> {
    try {
      await stat(this.abs(relPath))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  /**
   * 单文件元信息（mtimeMs/size）；不存在返回 null。
   * 用途是廉价的「内容是否变过」指纹：一次 stat 不读数据，远便宜于全文读 + 解析，
   * 且能捕获绕开本类的落盘（WAL 回滚会直接写回文件），比进程内修订号更可靠。
   */
  async stat(relPath: string): Promise<{ mtimeMs: number; size: number } | null> {
    try {
      const info = await stat(this.abs(relPath))
      return { mtimeMs: info.mtimeMs, size: info.size }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** 确保目录存在（递归创建）。目录创建幂等且无内容副作用，不纳入 WAL。 */
  async ensureDir(relPath = ''): Promise<void> {
    await mkdir(this.abs(relPath), { recursive: true })
  }

  /** 读取二进制内容；不存在返回 null。 */
  async readBytes(relPath: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.abs(relPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** 事务写入：每次修改先持久化 before/after，再原子替换正文；与回退共享工作区锁。 */
  async writeText(relPath: string, content: string): Promise<void> {
    await withWorkspaceLock(this.root, async () => {
      const abs = this.abs(relPath)
      if (this.wal && this.floor) {
        const bytes = await this.readBytes(relPath)
        const before = bytes === null ? null : snapshotOf(bytes)
        await this.wal.recordChange(this.floor, relPath, before?.value ?? null, content, before?.encoding ?? 'utf8', 'utf8')
      }
      await atomicWrite(abs, content)
    })
  }

  /**
   * 事务写入二进制（如 card.png 头像）：语义同 writeText，
   * 已存在文件的 before 快照以 base64 + 显式编码记录，回滚时对称解码。
   */
  async writeBytes(relPath: string, bytes: Uint8Array): Promise<void> {
    await withWorkspaceLock(this.root, async () => {
      const abs = this.abs(relPath)
      if (this.wal && this.floor) {
        const before = await this.readBytes(relPath)
        await this.wal.recordChange(this.floor, relPath,
          before === null ? null : Buffer.from(before).toString('base64'),
          Buffer.from(bytes).toString('base64'), 'base64', 'base64')
      }
      await atomicWrite(abs, bytes)
    })
  }

  /**
   * 事务删除（有当前楼层时同样记录快照）。
   * 快照口径必须与 writeBytes 对称：二进制内容（严格 UTF-8 解码失败）记 base64 + 编码字段，
   * 否则回滚写回的是有损转码后的字节。无楼层时只需判存在性，不读全文。
   */
  async delete(relPath: string): Promise<void> {
    await withWorkspaceLock(this.root, async () => {
      const abs = this.abs(relPath)
      if (this.wal && this.floor) {
        const bytes = await this.readBytes(relPath)
        if (bytes === null) return
        const before = snapshotOf(bytes)
        await this.wal.recordChange(this.floor, relPath, before.value, null, before.encoding ?? 'utf8', 'utf8')
      }
      await rm(abs, { force: true })
    })
  }

  /**
   * 列出 prefix 子目录下的文件（相对路径，正斜杠）。
   * 默认递归；`recursive: false` 只列本层文件（跳过子目录，不进去走）——
   * 记忆库那样「本层是热路径、子目录（archive/）只增不查」的场景必须用非递归，
   * 否则每次检索都要把归档整棵走完再丢掉，成本随归档量单调增长。
   * `skipDir` 在递归遍历遇到目录时回调（相对路径，正斜杠），返回 true 则整棵跳过——
   * state/wal、memory/archive 这类只增不查的目录应在遍历时直接排除，
   * 而不是全棵走完再由调用方过滤。
   */
  async list(prefix = '', options?: { recursive?: boolean; skipDir?: (relDir: string) => boolean }): Promise<string[]> {
    const recursive = options?.recursive !== false
    const skipDir = options?.skipDir
    const base = this.abs(prefix)
    const out: string[] = []
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (recursive && !skipDir?.(childRel)) await walk(join(dir, e.name), childRel)
        } else out.push(childRel)
      }
    }
    await walk(base, '')
    return out.sort()
  }

  /**
   * 列出 prefix 本层文件及其 mtime/size（非递归）。
   * 用途是廉价的「内容是否变过」指纹：N 次 stat 不读数据，远便宜于 N 次全文读 + 解析，
   * 且能捕获绕开本类的落盘（WAL 回滚会直接写回文件），故比进程内修订号更可靠。
   */
  async listStats(prefix = ''): Promise<Array<{ name: string; mtimeMs: number; size: number }>> {
    const names = await this.list(prefix, { recursive: false })
    const base = prefix ? `${prefix}/` : ''
    const stats = await Promise.all(
      names.map(async (name) => {
        try {
          const info = await stat(this.abs(`${base}${name}`))
          return { name, mtimeMs: info.mtimeMs, size: info.size }
        } catch (error) {
          // list 与 stat 之间文件被并发删掉：按不存在处理（与 readText 返回 null 的容错口径一致）。
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      }),
    )
    return stats.filter((s) => s !== null)
  }

  /**
   * 遗留兼容：开始一个楼层事务并把本实例的 floor 指过去（WAL 存在时）。
   * host 路径已改为 `wal.beginFloor(floor)` + `withFloor(floor)` 派生实例；保留仅为既有测试。
   */
  async beginFloor(floor: string): Promise<void> {
    if (this.wal) await this.wal.beginFloor(floor)
    this.setFloor(floor)
  }

  /** 遗留兼容：提交本实例当前楼层并清除楼层上下文。host 路径已改为 `wal.commitFloor(floor)`。 */
  async commitFloor(): Promise<void> {
    const floor = this.floor
    if (this.wal && floor && floor !== NON_FLOOR) await this.wal.commitFloor(floor)
    this.setFloor(null)
  }
}
