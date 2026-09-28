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
/**
 * MVU zod 模板的 `import { registerMvuSchema } from '…/mvu_zod.js'` 在沙箱 CSP 下无法加载，
 * 该脚本随之永远不会就绪，原生 MVU 会一直等待。只改写这一条顶层具名导入，取沙箱内的本地实现；
 * 其它导入与写法原样保留（仍按 CSP 失败并显示），不猜测任意远程模块。
 */
export declare function rewriteMvuZodImport(content: string): string;
/** 仅识别无版本与 beta 的纯官方 MVU 导入入口，交给已有原生 MVU；其它代码完整保留，不伪造父窗口。 */
export declare function isNativeMvuFramework(content: string): boolean;
