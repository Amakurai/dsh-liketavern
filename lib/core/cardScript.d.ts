/** 后台脚本的沙箱专属上下文和按钮；正文作为模块执行，按钮事件仅在该 iframe 内触发。 */
import type { HelperScript, HelperScriptTree, HelperScriptType } from './helperScripts.js';
export interface CardScriptContext {
    script: HelperScript;
    trees: HelperScriptTree[];
    libraryType?: HelperScriptType;
    libraries?: {
        type: 'global' | 'preset' | 'character';
        trees: HelperScriptTree[];
    }[];
}
export declare function installCardScript(context: CardScriptContext): () => void;
/** 用可信脚本创建内联 module 元素，JSON 编码避免正文中的结束标签逃出容器；模块网络仍受现有 CSP 限制。 */
export declare function helperScriptHtml(content: string): string;
/** 仅识别纯官方 MVU 框架导入入口，交给已有原生 MVU；其它代码完整保留，不伪造父窗口。 */
export declare function isNativeMvuFramework(content: string): boolean;
