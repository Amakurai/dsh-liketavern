#!/usr/bin/env node
/**
 * 宿主版本对齐检查。
 *
 * 兼容策略（v0.5.9 之后）：
 * - 公开的宿主门槛完全放开：`engines.dsh` 与所有 `@deepseek-ai/*` peer 必须是 `*`。
 *   宿主加载器优先读 `engines.dsh`，其余 peer 只服务旧版加载器与包管理器；
 *   `*` 让过去与未来任意宿主版本都被接受，自动升级不会再把插件判为不兼容。
 * - 开发依赖与 overrides 仍固定同一个精确基线：测试与构建必须针对经验证的宿主，
 *   以免“能安装但没测过”的版本悄悄进入发布物。
 *
 *   node scripts/verify-host-alignment.mjs
 *   node scripts/verify-host-alignment.mjs --package pkg.json --lock package-lock.json
 *
 * 退出码：0 全部对齐；1 有不一致（stderr 列出每一处）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validRange } from 'semver'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 宿主发布包统一前缀；cordis / schemastery / cordis-plugin-* 另有自己的版本线。 */
const HOST_PREFIX = '@deepseek-ai/dsh'
/** 公开门槛的放开值：宿主加载器与包管理器都接受任意版本。 */
const OPEN_RANGE = '*'
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * 检查一份 package.json 与锁文件的宿主版本策略。
 * @param pkg - 插件 package.json 内容。
 * @param lock - 对应 package-lock.json 内容。
 * @returns baseline（唯一的开发基线）、错误清单与开发基线包数量。
 */
export function inspectHostAlignment(pkg, lock) {
  const errors = []
  const versions = new Map()
  /** 开发依赖与 overrides 固定基线；公开门槛另行检查是否为 `*`。 */
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

  // 公开门槛：engines.dsh 由宿主加载器独断，必须完全放开。
  const engine = pkg.engines?.dsh
  if (engine !== OPEN_RANGE) {
    errors.push(engine === undefined
      ? `engines.dsh 缺失；应显式声明 ${OPEN_RANGE} 以免宿主升级后被判不兼容`
      : `engines.dsh 为 ${String(engine)}，应放开为 ${OPEN_RANGE}`)
  }

  // 旧版加载器与包管理器读 peer：同样必须放开，否则换一个 host 版本就再次被拒或被 pnpm 报警。
  const peers = Object.entries(pkg.peerDependencies ?? {})
  if (pkg.peerDependencies?.['@deepseek-ai/dsh'] === undefined) errors.push('peerDependencies 缺少 @deepseek-ai/dsh')
  for (const [name, spec] of peers) {
    if (!name.startsWith('@deepseek-ai/')) continue
    if (spec !== OPEN_RANGE) errors.push(`${name} 的 peer 为 ${String(spec)}，应放开为 ${OPEN_RANGE}`)
  }
  for (const name of ['@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
    const spec = pkg.peerDependencies?.[name]
    if (spec !== undefined && spec !== OPEN_RANGE) errors.push(`${name} 的 peer 为 ${String(spec)}，应放开为 ${OPEN_RANGE}`)
  }
  if (typeof engine === 'string' && validRange(engine) === null) errors.push(`engines.dsh 不是有效范围：${engine}`)

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
    if (lock.packages?.['']?.engines?.dsh !== engine) {
      errors.push(`锁文件的 engines.dsh 与清单不一致：${String(lock.packages?.['']?.engines?.dsh)} / ${String(engine)}`)
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
  console.log(`宿主版本对齐：公开门槛 *（任意版本），开发基线 ${result.baseline}（${result.packages} 个包，锁文件一致）`)
}
