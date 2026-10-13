/** 独立 WAL 清单与只读回滚预演回归：日志缺失不能洗掉，预演保留楼层外修订且不改正文。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Wal, WAL_COVERAGE_PATH } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'tavern-wal-coverage-'));roots.push(root)
  const wal=new Wal(join(root,'state/wal')),fs=new WorkspaceFs(root,wal)
  for(const turn of [1,2]) {
    await wal.beginFloor(`s#t${turn}`)
    await fs.withFloor(`s#t${turn}`).writeText(`${turn}.txt`,String(turn))
    await wal.commitFloor(`s#t${turn}`)
  }
  return {root,wal,fs}
}

it.each(['state/wal','state/wal/s_t1'])('删除 %s 后清单阻止开新层和批量回滚，原正文保留',async path=> {
  const {root,fs}=await fixture()
  await rm(join(root,path),{recursive:true,force:true})
  const restarted=new Wal(join(root,'state/wal'))
  await expect(restarted.listFloors()).rejects.toThrow(/WAL.*缺失/)
  await expect(restarted.beginFloor('s#t3')).rejects.toThrow(/WAL.*缺失/)
  await expect(restarted.rollbackAfter(['s#t2'],root)).rejects.toThrow(/WAL.*缺失/)
  expect(await fs.readText('1.txt')).toBe('1')
  expect(await fs.readText('2.txt')).toBe('2')
})

it('旧日志首次继续时登记已有楼层，已回滚副本清理后仍可正常开层',async()=> {
  const {root,wal,fs}=await fixture()
  await fs.delete(WAL_COVERAGE_PATH)
  await wal.beginFloor('s#t3')
  await fs.withFloor('s#t3').writeText('3.txt','3')
  await wal.commitFloor('s#t3')
  await wal.rollbackAfter(['s#t2','s#t3'],root)
  expect(await wal.prune({keepRolledBackDays:-1})).toBe(2)
  expect((await new Wal(join(root,'state/wal')).listFloors()).map(item=>item.floor)).toEqual(['s#t1'])
  await wal.beginFloor('s#t4')
  expect(await fs.readText('1.txt')).toBe('1')
  expect(await fs.readText('2.txt')).toBeNull()
})

it('损坏清单不能在开启新层时被重新生成覆盖',async()=> {
  const {fs,wal}=await fixture(),broken='{"version":1,"floors":[12]}'
  await fs.writeText(WAL_COVERAGE_PATH,broken)
  await expect(wal.beginFloor('s#t3')).rejects.toThrow(/清单损坏/)
  expect(await fs.readText(WAL_COVERAGE_PATH)).toBe(broken)
  expect(await fs.exists('state/wal/s_t3/meta.json')).toBe(false)
})

it('已有清单开新层只追加本层：日志文件被清空而目录仍在时登记不被重建，列举与回退照样拒绝',async()=> {
  const {root,fs}=await fixture()
  for(const name of ['meta.json','records.jsonl']) await rm(join(root,'state/wal/s_t1',name),{force:true})
  const restarted=new Wal(join(root,'state/wal'))
  // 开层只核对目录名，不逐层读取元数据；被清空的楼层仍留在清单里，不会因为新开一层而消失。
  await restarted.beginFloor('s#t3')
  await fs.withFloor('s#t3').writeText('3.txt','3')
  const coverage=JSON.parse((await fs.readText(WAL_COVERAGE_PATH))!) as {floors:Array<{floor:string}>}
  expect(coverage.floors.map(item=>item.floor)).toEqual(['s#t1','s#t2','s#t3'])
  await expect(restarted.listFloors()).rejects.toThrow(/WAL.*缺失/)
  await expect(restarted.rollbackAfter(['s#t2','s#t3'],root)).rejects.toThrow(/WAL.*缺失/)
  expect(await fs.readText('2.txt')).toBe('2')
  expect(await fs.readText('3.txt')).toBe('3')
})

it('已登记楼层目录被清空后不能以同名新层覆盖清单，缺失证据与原正文保留',async()=> {
  const {root,fs}=await fixture()
  const coverage=await fs.readText(WAL_COVERAGE_PATH)
  for(const name of ['meta.json','records.jsonl']) await rm(join(root,'state/wal/s_t1',name),{force:true})
  const restarted=new Wal(join(root,'state/wal'))
  await expect(restarted.listFloors()).rejects.toThrow(/WAL.*缺失/)
  await expect(restarted.beginFloor('s#t1')).rejects.toThrow(/WAL.*缺失/)
  expect(await fs.readText(WAL_COVERAGE_PATH)).toBe(coverage)
  expect(await fs.exists('state/wal/s_t1/meta.json')).toBe(false)
  await expect(restarted.rollbackFloor('s#t1',root)).rejects.toThrow(/WAL.*缺失/)
  expect(await fs.readText('1.txt')).toBe('1')
})

it('同名楼层重生成后清单只保留新的开始时间，其它楼层的登记不变',async()=> {
  const {root,wal,fs}=await fixture()
  const floors=async()=>(JSON.parse((await fs.readText(WAL_COVERAGE_PATH))!) as {floors:Array<{floor:string;startedAt:string}>}).floors
  const first=await floors()
  await wal.rollbackFloor('s#t2',root)
  await new Promise(resolve=>setTimeout(resolve,5))
  await wal.beginFloor('s#t2')
  const second=await floors()
  expect(second.map(item=>item.floor)).toEqual(['s#t1','s#t2'])
  expect(second[0]).toEqual(first[0])
  expect(second[1]!.startedAt).not.toBe(first[1]!.startedAt)
  expect((await new Wal(join(root,'state/wal')).listFloors()).filter(item=>!item.rolledBack).map(item=>item.floor)).toEqual(['s#t1','s#t2'])
})

it.each(['整目录','仅文件'])('重生成楼层的日志被删除（%s）后，旧回滚副本不能充当当前楼层的完整证明',async mode=> {
  const {root,wal,fs}=await fixture()
  await wal.rollbackFloor('s#t2',root)
  await wal.beginFloor('s#t2')
  await fs.withFloor('s#t2').writeText('2.txt','重生成正文')
  await wal.commitFloor('s#t2')
  const coverage=await fs.readText(WAL_COVERAGE_PATH)
  if(mode==='整目录') await rm(join(root,'state/wal/s_t2'),{recursive:true,force:true})
  else for(const name of ['meta.json','records.jsonl']) await rm(join(root,'state/wal/s_t2',name),{force:true})
  const restarted=new Wal(join(root,'state/wal'))
  await expect(restarted.listFloors()).rejects.toThrow(/WAL.*缺失/)
  await expect(restarted.beginFloor('s#t2')).rejects.toThrow(/WAL.*缺失/)
  expect(await fs.readText(WAL_COVERAGE_PATH)).toBe(coverage)
  expect(await fs.exists('state/wal/s_t2/meta.json')).toBe(false)
  expect(await fs.readText('2.txt')).toBe('重生成正文')
})

it('只读回滚预演与实际结果一致：保留夹在楼层写入间的手动根、新文件消失、二进制逐字节恢复',async()=> {
  const {root,wal,fs}=await fixture()
  const binary=Uint8Array.from([0xff,0,0x80,0x61])
  await fs.writeText('root.json','original')
  await fs.writeBytes('binary.dat',binary)
  await wal.beginFloor('s#t3')
  const scoped=fs.withFloor('s#t3')
  await scoped.writeText('root.json','prepared')
  await fs.writeText('root.json','manual prepared')
  await scoped.writeText('root.json','completed')
  await scoped.writeText('new.json','new')
  await scoped.writeText('binary.dat','changed')
  const log=await fs.readText('state/wal/s_t3/records.jsonl')
  const meta=await fs.readText('state/wal/s_t3/meta.json')
  const rootSnapshot=await wal.rollbackSnapshot('s#t3','root.json',await fs.readBytes('root.json'))
  expect(Buffer.from(rootSnapshot!).toString('utf8')).toBe('manual prepared')
  expect(await wal.rollbackSnapshot('s#t3','new.json',await fs.readBytes('new.json'))).toBeNull()
  const binarySnapshot=await wal.rollbackSnapshot('s#t3','binary.dat',await fs.readBytes('binary.dat'))
  expect(binarySnapshot).toEqual(Buffer.from(binary))
  expect(await fs.readText('root.json')).toBe('completed')
  expect(await fs.readText('new.json')).toBe('new')
  expect(await fs.readText('binary.dat')).toBe('changed')
  expect(await fs.readText('state/wal/s_t3/records.jsonl')).toBe(log)
  expect(await fs.readText('state/wal/s_t3/meta.json')).toBe(meta)
  expect(await fs.exists('state/wal/s_t3/rollback-progress.json')).toBe(false)
  await wal.rollbackFloor('s#t3',root)
  expect(await fs.readBytes('root.json')).toEqual(rootSnapshot)
  expect(await fs.readText('new.json')).toBeNull()
  expect(await fs.readBytes('binary.dat')).toEqual(binarySnapshot)
})

it.each(['records.jsonl','meta.json','rollback-progress.json'])('只读回滚预演拒绝损坏或恢复中的 %s，不把无效日志当回收依据',async name=> {
  const {wal,fs}=await fixture()
  await fs.writeText(`state/wal/s_t2/${name}`,'{broken')
  await expect(wal.rollbackSnapshot('s#t2','2.txt',Buffer.from('2'))).rejects.toThrow(/WAL|回滚|元数据/)
  expect(await fs.readText('2.txt')).toBe('2')
  expect(await fs.readText(`state/wal/s_t2/${name}`)).toBe('{broken')
})
