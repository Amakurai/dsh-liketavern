/** 回滚前展开受影响的归并谱系：摘要可重建，来源事实随原楼层撤销，旧格式同样适用。 */
import { isMemoryId, memorySourceIds, parseMemory } from './memory.js';
import { WorkspaceFs } from './workspaceFs.js';
/** Windows 的同名文件不区分大小写；只规范图节点身份，旧来源正文与 WAL 镜像保持原样。 */
function memoryIdentity(id) { return process.platform === 'win32' ? id.toLowerCase() : id; }
export async function expandAffectedMemories(root, paths) {
    const changed = new Set(paths.flatMap((path) => {
        const match = /^memory\/([^/]+)\.md$/.exec(memoryIdentity(path));
        return match && isMemoryId(match[1]) ? [memoryIdentity(match[1])] : [];
    }));
    if (!changed.size)
        return;
    const fs = new WorkspaceFs(root, null);
    const names = new Map();
    const rawEntries = new Map();
    // 摘要图必须完整：跳过链接来源会把相关摘要误判为独立事实，回滚应在写入前明确失败。
    for (const file of await fs.list('memory', { rejectLinks: true })) {
        const fileMatch = /^(?:archive\/)?([^/]+)\.md$/.exec(file);
        if (!fileMatch || !isMemoryId(fileMatch[1]))
            continue;
        const identity = memoryIdentity(fileMatch[1]);
        // 比较使用磁盘身份，实际读写仍用现存文件的拼写；活跃副本优先于归档副本。
        if (!names.has(identity) || !file.startsWith('archive/'))
            names.set(identity, fileMatch[1]);
        const text = await fs.readText(`memory/${file}`);
        if (text === null)
            continue;
        let entry;
        try {
            entry = parseMemory(file, text);
        }
        catch {
            continue; /* 损坏条目交由既有读取容错处理。 */
        }
        // 来源损坏必须在展开写入之前失败，不能把摘要误作独立事实后继续撤销来源。
        const sources = memorySourceIds(entry.sourceRange);
        // 归档删除中断可能留下双份。活跃副本即使已被人工修订为无来源，也必须覆盖
        // 归档旧链；只收非空来源会让旧链重新把人工正文当作派生摘要删除。
        if (!rawEntries.has(identity) || !entry.archived)
            rawEntries.set(identity, { id: entry.id, sources });
    }
    const canonicalId = (id) => names.get(memoryIdentity(id)) ?? id;
    const summaries = new Map([...rawEntries.values()].filter(entry => entry.sources.length)
        .map(({ id, sources }) => [canonicalId(id), sources.map(canonicalId)]));
    for (const [id, sources] of summaries) {
        if (sources.some(source => memoryIdentity(source) === memoryIdentity(id)))
            throw new Error('记忆归并来源存在循环，已停止回滚');
    }
    const invalid = new Set();
    let grew = true;
    while (grew) {
        grew = false;
        for (const [id, sources] of summaries) {
            if (!invalid.has(id) && sources.some((source) => changed.has(memoryIdentity(source)) || invalid.has(source))) {
                invalid.add(id);
                grew = true;
            }
        }
    }
    const visiting = new Set();
    const expanded = new Set();
    const restore = new Map();
    const sourcesToUnarchive = new Set();
    const postorder = [];
    // 先只读规划整张受影响来源图。共享中间摘要只能展开一次，不能处理完一个父摘要就删掉
    // 另一个父摘要仍需读取的来源；缺失与循环也必须在第一次正文修改之前拒绝。
    for (const rootId of invalid) {
        if (!(await fs.exists(`memory/${rootId}.md`)))
            continue;
        const pending = [{ id: rootId, exit: false }];
        while (pending.length) {
            const next = pending.pop();
            if (next.exit) {
                visiting.delete(next.id);
                expanded.add(next.id);
                postorder.push(next.id);
                continue;
            }
            if (expanded.has(next.id))
                continue;
            if (visiting.has(next.id))
                throw new Error('记忆归并来源存在循环，已停止回滚');
            visiting.add(next.id);
            pending.push({ id: next.id, exit: true });
            for (const source of summaries.get(next.id) ?? []) {
                if (!sourcesToUnarchive.has(source)) {
                    if (!(await fs.exists(`memory/${source}.md`))) {
                        const original = await fs.readText(`memory/archive/${source}.md`);
                        if (original === null)
                            throw new Error(`记忆归并来源 ${source} 缺失，已停止回滚`);
                        restore.set(source, original);
                    }
                    sourcesToUnarchive.add(source);
                }
                if (invalid.has(source))
                    pending.push({ id: source, exit: false });
            }
        }
    }
    // 全部来源恢复后才删除归档；I/O 失败时保留摘要和原文，重试可从活跃副本继续。
    for (const [id, original] of restore)
        await fs.writeText(`memory/${id}.md`, original);
    for (const id of sourcesToUnarchive)
        await fs.delete(`memory/archive/${id}.md`);
    // 逆后序确保所有父摘要先于共享子摘要删除，避免中途失败留下指向已删除子摘要的父级。
    for (const id of postorder.reverse()) {
        await fs.delete(`memory/${id}.md`);
        await fs.delete(`memory/archive/${id}.md`);
    }
}
