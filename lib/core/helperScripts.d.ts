/** 酒馆助手脚本资产归一化：兼容新旧角色卡字段，保留脚本正文但绝不在宿主执行。 */
import { helperJson, helperRecord, type HelperTable } from './helperRuntime.js';
import type { HelperWorldbookContext } from './helperWorldbook.js';
import type { HelperSnapshot } from './helperRuntime.js';
export interface HelperScriptLibrary {
    cardId: string;
    revision: string;
    trees: HelperScriptTree[];
}
export type HelperScriptTarget = {
    type: 'global';
} | {
    type: 'preset';
    presetId: string;
} | {
    type: 'character';
    cardId: string;
};
export type HelperScriptType = HelperScriptTarget['type'];
export interface HelperScriptView {
    type: HelperScriptType;
    revision: string;
    trees: HelperScriptTree[];
}
export interface HelperScriptContext {
    storyId: string;
    bindingRevision: string;
    libraries: HelperScriptView[];
}
export interface HelperScriptCommit {
    storyId: string;
    bindingRevision: string;
    type: HelperScriptType;
    revision: string;
    trees: unknown;
}
export interface HelperScriptAsset {
    target: HelperScriptTarget;
    revision: string;
    trees: HelperScriptTree[];
}
export interface HelperScriptBundle extends HelperScriptLibrary {
    libraries: HelperScriptAsset[];
    scriptContext?: HelperScriptContext;
    worldbooks?: HelperWorldbookContext;
    runtimeError?: string;
    storyId: string;
    messageId: number | null;
    snapshot?: HelperSnapshot;
    enabled: boolean;
    helperMvu?: boolean;
    whitelist: string[];
}
export interface HelperScriptButton {
    name: string;
    visible: boolean;
}
export interface HelperScript {
    type: 'script';
    id: string;
    name: string;
    enabled: boolean;
    content: string;
    info: string;
    button: {
        enabled: boolean;
        buttons: HelperScriptButton[];
    };
    data: HelperTable;
    export_with: {
        data: boolean;
        button: boolean;
    };
}
export interface HelperScriptFolder {
    type: 'folder';
    id: string;
    name: string;
    enabled: boolean;
    icon: string;
    color: string;
    scripts: HelperScript[];
}
export type HelperScriptTree = HelperScript | HelperScriptFolder;
export declare function parseHelperScriptTrees(input: unknown, json?: typeof helperJson, record?: typeof helperRecord): HelperScriptTree[];
export declare function characterHelperSettings(extensions: Record<string, unknown>): Record<string, unknown>;
/** 预设及导入设置只接受有界普通 JSON 对象，并统一脚本树格式。 */
export declare function helperScriptSettings(input: unknown): Record<string, unknown>;
export declare function characterHelperScripts(extensions: Record<string, unknown>): HelperScriptTree[];
export declare function enabledHelperScripts(trees: HelperScriptTree[]): HelperScript[];
/** 三类资产共享一组脚本身份；禁止启用的同 ID 脚本混用变量和事件。 */
export declare function enabledHelperLibraries(libraries: readonly {
    trees: HelperScriptTree[];
}[]): HelperScript[];
/** 独立脚本、文件夹、脚本数组或 scripts 设置对象；拒绝把无关 JSON 悄悄导入成空脚本。 */
export declare function importHelperScriptFile(input: unknown): HelperScriptTree[];
/** 导出遵守作者的 data/button 标记，不把明确排除的数据夹带到导出文件。 */
export declare function exportHelperScriptTrees(input: unknown): HelperScriptTree[];
