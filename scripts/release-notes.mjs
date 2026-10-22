#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取一个版本段，作为 GitHub Release notes。
 *
 *   node scripts/release-notes.mjs 0.6.0 [CHANGELOG.md] [release-notes.md]
 *
 * 段标题接受 `## 0.6.0`、`## 0.6.0（日期）`、`## [0.6.0]`；段内容到下一个 `## ` 为止。
 * 段为空直接失败——宁可让发布红灯，也不发一个没有说明的版本。
 */
import { readFileSync, writeFileSync } from 'node:fs'

export function extractReleaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const starts = (line) => {
    const text = line.trim()
    return text === `## ${version}` || text.startsWith(`## ${version} `) || text.startsWith(`## ${version}（`)
      || text.startsWith(`## [${version}]`)
  }
  const start = lines.findIndex(starts)
  if (start < 0) return null
  const body = []
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##\s/.test(lines[index])) break
    body.push(lines[index])
  }
  const notes = body.join('\n').trim()
  return notes.length ? notes : null
}

const invokedDirectly = process.argv[1] !== undefined && /release-notes\.mjs$/.test(process.argv[1])
if (invokedDirectly) {
  const [version, changelogPath = 'CHANGELOG.md', outPath = 'release-notes.md'] = process.argv.slice(2)
  if (!version) {
    console.error('用法：node scripts/release-notes.mjs <version> [CHANGELOG.md] [release-notes.md]')
    process.exit(1)
  }
  const notes = extractReleaseNotes(readFileSync(changelogPath, 'utf8'), version)
  if (notes === null) {
    console.error(`CHANGELOG 缺少 "${version}" 段或段内容为空：${changelogPath}`)
    process.exit(1)
  }
  writeFileSync(outPath, `${notes}\n`)
  console.log(`release notes: ${outPath}（${notes.length} 字符）`)
}
