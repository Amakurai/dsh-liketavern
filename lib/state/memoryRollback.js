/** 回滚前展开受影响的归并谱系：摘要可重建，来源事实随原楼层撤销，旧格式同样适用。 */
import { parseMemory } from './memory.js';
import { WorkspaceFs } from './workspaceFs.js';
export async function expandAffectedMemories(root, paths) {
    const changed = new Set(paths.flatMap((path) => {
        const match = /^memory\/([A-Za-z0-9_-]+)\.md$/.exec(path);
        return match ? [match[1]] : [];
    }));
    if (!changed.size)
        return;
    const fs = new WorkspaceFs(root, null);
    const summaries = new Map();
    for (const file of await fs.list('memory')) {
        if (!/^(?:archive\/)?[A-Za-z0-9_-]+\.md$/.test(file))
            continue;
        const text = await fs.readText(`memory/${file}`);
        if (text === null)
            continue;
        try {
            const entry = parseMemory(file, text);
            const match = /^(?:compress|merge):(.+)$/.exec(entry.sourceRange);
            if (!match)
                continue;
            const ids = match[1].split(',');
            if (ids.length && ids.every((id) => /^[A-Za-z0-9_-]+$/.test(id) && id !== entry.id))
                summaries.set(entry.id, ids);
        }
        catch { /* 损坏条目交由既有读取容错处理。 */ }
    }
    const invalid = new Set();
    let grew = true;
    while (grew) {
        grew = false;
        for (const [id, sources] of summaries) {
            if (!invalid.has(id) && sources.some((source) => changed.has(source) || invalid.has(source))) {
                invalid.add(id);
                grew = true;
            }
        }
    }
    const visiting = new Set();
    const expanded = new Set();
    const expand = async (id) => {
        if (expanded.has(id))
            return;
        if (visiting.has(id))
            throw new Error('记忆归并来源存在循环，已停止回滚');
        visiting.add(id);
        const sources = summaries.get(id) ?? [];
        // 所有来源先恢复成功，才移除摘要；中途 I/O 失败只产生暂时重复，不丢事实。
        for (const source of sources) {
            const active = `memory/${source}.md`;
            const archive = `memory/archive/${source}.md`;
            if (!(await fs.exists(active))) {
                const original = await fs.readText(archive);
                if (original === null)
                    throw new Error(`记忆归并来源 ${source} 缺失，已停止回滚`);
                await fs.writeText(active, original);
            }
        }
        for (const source of sources)
            await fs.delete(`memory/archive/${source}.md`);
        await fs.delete(`memory/${id}.md`);
        await fs.delete(`memory/archive/${id}.md`);
        expanded.add(id);
        for (const source of sources)
            if (invalid.has(source))
                await expand(source);
        visiting.delete(id);
    };
    // 从当前活跃摘要向下展开；归档摘要由父级恢复，未受影响的归并保持原样。
    for (const id of invalid)
        if (await fs.exists(`memory/${id}.md`))
            await expand(id);
}
