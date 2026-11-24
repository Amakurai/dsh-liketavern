import type { QuickJSContext, QuickJSWASMModule } from 'quickjs-emscripten';
import { type TemplateCheckpointVmImage } from '../core/templateCheckpoint.js';
export interface TemplateCheckpointVm {
    engine: QuickJSWASMModule;
    vm: QuickJSContext;
}
export declare function prepareTemplateCheckpointVm(): Promise<void>;
/** 同步收紧或放宽专属 WASM 线性内存上限；不会低于当前已分配页数，也不超过检查点硬上限。 */
export declare function setTemplateCheckpointVmMemoryLimit(vm: QuickJSContext, quickJsMemoryBytes: number): void;
/** 宿主 FFI（入参编码、错误格式化、dispose）期间临时提供少量 WASM 扩容余量，防止 _malloc 返回 NULL 触发 OOB。 */
export declare function withTemplateCheckpointVmHeadroom<T>(vm: QuickJSContext, extraBytes: number, fn: () => T): T;
export declare function createTemplateCheckpointVm(value?: TemplateCheckpointVmImage): Promise<TemplateCheckpointVm>;
/** 只读取内存与固定 FFI 状态，不调用 variables/schema，也不执行任何第三方脚本。 */
export declare function dumpTemplateCheckpointVm(owner: TemplateCheckpointVm): TemplateCheckpointVmImage;
