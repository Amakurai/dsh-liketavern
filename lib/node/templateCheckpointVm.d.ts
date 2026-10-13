import type { QuickJSContext, QuickJSWASMModule } from 'quickjs-emscripten';
import { type TemplateCheckpointVmImage } from '../core/templateCheckpoint.js';
export interface TemplateCheckpointVm {
    engine: QuickJSWASMModule;
    vm: QuickJSContext;
}
export declare function prepareTemplateCheckpointVm(): Promise<void>;
export declare function createTemplateCheckpointVm(value?: TemplateCheckpointVmImage): Promise<TemplateCheckpointVm>;
/** 只读取内存与固定 FFI 状态，不调用 variables/schema，也不执行任何第三方脚本。 */
export declare function dumpTemplateCheckpointVm(owner: TemplateCheckpointVm): TemplateCheckpointVmImage;
