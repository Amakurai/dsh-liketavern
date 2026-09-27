/** 原生 MVU 的状态栏展示补位：只补已启用角色正则明确声明的占位符，不改原文、提示词或剧情变量。 */
import type {RegexRule} from './types.js'
export const MVU_STATUS_PLACEHOLDER='<StatusPlaceHolderImpl/>'
/** 单条展示不知道消息深度，只给不限深度的规则补位；与 applyRegexToMessages 一致，负数（ST 的 -1）与 minDepth 0 均为不限。 */
function unlimitedDepth(rule:RegexRule):boolean {
  return (rule.minDepth===null||rule.minDepth<=0)&&(rule.maxDepth===null||rule.maxDepth<0)
}
export function needsMvuStatusPlaceholder(text:string,rules:RegexRule[]):boolean {
  if(text.includes('StatusPlaceHolderImpl'))return false
  return rules.some(rule=>rule.source==='card'&&rule.enabled&&rule.find===MVU_STATUS_PLACEHOLDER&&Boolean(rule.replace.trim())&&rule.scopes.includes('output')&&rule.timing.includes('render')&&(!rule.roles?.length||rule.roles.includes('assistant'))&&unlimitedDepth(rule))
}
