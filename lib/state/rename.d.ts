/** 首次成功无延迟；最多额外等待 100 ms，持续拒绝及其它错误仍交还原调用方处理。 */
export declare function renameWithRetry(from: string, to: string): Promise<void>;
