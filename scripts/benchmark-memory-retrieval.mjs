/**
 * 用合成记忆对照指定 Git 基线的 BM25 查询耗时；不读取剧情数据、不调用模型。
 * 先 npm run build，再 node scripts/benchmark-memory-retrieval.mjs <base-ref>。
 * 只测热索引查询，不代表文件读取、冷索引重建或端到端对话性能；不设耗时断言。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { Bm25Index } from '../lib/core/bm25.js'

const baseRef = process.argv[2]
if (!baseRef) throw new Error('用法：node scripts/benchmark-memory-retrieval.mjs <base-ref>')
const root = fileURLToPath(new URL('../', import.meta.url))
// 相对导入也取同一个 Git 基线：data: 模块不能直接 import ./stopwords.js，
// 也不能把旧 BM25 配上当前分词器，否则分词变化被排除在对照之外。
const baselineModules = new Map()
function baselineModule(path) {
  if (baselineModules.has(path)) return baselineModules.get(path)
  const source = execFileSync('git', ['show', '--no-ext-diff', '--end-of-options', `${baseRef}:${path}`], {
    cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
  })
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/\bfrom\s+(['"])(\.[^'"]+)\1/g, (_match, _quote, dependency) => {
    const dependencyPath = posix.join(posix.dirname(path), dependency).replace(/\.js$/, '.ts')
    return `from ${JSON.stringify(baselineModule(dependencyPath))}`
  })
  const url = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
  baselineModules.set(path, url)
  return url
}
const { Bm25Index: BeforeIndex } = await import(baselineModule('src/core/bm25.ts'))
const oldIndex = new BeforeIndex()
const newIndex = new Bm25Index()
const documents = 10_000
for (let i = 0; i < documents; i++) {
  const secondary = i % 5 < 2 ? ['草药箱', '取药筒', '汤药罐'][i % 3] : '旁观者'
  const doc = { id: `m-${i}`, text: `shared memory topic${i % 1_000} ${secondary}`, keys: [], ts: 1_000_000 }
  oldIndex.add(doc)
  newIndex.add(doc)
}
const samples = 7
const repeats = 100
function measure(index, operation, query, options) {
  const start = performance.now()
  for (let i = 0; i < repeats; i++) index[operation](query, options)
  return (performance.now() - start) / repeats
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const results = []
for (const [scenario, operation, query, topK] of [
  ['sparse-20-terms', 'search', Array.from({ length: 20 }, (_, i) => `topic${i}`).join(' '), 5],
  ['dense-common-term', 'search', 'shared', 5],
  ['dense-200-results', 'search', 'shared', 200],
  ['dense-chinese-stopwords', 'search', '现在旁观者在哪里', 5],
  ['dense-all-results', 'search', 'shared', documents],
  ['sparse-secondary-char', 'search', 'topic0 火药桶', 5],
  ['dense-similarity', 'similarity', 'shared memory topic0', 5],
]) {
  const options = { topK, now: 1_000_000 }
  assert.deepEqual(newIndex[operation](query, options), oldIndex[operation](query, options))
  for (let i = 0; i < 20; i++) { oldIndex[operation](query, options); newIndex[operation](query, options) }
  const oldTimes = []
  const newTimes = []
  for (let i = 0; i < samples; i++) {
    // 交替顺序，降低固定先后与 JIT/GC 抖动对对照的影响。
    if (i % 2 === 0) { oldTimes.push(measure(oldIndex, operation, query, options)); newTimes.push(measure(newIndex, operation, query, options)) }
    else { newTimes.push(measure(newIndex, operation, query, options)); oldTimes.push(measure(oldIndex, operation, query, options)) }
  }
  results.push({ scenario, operation, topK, beforeMedianMs: median(oldTimes), afterMedianMs: median(newTimes) })
}
console.log(JSON.stringify({ node: process.version, baseRef, documents, samples, repeats, results }, null, 2))
