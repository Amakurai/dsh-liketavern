/** 宿主按 npm SemVer 范围且包含预发布版判断 peer；旧发布的精确版本同样可读。 */
import { satisfies, valid, validRange } from 'semver';
export function safeHostRange(value) {
    return typeof value === 'string' && value.length <= 512 && /^[0-9A-Za-z.+<>=|*~^\- ]+$/.test(value)
        && validRange(value) !== null ? value : 'unknown';
}
/** 与较新宿主一致：显式 engines.dsh 优先；旧清单没有该字段时读取 DSH peer。 */
export function manifestHostRange(manifest) {
    const engines = manifest.engines;
    if (engines !== undefined) {
        if (!engines || typeof engines !== 'object' || Array.isArray(engines))
            return 'unknown';
        if (Object.hasOwn(engines, 'dsh'))
            return safeHostRange(engines.dsh);
    }
    const peers = manifest.peerDependencies;
    return peers && typeof peers === 'object' && !Array.isArray(peers)
        ? safeHostRange(peers['@deepseek-ai/dsh']) : 'unknown';
}
export function hostVersionSatisfies(version, range) {
    return version.length <= 256 && valid(version) !== null && safeHostRange(range) !== 'unknown'
        && satisfies(version, range, { includePrerelease: true });
}
