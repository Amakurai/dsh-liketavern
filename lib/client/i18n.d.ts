import { type TavernLocaleId, type TavernLocalePreference } from './locales.js';
export declare function getTavernLocale(): TavernLocaleId;
/** 设置语言偏好（'auto' 跟随宿主）；立即按当前宿主语言重算生效语言。 */
export declare function setTavernLocale(id: TavernLocalePreference): void;
/** 宿主界面语言（0.1.2 的 LocaleRuntime 快照）变化；仅 auto 档会影响生效语言。 */
export declare function setTavernHostLocale(active: string): void;
/** 取当前语言文案；en 缺失时回退 zh（字典齐全性由 test/i18n.test.ts 保证，兜底仅为防白屏）。 */
export declare function t(key: string, params?: Record<string, string | number>): string;
/** 组件内取文案的唯一入口：订阅语言切换，切语言时触发重渲染。 */
export declare function useT(): typeof t;
/**
 * 宿主 MarkdownText 的 chrome 文案（0.1.2 起 labels 为必填 prop，缺了渲染代码围栏即崩）。
 * 键位与宿主 markdownLabels(t) 一致，文案走本插件字典。
 */
export declare function useMarkdownLabels(): {
    code: {
        copyLabel: string;
        copiedLabel: string;
    };
    footnotes: string;
};
