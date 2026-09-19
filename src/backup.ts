#!/usr/bin/env node
/** 离线备份 CLI：只接受显式目录，机器结果不含私人路径、文件名、正文、ID 或底层异常消息。 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BackupError, createBackup, restoreBackup, verifyBackup, type BackupReport } from './node/backup.js'

interface Arguments { command: 'create' | 'verify' | 'restore'; home?: string; backup: string; target?: string; offline: boolean; json: boolean }
export function parseBackupArguments(args: string[]): Arguments {
  const command = args[0]
  if (command !== 'create' && command !== 'verify' && command !== 'restore') throw new BackupError('INVALID_ARGUMENTS')
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 1; i < args.length; i++) {
    const key = args[i]!
    if (key === '--json' || key === '--offline') {
      if (flags.has(key)) throw new BackupError('INVALID_ARGUMENTS')
      flags.add(key)
    } else if (key === '--home' || key === '--backup' || key === '--target') {
      const value = args[++i]
      if (!value || value.startsWith('--') || values.has(key)) throw new BackupError('INVALID_ARGUMENTS')
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

Stop every dsh process using the source or target before create/restore. --offline
declares that you have done so; it does NOT prove the host is stopped. Known live
PID lock signals are rejected; absence of a signal is not an offline guarantee.
No default DSH_HOME is read. Existing destination directories are never accepted.
The destination parent directory must already exist. Verify is read-only.

The backup includes data/configuration/history below the explicit home, excluding
only the host's profiles/node_modules, profiles/<name>/node_modules and
profiles/<name>/.dsh-module-fallback/node_modules dependency trees. Exclusions are
listed in manifest.json. Profile package/lock/patch files are preserved: use them
to reinstall dependencies after restoring. Manifest versions describe the backup
tool's runtime, not proof of the last writer's version. Custom storage outside home is not
included. Other links, hard links, special files and portable-path collisions
are rejected. The backup contains private data; protect it like the source.
Exit codes: 0 success, 1 verification/refusal, 2 arguments or unexpected I/O error.
`
export function formatBackupText(result: BackupReport): string {
  return `dsh-liketavern backup: ${result.operation} ${result.code}\nfiles=${result.files} directories=${result.directories} bytes=${result.bytes}\nexcluded-dependency-directories=${result.excludedDependencyDirectories} dependencies-need-reinstall=${result.dependenciesNeedReinstall}\noffline-declared=${result.offlineDeclared} offline-verified=false\n`
}
export async function backupMain(args = process.argv.slice(2), io = {
  out: (text: string) => { process.stdout.write(text) }, err: (text: string) => { process.stderr.write(text) },
}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { io.out(HELP); return 0 }
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
    const code = error instanceof BackupError ? error.code : 'IO_FAILED'
    const result = { schemaVersion: 1, ok: false, operation: parsed.command, code }
    io.err(parsed.json ? JSON.stringify(result) + '\n' : `dsh-liketavern backup: ${code}\n`)
    return error instanceof BackupError ? 1 : 2
  }
}
function direct(): boolean {
  try { return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1])) } catch { return false }
}
if (direct()) void backupMain().then(code => { process.exitCode = code }, () => { process.stderr.write('dsh-liketavern backup: IO_FAILED\n'); process.exitCode = 2 })
