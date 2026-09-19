/**
 * 一次提示词组装中的宏变量来源追踪。只分析文本，不展开宏或执行模板；变量值仍由
 * expandMacros 按原顺序写入。动态来源写入的变量及其传递读取归入本轮通道，纯静态
 * set/get 保留前缀缓存；后续独立的静态赋值可以恢复该变量的稳定性。
 */
import { hasTurnLocalMacros } from './macros.js';
export function createMacroDependencyTracker(initial, potentialSources = []) {
    // 调用方提供的变量没有静态资产来源保证，不能作为跨轮稳定值。
    const dynamicVariables = new Set(initial.store?.keys());
    // 潜在的条件写入不能因当前未命中或默认值赋值而清除，否则首轮会钉死空/default。
    const potentialVariables = new Set();
    let unknownDynamicWrite = false;
    const inspect = (text, context) => {
        const result = { dynamic: false, reads: new Set(), writes: new Set(), unknownWrite: false };
        const fields = {
            ...context.vars,
            char: context.char, charname: context.char, user: context.user, username: context.user,
            description: context.description, personality: context.personality, scenario: context.scenario,
            persona: context.persona, firstmessage: context.firstMessage, charfirstmessage: context.firstMessage,
            charprompt: context.charPrompt, charinstruction: context.charInstruction,
        };
        const pending = [text];
        const visited = new Set();
        while (pending.length > 0) {
            const current = pending.pop();
            if (hasTurnLocalMacros(current))
                result.dynamic = true;
            // 扫描宏开头而不吞掉整个正文，嵌套 set/get 同样能逐个看到；不执行随机数与写入。
            for (const match of current.matchAll(/\{\{\s*(getvar|getlocalvar|getglobalvar)\s*::([^{}]*)(?=\{\{|\}\})/gi)) {
                const key = match[2].trim();
                const computed = current.slice(match.index + match[0].length, match.index + match[0].length + 2) === '{{';
                result.reads.add(key);
                if (computed || unknownDynamicWrite || dynamicVariables.has(key) || potentialVariables.has(key))
                    result.dynamic = true;
            }
            for (const match of current.matchAll(/\{\{\s*(setvar|setlocalvar|setglobalvar|addvar)\s*::([^{}]*?)(?=::|\{\{|\}\})/gi)) {
                const key = match[2].trim();
                const computed = current.slice(match.index + match[0].length, match.index + match[0].length + 2) === '{{';
                if (computed)
                    result.unknownWrite = true;
                else if (key) {
                    result.writes.add(key);
                    if (match[1].toLowerCase() === 'addvar') {
                        result.reads.add(key);
                        if (unknownDynamicWrite || dynamicVariables.has(key) || potentialVariables.has(key))
                            result.dynamic = true;
                    }
                }
            }
            // 字段与 original 可以继续引用字段或变量。每个名称只访问一次，循环不递归展开。
            for (const match of current.matchAll(/\{\{\s*([^{}:]+?)\s*\}\}/g)) {
                const name = match[1].trim().toLowerCase();
                if (visited.has(name) || !Object.hasOwn(fields, name))
                    continue;
                visited.add(name);
                if (fields[name])
                    pending.push(fields[name]);
            }
        }
        return result;
    };
    // 所有候选来源只解析一次。通过变量→读取来源的反向边传播，条目是否在当前轮命中
    // 不改变 standing 的成员；独立的静态预设变量不会被一起降为动态。
    const candidates = potentialSources.map(source => ({ ...inspect(source.text, initial), turnLocal: source.turnLocal }));
    const readers = new Map();
    for (const [index, candidate] of candidates.entries()) {
        for (const key of candidate.reads) {
            const list = readers.get(key) ?? [];
            list.push(index);
            readers.set(key, list);
        }
    }
    const pending = candidates.flatMap((candidate, index) => candidate.turnLocal || candidate.dynamic ? [index] : []);
    const propagated = new Set();
    for (let cursor = 0; cursor < pending.length; cursor++) {
        const index = pending[cursor];
        if (propagated.has(index))
            continue;
        propagated.add(index);
        const candidate = candidates[index];
        if (candidate.unknownWrite && !unknownDynamicWrite) {
            unknownDynamicWrite = true;
            candidates.forEach((value, reader) => { if (value.reads.size)
                pending.push(reader); });
        }
        for (const key of candidate.writes) {
            if (potentialVariables.has(key))
                continue;
            potentialVariables.add(key);
            pending.push(...(readers.get(key) ?? []));
        }
    }
    return {
        isDynamic: (text, context) => inspect(text, context).dynamic,
        record: (text, context, turnLocal) => {
            const dependencies = inspect(text, context);
            // 计算出来的变量名在不执行宏的前提下不可知，后续读取保守使用本轮上下文。
            if (dependencies.unknownWrite)
                unknownDynamicWrite = true;
            for (const key of dependencies.writes) {
                if (turnLocal || dependencies.dynamic)
                    dynamicVariables.add(key);
                else
                    dynamicVariables.delete(key);
            }
        },
    };
}
