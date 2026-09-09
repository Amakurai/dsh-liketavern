/** MVU 普通 JSON 命令编解码：独立有界字面量解析、路径校验及原子应用，可把工厂序列化进不透明卡面沙箱。 */
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
}
/** json 必须是不调用访问器的有界普通 JSON 复制器；工厂不捕获模块变量、不使用代码求值或第三方解析器。 */
export declare function createHelperMvuCommandCodec(json: (value: unknown, maxBytes?: number) => unknown): HelperMvuCommandCodec;
