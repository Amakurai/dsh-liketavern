import type { TemplateReplay } from '../core/templateReplay.js';
/** vendor 是受信构建代码；Git 换行转换不能把同一发布产物误判为不兼容版本，执行文本仍原样保留。 */
export declare function fingerprintTemplateRuntime(bootstrap: string, librarySource: string, fakerSource: string): string;
export declare function loadTemplateRuntime(): Promise<{
    librarySource: string;
    fakerSource: string;
    hash: string;
}>;
export declare function assertTemplateCheckpointRuntime(replay: Pick<TemplateReplay, 'checkpoint'>): Promise<void>;
