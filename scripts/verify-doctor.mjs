/**
 * 诊断命令交付冒烟：运行实际 lib 入口，覆盖直接执行、安装链接和无副作用导入。
 * 只检查手写临时空目录，不读取用户 DSH_HOME；与源码单测共同保护 CLI 交付契约。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const entry = join(projectRoot, 'lib', 'doctor.js')
const manifest = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const scratch = await mkdtemp(join(tmpdir(), 'tavern-doctor-cli-'))
const missingHome = join(scratch, 'uninitialized-home')

function run(args) {
  return execFileSync(process.execPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, DSH_HOME: missingHome },
  })
}

try {
  let linkedEntry
  if (process.platform === 'win32') {
    // Windows junction 不要求文件符号链接权限，仍覆盖 argv 入口与 ESM realpath 不同。
    const installation = join(scratch, 'installed-package')
    await symlink(projectRoot, installation, 'junction')
    linkedEntry = join(installation, 'lib', 'doctor.js')
  } else {
    linkedEntry = join(scratch, 'dsh-tavern-doctor')
    await symlink(entry, linkedEntry, 'file')
  }
  const before = await readdir(scratch)
  for (const cli of [entry, linkedEntry]) {
    assert.match(run([cli, '--help']), /^Usage: dsh-tavern-doctor /)
    assert.equal(run([cli, '--version']).trim(), manifest.version)
    const output = run([cli, '--json', '--home', missingHome])
    const report = JSON.parse(output)
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.ok, true)
    assert.equal(report.storage.homeStatus, 'missing')
    assert.equal(report.storage.dataRootStatus, 'missing')
    assert.equal(output.includes(missingHome), false)
    assert.equal(output.includes(JSON.stringify(missingHome).slice(1, -1)), false)
  }
  const importSource = `await import(${JSON.stringify(pathToFileURL(entry).href)})`
  assert.equal(run(['--input-type=module', '--eval', importSource]), '')
  assert.deepEqual(await readdir(scratch), before, '诊断不能创建缺失的数据目录')
  console.log('doctor CLI 冒烟通过：直接入口、安装链接、JSON 隐私和只读导入')
} finally {
  // 清理范围固定为 mkdtemp 刚创建的目录；链接仅解除，不遍历安装目标。
  assert.equal(dirname(scratch), tmpdir())
  await rm(scratch, { recursive: true, force: true })
}
