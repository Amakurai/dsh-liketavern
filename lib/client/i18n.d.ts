import { type TavernLocaleId } from './locales.js';
export declare function getTavernLocale(): TavernLocaleId;
export declare function setTavernLocale(id: TavernLocaleId): void;
/** 取当前语言文案；en 缺失时回退 zh（字典齐全性由 test/i18n.test.ts 保证，兜底仅为防白屏）。 */
export declare function t(key: string, params?: Record<string, string | number>): string;
/** 组件内取文案的唯一入口：订阅语言切换，切语言时触发重渲染。 */
export declare function useT(): typeof t;
