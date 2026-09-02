/**
 * tavern 文案命名空间聚合：各模块字典在 ./locales/<module>.ts（zh 为键全集源，
 * en 同键齐全），此处合并导出。组件经 i18n.ts 的 useT()/t() 取文案；
 * 宿主 locale 服务也注册同一套字典（settings.section 的 slot label 走宿主语言）。
 * 新模块加文案时新建 ./locales/<module>.ts 片段并在此处接线；键带模块前缀防碰撞。
 */
export type TavernLocaleId = 'en' | 'zh';
/** 默认英文；用户可在设置页切中文（持久化在 dsh-tavern 设置的 locale 键）。 */
export declare const DEFAULT_LOCALE: TavernLocaleId;
export declare const zh: Record<string, string>;
export declare const en: Record<string, string>;
