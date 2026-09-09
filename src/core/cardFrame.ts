/**
 * 交互卡 iframe srcDoc 组装：CSP + SillyTavern / JS-Slash-Runner 窄桥脚本 +
 * 内存版 localStorage/sessionStorage shim（opaque origin 下原生访问会抛 SecurityError）。
 * 卡内 JS 不能碰主窗口；通过枚举业务消息切换开场白或提交当前剧情变量。
 */
import { installCardVariables, type CardVariableLabels } from './cardVariables.js'
import { installCardEvents } from './cardEvents.js'
import { installCardHelper, type CardHelperContext, type CardHelperLabels } from './cardHelper.js'
import { CARD_LIBRARIES } from '../../lib/vendor/card-libraries.js'
import { installCardPersistence, type CardPersistenceLabels } from './cardPersistence.js'
import type { HelperSnapshot } from './helperRuntime.js'
import {createHelperWorldbookSettingsCodec} from './helperWorldbookSettings.js'
import {installCardDisplay} from './cardDisplay.js'
import {installCardLegacyChat} from './cardLegacyChat.js'
import {installCardMvuRunner} from './cardMvuRunner.js'
import {createHelperMvuInitialData} from './helperMvuInitial.js'
import {installCardMvu} from './cardMvu.js'
import {createHelperMvuCommandCodec} from './helperMvuCommands.js'
import {installCardChatEdits} from './cardChatEdits.js'
import {parseHelperSwipes} from './helperSwipes.js'
import {normalizeHelperMessageInputs} from './helperMessageInputs.js'
import {parseHelperMessageEdits} from './helperChatEdits.js'
import {installCardWorldbook} from './cardWorldbook.js'
import {installCardLorebook} from './cardLorebook.js'
import {createHelperLorebookCodec} from './helperLorebook.js'
import type {HelperWorldbookContext} from './helperWorldbook.js'
import { installCardScriptLibraries } from './cardScriptLibraries.js'
import { helperJson,helperRecord } from './helperRuntime.js'
import { parseHelperScriptTrees,type HelperScriptContext } from './helperScripts.js'
import { installCardScript,type CardScriptContext } from './cardScript.js'

export const CARD_BRIDGE_SOURCE = 'dsh-tavern-card'

export interface CardFrameOptions {
  /** 开场白变体（0 = first_mes）。供 getChatMessages / swipe_id 使用。 */
  greetings: string[]
  greetingIndex: number
  variableLabels?: CardVariableLabels
  variableStyles?: string
  helperContext?: CardHelperContext
  helperLabels?: CardHelperLabels
  helperSnapshot?: HelperSnapshot
  mvuRunner?:boolean
  scriptContext?: CardScriptContext
  scriptLibraries?:HelperScriptContext
  worldbooks?:HelperWorldbookContext
  scriptLibraryLabels?:CardPersistenceLabels
  persistenceLabels?: CardPersistenceLabels
  /**
   * 额外信任的主机：放宽 connect-src 与 script-src（img/font/style 已默认放行 https）。
   * 空数组 = 脚本不能 fetch/XHR，也不能加载外部脚本；`*` = 全部放行。
   */
  connectHosts?: string[]
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

// 白名单条目的合法形态：主机名[:端口]，或带 https?:// 前缀。含引号/空白等字符的条目会
// 截断 meta content 属性注入 HTML、或让整条 CSP 失效，一律丢弃。
const CSP_HOST_RE = /^(?:https?:\/\/)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i

function cspContent(connectHosts: string[]): string {
  const raw = connectHosts.map((h) => h.trim()).filter((h) => h === '*' || CSP_HOST_RE.test(h))
  // `*` = 全部放行（一劳永逸开关）：connect-src/script-src 放开到 https/http。
  // iframe 无 allow-same-origin（opaque origin），卡内脚本仍够不到主窗口。
  const allowAll = raw.includes('*')
  const hosts = raw.filter((h) => h !== '*').map((h) => (h.includes('://') ? h : `https://${h}`))
  const connect = allowAll ? 'https: http:' : hosts.length > 0 ? hosts.join(' ') : "'none'"
  // 白名单主机同时进 script-src：有的封面会 fetch 外部 HTML 再 document.write，
  // 拉回的页面常带 <script src>，只放行 connect-src 仍然跑不起来。
  // Vue 等模板编译器依赖 Function；仅在 opaque-origin 沙箱内允许动态编译，
  // 不改变外部主机白名单、connect-src 或主页面权限。
  const localScript = "'unsafe-inline' 'unsafe-eval'"
  const script = allowAll ? `${localScript} https: http:` : [localScript, ...hosts].join(' ')
  return [
    "default-src 'none'",
    `script-src ${script}`,
    "style-src 'unsafe-inline' https:",
    'img-src https: http: data: blob:',
    'font-src https: http: data:',
    'media-src https: http: data: blob:',
    `connect-src ${connect}`,
  ].join('; ')
}

/** SillyTavern / tavernhelper 常用入口的 stub；卡内按钮经 postMessage 请求 swipeGreeting。 */
export function tavernCardBridgeScript(options: Omit<CardFrameOptions, 'connectHosts'>): string {
  const payload = escapeScriptJson({
    greetings: options.greetings,
    greetingIndex: options.greetingIndex,
    source: CARD_BRIDGE_SOURCE,
    helperSnapshot: options.helperSnapshot,
  })
  return `<script data-dsh-tavern-bridge>
(function () {
  if (typeof window.__dshTavernBridgeCleanup === 'function') window.__dshTavernBridgeCleanup();
  // 沙箱无 allow-same-origin（opaque origin）：访问 localStorage/sessionStorage 会抛
  // SecurityError。依赖存储的封面脚本在启动时就会整页崩成空白。
  // 装内存版 shim——挂在 window 上，document.write 重写文档后依然生效；刷新即失，不落盘。
  function memStorage() {
    var map = {};
    return {
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[String(k)] = String(v); },
      removeItem: function (k) { delete map[String(k)]; },
      clear: function () { map = {}; },
      key: function (i) { var ks = Object.keys(map); return i >= 0 && i < ks.length ? ks[i] : null; },
      get length() { return Object.keys(map).length; }
    };
  }
  function shimStorage(name) {
    try {
      var nativeStore = window[name];
      nativeStore.getItem('__dsh_tavern_probe__');
    } catch (e) {
      try {
        Object.defineProperty(window, name, { configurable: true, enumerable: true, value: memStorage() });
      } catch (e2) {}
    }
  }
  shimStorage('localStorage');
  shimStorage('sessionStorage');
  var cfg = ${payload};
  var cleanupPersistence = cfg.helperSnapshot ? (${installCardPersistence.toString()})(cfg.helperSnapshot,cfg.source,
    ${escapeScriptJson(options.persistenceLabels ?? {saving:'Saving story variables…',saved:'Story variables saved',failed:'Story variable save failed; keep a backup and refresh'})}) : function () {};
  (${installCardVariables.toString()})(${escapeScriptJson(options.variableLabels ?? {
    title: 'Card variables / backup', note: options.helperSnapshot ? 'Variables save to this story. Wait for the saved status before leaving; keep a backup if saving fails. Restoring also updates story variables.' : 'Card variables stay in this preview only. Copy a backup before leaving or refreshing.',
    backup: 'Select backup text', text: 'Card variable backup',
  })}, ${escapeScriptJson(options.variableStyles ?? '')}, cfg.helperSnapshot ? cfg.helperSnapshot.currentMessageId : ${escapeScriptJson(options.helperContext?.messageId ?? 0)}, cfg.helperSnapshot ? cfg.helperSnapshot.messages.length : undefined);
  function post(action, extra) {
    var msg = { source: cfg.source, action: action };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
    try { parent.postMessage(msg, '*'); } catch (e) {}
  }
  var cleanupEvents = (${installCardEvents.toString()})(Boolean(cfg.helperSnapshot));
  var cleanupHelper = (${installCardHelper.toString()})(Object.assign(${escapeScriptJson(options.helperContext ?? {})},{snapshot:cfg.helperSnapshot}), cfg.greetings, cfg.greetingIndex, cfg.source,
    ${escapeScriptJson(options.helperLabels ?? { diagnostics: "Card script messages", unsupported: "Not available in this card sandbox" })});
  var cleanupMvu=(function(){
    var HELPER_MAX_BYTES=1024*1024,helperRecord=(${helperRecord.toString()}),helperJson=(${helperJson.toString()});
    return (${installCardMvu.toString()})((${createHelperMvuCommandCodec.toString()})(helperJson),helperJson);
  })();
  var cleanupMvuRunner=${options.mvuRunner ? `(function(){var HELPER_MAX_BYTES=1024*1024,helperRecord=(${helperRecord.toString()}),helperJson=(${helperJson.toString()});return (${installCardMvuRunner.toString()})((${createHelperMvuInitialData.toString()}),helperJson);})()` : 'function(){}'};
  var ro = null, timers = [], lastHeight = 0;
  var scriptContext=${escapeScriptJson(options.scriptContext??null)};
  var scriptLibraries=${escapeScriptJson(options.scriptLibraries??null)};
  var cleanupScriptLibraries=scriptLibraries?(function(){
    var HELPER_MAX_BYTES=1024*1024;
    var helperRecord=(${helperRecord.toString()});
    var helperJson=(${helperJson.toString()});
    var parseScriptTrees=(${parseHelperScriptTrees.toString()});
    var normalize=function(input){return parseScriptTrees(input,helperJson,helperRecord);};
    return (${installCardScriptLibraries.toString()})(scriptLibraries,normalize,helperJson,${escapeScriptJson(options.scriptLibraryLabels??{saving:'Saving script library…',saved:'Script library saved',failed:'Script library save failed; keep your edits and refresh'})});
  })():function(){};
  var worldbooks=${escapeScriptJson(options.worldbooks??null)};
  var cleanupWorldbooks=worldbooks?(function(){
    var HELPER_MAX_BYTES=1024*1024,helperRecord=(${helperRecord.toString()}),helperJson=(${helperJson.toString()});
    var cleanup=(${installCardWorldbook.toString()})(worldbooks,helperJson,(${createHelperWorldbookSettingsCodec.toString()})(helperJson));
    (${installCardLorebook.toString()})(window.TavernHelper,(${createHelperLorebookCodec.toString()})(helperJson));
    return cleanup;
  })():function(){};
  var cleanupChatEdits=cfg.helperSnapshot?(function(){
    var HELPER_MAX_BYTES=1024*1024,helperRecord=(${helperRecord.toString()}),helperJson=(${helperJson.toString()});
    var parseHelperSwipes=(${parseHelperSwipes.toString()});
    var parseHelperMessageEdits=(${parseHelperMessageEdits.toString()});
    var normalizeHelperMessageInputs=(${normalizeHelperMessageInputs.toString()});
    var cleanup=(${installCardChatEdits.toString()})(function(input,lookup){return parseHelperMessageEdits(normalizeHelperMessageInputs(input,lookup,helperJson,parseHelperSwipes),helperJson,parseHelperSwipes);},helperJson);
    var cleanupDisplay=(${installCardDisplay.toString()})();
    var cleanupLegacy=(${installCardLegacyChat.toString()})(helperJson);
    return function(){cleanupDisplay();cleanupLegacy();cleanup();};
  })():function(){};
  var cleanupScript=scriptContext?(${installCardScript.toString()})(scriptContext):function(){};
  function reportHeight() {
    try {
      var h = 0;
      var el = document.documentElement;
      var body = document.body;
      // 根元素至少等于 iframe 视口，不能作为折叠后的内容高度下限。
      if (body) {
        h = Math.max(h, body.offsetHeight || 0);
        if (body.scrollHeight > (el ? el.clientHeight : 0)) h = Math.max(h, body.scrollHeight);
        var nodes = body.querySelectorAll('*');
        var n = Math.min(nodes.length, 400);
        for (var i = 0; i < n; i++) {
          var r = nodes[i].getBoundingClientRect();
          if (r && r.bottom > h) h = r.bottom;
        }
      }
      if (h > 0 && Math.ceil(h) !== lastHeight) {
        lastHeight = Math.ceil(h);
        post('resize', { height: lastHeight });
      }
    } catch (e) {}
  }
  function watchHeight() {
    reportHeight();
    if (typeof ResizeObserver !== 'undefined') {
      try {
        ro = new ResizeObserver(function () { reportHeight(); });
        if (document.documentElement) ro.observe(document.documentElement);
        if (document.body) ro.observe(document.body);
      } catch (e2) {}
    }
    window.addEventListener('load', reportHeight);
    timers.push(setTimeout(reportHeight, 300), setTimeout(reportHeight, 1200));
  }
  window.__dshTavernBridgeCleanup = function () {
    cleanupScript();
    cleanupScriptLibraries();
    cleanupWorldbooks();
    cleanupChatEdits();
    cleanupMvuRunner();
    cleanupMvu();
    cleanupPersistence();
    cleanupHelper();
    cleanupEvents();
    if (ro) ro.disconnect();
    timers.forEach(clearTimeout);
    window.removeEventListener('load', reportHeight);
    document.removeEventListener('DOMContentLoaded', watchHeight);
  };
  // 封面常 document.write 整页 HTML，会冲掉 head 里的桥。把 stub/CSP 写回后再落盘。
  var nativeDocument = window.__dshTavernNativeDocument || (window.__dshTavernNativeDocument = {
    open: document.open.bind(document), write: document.write.bind(document), close: document.close.bind(document)
  });
  var origOpen = nativeDocument.open;
  var origWrite = nativeDocument.write;
  var origClose = nativeDocument.close;
  var writeBuf = null;
  var stubNode = document.currentScript;
  var stubHtml = stubNode && stubNode.outerHTML ? stubNode.outerHTML : '';
  var cspNode = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  var cspHtml = cspNode && cspNode.outerHTML ? cspNode.outerHTML : '';
  var libraryNode = document.querySelector('script[data-dsh-tavern-libraries]');
  var libraryHtml = libraryNode && libraryNode.outerHTML ? libraryNode.outerHTML : '';
  function injectBridge(html) {
    // 不信任第三方 head、注释或伪造的 bridge 标记；重新解析前先建立有效策略。
    return (${wrapCardDocument.toString()})(html, cspHtml + libraryHtml + stubHtml);
  }
  document.open = function () {
    writeBuf = '';
    return document;
  };
  document.write = function () {
    var chunk = Array.prototype.join.call(arguments, '');
    if (writeBuf === null) {
      if (/<!DOCTYPE/i.test(chunk) || /<html[\\s>]/i.test(chunk)) {
        writeBuf = chunk;
        return;
      }
      return origWrite(chunk);
    }
    writeBuf += chunk;
  };
  document.writeln = function () {
    document.write(Array.prototype.join.call(arguments, '') + '\\n');
  };
  document.close = function () {
    if (writeBuf === null) return origClose();
    var html = injectBridge(writeBuf);
    writeBuf = null;
    origOpen();
    origWrite(html);
    origClose();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchHeight);
  else watchHeight();
})();
</script>`
}

/**
 * 所有第三方字节之前先建立真实 head；不能用正则在不可信 HTML 中找插入点。
 * 原文可能含注释中的 head、前置脚本或伪造桥标记。浏览器在已进入 body 后忽略
 * 重复的文档根标签，仍解析其中的样式与正文；初次加载和 document.write 共用此包装。
 */
function wrapCardDocument(html: string, trustedHead: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${trustedHead}</head><body>${html}</body></html>`
}

/** 把 CSP 与 ST 桥接脚本注入交互卡 HTML，得到 iframe srcDoc。 */
export function buildCardSrcDoc(html: string, options: CardFrameOptions): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${cspContent(options.connectHosts ?? [])}">`
  const stub = tavernCardBridgeScript(options)
  const libraries = `<script data-dsh-tavern-libraries>${CARD_LIBRARIES.replace(/<\/script/gi, '<\\/script')}</script>`
  return wrapCardDocument(html, meta + libraries + stub)
}

export interface CardBridgeMessage {
  source: string
  action: string
  index?: number
  height?: number
}

export function parseCardBridgeMessage(data: unknown): CardBridgeMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const rec = data as Record<string, unknown>
  if (rec.source !== CARD_BRIDGE_SOURCE || typeof rec.action !== 'string') return null
  if (rec.action !== 'swipeGreeting' && rec.action !== 'resize') return null
  if (rec.action === 'swipeGreeting' && (typeof rec.index !== 'number' || !Number.isSafeInteger(rec.index) || rec.index < 0)) return null
  const index = typeof rec.index === 'number' && Number.isFinite(rec.index) ? rec.index : undefined
  const height = typeof rec.height === 'number' && Number.isFinite(rec.height) ? rec.height : undefined
  return {
    source: rec.source,
    action: rec.action,
    ...(index !== undefined ? { index } : {}),
    ...(height !== undefined ? { height } : {}),
  }
}
