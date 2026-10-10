/**
 * 在本机对一个真实剧情的记忆库做只读的检索自检，只输出汇总数字，不打印任何记忆正文。
 * 评测集是手写的虚构数据；这个脚本用来在自己的数据上看同一套规则的表现，不需要人工标注。
 *
 *   npm run build
 *   node scripts/memory-retrieval-report.mjs <剧情目录>     # 目录下应有 memory/*.md
 *
 * 指标：
 * - 自检索：用每条记忆自己的 keys、以及正文的第一个分句当查询，看这条记忆能否排进前 5。
 *   排不进去通常说明它和别的条目高度重复，或者 keys 只有功能词。
 * - 单字词：有多少个字在库里单独成词过（可以单独带出命中）、多少个被单字 key 声明。
 * - 无关短句：一组与任何剧情都无关的日常句子里，有多少句带出了命中。
 * 加 --show-chars 会额外列出被当作单字词的字（这些字来自你的记忆正文）。
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Bm25Index } from '../lib/core/bm25.js'
import { isStopChar } from '../lib/core/stopwords.js'
import { analyzeText } from '../lib/core/tokenize.js'
import { parseMemory } from '../lib/state/memory.js'

const args = process.argv.slice(2)
const showChars = args.includes('--show-chars')
const target = args.find((arg) => !arg.startsWith('--'))
if (!target) {
  console.error('用法：node scripts/memory-retrieval-report.mjs <剧情目录> [--show-chars]')
  process.exit(2)
}
const dir = join(resolve(target), 'memory')
const names = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.md')).map((entry) => entry.name)
const entries = []
let unreadable = 0
for (const name of names) {
  try {
    entries.push(parseMemory(name, await readFile(join(dir, name), 'utf8')))
  } catch {
    unreadable++
  }
}
if (entries.length === 0) {
  console.error(`没有可解析的活跃记忆：${dir}`)
  process.exit(1)
}

const index = new Bm25Index()
for (const entry of entries) index.add({ id: entry.id, text: entry.body, keys: entry.keys })
const TOP = 5
const inTop = (query, id) => index.search(query, { topK: TOP }).some((hit) => hit.id === id)
const percent = (part, whole) => (whole === 0 ? '—' : `${Math.round((100 * part) / whole)}%`)

// 自检索
let withKeys = 0
let keysFound = 0
let clauses = 0
let clausesFound = 0
for (const entry of entries) {
  if (entry.keys.length > 0) {
    withKeys++
    if (inTop(entry.keys.join(' '), entry.id)) keysFound++
  }
  const clause = entry.body.split(/[，。！？；,.!?;\n]/).map((part) => part.trim()).find((part) => part.length >= 4)
  if (clause) {
    clauses++
    if (inTop(clause, entry.id)) clausesFound++
  }
}

// 单字词
const wordChars = new Set()
const declared = new Set()
for (const entry of entries) {
  for (const char of analyzeText(entry.body).words) if (!isStopChar(char)) wordChars.add(char)
  for (const key of entry.keys) {
    const tokens = analyzeText(key)
    for (const char of tokens.words) if (!isStopChar(char)) wordChars.add(char)
    if (tokens.terms.length === 0 && tokens.chars.length === 1) declared.add(tokens.chars[0])
  }
}

// 无关短句
const unrelated = ['周五晚上有空吗', '这道题怎么解', '帮我查一下快递', '空调温度调低一点', '明天记得交房租', '我想学吉他',
  '楼下新开了一家面馆', '手机快没电了', '电影几点开始', '地铁站怎么走', '咖啡不加糖谢谢', '帮我订一张机票',
  'What a lovely morning it is.', 'Do you have any plans for the weekend?']
const unrelatedHits = unrelated.map((query) => index.search(query, { topK: entries.length }).length)

console.log(`活跃记忆 ${entries.length} 条${unreadable ? `（另有 ${unreadable} 个文件无法解析，已跳过）` : ''}，其中 ${withKeys} 条带 keys`)
console.log(`自检索（前 ${TOP}）：用 keys 查 ${keysFound}/${withKeys}（${percent(keysFound, withKeys)}），用正文首句查 ${clausesFound}/${clauses}（${percent(clausesFound, clauses)}）`)
console.log(`单字词：${wordChars.size} 个字在库里单独成词过，${declared.size} 个字被单字 key 声明`)
console.log(`无关短句：${unrelated.length} 句里 ${unrelatedHits.filter((count) => count > 0).length} 句带出命中，平均 ${(unrelatedHits.reduce((sum, count) => sum + count, 0) / unrelated.length).toFixed(2)} 条`)
if (showChars) {
  console.log(`单独成词的字：${[...wordChars].sort().join('') || '（无）'}`)
  console.log(`单字 key 声明的字：${[...declared].sort().join('') || '（无）'}`)
}
