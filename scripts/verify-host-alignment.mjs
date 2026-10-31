#!/usr/bin/env node
/**
 * 宿主版本对齐检查：运行 peer 共用兼容范围，开发依赖和锁文件保持精确基线。
 *
 *   node scripts/verify-host-alignment.mjs
 *   node scripts/verify-host-alignment.mjs --package pkg.json --lock package-lock.json
 *
 * 退出码：0 全部对齐；1 有不一致（stderr 列出每一处）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { satisfies, subset, validRange } from 'semver'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 宿主发布包统一前缀；cordis / schemastery / cordis-plugin-* 另有自己的版本线，不参与对齐。 */
const HOST_PREFIX = '@deepseek-ai/dsh'
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
// 旧版和新版均以真实安装冒烟确认；上限包含下一条小版本线，升级时仍须核对宿主接口。
const HOST_BOUND = '>=0.2.0-rc.1 <0.4.0-0'

/**
 * 检查一份 package.json 与锁文件的宿主版本对齐。
 * @param pkg - 插件 package.json 内容。
 * @param lock - 对应 package-lock.json 内容。
 * @returns baseline（唯一的宿主版本）、错误清单与锁内宿主包数量。
 */
export function inspectHostAlignment(pkg, lock) {
  const errors = []
  const versions = new Map()
  /** 开发依赖与 overrides 固定基线；公开 peer 另行检查范围。 */
  const collect = (label, table) => {
    for (const [name, spec] of Object.entries(table ?? {})) {
      if (!name.startsWith(HOST_PREFIX)) continue
      if (typeof spec !== 'string' || !EXACT_VERSION.test(spec)) {
        errors.push(`${label} 里的 ${name} 不是精确版本：${String(spec)}`)
        continue
      }
      const seen = versions.get(name)
      if (seen !== undefined && seen !== spec) errors.push(`${name} 在不同依赖表里版本不一致：${seen} / ${spec}`)
      versions.set(name, spec)
    }
  }
  collect('devDependencies', pkg.devDependencies)
  collect('overrides', pkg.overrides)

  const baseline = versions.get('@deepseek-ai/dsh')
  if (baseline === undefined) errors.push('devDependencies 缺少 @deepseek-ai/dsh')
  for (const [name, version] of versions) {
    if (baseline !== undefined && version !== baseline) errors.push(`${name} 为 ${version}，与宿主基线 ${baseline} 不一致`)
  }
  const peers = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => name.startsWith(HOST_PREFIX))
  const range = pkg.peerDependencies?.['@deepseek-ai/dsh']
  if (typeof range !== 'string' || validRange(range) === null) errors.push('peerDependencies 缺少有效的 @deepseek-ai/dsh 兼容范围')
  if (typeof range === 'string' && validRange(range) !== null) {
    if (!subset(range, HOST_BOUND, { includePrerelease: true })) errors.push(`宿主 peer 范围越界，应限制在 ${HOST_BOUND}`)
    const engine = pkg.engines?.dsh
    if (engine !== undefined && (typeof engine !== 'string' || validRange(engine) === null
      || !subset(engine, range, { includePrerelease: true }) || !subset(range, engine, { includePrerelease: true }))) {
      errors.push('engines.dsh 与宿主 peer 的兼容范围不一致')
    }
    if (engine !== undefined && lock && lock.packages?.['']?.engines?.dsh !== engine) errors.push('锁文件的 engines.dsh 与清单不一致')
  }
  for (const [name, spec] of peers) {
    if (spec !== range) errors.push(`${name} 的 peer 范围与 @deepseek-ai/dsh 不一致`)
    if (typeof spec !== 'string' || validRange(spec) === null || (baseline && !satisfies(baseline, spec))) errors.push(`${name} 的 peer 范围不包含宿主基线 ${baseline}`)
    if (!versions.has(name)) errors.push(`${name} 缺少精确开发基线`)
    if (lock && lock.packages?.['']?.peerDependencies?.[name] !== spec) errors.push(`锁文件的 ${name} peer 范围与清单不一致`)
  }

  // 宿主会投影同一份 Cordis / Schemastery；其发布版本线与 dsh 分开，按各自边界核对。
  for (const [name, bound] of [['@deepseek-ai/cordis', '>=4.0.4 <5.0.0-0'], ['@deepseek-ai/schemastery', '>=3.18.4 <4.0.0-0']]) {
    const spec = pkg.peerDependencies?.[name]
    if (spec === undefined) continue
    if (typeof spec !== 'string' || validRange(spec) === null || !subset(spec, bound, { includePrerelease: true })) {
      errors.push(`${name} 的 peer 范围无效或越界，应限制在 ${bound}`)
    } else if (pkg.devDependencies?.[name] && !satisfies(pkg.devDependencies[name], spec)) {
      errors.push(`${name} 的 peer 范围不包含开发基线`)
    }
    if (lock && lock.packages?.['']?.peerDependencies?.[name] !== spec) errors.push(`锁文件的 ${name} peer 范围与清单不一致`)
  }

  // allowScripts 只记录实际跑过安装脚本的版本；宿主升级后这里最容易留下旧版本。
  for (const entry of Object.keys(pkg.allowScripts ?? {})) {
    const match = /^(@deepseek-ai\/dsh[^@]*)@(.+)$/.exec(entry)
    if (match === null || baseline === undefined) continue
    if (match[2] !== baseline) errors.push(`allowScripts 仍记录 ${match[1]}@${match[2]}，应为 ${match[1]}@${baseline}`)
  }

  if (lock !== undefined) {
    if (lock.packages?.['']?.version !== pkg.version) {
      errors.push(`锁文件根版本 ${String(lock.packages?.['']?.version)} 与 package.json ${String(pkg.version)} 不一致`)
    }
    const installed = new Map()
    for (const [path, entry] of Object.entries(lock.packages ?? {})) {
      if (!path.startsWith('node_modules/')) continue
      const name = path.slice('node_modules/'.length)
      if (!name.startsWith(HOST_PREFIX) || name.includes('/node_modules/')) continue
      installed.set(name, entry.version)
      if (baseline !== undefined && entry.version !== baseline) errors.push(`锁文件 ${name} 为 ${String(entry.version)}，应为 ${baseline}`)
    }
    for (const name of versions.keys()) {
      if (!installed.has(name)) errors.push(`锁文件缺少 ${name}`)
    }
  }

  return { baseline, errors, packages: versions.size }
}

/** 读取命令行给出的包清单；默认使用仓库自身的 package.json 与锁文件。 */
function parseArgs(argv) {
  const options = { packagePath: join(root, 'package.json'), lockPath: join(root, 'package-lock.json') }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--package') options.packagePath = argv[++index] ?? fail('--package 需要参数')
    else if (arg === '--lock') options.lockPath = argv[++index] ?? fail('--lock 需要参数')
    else fail(`未知参数 ${arg}`)
  }
  return options
}

function fail(message) {
  console.error(`host alignment: ${message}`)
  process.exit(1)
}

const invokedDirectly = process.argv[1] !== undefined && /verify-host-alignment\.mjs$/.test(process.argv[1])
if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2))
  const pkg = JSON.parse(readFileSync(options.packagePath, 'utf8'))
  const lock = JSON.parse(readFileSync(options.lockPath, 'utf8'))
  const result = inspectHostAlignment(pkg, lock)
  if (result.errors.length > 0) {
    console.error(`宿主版本没有对齐（${result.errors.length} 处）：`)
    for (const error of result.errors) console.error(`- ${error}`)
    process.exit(1)
  }
  console.log(`宿主版本对齐：${result.baseline}（${result.packages} 个包，锁文件一致）`)
}
