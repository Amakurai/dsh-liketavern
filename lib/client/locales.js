/**
 * tavern 文案命名空间聚合：各模块字典在 ./locales/<module>.ts（zh 为键全集源，
 * en 同键齐全），此处合并导出。组件经 i18n.ts 的 useT()/t() 取文案；
 * 宿主 locale 服务也注册同一套字典（settings.section 的 slot label 走宿主语言）。
 * 新模块加文案时新建 ./locales/<module>.ts 片段并在此处接线；键带模块前缀防碰撞。
 */
import * as actions from './locales/actions.js';
import * as assistant from './locales/assistant.js';
import * as characters from './locales/characters.js';
import * as chip from './locales/chip.js';
import * as common from './locales/common.js';
import * as hero from './locales/hero.js';
import * as lorebookEditor from './locales/lorebookEditor.js';
import * as lorebooks from './locales/lorebooks.js';
import * as memory from './locales/memory.js';
import * as panel from './locales/panel.js';
import * as personas from './locales/personas.js';
import * as presets from './locales/presets.js';
import * as regex from './locales/regex.js';
import * as settings from './locales/settings.js';
import * as speech from './locales/speech.js';
import * as util from './locales/util.js';
/** 播种前的初始语言；宿主语言经 setTavernHostLocale 在 apply 早期修正（持久化偏好在 dsh-tavern 设置的 locale 键）。 */
export const DEFAULT_LOCALE = 'en';
export const zh = {
    ...common.zh,
    ...util.zh,
    ...panel.zh,
    ...settings.zh,
    ...characters.zh,
    ...presets.zh,
    ...lorebooks.zh,
    ...lorebookEditor.zh,
    ...personas.zh,
    ...regex.zh,
    ...memory.zh,
    ...chip.zh,
    ...hero.zh,
    ...actions.zh,
    ...assistant.zh,
    ...speech.zh,
};
export const en = {
    ...common.en,
    ...util.en,
    ...panel.en,
    ...settings.en,
    ...characters.en,
    ...presets.en,
    ...lorebooks.en,
    ...lorebookEditor.en,
    ...personas.en,
    ...regex.en,
    ...memory.en,
    ...chip.en,
    ...hero.en,
    ...actions.en,
    ...assistant.en,
    ...speech.en,
};
