/** 关于与用户主动更新检查：只读本地版本；联网仅访问固定 GitHub 发布端点，不执行安装或返回本机路径。 */
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPOSITORY = 'https://github.com/Amakurai/dsh-liketavern';
const RELEASE_API = 'https://api.github.com/repos/Amakurai/dsh-liketavern/releases/latest';
const RAW_PACKAGE_ROOT = 'https://raw.githubusercontent.com/Amakurai/dsh-liketavern/';
const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 9_000;
const METADATA_ERROR = '插件或宿主版本元数据无效，无法检查更新';
const NETWORK_ERROR = '无法读取 GitHub 更新信息，请稍后重试';
const TIMEOUT_ERROR = '检查 GitHub 更新超时，请稍后重试';
const INVALID_RELEASE_ERROR = 'GitHub 发布元数据无效，已停止更新检查';
const PUBLIC_NETWORK_ERRORS = new Set([NETWORK_ERROR, TIMEOUT_ERROR, INVALID_RELEASE_ERROR,
    'GitHub 尚无可用正式发布，或发布文件不存在', 'GitHub 更新检查请求过于频繁，请稍后重试', 'GitHub 更新信息超过 256 KiB 上限']);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function semver(value, message) {
    if (typeof value !== 'string' || value.length > 256)
        throw new Error(message);
    const match = VERSION.exec(value);
    if (!match)
        throw new Error(message);
    const prerelease = match[4]?.split('.') ?? [];
    if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0')))
        throw new Error(message);
    return { value, core: [match[1], match[2], match[3]], prerelease };
}
function numeric(left, right) { return left.length !== right.length ? Math.sign(left.length - right.length) : left === right ? 0 : left < right ? -1 : 1; }
/** 按 SemVer 优先级比较，不把大整数转为浮点数；build metadata 不参与排序。 */
function compare(left, right) {
    for (let index = 0; index < 3; index++) {
        const order = numeric(left.core[index], right.core[index]);
        if (order)
            return order;
    }
    if (!left.prerelease.length || !right.prerelease.length)
        return left.prerelease.length ? -1 : right.prerelease.length ? 1 : 0;
    for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
        const a = left.prerelease[index], b = right.prerelease[index];
        if (a === b)
            continue;
        if (a === undefined)
            return -1;
        if (b === undefined)
            return 1;
        const aNumeric = /^\d+$/.test(a), bNumeric = /^\d+$/.test(b);
        if (aNumeric && bNumeric)
            return numeric(a, b);
        if (aNumeric !== bNumeric)
            return aNumeric ? -1 : 1;
        return a < b ? -1 : 1;
    }
    return 0;
}
function packageVersions(value, error) {
    if (!object(value) || value.name !== 'dsh-liketavern' || !object(value.peerDependencies))
        throw new Error(error);
    return { version: semver(value.version, error), host: semver(value.peerDependencies['@deepseek-ai/dsh'], error) };
}
async function localJson(path) {
    const file = await open(path, 'r');
    try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_RESPONSE_BYTES)
            throw new Error(METADATA_ERROR);
        const chunks = [];
        let length = 0;
        while (length <= MAX_RESPONSE_BYTES) {
            const buffer = Buffer.allocUnsafe(Math.min(16 * 1024, MAX_RESPONSE_BYTES + 1 - length));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, length);
            if (!bytesRead)
                break;
            length += bytesRead;
            if (length > MAX_RESPONSE_BYTES)
                throw new Error(METADATA_ERROR);
            chunks.push(buffer.subarray(0, bytesRead));
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    finally {
        await file.close();
    }
}
async function readInstalledMetadata() {
    const sourceCheckout = await lstat(fileURLToPath(new URL('../../.git', import.meta.url))).then(() => true, (error) => {
        if (error.code === 'ENOENT')
            return false;
        throw new Error(METADATA_ERROR);
    });
    const [plugin, host] = await Promise.all([
        localJson(fileURLToPath(new URL('../../package.json', import.meta.url))),
        readHostEntryMetadata(process.argv[1]),
    ]);
    return { plugin, host, sourceCheckout };
}
/** 仅从本次 Node 主入口确认宿主；插件旁的开发依赖、PATH 里的其它 dsh 都不能冒充当前运行版本。 */
export async function readHostEntryMetadata(entry) {
    if (!entry)
        return null;
    try {
        const actualEntry = await realpath(resolve(entry));
        let directory = dirname(actualEntry);
        for (let depth = 0; depth < 8; depth++) {
            let manifest;
            try {
                manifest = await localJson(join(directory, 'package.json'));
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    return null;
                const parent = dirname(directory);
                if (parent === directory)
                    return null;
                directory = parent;
                continue;
            }
            // 最近的包拥有入口；不穿过自定义 launcher 的 package.json 再猜它可能加载了哪个宿主。
            if (!object(manifest) || manifest.name !== '@deepseek-ai/dsh' || !object(manifest.bin)
                || typeof manifest.bin.dsh !== 'string' || !manifest.bin.dsh || isAbsolute(manifest.bin.dsh))
                return null;
            const declared = resolve(directory, manifest.bin.dsh), child = relative(directory, declared);
            if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child))
                return null;
            const actualBin = await realpath(declared);
            const normalize = (path) => process.platform === 'win32' ? path.toLowerCase() : path;
            if (normalize(actualEntry) !== normalize(actualBin))
                return null;
            semver(manifest.version, METADATA_ERROR);
            return manifest;
        }
    }
    catch {
        return null;
    }
    return null;
}
function cancel(body) { if (body)
    void body.cancel().catch(() => { }); }
async function responseJson(response, signal) {
    if (response.status !== 200 || response.redirected) {
        cancel(response.body);
        if (response.status === 404)
            throw new Error('GitHub 尚无可用正式发布，或发布文件不存在');
        if (response.status === 429)
            throw new Error('GitHub 更新检查请求过于频繁，请稍后重试');
        throw new Error(NETWORK_ERROR);
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
        cancel(response.body);
        throw new Error('GitHub 更新信息超过 256 KiB 上限');
    }
    if (!response.body)
        throw new Error(INVALID_RELEASE_ERROR);
    const reader = response.body.getReader(), chunks = [];
    const stop = () => { void reader.cancel().catch(() => { }); };
    signal.addEventListener('abort', stop, { once: true });
    let bytes = 0;
    try {
        for (;;) {
            if (signal.aborted)
                throw new Error(TIMEOUT_ERROR);
            const result = await reader.read();
            if (result.done)
                break;
            bytes += result.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES)
                throw new Error('GitHub 更新信息超过 256 KiB 上限');
            chunks.push(result.value);
        }
        if (signal.aborted)
            throw new Error(TIMEOUT_ERROR);
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        catch {
            throw new Error(INVALID_RELEASE_ERROR);
        }
    }
    finally {
        signal.removeEventListener('abort', stop);
        stop();
        reader.releaseLock();
    }
}
export function createPluginAboutReader(options = {}) {
    const fetcher = options.fetch ?? globalThis.fetch;
    const metadata = options.readMetadata ?? readInstalledMetadata;
    const timeoutMs = typeof options.timeoutMs === 'number' && Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
        ? Math.min(options.timeoutMs, TIMEOUT_MS) : TIMEOUT_MS;
    let inflight;
    const getPluginAbout = async () => {
        try {
            const raw = await metadata(), current = packageVersions(raw.plugin, METADATA_ERROR);
            if ((raw.host !== null && (!object(raw.host) || raw.host.name !== '@deepseek-ai/dsh')) || typeof raw.sourceCheckout !== 'boolean')
                throw new Error(METADATA_ERROR);
            return { version: current.version.value, hostVersion: raw.host === null ? 'unknown' : semver(raw.host.version, METADATA_ERROR).value,
                expectedHostVersion: current.host.value, repositoryUrl: REPOSITORY, releasesUrl: `${REPOSITORY}/releases`, sourceCheckout: raw.sourceCheckout };
        }
        catch {
            throw new Error(METADATA_ERROR);
        }
    };
    const check = async () => {
        const current = await getPluginAbout();
        if (current.hostVersion === 'unknown')
            throw new Error('无法确认当前运行宿主版本，请通过 dsh 正常启动后重试');
        const controller = new AbortController();
        let timeout;
        const expired = new Promise((_, reject) => {
            timeout = setTimeout(() => { controller.abort(); reject(new Error(TIMEOUT_ERROR)); }, timeoutMs);
        });
        const request = async (url) => {
            try {
                const response = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
                    headers: { Accept: 'application/json', 'User-Agent': 'dsh-liketavern-update-check' } });
                if (controller.signal.aborted) {
                    cancel(response.body);
                    throw new Error(TIMEOUT_ERROR);
                }
                return await responseJson(response, controller.signal);
            }
            catch (error) {
                if (controller.signal.aborted)
                    throw new Error(TIMEOUT_ERROR);
                throw new Error(error instanceof Error && PUBLIC_NETWORK_ERRORS.has(error.message) ? error.message : NETWORK_ERROR);
            }
        };
        const operation = async () => {
            const release = await request(RELEASE_API);
            if (!object(release) || release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string')
                throw new Error(INVALID_RELEASE_ERROR);
            const tag = release.tag_name, latest = semver(tag.startsWith('v') ? tag.slice(1) : tag, INVALID_RELEASE_ERROR);
            if (latest.prerelease.length)
                throw new Error(INVALID_RELEASE_ERROR);
            const target = packageVersions(await request(`${RAW_PACKAGE_ROOT}${encodeURIComponent(tag)}/package.json`), INVALID_RELEASE_ERROR);
            if (target.version.value !== latest.value)
                throw new Error(INVALID_RELEASE_ERROR);
            const compatible = compare(semver(current.hostVersion, METADATA_ERROR), target.host) === 0;
            const order = compare(latest, semver(current.version, METADATA_ERROR));
            const status = !compatible ? 'incompatible' : order > 0 ? 'available' : order < 0 ? 'ahead' : 'current';
            return { status, latestVersion: latest.value, requiredHostVersion: target.host.value,
                releaseUrl: `${REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`,
                command: status === 'available' && !current.sourceCheckout ? `dsh plugin --profile web add github:Amakurai/dsh-liketavern#${tag}` : null };
        };
        try {
            return await Promise.race([operation(), expired]);
        }
        finally {
            if (timeout !== undefined)
                clearTimeout(timeout);
        }
    };
    return { getPluginAbout, checkPluginUpdate() { return inflight ??= check().finally(() => { inflight = undefined; }); } };
}
const installedReader = createPluginAboutReader();
export const getPluginAbout = () => installedReader.getPluginAbout();
export const checkPluginUpdate = () => installedReader.checkPluginUpdate();
