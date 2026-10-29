/** 将 Vitest JSON 结果转成 CI 摘要：保留失败位置与慢用例，便于区分业务错误和 runner 抖动。 */
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const code = value => `\`${String(value).replace(/[`\r\n]/g, ' ')}\``
const seconds = value => `${(Math.max(0, Number.isFinite(value) ? value : 0) / 1000).toFixed(2)}s`

export function summarizeTests(report, { root = process.cwd(), label = 'Tests' } = {}) {
  if (!report || typeof report.success !== 'boolean' || !Array.isArray(report.testResults)
    || ['numPassedTests', 'numFailedTests', 'numPendingTests', 'numTotalTests'].some(key => !Number.isSafeInteger(report[key]) || report[key] < 0)) {
    throw new Error('Vitest 报告格式无效，无法生成测试摘要')
  }
  const files = report.testResults.map(file => {
    if (!file || typeof file.name !== 'string' || !Array.isArray(file.assertionResults)) throw new Error('Vitest 文件结果格式无效')
    return { ...file, path: relative(root, file.name).replace(/\\/g, '/'), duration: file.endTime - file.startTime }
  })
  const tests = files.flatMap(file => file.assertionResults.map(test => ({ ...test, path: file.path })))
  const lines = [
    `### ${code(label)}: ${report.success ? 'passed' : 'failed'}`,
    '',
    `${report.numPassedTests} passed · ${report.numFailedTests} failed · ${report.numPendingTests} skipped · ${report.numTotalTests} total · ${files.length} files`,
    '',
  ]
  const failed = tests.filter(test => test.status === 'failed')
  if (failed.length) {
    lines.push('Failed tests:', '', ...failed.slice(0, 20).map(test => `- ${code(test.path)} — ${code(test.fullName)} (${seconds(test.duration)})`), '')
    if (failed.length > 20) lines.push(`另有 ${failed.length - 20} 项失败，详见 JSON/JUnit 附件。`, '')
  }
  // 文件级导入/钩子错误可能没有 assertionResults，不能只列失败断言。
  const failedFiles = files.filter(file => file.status === 'failed')
  if (failedFiles.length) lines.push('Failed files (including import/hooks):', '', ...failedFiles.slice(0, 20).map(file => `- ${code(file.path)}`), '')
  lines.push('Slowest files:', '', ...[...files].sort((a, b) => b.duration - a.duration).slice(0, 10)
    .map(file => `- ${code(file.path)} — ${seconds(file.duration)}`), '')
  lines.push('Slowest tests:', '', ...tests.filter(test => Number.isFinite(test.duration)).sort((a, b) => b.duration - a.duration).slice(0, 10)
    .map(test => `- ${code(test.path)} — ${code(test.fullName)} (${seconds(test.duration)})`), '')
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = JSON.parse(readFileSync(process.argv[2] ?? '.vitest/results.json', 'utf8'))
  const summary = summarizeTests(report, { label: process.env.TEST_LABEL ?? 'Tests' })
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, 'utf8')
  console.log(summary)
}
