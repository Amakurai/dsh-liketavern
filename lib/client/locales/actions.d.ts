/** 操作条（actions.tsx）界面文案。zh 为键全集源；en 必须同键齐全（test/i18n.test.ts 校验）。 */
export declare const zh: {
    readonly 'actions.branchPrev': "上一个分支（同一楼层的另一版回复）";
    readonly 'actions.branchNext': "下一个分支（同一楼层的另一版回复）";
    readonly 'actions.branchCount': "第 {turn} 层有 {total} 个分支";
    readonly 'actions.branchGone': "这个分支会话不存在或已被删除";
    readonly 'actions.swipePrev': "上一条开场白";
    readonly 'actions.swipeNext': "下一条开场白";
    readonly 'actions.regenerate': "重新生成这一层";
    readonly 'actions.continue': "续写这一层（接着被截断的回复写）";
    readonly 'actions.editUser': "编辑这一层的用户消息";
    readonly 'actions.editAi': "编辑这一层的回复（不重跑）";
    readonly 'actions.impersonate': "AI 代答用户（生成我的台词，复制到剪贴板）";
    readonly 'actions.impersonateCopied': "用户台词已生成并复制到剪贴板，粘贴到输入框后发送";
    readonly 'actions.impersonateTitle': "AI 代答的用户台词";
    readonly 'actions.clipboardUnavailable': "剪贴板不可用，请手动复制后粘贴到输入框。";
    readonly 'actions.rollback': "回退到这一层（丢弃其后楼层）";
    readonly 'actions.editUserTitle': "编辑第 {turn} 层的用户消息";
    readonly 'actions.editAiTitle': "编辑第 {turn} 层的回复";
    readonly 'actions.saving': "保存中…";
    readonly 'actions.saveRerun': "保存并重跑";
    readonly 'actions.saveNoRerun': "保存（不重跑）";
};
export declare const en: Record<keyof typeof zh, string>;
