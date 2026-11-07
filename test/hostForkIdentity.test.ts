/** 原生分支来源凭据使用真实文件存储：冲突、损坏与继承历史变化均不能静默换源。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Session } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import { deleteHostForkIdentity, readHostForkIdentity, writeHostForkIdentity } from '../src/node/hostForkIdentity.js'
import type { TavernPaths } from '../src/node/paths.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tavern-fork-identity-')); roots.push(root)
  return { root } as TavernPaths
}
const child = (events: unknown[], parentSession?: string) => ({
  id: 'session-child', inheritedEventCount: events.length, snapshotEvents: () => events,
  header: { isSeeded: true, ...(parentSession ? { parentSession } : {}) },
}) as unknown as Session

it('并发写入同一子会话的不同来源时仅有一个成功，同一凭据重试可复用', async () => {
  const paths = await fixture(), prefix = [{ type: 'turn/start', seq: 0 }]
  const results = await Promise.allSettled([
    writeHostForkIdentity(paths, 'session-child', 'session-parent-a', prefix),
    writeHostForkIdentity(paths, 'session-child', 'session-parent-b', prefix),
  ])
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  const saved = await readHostForkIdentity(paths, child(prefix))
  expect(['session-parent-a', 'session-parent-b']).toContain(saved?.parentId)
  await expect(writeHostForkIdentity(paths, 'session-child', saved!.parentId!, prefix)).resolves.toBeUndefined()
  await expect(writeHostForkIdentity(paths, 'session-child', saved!.parentId!, [{ type: 'turn/end', seq: 0 }])).rejects.toThrow('冲突')
  expect(await readHostForkIdentity(paths, child(prefix))).toEqual(saved)
})

it('历史前缀或宿主已有父身份不匹配、来源记录损坏时明确拒绝', async () => {
  const paths = await fixture(), prefix = [{ type: 'turn/start', seq: 0 }]
  await writeHostForkIdentity(paths, 'session-child', 'session-parent', prefix)
  await expect(readHostForkIdentity(paths, child([{ type: 'turn/end', seq: 0 }]))).rejects.toThrow('继承历史不符')
  await expect(readHostForkIdentity(paths, child(prefix, 'session-other'))).rejects.toThrow('继承历史不符')
  const name = createHash('sha256').update('session-child').digest('hex') + '.json'
  await writeFile(join(paths.root, 'state', 'host-fork-identities', name), '{broken')
  await expect(readHostForkIdentity(paths, child(prefix))).rejects.toThrow('来源记录损坏')
  await deleteHostForkIdentity(paths, 'session-child')
  expect(await readHostForkIdentity(paths, child(prefix))).toBeNull()
})
