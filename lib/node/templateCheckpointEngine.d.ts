import type { newQuickJSWASMModule, newVariant, RELEASE_SYNC } from 'quickjs-emscripten';
export interface TemplateCheckpointEngine {
    newQuickJSWASMModule: typeof newQuickJSWASMModule;
    newVariant: typeof newVariant;
    RELEASE_SYNC: typeof RELEASE_SYNC;
    wasmBytes: Uint8Array<ArrayBuffer>;
}
/** 与冻结源及构建脚本共同固定；新增引擎必须使用新的版本目录，不能就地替换旧堆的 ABI。 */
export declare const TEMPLATE_CHECKPOINT_ENGINE_JS_HASH = "1d4ea4f8afe25475133e15a7f560dff6d73d7c898033cf1e83a7cc96340b3f79";
/** 主线程在开 WAL 前可只读核对安装文件；不 import 引擎 JS、不编译 WASM、不解释检查点正文。 */
export declare function assertTemplateCheckpointEngine(): Promise<void>;
/** 仅首次调用读取并校验；import 本模块本身不会执行固定引擎，也不会创建或恢复 VM。 */
export declare function loadTemplateCheckpointEngine(): Promise<TemplateCheckpointEngine>;
