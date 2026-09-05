/** 隔离运行时按墙钟限时；限制测试文件并发，避免大量测试沙箱争抢 CPU 产生假超时，不放宽产品限额。 */
import { availableParallelism } from 'node:os'
import { defineConfig } from 'vitest/config'

export default defineConfig({test:{maxWorkers:Math.min(4,availableParallelism())}})
