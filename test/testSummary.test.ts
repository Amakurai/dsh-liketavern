/** CI 诊断摘要的行为边界：真实报告格式、慢用例排序、收集失败、坏数据与 CLI 输出。 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { estimateTestFileSeconds, partitionTestShard, sortShardFiles } from '../scripts/shard-tests.mjs'
import { summarizeTests } from '../scripts/summarize-tests.mjs'

function report() {
  const root = join(tmpdir(), 'summary-factory')
  return { root, value: { success: false, numPassedTests: 1, numFailedTests: 1, numPendingTests: 1, numTotalTests: 3,
    testResults: [
      { name: join(root, 'test/fast.test.ts'), status: 'passed', startTime: 100, endTime: 300,
        assertionResults: [{ status: 'passed', fullName: '正常用例', duration: 80 }, { status: 'pending', fullName: '跳过用例' }] },
      { name: join(root, 'test/slow.test.ts'), status: 'failed', startTime: 500, endTime: 16_500,
        assertionResults: [{ status: 'failed', fullName: '多次写入与回滚', duration: 15_000 }] },
      { name: join(root, 'test/import.test.ts'), status: 'failed', startTime: 100, endTime: 100, assertionResults: [] },
    ] } }
}

it('保留计数、失败用例与收集错误，按真实耗时排序且不输出机器绝对路径', () => {
  const fixture = report()
  const text = summarizeTests(fixture.value, { root: fixture.root, label: 'Windows shard 1/2' })
  expect(text).toContain('Windows shard 1/2')
  expect(text).toContain('1 passed · 1 failed · 1 skipped · 3 total · 3 files')
  expect(text).toContain('`多次写入与回滚` (15.00s)')
  expect(text).toContain('`test/import.test.ts`')
  expect(text).not.toContain(fixture.root)
  const slowFiles = text.split('Slowest files:')[1]!.split('Slowest tests:')[0]!
  expect(slowFiles.indexOf('slow.test.ts')).toBeLessThan(slowFiles.indexOf('fast.test.ts'))
})

it('成功报告和无 duration 的跳过项正常展示，坏报告明确失败', () => {
  const fixture = report()
  fixture.value.success = true
  expect(summarizeTests(fixture.value)).toContain(': passed')
  for (const invalid of [null, {}, { ...fixture.value, numPassedTests: -1 }, { ...fixture.value, testResults: [{}] }]) {
    expect(() => summarizeTests(invalid)).toThrow('格式无效')
  }
})

it('实际 CLI 读取 JSON 并追加 GitHub 摘要；报告缺失不伪造通过', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-test-summary-'))
  try {
    const input = join(root, 'report.json'), summary = join(root, 'summary.md')
    await writeFile(input, JSON.stringify(report().value))
    await writeFile(summary, '既有摘要\n')
    const script = fileURLToPath(new URL('../scripts/summarize-tests.mjs', import.meta.url))
    const options = { encoding: 'utf8' as const, windowsHide: true, env: { ...process.env, GITHUB_STEP_SUMMARY: summary, TEST_LABEL: 'factory shard' } }
    const stdout = execFileSync(process.execPath, [script, input], options)
    expect(stdout).toContain('factory shard')
    expect(await readFile(summary, 'utf8')).toBe(`既有摘要\n${stdout}`)
    expect(() => execFileSync(process.execPath, [script, join(root, 'missing.json')], { ...options, stdio: 'pipe' })).toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('实际 Vitest CLI 在本地和 Actions 两种 reporter 配置下均能启动并枚举测试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-vitest-config-'))
  try {
    for (const mode of ['false', 'true']) {
      const output = join(root, `${mode}.json`)
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
        'list', '--filesOnly', `--json=${output}`], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', windowsHide: true, timeout: 10_000,
        env: { ...process.env, CI: 'true', GITHUB_ACTIONS: mode },
      })
      expect(result.status, result.stderr || result.error?.message).toBe(0)
      const files = JSON.parse(await readFile(output, 'utf8')) as Array<{ file: string }>
      expect(files.some(row => row.file.endsWith('/test/toolWriteReceipt.test.ts'))).toBe(true)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('LPT 分片在任意片数下保持完整不重不漏，并将重型套件均匀分散到不同分片', () => {
  const sample = [
    'test/templateCheckpointUpgrade.test.ts',
    'test/template.test.ts',
    'test/walCrashMatrix.test.ts',
    'test/templateStorageScale.test.ts',
    'test/templateCheckpoint.test.ts',
    'test/transactionRecovery.test.ts',
    'test/brandNewFutureSuite.test.ts',
    'test/brandNewUiSuite.test.tsx',
    'test/brandNewTemplateSuite.test.ts',
    'test/tokenize.test.ts',
    'test/i18n.test.ts',
    'test/bm25.test.ts',
  ].map(relativePath => ({ item: relativePath, relativePath }))

  for (const platform of ['win32', 'linux'] as const) {
    for (const count of [1, 2, 3, 4, 6]) {
      const shards = Array.from({ length: count }, (_, idx) =>
        partitionTestShard(sample, { index: idx + 1, count, platform }))
      const flattened = shards.flat()
      expect(new Set(flattened).size).toBe(sample.length)
      expect([...flattened].sort()).toEqual(sample.map(entry => entry.item).sort())
      // 输入乱序时同一平台各 runner 仍计算出完全一致的分片结果。
      const reversed = [...sample].reverse()
      expect(partitionTestShard(reversed, { index: count, count, platform })).toEqual(shards[count - 1])
    }
    const fourShards = Array.from({ length: 4 }, (_, idx) =>
      partitionTestShard(sample, { index: idx + 1, count: 4, platform }))
    const shardTotals = fourShards.map(files =>
      files.reduce((sum, file) => sum + estimateTestFileSeconds(file, platform), 0))
    expect(Math.max(...shardTotals) - Math.min(...shardTotals)).toBeLessThan(15)
    const sorted = sortShardFiles(sample, { platform })
    expect(estimateTestFileSeconds(sorted[0]!, platform)).toBeGreaterThan(estimateTestFileSeconds(sorted.at(-1)!, platform))
  }
  expect(() => partitionTestShard(sample, { index: 0, count: 4 })).toThrow('无效的分片序号')
  expect(() => partitionTestShard(sample, { index: 5, count: 4 })).toThrow('无效的分片序号')
  expect(() => partitionTestShard(sample, { index: 1, count: 0 })).toThrow('无效的分片总数')
})
