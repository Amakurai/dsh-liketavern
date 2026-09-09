/** 酒馆助手脚本资产归一化：兼容新旧角色卡字段，保留脚本正文但绝不在宿主执行。 */
import { helperJson, helperRecord } from './helperRuntime.js';
export function parseHelperScriptTrees(input, json = helperJson, record = helperRecord) {
    const value = json(input, 4 * 1024 * 1024);
    if (!Array.isArray(value) || value.length > 128)
        throw new Error('脚本树必须是至多 128 项的数组');
    const ids = new Set();
    let count = 0;
    const string = (value, fallback, max = 256) => {
        if (value === undefined)
            return fallback;
        if (typeof value !== 'string' || value.length > max)
            throw new Error('脚本字段不是文本或超过预算');
        return value;
    };
    const bool = (value, fallback) => { if (value === undefined)
        return fallback; if (typeof value !== 'boolean')
        throw new Error('脚本开关必须是布尔值'); return value; };
    const identity = (item, path) => {
        const id = string(item.id, `imported-${path}`);
        if (!id || ids.has(id))
            throw new Error('脚本或文件夹 ID 为空或重复');
        ids.add(id);
        return id;
    };
    const script = (raw, path) => {
        if (!record(raw) || ++count > 128)
            throw new Error('脚本无效或总数超过 128');
        const item = record(raw.value) ? raw.value : raw;
        if (item.type !== undefined && item.type !== 'script')
            throw new Error('文件夹不能嵌套');
        const button = item.button === undefined ? {} : item.button;
        if (!record(button))
            throw new Error('脚本按钮配置无效');
        const buttons = button.buttons ?? item.buttons ?? [];
        if (!Array.isArray(buttons) || buttons.length > 64)
            throw new Error('脚本按钮超过预算');
        const names = new Set();
        const parsed = buttons.map(value => {
            if (!record(value))
                throw new Error('脚本按钮无效');
            const name = string(value.name, '');
            if (!name || names.has(name))
                throw new Error('脚本按钮名称为空或重复');
            names.add(name);
            return { name, visible: bool(value.visible, true) };
        });
        const data = item.data ?? {}, exportWith = item.export_with ?? {};
        if (!record(data) || !record(exportWith))
            throw new Error('脚本初始变量或导出配置无效');
        return { type: 'script', id: identity(item, path), name: string(item.name, ''), enabled: bool(item.enabled, false),
            content: string(item.content, '', 256 * 1024), info: string(item.info, '', 64 * 1024), data,
            button: { enabled: bool(button.enabled, true), buttons: parsed }, export_with: { data: bool(exportWith.data, true), button: bool(exportWith.button, true) } };
    };
    return value.map((raw, index) => {
        if (!record(raw))
            throw new Error('脚本树条目无效');
        if (raw.type !== 'folder')
            return script(raw, String(index));
        const children = raw.scripts ?? raw.value ?? [];
        if (!Array.isArray(children))
            throw new Error('脚本文件夹内容必须是数组');
        return { type: 'folder', id: identity(raw, String(index)), name: string(raw.name, ''), enabled: bool(raw.enabled, raw.value !== undefined),
            icon: string(raw.icon, ''), color: string(raw.color, ''), scripts: children.map((child, childIndex) => script(child, `${index}-${childIndex}`)) };
    });
}
export function characterHelperSettings(extensions) {
    let settings = extensions.tavern_helper;
    if (Array.isArray(settings)) {
        const object = {};
        for (const pair of settings) {
            if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(pair[0]) || Object.hasOwn(object, pair[0]))
                throw new Error('旧版酒馆助手设置无效');
            object[pair[0]] = pair[1];
        }
        settings = object;
    }
    if (settings !== undefined && !helperRecord(settings))
        throw new Error('酒馆助手设置必须为对象');
    return helperRecord(settings) ? settings : { scripts: extensions.TavernHelper_scripts ?? [] };
}
/** 预设及导入设置只接受有界普通 JSON 对象，并统一脚本树格式。 */
export function helperScriptSettings(input) {
    const settings = helperJson(input, 4 * 1024 * 1024);
    if (!helperRecord(settings))
        throw new Error('酒馆助手设置必须为对象');
    return { ...settings, scripts: parseHelperScriptTrees(settings.scripts ?? []) };
}
export function characterHelperScripts(extensions) {
    return parseHelperScriptTrees(characterHelperSettings(extensions).scripts ?? []);
}
export function enabledHelperScripts(trees) {
    return trees.flatMap(tree => tree.type === 'script' ? (tree.enabled ? [tree] : []) : tree.enabled ? tree.scripts.filter(script => script.enabled) : []);
}
/** 三类资产共享一组脚本身份；禁止启用的同 ID 脚本混用变量和事件。 */
export function enabledHelperLibraries(libraries) {
    const scripts = libraries.flatMap(library => enabledHelperScripts(library.trees)), ids = new Set();
    for (const script of scripts) {
        if (ids.has(script.id))
            throw new Error(`启用的脚本 ID 重复：${script.id}`);
        ids.add(script.id);
    }
    return scripts;
}
/** 独立脚本、文件夹、脚本数组或 scripts 设置对象；拒绝把无关 JSON 悄悄导入成空脚本。 */
export function importHelperScriptFile(input) {
    const value = helperJson(input, 4 * 1024 * 1024);
    if (Array.isArray(value))
        return parseHelperScriptTrees(value);
    if (!helperRecord(value))
        throw new Error('文件不是酒馆助手脚本');
    if (value.type === 'script' || value.type === 'folder' || typeof value.content === 'string' || Object.hasOwn(value, 'value'))
        return parseHelperScriptTrees([value]);
    if (Array.isArray(value.scripts))
        return parseHelperScriptTrees(value.scripts);
    throw new Error('文件不是酒馆助手脚本');
}
/** 导出遵守作者的 data/button 标记，不把明确排除的数据夹带到导出文件。 */
export function exportHelperScriptTrees(input) {
    const script = (value) => ({ ...value, data: value.export_with.data ? value.data : {},
        button: value.export_with.button ? value.button : { enabled: true, buttons: [] } });
    return parseHelperScriptTrees(input).map(tree => tree.type === 'script' ? script(tree) : { ...tree, scripts: tree.scripts.map(script) });
}
