/**
 * 记忆检索别名的存储行为（真实文件系统 + WAL）：别名存在 memory/aliases.json，按正文指纹对应到记忆。
 * 验证：保存后长期存活的另一个实例立即能按别名检索；正文改动、楼层回退后旧别名自动作废；
 * 别名不影响写入去重；归档来源继续带着别名；文件损坏、绕过存储类的改写与楼层内写入的失败边界。
 */
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MemoryStore } from '../src/state/memory.js'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let wal: Wal
let fs: WorkspaceFs
/** 长期存活的读实例（相当于管线与工具只读操作用的那个）。 */
let reader: MemoryStore
/** 另一个实例（相当于空闲维护每次新建的那个）。 */
let writer: MemoryStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'memory-alias-'))
  wal = new Wal(join(root, 'state', 'wal'))
  fs = new WorkspaceFs(root, wal)
  reader = new MemoryStore(fs)
  writer = new MemoryStore(new WorkspaceFs(root, null))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const PILLS = '医务室的止痛剂上个月少了两箱，值班记录被人改过。'
const ids = async (store: MemoryStore, query: string): Promise<string[]> => (await store.search(query, { topK: 50 })).map((hit) => hit.entry.id)

it('保存别名后，另一个长期存活的实例不必作废缓存就能按别名检索', async () => {
  const pills = await writer.write({ body: PILLS })
  await writer.write({ body: '北门每晚亥时落锁。' })
  // 先检索一次，让读实例把索引和别名文件的状态都缓存下来
  expect(await ids(reader, '谁在偷药')).toEqual([])
  expect((await reader.aliasCandidates(10)).map((entry) => entry.id).sort()).toEqual((await reader.list()).map((entry) => entry.id).sort())

  expect(await writer.saveAliases([{ entry: pills, aliases: ['药', '失窃', '偷药'] }])).toBe(1)
  expect(await ids(reader, '谁在偷药')).toEqual([pills.id])
  expect(await ids(reader, '药品失窃是怎么回事')).toEqual([pills.id])
  // 检索结果里的条目仍是记忆本身，不带别名
  expect((await reader.search('偷药'))[0]!.entry).toEqual((await reader.list()).find((entry) => entry.id === pills.id))
  // 记忆文件没有被改动
  expect(await readFile(join(root, 'memory', `${pills.id}.md`), 'utf8')).not.toContain('失窃')
})

it('候选只列还没有别名的记忆，最新的在前；模型没给出别名的记为空列表，不再列出', async () => {
  const first = await writer.write({ body: '第一条：北门每晚落锁。' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const second = await writer.write({ body: '第二条：灯塔的看守是哑巴。' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const third = await writer.write({ body: '第三条：集市只收铜板。' })
  expect((await reader.aliasCandidates(2)).map((entry) => entry.id)).toEqual([third.id, second.id])
  await writer.saveAliases([{ entry: third, aliases: ['集市'] }, { entry: second, aliases: [] }])
  expect((await reader.aliasCandidates(10)).map((entry) => entry.id)).toEqual([first.id])
  // 空正文不需要别名
  await writer.write({ body: '   ' })
  expect((await reader.aliasCandidates(10)).map((entry) => entry.id)).toEqual([first.id])
})

it('正文改动后旧别名作废：不再命中，并重新成为候选', async () => {
  const pills = await writer.write({ body: PILLS })
  await writer.saveAliases([{ entry: pills, aliases: ['药', '失窃'] }])
  expect(await ids(reader, '谁在偷药')).toEqual([pills.id])
  await writer.update(pills.id, { body: '医务室的门锁上周换过。' })
  expect(await ids(reader, '谁在偷药')).toEqual([])
  expect((await reader.aliasCandidates(10)).map((entry) => entry.id)).toEqual([pills.id])
  // 只改标签和关键词不动正文：别名继续有效
  const gate = await writer.write({ body: '北门每晚亥时落锁。' })
  await writer.saveAliases([{ entry: gate, aliases: ['宵禁'] }])
  await writer.update(gate.id, { tags: ['地点'], keys: ['北门'] })
  expect(await ids(reader, '宵禁是几点')).toEqual([gate.id])
})

it('等待模型期间记忆被改写或删除：对不上的别名不保存', async () => {
  const pills = await writer.write({ body: PILLS })
  const gate = await writer.write({ body: '北门每晚亥时落锁。' })
  const gone = await writer.write({ body: '集市只收铜板。' })
  await writer.update(pills.id, { body: '医务室的门锁上周换过。' })
  await writer.delete(gone.id)
  expect(await writer.saveAliases([{ entry: pills, aliases: ['药'] }, { entry: gate, aliases: ['宵禁'] }, { entry: gone, aliases: ['铜板'] }])).toBe(1)
  expect(await ids(reader, '药')).toEqual([])
  expect(await ids(reader, '宵禁')).toEqual([gate.id])
  // 一条都对不上时不写文件
  const before = await readFile(join(root, 'memory', 'aliases.json'), 'utf8')
  expect(await writer.saveAliases([{ entry: gone, aliases: ['铜板'] }])).toBe(0)
  expect(await readFile(join(root, 'memory', 'aliases.json'), 'utf8')).toBe(before)
})

it('楼层回退撤销正文改动后，按新正文生成的别名不再生效；被回退删除的记忆的记录在下次保存时清掉', async () => {
  const pills = await writer.write({ body: PILLS })
  await writer.saveAliases([{ entry: pills, aliases: ['药', '失窃'] }])
  // 楼层内：改写一条、新写一条
  const floor = 's#t1'
  await wal.beginFloor(floor)
  const inFloor = new MemoryStore(fs.withFloor(floor))
  await inFloor.update(pills.id, { body: '医务室的门锁上周换过。' })
  const added = await inFloor.write({ body: '禾对合成蛋白过敏。' })
  await wal.commitFloor(floor)
  // 空闲维护按楼层后的正文补了别名
  const current = await writer.list()
  await writer.saveAliases([
    { entry: current.find((entry) => entry.id === pills.id)!, aliases: ['门锁', '换锁'] },
    { entry: current.find((entry) => entry.id === added.id)!, aliases: ['食物', '过敏原'] },
  ])
  expect(await ids(reader, '换锁')).toEqual([pills.id])
  expect(await ids(reader, '食物')).toEqual([added.id])

  await wal.rollbackAfter([floor], root)
  // 正文回到了楼层之前：新别名对不上，旧别名的记录已被覆盖，这条重新成为候选
  expect((await reader.list()).map((entry) => entry.body)).toEqual([PILLS])
  expect(await ids(reader, '换锁')).toEqual([])
  expect(await ids(reader, '食物')).toEqual([])
  expect((await reader.aliasCandidates(10)).map((entry) => entry.id)).toEqual([pills.id])
  // 重新生成并保存：被回退删除的那条记忆的记录一并清掉
  await writer.saveAliases([{ entry: (await writer.list())[0]!, aliases: ['药'] }])
  const file = JSON.parse(await readFile(join(root, 'memory', 'aliases.json'), 'utf8')) as { entries: Record<string, unknown> }
  expect(Object.keys(file.entries)).toEqual([pills.id])
  expect(await ids(reader, '谁在偷药')).toEqual([pills.id])
})

it('别名不进去重索引：同一段正文再写一次仍然判为重复', async () => {
  const pills = await writer.write({ body: PILLS })
  await writer.write({ body: '北门每晚亥时落锁。' })
  await writer.write({ body: '灯塔的看守人是个哑巴老人。' })
  const before = await reader.findSimilar(PILLS, [])
  expect(before[0]).toMatchObject({ score: 1 })
  await writer.saveAliases([{ entry: pills, aliases: ['药', '药品', '失窃', '偷药', '医务室失窃案', '谁改了记录'] }])
  // 检索用的索引已经带上别名
  expect(await ids(reader, '医务室失窃案')).toEqual([pills.id])
  expect(await reader.findSimilar(PILLS, [])).toEqual(before)
  // 别名里的词不会让无关的新事实被判为相似
  expect((await reader.findSimilar('码头发生了一起失窃案', []))[0]?.score ?? 0).toBeLessThan(0.3)
})

it('归并归档之后，可达的归档来源继续按别名检索，它的记录不被清掉', async () => {
  const pills = await writer.write({ body: PILLS })
  const gate = await writer.write({ body: '北门每晚亥时落锁。' })
  await writer.saveAliases([{ entry: pills, aliases: ['药', '失窃'] }, { entry: gate, aliases: ['宵禁'] }])
  expect(await writer.mergeBatch([pills, gate], '止痛剂失踪；北门夜里落锁。', 'compress')).toBe(2)
  const summary = (await writer.list())[0]!
  expect(await ids(reader, '谁在偷药')).toEqual([pills.id])
  // 给摘要补别名时，归档来源的记录仍在
  await writer.saveAliases([{ entry: summary, aliases: ['旧事'] }])
  expect(await ids(reader, '宵禁')).toEqual([gate.id])
  expect((await ids(reader, '旧事'))).toEqual([summary.id])
})

it('别名文件损坏或被手改时不影响检索：坏文件当作没有别名，手改进去的功能词不生效', async () => {
  const pills = await writer.write({ body: PILLS })
  await writer.saveAliases([{ entry: pills, aliases: ['药'] }])
  expect(await ids(reader, '药')).toEqual([pills.id])
  await fs.writeText('memory/aliases.json', '{ 不是 JSON')
  expect(await ids(reader, '药')).toEqual([])
  expect(await ids(reader, '止痛剂')).toEqual([pills.id])
  expect((await reader.aliasCandidates(10)).map((entry) => entry.id)).toEqual([pills.id])
  // 重新保存会写出一份完好的文件
  await writer.saveAliases([{ entry: pills, aliases: ['药'] }])
  expect(await ids(reader, '药')).toEqual([pills.id])
  // 手改：把指纹留着，别名换成功能词
  const file = JSON.parse(await readFile(join(root, 'memory', 'aliases.json'), 'utf8')) as { entries: Record<string, { hash: string; aliases: string[] }> }
  file.entries[pills.id]!.aliases = ['的', '什么', '失窃']
  await fs.writeText('memory/aliases.json', JSON.stringify(file))
  expect(await ids(reader, '的')).toEqual([])
  expect(await ids(reader, '什么')).toEqual([])
  expect(await ids(reader, '失窃')).toEqual([pills.id])
})

it('绕过存储类直接改写别名文件：指纹（大小或修改时间）变了即生效，完全相同时要显式作废', async () => {
  const pills = await writer.write({ body: PILLS })
  await writer.saveAliases([{ entry: pills, aliases: ['药'] }])
  expect(await ids(reader, '药')).toEqual([pills.id])
  const path = join(root, 'memory', 'aliases.json')
  const original = await readFile(path, 'utf8')
  // 外部写入，长度不同；修改时间钉在一个固定的整秒上
  const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000)
  await writeFile(path, original.replace('"药"', '"药", "失窃"'))
  await utimes(path, pinned, pinned)
  expect(await ids(reader, '失窃')).toEqual([pills.id])
  // 外部写入，长度与修改时间都与上次相同：读实例看不出来
  await writeFile(path, (await readFile(path, 'utf8')).replace('"失窃"', '"盗窃"'))
  await utimes(path, pinned, pinned)
  expect(await ids(reader, '盗窃')).toEqual([])
  reader.invalidate()
  expect(await ids(reader, '盗窃')).toEqual([pills.id])
})

it('别名只能经无楼层的文件面保存：楼层内的实例直接拒绝，不留下任何文件', async () => {
  const pills = await writer.write({ body: PILLS })
  const floor = 's#t1'
  await wal.beginFloor(floor)
  const inFloor = new MemoryStore(fs.withFloor(floor))
  await expect(inFloor.saveAliases([{ entry: pills, aliases: ['药'] }])).rejects.toThrow('不能在楼层内写入')
  await wal.commitFloor(floor)
  expect(await fs.exists('memory/aliases.json')).toBe(false)
  // 楼层内的实例照常可以读别名参与检索
  await writer.saveAliases([{ entry: pills, aliases: ['药'] }])
  expect(await ids(inFloor, '药')).toEqual([pills.id])
})
