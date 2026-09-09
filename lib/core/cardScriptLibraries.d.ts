/** 沙箱脚本库 API：同步草稿、串行 CAS 保存、显式回执及重载确认；第三方 updater 只在 iframe 执行。 */
import type { HelperScriptContext, HelperScriptTree } from './helperScripts.js';
import type { CardPersistenceLabels } from './cardPersistence.js';
export declare function installCardScriptLibraries(initial: HelperScriptContext, normalize: (input: unknown) => HelperScriptTree[], json: (input: unknown, maxBytes: number) => unknown, _labels: CardPersistenceLabels): () => void;
