#!/usr/bin/env node
/**
 * 锁文件依赖安全审计守卫：
 * 1. 生产运行依赖（`--omit=dev`）实行零容忍，不允许任何豁免。
 * 2. 完整锁文件审计默认拒绝全部漏洞；仅对已核实不影响运行包、且上游在 npm 尚无任何修复版本的
 *    开发链传递依赖公告做精确登记，并在公告受影响范围变化（上游发布补丁）时自动失效报错。
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 临时受控的开发依赖链未修复公告表：
 * 当前为空（生产运行依赖与开发锁文件均保持 0 项已知漏洞、0 项豁免）。
 * 历史临时条目 GHSA-fc5q-39xc-vjpf（picomatch <=4.0.7）已于 2026-11-18 被 GitHub 官方撤回并清理。
 */
export const TEMPORARY_UNPATCHED_DEV_ADVISORIES = Object.freeze({})

const GHSA_URL_RE = /\/advisories\/(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})(?:$|[/?#])/i

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function extractGhsaId(advisory) {
  if (typeof advisory.url !== 'string') return null
  const match = GHSA_URL_RE.exec(advisory.url)
  return match ? match[1] : null
}

/**
 * 纯函数校验生产依赖与全量锁文件的 `npm audit --json` 报告。
 * @param {unknown} prodReport - `npm audit --omit=dev --package-lock-only --json` 解析结果
 * @param {unknown} fullReport - `npm audit --package-lock-only --json` 解析结果
 * @param {Record<string, { packageName: string; unpatchedRange: string }>} allowlist - 受控开发链未修复公告表
 */
export function inspectAuditReports(
  prodReport,
  fullReport,
  allowlist = TEMPORARY_UNPATCHED_DEV_ADVISORIES,
) {
  const errors = []
  const notices = new Set()

  if (!isPlainObject(prodReport) || prodReport.error !== undefined || !isPlainObject(prodReport.vulnerabilities)) {
    errors.push('生产依赖 npm audit 报告格式无效或包含错误响应')
    return { ok: false, errors, notices: [] }
  }
  if (!isPlainObject(fullReport) || fullReport.error !== undefined || !isPlainObject(fullReport.vulnerabilities)) {
    errors.push('全量锁文件 npm audit 报告格式无效或包含错误响应')
    return { ok: false, errors, notices: [] }
  }

  const prodNames = Object.keys(prodReport.vulnerabilities)
  const prodTotal = Number(prodReport.metadata?.vulnerabilities?.total ?? prodNames.length)
  if (prodNames.length > 0 || !Number.isFinite(prodTotal) || prodTotal > 0) {
    errors.push(`生产运行依赖存在已知漏洞（--omit=dev 零容忍）：${prodNames.join(', ') || String(prodTotal)}`)
    return { ok: false, errors, notices: [] }
  }

  const entries = Object.entries(fullReport.vulnerabilities)
  const fullTotal = Number(fullReport.metadata?.vulnerabilities?.total ?? entries.length)
  if (!Number.isFinite(fullTotal) || (entries.length === 0 && fullTotal > 0)) {
    errors.push('全量锁文件 npm audit 报告漏洞计数异常但缺少漏洞明细')
    return { ok: false, errors, notices: [] }
  }
  if (entries.length === 0) {
    return { ok: true, errors: [], notices: [] }
  }

  const acceptedAdvisoryObjects = new Set()
  const directRejectedPackages = new Set()

  for (const [pkgName, vuln] of entries) {
    if (!isPlainObject(vuln) || !Array.isArray(vuln.via) || vuln.via.length === 0) {
      errors.push(`漏洞条目结构无效：${pkgName}`)
      directRejectedPackages.add(pkgName)
      continue
    }
    for (const item of vuln.via) {
      if (typeof item === 'string') continue
      if (!isPlainObject(item)) {
        errors.push(`漏洞来源项格式无效：${pkgName}`)
        directRejectedPackages.add(pkgName)
        continue
      }
      const ghsa = extractGhsaId(item)
      const rule = ghsa && Object.hasOwn(allowlist, ghsa) ? allowlist[ghsa] : undefined
      const advisoryPkg = typeof item.name === 'string' ? item.name : pkgName
      if (!rule || advisoryPkg !== rule.packageName || pkgName !== rule.packageName) {
        errors.push(
          `未豁免漏洞：${advisoryPkg} (${ghsa ?? String(item.source ?? 'unknown')})${item.title ? ` — ${String(item.title)}` : ''}`,
        )
        directRejectedPackages.add(pkgName)
        continue
      }
      const range = String(item.range ?? '').trim()
      if (range !== rule.unpatchedRange) {
        errors.push(
          `${ghsa} (${rule.packageName}) 受影响范围已变更为 "${range}"（原为 "${rule.unpatchedRange}"），上游可能已发布修复版本，请升级锁文件并移除临时豁免`,
        )
        directRejectedPackages.add(pkgName)
        continue
      }
      if (vuln.fixAvailable === true || (isPlainObject(vuln.fixAvailable) && vuln.fixAvailable.name === rule.packageName)) {
        const fixVer = isPlainObject(vuln.fixAvailable) ? String(vuln.fixAvailable.version ?? '') : 'semver-compatible'
        errors.push(
          `${ghsa} (${rule.packageName}) 已报告直接修复版本 ${fixVer}，请升级锁文件并移除临时豁免`,
        )
        directRejectedPackages.add(pkgName)
        continue
      }
      acceptedAdvisoryObjects.add(item)
      notices.add(`${ghsa}（${rule.packageName} ${range}，仅开发依赖链，上游尚无修复版本；见 docs/DEPENDENCY_SECURITY.md）`)
    }
  }

  const acceptedPackages = new Set()
  let progressed = true
  while (progressed) {
    progressed = false
    for (const [pkgName, vuln] of entries) {
      if (acceptedPackages.has(pkgName) || directRejectedPackages.has(pkgName)) continue
      if (!isPlainObject(vuln) || !Array.isArray(vuln.via) || vuln.via.length === 0) continue
      const allCovered = vuln.via.every(
        item => (typeof item === 'string' && acceptedPackages.has(item)) || acceptedAdvisoryObjects.has(item),
      )
      if (allCovered) {
        acceptedPackages.add(pkgName)
        progressed = true
      }
    }
  }

  for (const [pkgName] of entries) {
    if (!acceptedPackages.has(pkgName) && !directRejectedPackages.has(pkgName)) {
      errors.push(`存在未归因于受控公告的依赖告警：${pkgName}`)
    }
  }

  return { ok: errors.length === 0, errors, notices: [...notices] }
}

function runNpmAuditJson(extraArgs) {
  const npmArgs = ['audit', ...extraArgs, '--package-lock-only', '--json']
  const npmExecPath = process.env.npm_execpath
  const command = npmExecPath
    ? process.execPath
    : process.platform === 'win32'
      ? process.env.ComSpec || 'cmd.exe'
      : 'npm'
  const args = npmExecPath
    ? [npmExecPath, ...npmArgs]
    : process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm.cmd', ...npmArgs]
      : npmArgs

  let stdout = ''
  try {
    stdout = execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    })
  } catch (error) {
    if (error && typeof error === 'object' && typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) {
      stdout = error.stdout
    } else {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`执行 npm ${npmArgs.join(' ')} 失败：${detail}`)
    }
  }

  try {
    return JSON.parse(stdout)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`解析 npm ${npmArgs.join(' ')} JSON 输出失败：${detail}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const prodReport = runNpmAuditJson(['--omit=dev'])
  const fullReport = runNpmAuditJson([])
  const result = inspectAuditReports(prodReport, fullReport)
  if (!result.ok) {
    console.error(`依赖安全审计未通过（${result.errors.length} 处）：`)
    for (const error of result.errors) console.error(`- ${error}`)
    process.exit(1)
  }
  if (result.notices.length === 0) {
    console.log('依赖安全审计通过：生产依赖与开发锁文件均为 0 项已知漏洞')
  } else {
    console.log('依赖安全审计通过：生产运行依赖 0 项已知漏洞；开发锁文件含已登记的无补丁上游公告：')
    for (const notice of result.notices) console.log(`- ${notice}`)
  }
}
