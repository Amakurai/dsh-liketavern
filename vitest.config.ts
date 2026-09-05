/** 隔离运行时按墙钟限时；限制测试文件并发，避免大量测试沙箱争抢 CPU 产生假超时，不放宽产品限额。 */
import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'

export default defineConfig({test:{
  // CI 共享机器串行运行文件，避免多个 QuickJS 实例争抢 CPU 耗尽产品的墙钟预算。
  maxWorkers:process.env.CI ? 1 : Math.min(4,availableParallelism()),
  // 集成用例会依次启动多个 worker；整条用例的时限独立于每次隔离计算的产品限额。
  testTimeout:15_000,
}})
