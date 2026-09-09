/** 卡面通知按会话和剧情双重隔离，卸载后不能再收到刷新通知。 */
import { expect,it,vi } from 'vitest'
import { notifyHelperStory,watchHelperStory } from '../src/client/helperNotifications.js'

it('只通知同会话同剧情的存活卡面，独立会话及分支互不触发',()=>{
  const first=vi.fn(),second=vi.fn(),branch=vi.fn(),other=vi.fn()
  const stops=[watchHelperStory('a','story',first),watchHelperStory('a','story',second),
    watchHelperStory('a','branch',branch),watchHelperStory('b','story',other)]
  try {
    notifyHelperStory('a','story')
    expect(first).toHaveBeenCalledOnce();expect(second).toHaveBeenCalledOnce()
    expect(branch).not.toHaveBeenCalled();expect(other).not.toHaveBeenCalled()
    stops[0]!();notifyHelperStory('a','story')
    expect(first).toHaveBeenCalledOnce();expect(second).toHaveBeenCalledTimes(2)
  } finally {for(const stop of stops) stop()}
  notifyHelperStory('a','story');expect(second).toHaveBeenCalledTimes(2)
})

/** 多气泡准备失败必须释放已完成及迟到的卡面锁，不能部分替换显示。 */
it('显示准备完成后才允许发布，取消及失败释放所有气泡，隔离其它会话',async()=>{
  const {registerHelperDisplay,prepareHelperDisplay}=await import('../src/client/helperDisplay.js')
  const a={check:vi.fn(),commit:vi.fn(),cancel:vi.fn()},b={check:vi.fn(),commit:vi.fn(),cancel:vi.fn()},other=vi.fn()
  const stops=[registerHelperDisplay('display',async()=>a),registerHelperDisplay('other',other)]
  const request={storyId:'story',historyRevision:'v',ids:[1]}
  try{
    const lease=await prepareHelperDisplay('display',request);expect(a.commit).not.toHaveBeenCalled();expect(other).not.toHaveBeenCalled()
    await expect(prepareHelperDisplay('display',request)).rejects.toThrow('busy')
    lease.commit();expect(a.commit).toHaveBeenCalledOnce();expect(a.cancel).not.toHaveBeenCalled()
    await expect(Promise.resolve().then(()=>lease.commit())).rejects.toThrow('stale')
    const failed=registerHelperDisplay('display',async()=>{throw Error('草稿未保存')})
    let release!:(value:typeof b)=>void;const late=registerHelperDisplay('display',()=>new Promise(resolve=>{release=resolve}))
    const next=prepareHelperDisplay('display',request),assertion=expect(next).rejects.toThrow(/草稿/)
    release(b);await assertion;expect(b.cancel).toHaveBeenCalledOnce();expect(b.commit).not.toHaveBeenCalled()
    failed();late();const retry=await prepareHelperDisplay('display',request);retry.cancel()
  }finally{for(const stop of stops)stop()}
})

it('显示准备超时可取消挂起读取，迟到成功不能再发布，下一次请求可继续',async()=>{
  const {registerHelperDisplay,prepareHelperDisplay,waitHelperDisplay}=await import('../src/client/helperDisplay.js')
  vi.useFakeTimers()
  let release!:(value:number)=>void
  const commit=vi.fn(),cancel=vi.fn()
  const stop=registerHelperDisplay('timeout',async(_request,signal)=>{await waitHelperDisplay(new Promise<number>(resolve=>release=resolve),signal);return {check:()=>{},commit,cancel}})
  try{
    const result=prepareHelperDisplay('timeout',{storyId:'story',historyRevision:'v',ids:null}),assertion=expect(result).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(25000);await assertion;release(1);await Promise.resolve();expect(commit).not.toHaveBeenCalled()
    stop();const retry=await prepareHelperDisplay('timeout',{storyId:'story',historyRevision:'v',ids:[]});retry.commit()
  }finally{stop();vi.useRealTimers()}
})
