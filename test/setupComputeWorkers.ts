/** 每个测试文件结束后释放其隔离模块拥有的空闲 worker，避免 Vitest 模块隔离把生产缓存重复保留。 */
import { afterAll } from 'vitest'

afterAll(async () => {
  // 延后加载，让测试文件自身的 worker 模拟器先注册，避免全局 setup 抢先固定真实模块。
  const { disposeIdleComputeWorkers } = await import('../src/node/isolated.js')
  await disposeIdleComputeWorkers()
})
