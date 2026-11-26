/** 完整离线备份的文件边界：拒绝链接与跨平台路径别名，分块校验和复制，不输出私人路径。 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
export const BACKUP_LIMITS = { entries: 200_000, depth: 64, fileBytes: 64 * 1024 ** 3, totalBytes: 1024 ** 4,
    manifestBytes: 64 * 1024 ** 2, pathBytes: 32 * 1024 ** 2 };
export class BackupError extends Error {
    code;
    issues;
    constructor(code, issues) {
        super(code);
        this.code = code;
        this.name = 'BackupError';
        if (issues && issues.length > 0)
            this.issues = issues.map(issue => ({ ...issue }));
    }
}
export function fail(code, issues) { throw new BackupError(code, issues); }
function errorCode(error) { return error?.code; }
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
/** 包括传入根的祖先（或指定 boundary 向下），避免中间的 junction 把显式目录解析到其它数据树。 */
export async function assertDirectory(path, options) {
    const absolute = resolve(path);
    const isSet = options !== undefined && typeof options.has === 'function';
    const opts = isSet ? { verified: options } : (options ?? {});
    const verified = opts.verified;
    const mutableVerified = verified instanceof Set ? verified : undefined;
    if (opts.boundary !== undefined) {
        const boundary = resolve(opts.boundary);
        const rel = relative(boundary, absolute);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
            fail('UNSAFE_PATH');
        const targets = [boundary];
        let current = boundary;
        for (const part of rel.split(sep).filter(Boolean)) {
            current = join(current, part);
            targets.push(current);
        }
        for (const dir of targets) {
            if (verified?.has(dir))
                continue;
            const info = await lstat(dir);
            if (info.isSymbolicLink())
                fail('LINK_NOT_ALLOWED');
            if (!info.isDirectory())
                fail('DIRECTORY_REQUIRED');
            mutableVerified?.add(dir);
        }
        return;
    }
    const root = parse(absolute).root;
    let current = root;
    for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
        current = join(current, part);
        if (verified?.has(current))
            continue;
        const info = await lstat(current);
        if (info.isSymbolicLink())
            fail('LINK_NOT_ALLOWED');
        if (!info.isDirectory())
            fail('DIRECTORY_REQUIRED');
        mutableVerified?.add(current);
    }
}
/** Windows 的 libuv lstat 对目录和文件统一合成 0o666（缺目录 +x 且全员可写）；归一化为可移植私有 POSIX 权限位。 */
export function portableMode(kind, rawMode, platform = process.platform) {
    if (platform === 'win32') {
        const writable = (rawMode & 0o200) !== 0;
        return kind === 'directory' ? (writable ? 0o700 : 0o500) : (writable ? 0o600 : 0o400);
    }
    return rawMode & 0o777;
}
export function ancestorChainAbove(root) {
    const absolute = resolve(root);
    const fsRoot = parse(absolute).root;
    const chain = new Set();
    let current = fsRoot;
    const parts = relative(fsRoot, absolute).split(sep).filter(Boolean);
    for (let i = 0; i < parts.length - 1; i++) {
        current = join(current, parts[i]);
        chain.add(current);
    }
    return chain;
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
    const aPrefix = a.endsWith(sep) ? a : a + sep;
    const bPrefix = b.endsWith(sep) ? b : b + sep;
    if (a === b || a.startsWith(bPrefix) || b.startsWith(aPrefix))
        fail('NESTED_PATHS');
}
function sameFile(a, b, expectedNlink = 1) {
    const expected = BigInt(expectedNlink);
    return a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink() && a.nlink === expected && b.nlink === expected
        && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs
        && a.ctimeNs === b.ctimeNs && a.mode === b.mode;
}
/** 与宿主 app-boot 的共享 fallback、profile 私有 pnpm/投影目录保持同一精确布局。 */
export function isDependencyPath(path) {
    return path === 'profiles/node_modules' || /^profiles\/[^/]+\/(?:\.dsh-module-fallback\/)?node_modules$/.test(path);
}
export async function inventory(root, excludedDependencies) {
    await assertDirectory(root);
    const aboveRoot = ancestorChainAbove(root);
    const entries = [];
    const folded = new Set();
    let totalBytes = 0;
    let pathBytes = 0;
    async function visit(prefix) {
        const directory = prefix ? checkedPath(root, prefix) : root;
        await assertDirectory(directory, aboveRoot);
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
            const stamp = await lstat(checkedPath(root, path), { bigint: true });
            if (stamp.isSymbolicLink())
                fail('LINK_NOT_ALLOWED');
            if (!stamp.isDirectory() && !stamp.isFile())
                fail('SPECIAL_FILE_NOT_ALLOWED');
            const kind = stamp.isDirectory() ? 'directory' : 'file';
            if (kind === 'file' && stamp.nlink < 1n)
                fail('LINK_NOT_ALLOWED');
            if (kind === 'file' && (stamp.size < 0n || stamp.size > BigInt(BACKUP_LIMITS.fileBytes)))
                fail('SIZE_LIMIT');
            const size = kind === 'file' ? Number(stamp.size) : 0;
            if (!Number.isSafeInteger(size) || size < 0 || size > BACKUP_LIMITS.fileBytes)
                fail('SIZE_LIMIT');
            totalBytes += size;
            if (totalBytes > BACKUP_LIMITS.totalBytes)
                fail('SIZE_LIMIT');
            entries.push({ path, kind, size, mode: portableMode(kind, Number(stamp.mode)), stamp, expectedNlink: 1 });
            if (kind === 'directory')
                await visit(path);
        }
    }
    await visit('');
    await assertDirectory(root);
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    // 宿主文件附件在 attachments/v1/{file-objects,files}/ 间使用同根硬链接：只允许全部链接都落在
    // 当前根内的封闭硬链接组（nlink 严格等于组内数量），任何指向根外或排除目录的硬链接一律拒绝。
    const hardlinkGroups = new Map();
    for (const entry of entries) {
        if (entry.kind !== 'file' || entry.stamp.nlink === 1n)
            continue;
        const inodeKey = `${entry.stamp.dev}:${entry.stamp.ino}`;
        const group = hardlinkGroups.get(inodeKey);
        if (group)
            group.push(entry);
        else
            hardlinkGroups.set(inodeKey, [entry]);
    }
    let nextGroupId = 1;
    for (const members of hardlinkGroups.values()) {
        const count = BigInt(members.length);
        const first = members[0];
        if (members.length < 2 || members.some(m => m.stamp.nlink !== count || m.size !== first.size || m.mode !== first.mode)) {
            fail('LINK_NOT_ALLOWED');
        }
        const groupId = nextGroupId++;
        for (const member of members) {
            member.hardlinkGroup = groupId;
            member.expectedNlink = members.length;
        }
    }
    return entries;
}
/** 固定位置分块读取，完整检查前后文件身份；输出文件独占创建且同步后关闭。 */
export async function transferFile(root, entry, destination, verifiedAboveRoot, options) {
    const expectedNlink = options?.expectedNlink ?? 1;
    const path = checkedPath(root, entry.path);
    await assertDirectory(dirname(path), verifiedAboveRoot);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(expectedNlink))
        fail('LINK_NOT_ALLOWED');
    if (before.size !== BigInt(entry.size))
        fail('SOURCE_CHANGED');
    const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let target;
    try {
        if (!sameFile(before, await source.stat({ bigint: true }), expectedNlink))
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
        await assertDirectory(dirname(path), verifiedAboveRoot);
        if (position !== entry.size || !sameFile(before, await source.stat({ bigint: true }), expectedNlink)
            || !sameFile(before, await lstat(path, { bigint: true }), expectedNlink))
            fail('SOURCE_CHANGED');
        if (target) {
            if (!options?.deferChmod)
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
export async function boundedJson(path, maxBytes = BACKUP_LIMITS.manifestBytes, options) {
    await assertDirectory(dirname(path), options);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
        fail('LINK_NOT_ALLOWED');
    if (before.size > BigInt(maxBytes))
        fail('METADATA_LIMIT');
    const size = Number(before.size);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        if (!sameFile(before, await handle.stat({ bigint: true })))
            fail('SOURCE_CHANGED');
        const chunks = [];
        let position = 0;
        while (position <= size) {
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size + 1 - position));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (!bytesRead)
                break;
            chunks.push(buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
        if (position !== size || !sameFile(before, await handle.stat({ bigint: true })) || !sameFile(before, await lstat(path, { bigint: true })))
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
/** 会话迁移读原始字节：限额在读取前后都生效，并复核句柄与目录项仍为同一普通文件。 */
export async function boundedBytes(path, maxBytes, options) {
    await assertDirectory(dirname(path), options);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
        fail('LINK_NOT_ALLOWED');
    if (before.size > BigInt(maxBytes))
        fail('SIZE_LIMIT');
    const size = Number(before.size);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        if (!sameFile(before, await handle.stat({ bigint: true })))
            fail('SOURCE_CHANGED');
        const chunks = [];
        let position = 0;
        while (position <= size) {
            const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size + 1 - position));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
            if (!bytesRead)
                break;
            chunks.push(buffer.subarray(0, bytesRead));
            position += bytesRead;
        }
        if (position !== size || !sameFile(before, await handle.stat({ bigint: true })) || !sameFile(before, await lstat(path, { bigint: true })))
            fail('SOURCE_CHANGED');
        return Buffer.concat(chunks, position);
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
/** 失败草稿可能已经套用源目录的只读权限或内部硬链接；仅在自有、无外链草稿内恢复清理所需权限。 */
export async function discardTemporary(root) {
    const files = [];
    async function scan(path) {
        await assertDirectory(dirname(path));
        const info = await lstat(path, { bigint: true });
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
            fail('UNSAFE_CLEANUP');
        if (info.isDirectory()) {
            await chmod(path, 0o700);
            for await (const entry of await opendir(path)) {
                if (!safeRelative(entry.name))
                    fail('UNSAFE_CLEANUP');
                await scan(join(path, entry.name));
            }
        }
        else {
            if (info.nlink < 1n)
                fail('UNSAFE_CLEANUP');
            files.push({ path, info });
        }
    }
    await scan(root);
    const hardlinks = new Map();
    for (const item of files) {
        if (item.info.nlink === 1n)
            continue;
        const key = `${item.info.dev}:${item.info.ino}`;
        const group = hardlinks.get(key);
        if (group)
            group.push(item);
        else
            hardlinks.set(key, [item]);
    }
    for (const group of hardlinks.values()) {
        const count = BigInt(group.length);
        if (group.some(item => item.info.nlink !== count))
            fail('UNSAFE_CLEANUP');
    }
    for (const item of files)
        await chmod(item.path, 0o600);
    await rm(root, { recursive: true, force: true });
}
