/** 完整离线备份的文件边界：拒绝链接与跨平台路径别名，分块校验和复制，不输出私人路径。 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
export const BACKUP_LIMITS = { entries: 200_000, depth: 64, fileBytes: 64 * 1024 ** 3, totalBytes: 1024 ** 4,
    manifestBytes: 64 * 1024 ** 2, pathBytes: 32 * 1024 ** 2 };
export class BackupError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = 'BackupError';
    }
}
export function fail(code) { throw new BackupError(code); }
export function errorCode(error) { return error?.code; }
export function safeRelative(path) {
    if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\\') || isAbsolute(path))
        return false;
    const parts = path.split('/');
    return parts.length <= BACKUP_LIMITS.depth && parts.every(part => part.length > 0 && part.length <= 255
        && part !== '.' && part !== '..' && !/[<>:"|?*\u0000-\u001f\u007f]/.test(part) && !/[. ]$/.test(part)
        && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
export function checkedPath(root, path) {
    if (!safeRelative(path))
        fail('UNSAFE_PATH');
    const child = resolve(root, ...path.split('/'));
    const rel = relative(root, child);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel))
        fail('UNSAFE_PATH');
    return child;
}
/** 包括传入根的祖先，避免中间的 junction 把显式目录解析到其它数据树。 */
export async function assertDirectory(path) {
    const absolute = resolve(path);
    const root = parse(absolute).root;
    let current = root;
    for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
        current = join(current, part);
        const info = await lstat(current);
        if (info.isSymbolicLink())
            fail('LINK_NOT_ALLOWED');
        if (!info.isDirectory())
            fail('DIRECTORY_REQUIRED');
    }
}
export async function assertAbsent(path) {
    try {
        await lstat(path);
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return;
        throw error;
    }
    fail('TARGET_EXISTS');
}
export function assertSeparate(left, right) {
    const a = resolve(left).toLocaleLowerCase('en-US');
    const b = resolve(right).toLocaleLowerCase('en-US');
    if (a === b || a.startsWith(b + sep) || b.startsWith(a + sep))
        fail('NESTED_PATHS');
}
function sameFile(a, b) {
    return a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() && a.nlink === 1 && b.nlink === 1
        && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
        && a.ctimeMs === b.ctimeMs && a.mode === b.mode;
}
/** 与宿主 app-boot 的共享 fallback、profile 私有 pnpm/投影目录保持同一精确布局。 */
export function isDependencyPath(path) {
    return path === 'profiles/node_modules' || /^profiles\/[^/]+\/(?:\.dsh-module-fallback\/)?node_modules$/.test(path);
}
export async function inventory(root, excludedDependencies) {
    await assertDirectory(root);
    const entries = [];
    const folded = new Set();
    let totalBytes = 0;
    let pathBytes = 0;
    async function visit(prefix) {
        const directory = prefix ? checkedPath(root, prefix) : root;
        await assertDirectory(directory);
        for await (const entry of await opendir(directory)) {
            const path = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (!safeRelative(path))
                fail('UNSAFE_PATH');
            pathBytes += Buffer.byteLength(path);
            if (pathBytes > BACKUP_LIMITS.pathBytes)
                fail('METADATA_LIMIT');
            const key = path.normalize('NFC').toLocaleLowerCase('en-US');
            if (folded.has(key))
                fail('PATH_COLLISION');
            folded.add(key);
            if (excludedDependencies && isDependencyPath(path)) {
                excludedDependencies.push(path);
                continue;
            }
            if (entries.length >= BACKUP_LIMITS.entries)
                fail('ENTRY_LIMIT');
            const stamp = await lstat(checkedPath(root, path));
            if (stamp.isSymbolicLink() || (stamp.isFile() && stamp.nlink !== 1))
                fail('LINK_NOT_ALLOWED');
            if (!stamp.isDirectory() && !stamp.isFile())
                fail('SPECIAL_FILE_NOT_ALLOWED');
            const kind = stamp.isDirectory() ? 'directory' : 'file';
            const size = kind === 'file' ? stamp.size : 0;
            if (!Number.isSafeInteger(size) || size < 0 || size > BACKUP_LIMITS.fileBytes)
                fail('SIZE_LIMIT');
            totalBytes += size;
            if (totalBytes > BACKUP_LIMITS.totalBytes)
                fail('SIZE_LIMIT');
            entries.push({ path, kind, size, mode: stamp.mode & 0o777, stamp });
            if (kind === 'directory')
                await visit(path);
        }
    }
    await visit('');
    return entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
/** 固定位置分块读取，完整检查前后文件身份；输出文件独占创建且同步后关闭。 */
export async function transferFile(root, entry, destination) {
    const path = checkedPath(root, entry.path);
    await assertDirectory(dirname(path));
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
        fail('LINK_NOT_ALLOWED');
    if (before.size !== entry.size)
        fail('SOURCE_CHANGED');
    const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let target;
    try {
        if (!sameFile(before, await source.stat()))
            fail('SOURCE_CHANGED');
        if (destination)
            target = await open(destination, 'wx', 0o600);
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(128 * 1024);
        let position = 0;
        while (position <= entry.size) {
            const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, entry.size + 1 - position), position);
            if (!bytesRead)
                break;
            if (position + bytesRead > entry.size)
                fail('SOURCE_CHANGED');
            hash.update(buffer.subarray(0, bytesRead));
            if (target) {
                let written = 0;
                while (written < bytesRead) {
                    const result = await target.write(buffer, written, bytesRead - written, position + written);
                    if (!result.bytesWritten)
                        fail('WRITE_FAILED');
                    written += result.bytesWritten;
                }
            }
            position += bytesRead;
        }
        await assertDirectory(dirname(path));
        if (position !== entry.size || !sameFile(before, await source.stat()) || !sameFile(before, await lstat(path)))
            fail('SOURCE_CHANGED');
        if (target) {
            await target.chmod(entry.mode);
            await target.sync();
        }
        return hash.digest('hex');
    }
    finally {
        await source.close();
        await target?.close();
    }
}
export async function boundedJson(path, maxBytes = BACKUP_LIMITS.manifestBytes) {
    await assertDirectory(dirname(path));
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
        fail('LINK_NOT_ALLOWED');
    if (before.size > maxBytes)
        fail('METADATA_LIMIT');
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        if (!sameFile(before, await handle.stat()))
            fail('SOURCE_CHANGED');
        const chunks = [];
        let position = 0;
        while (position <= before.size) {
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, before.size + 1 - position));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (!bytesRead)
                break;
            chunks.push(buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
        if (position !== before.size || !sameFile(before, await handle.stat()) || !sameFile(before, await lstat(path)))
            fail('SOURCE_CHANGED');
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch {
            return fail('INVALID_JSON');
        }
    }
    finally {
        await handle.close();
    }
}
export async function createDirectories(root, entries) {
    for (const entry of entries)
        if (entry.kind === 'directory')
            await mkdir(checkedPath(root, entry.path), { mode: 0o700 });
}
/** 失败草稿可能已经套用源目录的只读权限；仅在自有、无链接草稿内恢复清理所需权限。 */
export async function discardTemporary(root) {
    async function writable(path) {
        await assertDirectory(dirname(path));
        const info = await lstat(path);
        if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)))
            fail('UNSAFE_CLEANUP');
        await chmod(path, info.isDirectory() ? 0o700 : 0o600);
        if (info.isDirectory()) {
            for await (const entry of await opendir(path)) {
                if (!safeRelative(entry.name))
                    fail('UNSAFE_CLEANUP');
                await writable(join(path, entry.name));
            }
        }
    }
    await writable(root);
    await rm(root, { recursive: true, force: true });
}
