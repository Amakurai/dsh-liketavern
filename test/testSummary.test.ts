/** CI 诊断摘要的行为边界：真实报告格式、慢用例排序、收集失败、坏数据与 CLI 输出。 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
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
