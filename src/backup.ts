#!/usr/bin/env node
/** 离线备份 CLI：只接受显式目录，机器结果不含私人路径、文件名、正文、ID 或底层异常消息。 */
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isRecord } from './core/guards.js'
import { BackupError, createBackup, restoreBackup, verifyBackup, type BackupReport } from './node/backup.js'

const SAFE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/

async function ownPackageVersion(): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as unknown
    return isRecord(raw) && typeof raw.version === 'string' && SAFE_VERSION.test(raw.version) ? raw.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

interface Arguments { command: 'create' | 'verify' | 'restore'; home?: string; backup: string; target?: string; offline: boolean; json: boolean }
const VALUE_FLAGS = new Set(['--home', '--backup', '--target'])
export function parseBackupArguments(args: string[]): Arguments {
  const command = args[0]
  if (command !== 'create' && command !== 'verify' && command !== 'restore') throw new BackupError('INVALID_ARGUMENTS')
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 1; i < args.length; i++) {
    const raw = args[i]!
    if (raw === '--json' || raw === '--offline') {
      if (flags.has(raw)) throw new BackupError('INVALID_ARGUMENTS')
      flags.add(raw)
      continue
    }
    let key = raw
    let value: string | undefined
    const eq = raw.indexOf('=')
    if (eq !== -1) {
      key = raw.slice(0, eq)
      value = raw.slice(eq + 1)
    }
    if (VALUE_FLAGS.has(key)) {
      if (eq === -1) value = args[++i]
      // 同时拦截单短横（如 -h）与双短横标志，避免忘记路径参数时把标志创建成字面目录。
      if (!value || value.startsWith('-') || values.has(key)) throw new BackupError('INVALID_ARGUMENTS')
      values.set(key, value)
    } else throw new BackupError('INVALID_ARGUMENTS')
  }
  if (!values.has('--backup') || (command === 'create' && (!values.has('--home') || values.has('--target')))
    || (command === 'restore' && (!values.has('--target') || values.has('--home')))
    || (command === 'verify' && (values.has('--home') || values.has('--target') || flags.has('--offline')))) throw new BackupError('INVALID_ARGUMENTS')
  return { command, backup: values.get('--backup')!, home: values.get('--home'), target: values.get('--target'),
    offline: flags.has('--offline'), json: flags.has('--json') }
}
const HELP = `Usage: dsh-tavern-backup <create|verify|restore> [options]

  create  --home <DSH_HOME> --backup <NEW_DIRECTORY> --offline [--json]
  verify  --backup <BACKUP_DIRECTORY> [--json]
  restore --backup <BACKUP_DIRECTORY> --target <NEW_DSH_HOME> --offline [--json]
  --version | -v
  --help | -h (or <subcommand> --help)

Stop every dsh process using the source or target before create/restore. --offline
declares that you have done so; it does NOT prove the host is stopped. Known live
PID lock signals are rejected; absence of a signal is not an offline guarantee.
No default DSH_HOME is read. Existing destination directories are never accepted.
The destination parent directory must already exist (PARENT_DIRECTORY_MISSING otherwise).
Verify is read-only. Options also accept --flag=<path> form.

The backup includes data/configuration/history below the explicit home, excluding
only the host's profiles/node_modules, profiles/<name>/node_modules and
profiles/<name>/.dsh-module-fallback/node_modules dependency trees. Exclusions are
listed in manifest.json. Profile package/lock/patch files are preserved: use them
to reinstall dependencies after restoring. Manifest versions describe the backup
tool's runtime, not proof of the last writer's version. Custom storage outside home is not
included. Self-contained hard-link groups inside the home (such as host file attachments)
are verified and preserved; symlinks, external hard links, special files and portable-path
collisions are rejected. The backup contains private data; protect it like the source.
Exit codes: 0 success, 1 verification/refusal, 2 arguments or unexpected I/O error.
`
export function formatBackupText(result: BackupReport): string {
  const lines = [
    `dsh-liketavern backup: ${result.operation} ${result.code}`,
    `files=${result.files} directories=${result.directories} bytes=${result.bytes}`,
    `excluded-dependency-directories=${result.excludedDependencyDirectories} dependencies-need-reinstall=${result.dependenciesNeedReinstall}`,
    `offline-declared=${result.offlineDeclared} offline-verified=false`,
  ]
  for (const issue of result.issues) lines.push(`issue: severity=${issue.severity} code=${issue.code} count=${issue.count}`)
  return lines.join('\n') + '\n'
}
function isHelpInvocation(args: string[]): boolean {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return true
  return args.length === 2 && (args[0] === 'create' || args[0] === 'verify' || args[0] === 'restore')
    && (args[1] === '--help' || args[1] === '-h')
}
export async function backupMain(args = process.argv.slice(2), io = {
  out: (text: string) => { process.stdout.write(text) }, err: (text: string) => { process.stderr.write(text) },
}): Promise<number> {
  if (isHelpInvocation(args)) { io.out(HELP); return 0 }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v')) { io.out(`${await ownPackageVersion()}\n`); return 0 }
  let parsed: Arguments
  try { parsed = parseBackupArguments(args) } catch {
    io.err(args.includes('--json') ? JSON.stringify({ schemaVersion: 1, ok: false, code: 'INVALID_ARGUMENTS' }) + '\n'
      : 'dsh-liketavern backup: INVALID_ARGUMENTS; use --help\n')
    return 2
  }
  try {
    const result = parsed.command === 'create' ? await createBackup({ home: parsed.home!, backup: parsed.backup, offline: parsed.offline })
      : parsed.command === 'restore' ? await restoreBackup({ backup: parsed.backup, target: parsed.target!, offline: parsed.offline })
      : await verifyBackup({ backup: parsed.backup })
    io.out(parsed.json ? JSON.stringify(result, null, 2) + '\n' : formatBackupText(result))
    return 0
  } catch (error) {
    const backupError = error instanceof BackupError ? error : null
    const code = backupError ? backupError.code : 'IO_FAILED'
    const issues = backupError?.issues
    const result = { schemaVersion: 1, ok: false, operation: parsed.command, code, ...(issues ? { issues } : {}) }
    if (parsed.json) {
      io.err(JSON.stringify(result) + '\n')
    } else {
      const lines = [`dsh-liketavern backup: ${code}`]
      if (issues && issues.length > 0) {
        for (const issue of issues) lines.push(`issue: severity=${issue.severity} code=${issue.code} count=${issue.count}`)
        lines.push('hint: run dsh-tavern-doctor for detailed sanitized guidance')
      }
      io.err(lines.join('\n') + '\n')
    }
    return backupError ? 1 : 2
  }
}
function direct(): boolean {
  try { return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1])) } catch { return false }
}
if (direct()) void backupMain().then(code => { process.exitCode = code }, () => { process.stderr.write('dsh-liketavern backup: IO_FAILED\n'); process.exitCode = 2 })
