/** 人设面板（panel/personas.tsx）界面文案。zh 为键全集源；en 必须同键齐全（test/i18n.test.ts 校验）。 */
export declare const zh: {
    readonly 'personas.sectionDesc': "用户侧人设，名字会替换 {{user}}。库里只有一条时，未绑人设的会话也会自动用它；多条时请在「设置」页或对话芯片里选择。";
    readonly 'personas.new': "新建人设";
    readonly 'personas.searchLabel': "搜索人设";
    readonly 'personas.searchPlaceholder': "搜索人设名 / 描述";
    readonly 'personas.entity': "人设";
    readonly 'personas.emptyTitle': "暂无人设";
    readonly 'personas.emptyDesc': "新建一条人设，对话里的 {{user}} 就会换成它。";
    readonly 'personas.noDescription': "还没有填写人设描述。";
    readonly 'personas.setDefault': "设为默认";
    readonly 'personas.delete': "删除人设";
    readonly 'personas.deleteTitle': "删除人设？";
    readonly 'personas.deleteDesc': "确定删除人设「{name}」？";
    readonly 'personas.nameRequired': "人设名称不能为空";
    readonly 'personas.saved': "已保存人设 {name}";
    readonly 'personas.defaultSet': "已设为新会话默认人设（当前打开的对话请用角色芯片切换）";
    readonly 'personas.field.name': "名称";
    readonly 'personas.field.description': "描述";
    readonly 'personas.field.lorebook': "人设世界书";
    readonly 'personas.lorebookNone': "（无）";
};
export declare const en: Record<keyof typeof zh, string>;
