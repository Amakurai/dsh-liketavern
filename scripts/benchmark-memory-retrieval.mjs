/**
 * 用合成记忆对照指定 Git 基线的 BM25 查询耗时；不读取剧情数据、不调用模型。
 * 先 npm run build，再 node scripts/benchmark-memory-retrieval.mjs <base-ref>。
 * 只测热索引查询，不代表文件读取、冷索引重建或端到端对话性能；不设耗时断言。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { Bm25Index } from '../lib/core/bm25.js'

const baseRef = process.argv[2]
if (!baseRef) throw new Error('用法：node scripts/benchmark-memory-retrieval.mjs <base-ref>')
const root = fileURLToPath(new URL('../', import.meta.url))
const tokenizerUrl = new URL('../lib/core/tokenize.js', import.meta.url).href
const before = execFileSync('git', ['show', '--no-ext-diff', '--end-of-options', `${baseRef}:src/core/bm25.ts`], {
  cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
}).replace(/(['"])\.\/tokenize\.js\1/, JSON.stringify(tokenizerUrl))
const compiled = ts.transpileModule(before, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText
const { Bm25Index: BeforeIndex } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const oldIndex = new BeforeIndex()
const newIndex = new Bm25Index()
const documents = 10_000
for (let i = 0; i < documents; i++) {
  const doc = { id: `m-${i}`, text: `shared memory topic${i % 1_000}`, keys: [], ts: 1_000_000 }
  oldIndex.add(doc)
  newIndex.add(doc)
}
const samples = 5
const repeats = 50
const options = { topK: 5, now: 1_000_000 }
function measure(index, query) {
  const start = performance.now()
  for (let i = 0; i < repeats; i++) index.search(query, options)
  return (performance.now() - start) / repeats
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const results = []
for (const [scenario, query] of [
  ['sparse-20-terms', Array.from({ length: 20 }, (_, i) => `topic${i}`).join(' ')],
  ['dense-common-term', 'shared'],
]) {
  assert.deepEqual(newIndex.search(query, options), oldIndex.search(query, options))
  for (let i = 0; i < 20; i++) { oldIndex.search(query, options); newIndex.search(query, options) }
  const oldTimes = []
  const newTimes = []
  for (let i = 0; i < samples; i++) {
    // 交替顺序，降低固定先后与 JIT/GC 抖动对对照的影响。
    if (i % 2 === 0) { oldTimes.push(measure(oldIndex, query)); newTimes.push(measure(newIndex, query)) }
    else { newTimes.push(measure(newIndex, query)); oldTimes.push(measure(oldIndex, query)) }
  }
  results.push({ scenario, beforeMedianMs: median(oldTimes), afterMedianMs: median(newTimes) })
}
console.log(JSON.stringify({ node: process.version, documents, samples, repeats, results }, null, 2))
