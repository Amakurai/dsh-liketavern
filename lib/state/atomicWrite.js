/**
 * 同目录临时文件落盘后替换目标，避免正文或 WAL 被截断；失败保留原文件。
 * 临时文件使用固定短前缀，避免合法长目标名再追加后缀后超过文件系统上限。
 * 进程在替换前崩溃会留下 `.dsh-tavern-write.<uuid>.tmp`，打开数据目录时回收；兼容旧目标名格式。
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
/** 只匹配本模块生成的临时文件名，不碰用户或其它程序的 .tmp。 */
const ORPHAN_TEMP = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
/** 正常写入只持有临时文件几毫秒；超过该时长的一定是崩溃遗留，清理不需要与写入互斥。 */
export const ORPHAN_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
export async function atomicWrite(path, data) {
    await mkdir(dirname(path), { recursive: true });
    const temp = join(dirname(path), `.dsh-tavern-write.${randomUUID()}.tmp`);
    let owned = false;
    try {
        const file = await open(temp, 'wx');
        owned = true;
        try {
            await file.writeFile(data);
            await file.sync();
        }
        catch (error) {
            // 保留最先发生的写入/同步错误；关闭和清理只做尽力收尾。
            await file.close().catch(() => { });
            throw error;
        }
        await file.close();
        await rename(temp, path);
        // rename 已经移走临时文件并提交正文，不再追加可能把成功改报失败的文件操作。
    }
    catch (error) {
        // wx 失败时未取得文件所有权；即使碰撞也不能删除其它调用的临时文件。
        if (owned)
            await rm(temp, { force: true }).catch(() => { });
        throw error;
    }
}
/**
 * 递归删除 dir 下超龄的原子写临时文件，返回删除数。不跟随链接；skipDir 以正斜杠相对路径
 * 排除整棵子树（例如由各自剧情打开时清理的 stories/）。目录不存在视为无事可做。
 */
export async function sweepOrphanTemps(dir, options) {
    const cutoff = (options?.now ?? Date.now()) - (options?.maxAgeMs ?? ORPHAN_TEMP_MAX_AGE_MS);
    let removed = 0;
    const walk = async (abs, rel) => {
        let entries;
        try {
            // readdir 会跟随入口链接；根目录也必须检查，递归时再复核一次目录身份。
            // 只检查本工作区入口，不拒绝安装路径祖先的正常挂载。
            if ((await lstat(abs)).isSymbolicLink())
                return;
            entries = await readdir(abs, { withFileTypes: true });
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        for (const entry of entries) {
            const childRel = rel ? `${rel}/${entry.name}` : entry.name;
            const child = join(abs, entry.name);
            if (entry.isDirectory()) {
                if (!options?.skipDir?.(childRel))
                    await walk(child, childRel);
                continue;
            }
            if (!entry.isFile() || !ORPHAN_TEMP.test(entry.name))
                continue;
            const info = await lstat(child).catch((error) => {
                if (error.code === 'ENOENT')
                    return null;
                throw error;
            });
            if (!info?.isFile() || info.mtimeMs > cutoff)
                continue;
            await rm(child, { force: true });
            removed += 1;
        }
    };
    // 去掉末尾分隔符，避免 lstat 在部分平台把链接入口当成目标目录。
    await walk(resolve(dir), '');
    return removed;
}
