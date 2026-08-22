export declare const TAVERN_PRESET_ID = "tavern";
/** 推导 agent 入口的 file:// URL（Windows 下 loader 只接受合法 ESM URL）。 */
export declare function agentModulePath(): string;
/**
 * YAML 单引号标量转义：只需把 `'` 写成 `''`。
 * 模板里 `__AGENT_MODULE__` 位于单引号标量内，而 pathToFileURL 不会编码撇号
 * （安装路径形如 `C:\Users\O'Brien\...` 时 href 里就带着裸撇号），不转义会写出
 * 语法坏掉的 YAML —— 预设挂不上且没有任何诊断。
 */
export declare function escapeYamlSingleQuoted(value: string): string;
export interface PresetInstallResult {
    dir: string;
    written: string[];
    skipped: string[];
}
export declare function installTavernPreset(home?: string): Promise<PresetInstallResult>;
