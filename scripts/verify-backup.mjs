/** 编译交付备份命令冒烟：只使用临时手写数据，验证实际入口、安装链接、只读导入与完整恢复演练。 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const entry = join(root, 'lib/backup.js')
const scratch = await mkdtemp(join(tmpdir(), 'tavern-backup-cli-'))
const home = join(scratch, 'home'), backup = join(scratch, 'backup'), target = join(scratch, 'restored')
const env = { ...process.env, DSH_HOME: join(scratch, 'must-not-read-default') }
const options = { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024, env }
const run = args => execFileSync(process.execPath, args, options)
try {
  await mkdir(home)
  await writeFile(join(home, 'config.yml'), 'token: synthetic-private-token\n')
  await mkdir(join(home, 'history'))
  await writeFile(join(home, 'history/session.jsonl'), '{"text":"synthetic-story"}\n')
  let linked
  if (process.platform === 'win32') {
    const installation = join(scratch, 'installation'); await symlink(root, installation, 'junction')
    linked = join(installation, 'lib/backup.js')
  } else { linked = join(scratch, 'dsh-tavern-backup'); await symlink(entry, linked, 'file') }
  for (const cli of [entry, linked]) assert.match(run([cli, '--help']), /^Usage: dsh-tavern-backup /)
  assert.equal(run(['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(entry).href)})`]), '')
  const created = run([linked, 'create', '--home', home, '--backup', backup, '--offline', '--json'])
  assert.equal(JSON.parse(created).ok, true)
  assert.equal(JSON.parse(created).offlineVerified, false)
  for (const secret of [home, 'synthetic-private-token', 'synthetic-story']) assert.equal(created.includes(secret), false)
  const before = await readFile(join(backup, 'manifest.json'))
  assert.equal(JSON.parse(run([entry, 'verify', '--backup', backup, '--json'])).ok, true)
  assert.deepEqual(await readFile(join(backup, 'manifest.json')), before)
  assert.equal(JSON.parse(run([entry, 'restore', '--backup', backup, '--target', target, '--offline', '--json'])).ok, true)
  assert.equal(await readFile(join(target, 'config.yml'), 'utf8'), await readFile(join(home, 'config.yml'), 'utf8'))
  assert.equal(await readFile(join(target, 'history/session.jsonl'), 'utf8'), await readFile(join(home, 'history/session.jsonl'), 'utf8'))
  const overwrite = spawnSync(process.execPath, [entry, 'restore', '--backup', backup, '--target', target, '--offline', '--json'], options)
  assert.equal(overwrite.status, 1)
  assert.equal(JSON.parse(overwrite.stderr).code, 'TARGET_EXISTS')
  await writeFile(join(backup, 'data/config.yml'), 'tampered')
  const corrupted = spawnSync(process.execPath, [entry, 'verify', '--backup', backup, '--json'], options)
  assert.equal(corrupted.status, 1)
  assert.equal(JSON.parse(corrupted.stderr).ok, false)
  assert.equal((await readdir(scratch)).includes('must-not-read-default'), false)
  console.log('backup CLI 冒烟通过：直接/安装入口、显式目录、校验、恢复、防覆盖、篡改拒绝和隐私')
} finally {
  assert.equal(dirname(scratch), tmpdir())
  await rm(scratch, { recursive: true, force: true })
}
