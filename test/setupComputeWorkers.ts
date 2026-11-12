/** 每个测试文件结束后释放其实际加载的隔离模块拥有的空闲 worker，未加载隔离层的文件不额外解析或初始化 worker 池。 */
import { afterAll } from 'vitest'

const DISPOSERS_KEY = Symbol.for('dsh-liketavern.computeWorkerDisposers')
type DisposerRegistry = { [DISPOSERS_KEY]?: Set<() => Promise<void>> }

afterAll(async () => {
  const registry = globalThis as unknown as DisposerRegistry
  const disposers = registry[DISPOSERS_KEY]
  if (!disposers || disposers.size === 0) return
  const pending = [...disposers]
  disposers.clear()
  await Promise.all(pending.map(dispose => dispose()))
})
