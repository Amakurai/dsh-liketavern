/** 只读校验受信发布目录中的冻结 v1 引擎，实际加载只在 worker 发生；不按存档提供的路径、代码或 WASM 启动宿主模块。 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TEMPLATE_CHECKPOINT_ENGINE, TEMPLATE_CHECKPOINT_WASM_HASH } from '../core/templateCheckpoint.js';
/** 与冻结源及构建脚本共同固定；新增引擎必须使用新的版本目录，不能就地替换旧堆的 ABI。 */
export const TEMPLATE_CHECKPOINT_ENGINE_JS_HASH = '1d4ea4f8afe25475133e15a7f560dff6d73d7c898033cf1e83a7cc96340b3f79';
const hash = (value) => createHash('sha256').update(value).digest('hex');
let verified;
let pinned;
/** 主线程在开 WAL 前可只读核对安装文件；不 import 引擎 JS、不编译 WASM、不解释检查点正文。 */
export async function assertTemplateCheckpointEngine() {
    await verifiedEngine();
}
/** 仅首次调用读取并校验；import 本模块本身不会执行固定引擎，也不会创建或恢复 VM。 */
export function loadTemplateCheckpointEngine() {
    if (pinned)
        return pinned;
    const pending = load();
    pinned = pending;
    void pending.catch(() => { if (pinned === pending)
        pinned = undefined; });
    return pending;
}
function verifiedEngine() {
    if (verified)
        return verified;
    const pending = verify();
    verified = pending;
    // 安装修复后允许同一宿主进程重试；仅成功校验能作为后续轮次的只读结论。
    void pending.catch(() => { if (verified === pending)
        verified = undefined; });
    return pending;
}
async function verify() {
    // src 测试与 lib 运行使用同一个发布目录；不寻找 node_modules 中可能已升级的引擎。
    const engineUrl = new URL('../../lib/vendor/checkpoint-engine-v1/engine.js', import.meta.url);
    const wasmUrl = new URL('../../lib/vendor/checkpoint-engine-v1/engine.wasm', import.meta.url);
    const manifestUrl = new URL('../../lib/vendor/checkpoint-engine-v1/manifest.json', import.meta.url);
    let javascript, wasm;
    let manifestText;
    try {
        [javascript, wasm, manifestText] = await Promise.all([readFile(engineUrl), readFile(wasmUrl), readFile(manifestUrl, 'utf8')]);
    }
    catch {
        throw new Error('固定模板检查点 v1 引擎文件缺失，无法恢复；请修复插件安装');
    }
    let manifest;
    try {
        manifest = JSON.parse(manifestText);
    }
    catch {
        throw new Error('固定模板检查点 v1 引擎清单损坏，拒绝执行');
    }
    if (!manifest || typeof manifest !== 'object' || !('version' in manifest) || manifest.version !== 1
        || !('engine' in manifest) || manifest.engine !== TEMPLATE_CHECKPOINT_ENGINE || !('files' in manifest) || !manifest.files || typeof manifest.files !== 'object'
        || !('engine.js' in manifest.files) || manifest.files['engine.js'] !== TEMPLATE_CHECKPOINT_ENGINE_JS_HASH
        || !('engine.wasm' in manifest.files) || manifest.files['engine.wasm'] !== TEMPLATE_CHECKPOINT_WASM_HASH)
        throw new Error('固定模板检查点 v1 引擎清单损坏，拒绝执行');
    if (hash(javascript) !== TEMPLATE_CHECKPOINT_ENGINE_JS_HASH || hash(wasm) !== TEMPLATE_CHECKPOINT_WASM_HASH)
        throw new Error('固定模板检查点 v1 引擎文件校验失败，拒绝执行');
    return { engineUrl, wasmBytes: new Uint8Array(wasm) };
}
async function load() {
    const { engineUrl, wasmBytes } = await verifiedEngine();
    const loaded = await import(engineUrl.href);
    if (!loaded || typeof loaded !== 'object' || !('newQuickJSWASMModule' in loaded) || typeof loaded.newQuickJSWASMModule !== 'function'
        || !('newVariant' in loaded) || typeof loaded.newVariant !== 'function' || !('RELEASE_SYNC' in loaded) || !loaded.RELEASE_SYNC
        || typeof loaded.RELEASE_SYNC !== 'object' || !('type' in loaded.RELEASE_SYNC) || loaded.RELEASE_SYNC.type !== 'sync')
        throw new Error('固定模板检查点 v1 引擎导出不兼容');
    const engine = loaded;
    return { newQuickJSWASMModule: engine.newQuickJSWASMModule, newVariant: engine.newVariant, RELEASE_SYNC: engine.RELEASE_SYNC, wasmBytes };
}
