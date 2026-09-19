/** 角色管理与新会话选择器共用字面搜索；名称、书名、作者和每个标签分别匹配，不执行输入正则。 */
import type { CharacterSummary } from './types.js';
export declare function matchesCharacterSearch(card: CharacterSummary, query: string): boolean;
