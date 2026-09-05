/** 仅注入卡内沙箱的备份工具；不依赖主页面样式继承，也不覆盖卡片自身控件。 */
export declare const CARD_VARIABLE_STYLES = "\n#dsh-tavern-variable-backup{box-sizing:border-box;margin:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,GrayText);\n  border-radius:8px;font:13px/1.5 system-ui;background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);position:relative;z-index:1}\n#dsh-tavern-variable-backup summary{cursor:pointer;min-height:28px}\n#dsh-tavern-variable-backup textarea{box-sizing:border-box;display:block;width:100%;min-height:90px;margin:8px 0;font:12px/1.5 monospace}\n#dsh-tavern-variable-backup button{min-height:32px;margin:4px 8px 4px 0;cursor:pointer}\n";
/** 幂等注入全局样式表（模块加载即执行一次）。 */
export declare function ensureTavernStyles(): void;
