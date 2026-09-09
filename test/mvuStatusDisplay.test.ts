/** 状态栏补位只影响明确启用的角色展示规则，已有占位符与禁用/其它作用域不会补位。 */
import {expect,it} from 'vitest'
import {needsMvuStatusPlaceholder,MVU_STATUS_PLACEHOLDER} from '../src/core/mvuStatusDisplay.js'
import type {RegexRule} from '../src/core/types.js'
const rule:RegexRule={id:'status',name:'Status',find:MVU_STATUS_PLACEHOLDER,replace:'<div>Status</div>',enabled:true,scopes:['output'],timing:['render'],minDepth:null,maxDepth:null,substituteRegex:0,source:'card'}
it('明确的角色状态栏在普通正文缺少占位符时补位，已存在时不重复',()=>{
 expect(needsMvuStatusPlaceholder('正文',[rule])).toBe(true)
 expect(needsMvuStatusPlaceholder('正文'+MVU_STATUS_PLACEHOLDER,[rule])).toBe(false)
 for(const patch of [{enabled:false},{source:'preset' as const},{scopes:['prompt'] as RegexRule['scopes']},{timing:['send'] as RegexRule['timing']},{roles:['user'] as RegexRule['roles']},{minDepth:1},{maxDepth:2},{find:'unrelated'},{replace:''}])expect(needsMvuStatusPlaceholder('正文',[{...rule,...patch}])).toBe(false)
})
