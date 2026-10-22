#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取版本段与 Release 标题。
 *
 *   node scripts/release-notes.mjs 0.6.0 [CHANGELOG.md] [release-notes.md] [release-title.txt]
 *
 * 段标题接受 `## 0.6.0`、`## 0.6.0（日期）`、`## [0.6.0]`。版本号与日期之后若还有文字，
 * 用作 Release 标题（`v0.6.0：那段文字`），与仓库既有的 "v0.5.5：审计修复…" 一致。
 * 段为空直接失败——宁可让发布红灯，也不发一个没有说明的版本。
 */
import { readFileSync, writeFileSync } from 'node:fs'

function escapeVersion(version) {
  return version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function headingBody(line) {
  const match = /^##\s+(.+?)\s*$/.exec(line.trim())
  return match ? match[1] : null
}

function findVersionHeading(lines, version) {
  const pattern = new RegExp(`^\\[?${escapeVersion(version)}\\]?(?:$|\\s|（|\\()`)
  return lines.findIndex(line => {
    const body = headingBody(line)
    return body !== null && pattern.test(body)
  })
}

export function extractReleaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const start = findVersionHeading(lines, version)
  if (start < 0) return null
  const body = []
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##\s/.test(lines[index])) break
    body.push(lines[index])
  }
  const notes = body.join('\n').trim()
  return notes.length ? notes : null
}

/** 版本段标题里的说明文字即 Release 标题；没有说明时退化为纯 `vX.Y.Z`。 */
export function extractReleaseTitle(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const index = findVersionHeading(lines, version)
  if (index < 0) return `v${version}`
  let rest = headingBody(lines[index]) ?? ''
  rest = rest.replace(new RegExp(`^\\[?${escapeVersion(version)}\\]?`), '')
  rest = rest.replace(/^\s*[（(][^）)]*[）)]/, '')
  rest = rest.replace(/^\s*[-–—:：]\s*/, '').trim()
  return rest ? `v${version}：${rest}` : `v${version}`
}

const invokedDirectly = process.argv[1] !== undefined && /release-notes\.mjs$/.test(process.argv[1])
if (invokedDirectly) {
  const [version, changelogPath = 'CHANGELOG.md', outPath = 'release-notes.md', titlePath] = process.argv.slice(2)
  if (!version) {
    console.error('用法：node scripts/release-notes.mjs <version> [CHANGELOG.md] [release-notes.md] [release-title.txt]')
    process.exit(1)
  }
  const changelog = readFileSync(changelogPath, 'utf8')
  const notes = extractReleaseNotes(changelog, version)
  if (notes === null) {
    console.error(`CHANGELOG 缺少 "${version}" 段或段内容为空：${changelogPath}`)
    process.exit(1)
  }
  writeFileSync(outPath, `${notes}\n`)
  console.log(`release notes: ${outPath}（${notes.length} 字符）`)
  if (titlePath) {
    const title = extractReleaseTitle(changelog, version)
    writeFileSync(titlePath, `${title}\n`)
    console.log(`release title: ${title}`)
  }
}
