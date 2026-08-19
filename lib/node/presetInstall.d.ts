export declare const TAVERN_PRESET_ID = "tavern";
/** 推导 agent 入口的 file:// URL（Windows 下 loader 只接受合法 ESM URL）。 */
export declare function agentModulePath(): string;
export interface PresetInstallResult {
    dir: string;
    written: string[];
    skipped: string[];
}
export declare function installTavernPreset(home?: string): Promise<PresetInstallResult>;
