/** 角色发言条（speech.tsx）界面文案。zh 为键全集源。 */
export declare const zh: {
    readonly 'speech.copied': "已复制消息文本";
    readonly 'speech.copyFailed': "复制失败";
    readonly 'speech.copy': "复制消息文本";
    readonly 'speech.navigationUnavailable': "会话导航暂不可用，请刷新后重试。";
    readonly 'speech.swipeStarted': "对话已开始，不能直接切换开场白；请使用楼层分支操作。";
    readonly 'speech.cardDataTitle': "卡内临时数据 · 备份与恢复";
    readonly 'speech.cardDataNote': "只备份卡片通过变量接口保存的数据，不包含未保存的输入。切换会话或刷新前请生成并复制备份，之后用卡片下方的恢复按钮载入；数据不写入角色资产或剧情记忆。";
    readonly 'speech.cardDataBackup': "生成并选中备份";
    readonly 'speech.cardDataRestore': "恢复卡内备份";
    readonly 'speech.cardDataRestoreDesc': "粘贴此前复制的完整备份。确认后会重新打开此卡面并载入备份，替换当前卡内临时数据；会话消息和剧情记忆不受影响。";
    readonly 'speech.cardDataText': "卡内变量备份文本";
    readonly 'speech.cardDataFailed': "备份无效或超过 1 MiB，原数据未改动。";
};
export declare const en: Record<keyof typeof zh, string>;
