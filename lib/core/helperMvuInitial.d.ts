/** MVU 初值装配：在卡面沙箱内解析有界 JSON/YAML，按世界书顺序合并普通数据，不执行模板、不发事件或落盘。 */
export interface HelperMvuInitialSource {
    name: string;
    role?: 'global' | 'character';
    entries: {
        uid: string | number;
        comment: string;
        content: string;
    }[];
}
/** 函数可独立 toString 注入 iframe；parseYaml 与不调用访问器的有界 json 复制器必须由沙箱显式提供。 */
export declare function createHelperMvuInitialData(sources: HelperMvuInitialSource[], greeting: string, existing: Record<string, unknown>, parseYaml: (text: string) => unknown, json: (value: unknown, maxBytes?: number) => unknown): Record<string, unknown>;
