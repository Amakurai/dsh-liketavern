/**
 * 基于双平台真实 CI 耗时基线的确定性 LPT（最长处理时间优先）测试分片与排序：
 * 重型沙箱、WAL 故障矩阵与宿主集成套件优先均摊至各分片，新增或未登记文件按特征估算与 SHA-1 稳定打散，
 * 保证任意分片总数下全量用例不重不漏，同时消除单纯哈希切分造成的长尾木桶效应。
 */
import { createHash } from 'node:crypto'

/** 双平台实测重型测试基线耗时（秒）：[Windows 单核, Linux 单核]。 */
const HEAVY_SUITE_SECONDS = Object.freeze({
  'test/templateCheckpointUpgrade.test.ts': [26.2, 16.7],
  'test/template.test.ts': [24.6, 22.0],
  'test/walCrashMatrix.test.ts': [22.5, 12.8],
  'test/templateStorageScale.test.ts': [21.4, 3.5],
  'test/templateCheckpoint.test.ts': [21.0, 24.8],
  'test/transactionRecovery.test.ts': [19.8, 2.5],
  'test/helperChatEdits.test.ts': [19.1, 4.9],
  'test/hostForkAdoptionRecovery.test.ts': [18.3, 7.3],
  'test/templateWorkerCache.test.ts': [17.7, 18.0],
  'test/templateEjs.test.ts': [16.0, 15.5],
  'test/templateReplayStructure.test.ts': [15.1, 15.2],
  'test/templateCheckpointStorage.test.ts': [15.1, 8.1],
  'test/requestPlanBinding.test.ts': [14.6, 10.6],
  'test/templateHelperMvu.test.ts': [14.2, 15.2],
  'test/ptcTools.test.ts': [13.4, 9.5],
  'test/templateStorage.test.ts': [13.1, 2.6],
  'test/helperMvuRuntime.test.ts': [12.9, 5.7],
  'test/templateContinuation.test.ts': [12.5, 15.3],
  'test/templateSecurity.test.ts': [11.2, 11.6],
  'test/templateCompatibility.test.ts': [10.3, 11.4],
  'test/challengerM3StressAdversarial.test.ts': [10.1, 9.2],
  'test/templateGeneration.test.ts': [9.9, 9.7],
  'test/templateMessageVariables.test.ts': [9.8, 8.5],
  'test/templateReplayRecovery.test.ts': [9.4, 7.5],
  'test/templateFormatterMigration.test.ts': [9.4, 8.8],
  'test/templatePlacement.test.ts': [9.0, 8.8],
  'test/zz-audit-sandbox/pendingJobs.test.ts': [8.8, 8.9],
  'test/templateSchema.test.ts': [8.3, 8.2],
  'test/zz-audit-sandbox/memoryBound.test.ts': [7.8, 7.9],
  'test/presetLiveRequest.test.ts': [7.8, 7.2],
  'test/templateGenerationBody.test.ts': [7.1, 5.4],
  'test/presetStructuredLive.test.ts': [7.0, 5.2],
  'test/templateFaker.test.ts': [6.9, 7.1],
  'test/templateCheckpointRuntime.test.ts': [6.8, 4.8],
  'test/helperWorldbook.test.ts': [6.7, 4.1],
  'test/releaseScript.test.ts': [6.6, 1.2],
  'test/longStoryGrowth.test.ts': [6.5, 4.2],
  'test/templateSticky.test.ts': [6.0, 6.9],
  'test/serviceHardening.test.ts': [5.9, 2.3],
  'test/templateCheckpointMemory.test.ts': [5.6, 6.4],
  'test/templateOutlets.test.ts': [5.6, 6.5],
  'test/pendingTurnInputs.test.ts': [5.6, 5.2],
  'test/templateReplayStructureIntegration.test.ts': [5.5, 7.1],
  'test/helperMvuAbandon.test.ts': [5.3, 2.7],
  'test/templateCommitRecovery.test.ts': [5.3, 3.6],
  'test/challengerM2R2StressHarness.test.ts': [5.3, 3.4],
  'test/templateLongDisplay.test.ts': [5.2, 6.4],
  'test/templateApiParity.test.ts': [5.2, 4.8],
  'test/storyIsolation.test.ts': [5.1, 1.9],
  'test/walIntegrity.test.ts': [5.1, 1.7],
})

const normalizeRelativePath = value => String(value).replaceAll('\\', '/').replace(/^\/+/, '')

/** 估算单个测试文件的相对耗时权重；未登记的新增文件按路径特征与平台给保守初值。 */
export function estimateTestFileSeconds(relativePath, platform = process.platform) {
  const normalized = normalizeRelativePath(relativePath)
  const recorded = Object.hasOwn(HEAVY_SUITE_SECONDS, normalized) ? HEAVY_SUITE_SECONDS[normalized] : undefined
  if (recorded) return platform === 'win32' ? recorded[0] : recorded[1]
  if (/(?:template|Recovery|Concurrency|Crash|Stress|Live|Bridge|Mvu)/i.test(normalized)) {
    return platform === 'win32' ? 2.4 : 1.8
  }
  if (normalized.endsWith('.tsx')) return platform === 'win32' ? 1.8 : 1.3
  return platform === 'win32' ? 1.0 : 0.7
}

function rankFiles(entries, platform) {
  return entries.map(entry => {
    const rel = normalizeRelativePath(entry.relativePath)
    return {
      ...entry,
      rel,
      weight: estimateTestFileSeconds(rel, platform),
      hash: createHash('sha1').update(rel).digest('hex'),
    }
  }).sort((left, right) => (right.weight - left.weight)
    || (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0)
    || (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0))
}

/**
 * 按 LPT 贪心将测试规格均匀分配到 count 个桶，返回第 index（1..count）片。
 * 同一平台的所有 runner 输入相同相对路径集合时，结果严格确定且两两互不相交、并集完整。
 */
export function partitionTestShard(entries, { index, count, platform = process.platform }) {
  if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`无效的分片总数：${String(count)}`)
  if (!Number.isSafeInteger(index) || index < 1 || index > count) {
    throw new Error(`无效的分片序号：${String(index)}/${String(count)}`)
  }
  const ranked = rankFiles(entries, platform)
  const buckets = Array.from({ length: count }, () => ({ total: 0, items: [] }))
  for (const entry of ranked) {
    let target = 0
    for (let cursor = 1; cursor < count; cursor++) {
      if (buckets[cursor].total < buckets[target].total
        || (buckets[cursor].total === buckets[target].total && buckets[cursor].items.length < buckets[target].items.length)) {
        target = cursor
      }
    }
    buckets[target].total += entry.weight
    buckets[target].items.push(entry.item)
  }
  return buckets[index - 1].items
}

/** 片内先跑重型集成与沙箱回归，让潜在超时与复杂故障尽早暴露，同时保持顺序确定。 */
export function sortShardFiles(entries, { platform = process.platform } = {}) {
  return rankFiles(entries, platform).map(entry => entry.item)
}
