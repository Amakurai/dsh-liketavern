/** MVU 普通 JSON 命令编解码：独立有界字面量解析、路径校验及原子应用，可把工厂序列化进不透明卡面沙箱。 */
import type { markdownCodeScanner } from './markdownCode.js';
export interface HelperMvuCommand {
    type: 'set' | 'add' | 'insert' | 'delete' | 'move' | 'copy' | 'test';
    full_match: string;
    args: string[];
    reason: string;
}
export interface HelperMvuCommandCodec {
    parse(message: string): HelperMvuCommand[];
    apply(statData: Record<string, unknown>, commands: HelperMvuCommand[], displayBase?: Record<string, unknown>): {
        stat_data: Record<string, unknown>;
        display_data: Record<string, unknown>;
        delta_data: Record<string, unknown>;
    };
    /** 按命令同一路径规则只读取值（副本）；路径不存在时为 null，供 SINGLE_VARIABLE_UPDATED 报告前后值。 */
    read(statData: Record<string, unknown>, path: unknown): unknown;
}
/** 两个依赖均显式传入：有界 JSON 复制器与纯 Markdown 扫描器；工厂不捕获模块变量或求值代码。 */
export declare function createHelperMvuCommandCodec(json: (value: unknown, maxBytes?: number) => unknown, markdown: typeof markdownCodeScanner): HelperMvuCommandCodec;
