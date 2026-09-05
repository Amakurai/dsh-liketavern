/**
 * 共享界面文案：跨模块复用的动作、分区标题、对话框与搜索默认值。
 * zh 为键全集源；en 必须同键齐全（test/i18n.test.ts 校验）。
 * 模块私有文案放各自的 locales/<module>.ts，键一律带模块前缀，避免碰撞。
 */
export declare const zh: {
    readonly 'draft.unsaved': "未保存修改";
    readonly 'draft.leaveTitle': "放弃未保存的修改？";
    readonly 'draft.leaveDesc': "离开后，这些修改将丢失。取消可返回继续编辑并保存。";
    readonly 'draft.discard': "放弃修改并离开";
    readonly 'draft.saving': "保存中…";
    readonly 'draft.loadFailed': "未能读取编辑草稿。";
    readonly 'draft.restored': "已恢复上次编辑草稿，请检查后保存。";
    readonly 'draft.autosaving': "正在暂存草稿…";
    readonly 'draft.autosaved': "草稿已暂存，刷新后可恢复；修改仍需点击保存。";
    readonly 'draft.autosaveFailed': "草稿暂存失败，编辑内容仍保留在当前页面。";
    readonly 'settings.label': "Tavern";
    readonly 'section.characters': "角色卡";
    readonly 'section.presets': "提示词预设";
    readonly 'section.lorebooks': "世界书";
    readonly 'section.personas': "用户";
    readonly 'section.regex': "正则脚本";
    readonly 'section.memory': "记忆与世界状态";
    readonly 'action.delete': "删除";
    readonly 'action.save': "保存";
    readonly 'action.edit': "编辑";
    readonly 'action.refresh': "刷新";
    readonly 'action.cancel': "取消";
    readonly 'action.confirm': "确定";
    readonly 'action.close': "关闭";
    readonly 'action.retry': "重试";
    readonly 'action.clearSearch': "清空搜索";
    readonly 'hero.pickCharacter': "选择角色卡";
    readonly 'hero.noCharacters': "暂无角色卡";
    readonly 'binding.save': "保存绑定";
    readonly 'binding.greeting': "插入开场白";
    readonly 'binding.triggerLog': "触发日志";
    readonly 'binding.preview': "预览提示词";
    readonly 'interactive.open': "打开交互卡";
    readonly 'common.searchPlaceholder': "搜索…";
    readonly 'common.noMatch': "没有匹配的{what}";
    readonly 'common.noMatchDesc': "「{query}」没有命中任何条目，可换个关键词或";
    readonly 'common.unlimited': "不限";
    readonly 'common.copy': "复制";
    readonly 'common.copied': "已复制";
    readonly 'common.markdownFootnotes': "脚注";
};
export declare const en: Record<keyof typeof zh, string>;
