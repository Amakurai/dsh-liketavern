/** GENERATE 整轮扩张回归：已有长历史不占新增额度，全局尾注入及多个 basic 批次仍共用单轮净增边界。 */
import { describe,expect,it } from 'vitest'
import { defaultPreset } from '../src/core/assemble.js'
import { emptyTemplateScopes,type TemplateContext } from '../src/core/template.js'
import { DEFAULT_WI_SETTINGS,EMPTY_TIMER_STATE,type ChatMessage } from '../src/core/types.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'
import { isolated } from '../src/node/isolated.js'
import { parseLorebook } from '../src/state/lorebook.js'

function request(history:ChatMessage[],lore:Record<string,unknown>[]):ComputeJobs['assemble']['input'] {
  const preset=defaultPreset()
  const entries=parseLorebook({entries:lore.map((entry,index)=>({uid:index+1,constant:true,...entry}))},{source:'character',sourceRef:'factory'})
  const templates:TemplateContext={variables:emptyTemplateScopes(),char:'Factory',user:'User',card:{},entries,presets:preset.entries,
    history,historyIdentities:history.map((_,index)=>({messageId:`m${index}`,swipeId:0})),now:0,seed:1,phase:'generate'}
  return {preset,card:null,personaDescription:'',history,wi:null,memories:[],worldDeltas:[],regexRules:[],
    macroCtx:{char:'Factory',user:'User'},seed:1,budget:{maxTokens:10_000_000,reserveForOutput:0},templates,
    wiEvaluation:{entries,messages:history,settings:DEFAULT_WI_SETTINGS,timerState:EMPTY_TIMER_STATE,contextWindowTokens:10_000_000,reservedTokens:0,seed:1}}
}

describe('长历史中的单轮新增正文预算',()=> {
  it('全局 AFTER 不能借多条长历史的既有字数再新增超过 1 MiB',async()=> {
    const history:ChatMessage[]=Array.from({length:8},(_,index)=>({role:index%2?'assistant':'user',content:'x'.repeat(200_000)}))
    expect(history.reduce((sum,message)=>sum+message.content.length,0)).toBeGreaterThan(1024*1024)
    const input=request(history,[{comment:'[GENERATE:AFTER]',content:'<% print("z".repeat(1_150_000)) %>'}])
    await expect(isolated('assemble',input)).rejects.toThrow(/GENERATE 脚本新增输出超过 1 MiB/)
  },30_000)

  it('每个 basic 批次均未超额时，所有批次累积新增超过 1 MiB 仍拒绝整轮',async()=> {
    const history:ChatMessage[]=Array.from({length:1025},(_,index)=>({role:index%2?'assistant':'user',content:'abc'+'x'.repeat(1024)}))
    // 每批至多 512 条，各自新增 614400 字符；整轮新增 1230000 字符。
    const input=request(history,[{comment:'preload',content:'@@only_preload\n<% activateRegex(/abc/,"$&"+"z".repeat(1200),{uuid:"expand",basic:true}) %>'}])
    await expect(isolated('assemble',input)).rejects.toThrow(/GENERATE 正则新增输出超过 1 MiB/)
  },30_000)
})
