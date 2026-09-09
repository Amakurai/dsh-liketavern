/** MVU 沙箱适配：同步读取本地剧情快照，按顺序等待变量事件，显式保存沿用 CAS/WAL 回执。 */
import type { HelperMvuCommandCodec } from './helperMvuCommands.js';
/** 自包含函数注入 opaque iframe；不加载原版主窗口脚本，不自动改写正文或发起模型请求。 */
export declare function installCardMvu(codec: HelperMvuCommandCodec, json: (value: unknown, maxBytes?: number) => unknown): () => void;
