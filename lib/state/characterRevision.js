/** 资产编辑的乐观并发版本：比较实际保存内容，不把其它资产修订混入编辑冲突。 */
import { createHash } from 'node:crypto';
export function characterEditRevision(card) {
    const fields = ['name', 'description', 'personality', 'scenario', 'firstMes',
        'alternateGreetings', 'mesExample', 'systemPrompt', 'postHistoryInstructions',
        'creatorNotes', 'creator', 'characterVersion', 'tags', 'depthPrompt'];
    const content = fields.map(key => card[key] ?? null);
    return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
/** 人设编辑同样按用户可编辑字段生成版本；传输版本不写回资产，缺省世界书与 null 等价。 */
export function personaEditRevision(persona) {
    return createHash('sha256').update(JSON.stringify([
        persona.id, persona.name, persona.description, persona.avatar, persona.lorebookId ?? null,
    ])).digest('hex');
}
/** 整表正则版本保留规则顺序与全部执行字段，避免只改名称或开关时覆盖另一窗口的匹配式。 */
export function regexEditRevision(rules) {
    const fields = ['id', 'name', 'find', 'replace', 'enabled', 'scopes', 'timing', 'minDepth',
        'maxDepth', 'substituteRegex', 'source', 'roles', 'trimStrings', 'trimStringsRegex'];
    return createHash('sha256').update(JSON.stringify(rules.map(rule => fields.map(key => rule[key] ?? null)))).digest('hex');
}
/** 世界书版本来自实际读取/写入的完整 JSON，包含当前绑定及保留副本，不能只比较可见条目。 */
export function jsonEditRevision(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
/** 脚本库有独立版本且由保存端保留；其余预设字段（包括扩展字段）都参与冲突校验。 */
export function presetEditRevision(preset) {
    const { helperSettings: _helper, ...content } = preset;
    return jsonEditRevision(content);
}
