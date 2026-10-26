/**
 * 交互卡 iframe srcDoc 组装：CSP + SillyTavern / JS-Slash-Runner 窄桥脚本 +
 * 内存版 localStorage/sessionStorage shim（opaque origin 下原生访问会抛 SecurityError）。
 * 卡内 JS 不能碰主窗口；通过枚举业务消息切换开场白或提交当前剧情变量。
 */
import { installCardVariables } from './cardVariables.js';
import { installCardEvents } from './cardEvents.js';
import { installCardHelper } from './cardHelper.js';
import { CARD_LIBRARIES } from '../../lib/vendor/card-libraries.js';
import { installCardPersistence } from './cardPersistence.js';
import { createHelperWorldbookSettingsCodec } from './helperWorldbookSettings.js';
import { installCardDisplay } from './cardDisplay.js';
import { installCardLegacyChat } from './cardLegacyChat.js';
import { installCardMvuRunner } from './cardMvuRunner.js';
import { createHelperMvuInitialData } from './helperMvuInitial.js';
import { installCardMvu } from './cardMvu.js';
import { createHelperMvuCommandCodec } from './helperMvuCommands.js';
import { markdownCodeScanner } from './markdownCode.js';
import { installCardChatEdits } from './cardChatEdits.js';
import { parseHelperSwipes } from './helperSwipes.js';
import { normalizeHelperMessageInputs } from './helperMessageInputs.js';
import { parseHelperMessageEdits } from './helperChatEdits.js';
import { installCardWorldbook } from './cardWorldbook.js';
import { installCardLorebook } from './cardLorebook.js';
import { createHelperLorebookCodec } from './helperLorebook.js';
import { installCardScriptLibraries } from './cardScriptLibraries.js';
import { helperJson, helperRecord } from './helperRuntime.js';
import { parseHelperScriptTrees } from './helperScripts.js';
import { installCardScript } from './cardScript.js';
import { isFullHtmlDocument } from './htmlFragment.js';
export const CARD_BRIDGE_SOURCE = 'dsh-tavern-card';
// 兼容库超过 600 KiB；转义结果在模块内只构造一次。纯静态卡没有任何可执行入口，
// 不需要为每个历史 iframe 复制并初始化 jQuery/Lodash/Zod/YAML/jsonrepair。
const CARD_LIBRARY_TAG = `<script data-dsh-tavern-libraries>${CARD_LIBRARIES.replace(/<\/script/gi, '<\\/script')}</script>`;
function escapeScriptJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
/**
 * \u957f\u5386\u53f2\u91cc\u6bcf\u4e2a\u5361\u9762\u90fd\u5185\u5d4c\u540c\u4e00\u4efd\u5386\u53f2\u5feb\u7167\u3001\u811a\u672c\u5e93\u4e0e\u4e16\u754c\u4e66\uff1b\u6279\u91cf\u5c55\u793a\u8ba9\u5b83\u4eec\u5171\u7528\u540c\u4e00\u5bf9\u8c61\uff0c
 * \u8fd9\u91cc\u6309\u5bf9\u8c61\u8eab\u4efd\u7f13\u5b58\u8f6c\u4e49\u540e\u7684 JSON\uff0cN \u4e2a\u5361\u9762\u53ea\u5e8f\u5217\u5316\u4e00\u6b21\u3002\u7f13\u5b58\u524d\u63d0\u662f\u8fd9\u4e9b\u5c55\u793a\u5feb\u7167
 * \u521b\u5efa\u540e\u4e0d\u518d\u539f\u5730\u4fee\u6539\uff08\u5ba2\u6237\u7aef\u53ea\u8bfb\uff0c\u5237\u65b0\u603b\u662f\u6362\u65b0\u5bf9\u8c61\uff09\u3002
 */
const scriptJsonCache = new WeakMap();
function cachedScriptJson(value, encode) {
    let json = scriptJsonCache.get(value);
    if (json === undefined) {
        json = encode();
        scriptJsonCache.set(value, json);
    }
    return json;
}
/** \u9875\u96c6\u5408\u53ea\u6709\u5f53\u524d\u9875\u4e14\u4e0e\u6d88\u606f\u672c\u8eab\u4e00\u81f4\uff1aiframe \u5185\u53ef\u7531\u6d88\u606f\u5b57\u6bb5\u539f\u6837\u91cd\u5efa\u3002 */
function isDefaultSwipe(message) {
    const swipe = message.swipe, page = swipe?.pages[0];
    if (!swipe || !page || swipe.active !== 0 || swipe.pages.length !== 1 || Object.keys(swipe).join() !== 'active,pages' || Object.keys(page).join() !== 'message,data,extra')
        return false;
    if (page.message !== message.message)
        return false;
    const same = (left, right) => left === right || JSON.stringify(left) === JSON.stringify(right);
    return same(page.data, message.data) && same(page.extra, message.extra);
}
/**
 * \u5feb\u7167\u7684\u811a\u672c\u5185\u5d4c\u5f62\u5f0f\uff1a\u9ed8\u8ba4\u9875\u96c6\u5408\u4e0d\u518d\u628a\u6b63\u6587\u548c\u53d8\u91cf\u5404\u5199\u4e00\u904d\uff0c\u6539\u8bb0 swipeDefaults \u4e0b\u6807\uff0c
 * \u7531\u6865\u63a5\u811a\u672c\u5728\u4efb\u4f55\u5361\u9762\u4ee3\u7801\u8fd0\u884c\u524d\u8fd8\u539f\u6210\u4e0e\u539f\u5feb\u7167\u9010\u5b57\u6bb5\u76f8\u540c\u7684\u72ec\u7acb\u526f\u672c\u3002
 */
function snapshotScriptJson(input) {
    // 与 JSON.stringify 同口径：先取 toJSON 结果，跳过 undefined、函数与 symbol 字段。
    const custom = input.toJSON;
    const snapshot = typeof custom === 'function' ? custom.call(input) : input;
    const fields = Object.entries(snapshot).filter(([, value]) => value !== undefined && typeof value !== 'function' && typeof value !== 'symbol').map(([key, value]) => {
        if (key === 'messages' && Array.isArray(value)) {
            return '"messages":' + cachedScriptJson(snapshot.messages, () => {
                const defaults = [];
                const messages = snapshot.messages.map((message, index) => {
                    if (!isDefaultSwipe(message))
                        return message;
                    defaults.push(index);
                    const { swipe: _swipe, ...rest } = message;
                    return rest;
                });
                return escapeScriptJson(messages) + ',"swipeDefaults":' + escapeScriptJson(defaults);
            });
        }
        if (key === 'scopes' && value && typeof value === 'object')
            return '"scopes":' + cachedScriptJson(snapshot.scopes, () => escapeScriptJson(snapshot.scopes));
        return escapeScriptJson(key) + ':' + escapeScriptJson(value);
    });
    return '{' + fields.join(',') + '}';
}
// 白名单条目的合法形态：主机名[:端口]，或带 https?:// 前缀。含引号/空白等字符的条目会
// 截断 meta content 属性注入 HTML、或让整条 CSP 失效，一律丢弃。
const CSP_HOST_RE = /^(?:https?:\/\/)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;
function cspContent(connectHosts) {
    const raw = connectHosts.map((h) => h.trim()).filter((h) => h === '*' || CSP_HOST_RE.test(h));
    // `*` = 全部放行（一劳永逸开关）：connect-src/script-src 放开到 https/http。
    // iframe 无 allow-same-origin（opaque origin），卡内脚本仍够不到主窗口。
    const allowAll = raw.includes('*');
    const hosts = raw.filter((h) => h !== '*').map((h) => (h.includes('://') ? h : `https://${h}`));
    const connect = allowAll ? 'https: http:' : hosts.length > 0 ? hosts.join(' ') : "'none'";
    // 白名单主机同时进 script-src：有的封面会 fetch 外部 HTML 再 document.write，
    // 拉回的页面常带 <script src>，只放行 connect-src 仍然跑不起来。
    // Vue 等模板编译器依赖 Function；仅在 opaque-origin 沙箱内允许动态编译，
    // 不改变外部主机白名单、connect-src 或主页面权限。
    const localScript = "'unsafe-inline' 'unsafe-eval'";
    const script = allowAll ? `${localScript} https: http:` : [localScript, ...hosts].join(' ');
    return [
        "default-src 'none'",
        `script-src ${script}`,
        "style-src 'unsafe-inline' https:",
        'img-src https: http: data: blob:',
        'font-src https: http: data:',
        'media-src https: http: data: blob:',
        `connect-src ${connect}`,
    ].join('; ');
}
/** SillyTavern / tavernhelper 常用入口的 stub；卡内按钮经 postMessage 请求 swipeGreeting。 */
export function tavernCardBridgeScript(options) {
    // 小字段照常序列化（缺省字段同样省略），只把可缓存的大快照拼接进去；source 恒在，对象不为空。
    const head = escapeScriptJson({ greetings: options.greetings, greetingIndex: options.greetingIndex, source: CARD_BRIDGE_SOURCE });
    const payload = options.helperSnapshot ? head.slice(0, -1) + ',"helperSnapshot":' + snapshotScriptJson(options.helperSnapshot) + '}' : head;
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
  // 局域网 http 打开宿主时 iframe 也不是安全上下文，crypto.randomUUID 不存在；桥接代码与卡片脚本
  // 都会调用它。getRandomValues 不受限制，用它补一个 v4 实现。
  (function () {
    var c = window.crypto;
    if (!c || typeof c.randomUUID === 'function' || typeof c.getRandomValues !== 'function') return;
    try {
      Object.defineProperty(c, 'randomUUID', { configurable: true, writable: true, value: function () {
        var b = c.getRandomValues(new Uint8Array(16)), h = '';
        b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
        for (var i = 0; i < 16; i++) h += (b[i] + 256).toString(16).slice(1);
        return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
      } });
    } catch (e) {}
  })();
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
  // 还原内嵌时省去的默认页集合：每页数据是独立副本，与逐字段内嵌的旧快照行为一致。
  (function (snapshot) {
    if (!snapshot || !snapshot.swipeDefaults) return;
    var list = snapshot.swipeDefaults;
    delete snapshot.swipeDefaults;
    for (var i = 0; i < list.length; i++) {
      var m = snapshot.messages[list[i]];
      if (m) m.swipe = { active: 0, pages: [{ message: m.message, data: JSON.parse(JSON.stringify(m.data)), extra: JSON.parse(JSON.stringify(m.extra)) }] };
    }
  })(cfg.helperSnapshot);
  // 先固定本次运行时，所有业务桥随后捕获它；document.write 重建后旧异步任务不能认领新身份。
  var cleanupEvents = (${installCardEvents.toString()})(Boolean(cfg.helperSnapshot));
  var runtimeId = window.__dshTavernEventRuntimeId;
  var cleanupPersistence = cfg.helperSnapshot ? (${installCardPersistence.toString()})(cfg.helperSnapshot,cfg.source,
    ${escapeScriptJson(options.persistenceLabels ?? { saving: 'Saving story variables…', saved: 'Story variables saved', failed: 'Story variable save failed; keep a backup and refresh' })}) : function () {};
  (${installCardVariables.toString()})(${escapeScriptJson(options.variableLabels ?? {
        title: 'Card variables / backup', note: options.helperSnapshot ? 'Variables save to this story. Wait for the saved status before leaving; keep a backup if saving fails. Restoring also updates story variables.' : 'Card variables stay in this preview only. Copy a backup before leaving or refreshing.',
        backup: 'Select backup text', text: 'Card variable backup',
    })}, ${escapeScriptJson(options.variableStyles ?? '')}, cfg.helperSnapshot ? cfg.helperSnapshot.currentMessageId : ${escapeScriptJson(options.helperContext?.messageId ?? 0)}, cfg.helperSnapshot ? cfg.helperSnapshot.messages.length : undefined);
  function post(action, extra) {
    var msg = { source: cfg.source, action: action, runtimeId: runtimeId };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
    try { parent.postMessage(msg, '*'); } catch (e) {}
  }
  var cleanupHelper = (${installCardHelper.toString()})(Object.assign(${escapeScriptJson(options.helperContext ?? {})},{snapshot:cfg.helperSnapshot}), cfg.greetings, cfg.greetingIndex, cfg.source,
    ${escapeScriptJson(options.helperLabels ?? { diagnostics: "Card script messages", unsupported: "Not available in this card sandbox" })});
  var cleanupMvu=(function(){
    var HELPER_MAX_BYTES=1024*1024,helperRecord=(${helperRecord.toString()}),helperJson=(${helperJson.toString()});
    return (${installCardMvu.toString()})((${createHelperMvuCommandCodec.toString()})(helperJson,(${markdownCodeScanner.toString()})),helperJson);
  })();
  var cleanupMvuRunner=${options.mvuRunner ? `(function(){var HELPER_MAX_BYTES=1024*1024,helperRecord=(${helperRecord.toString()}),helperJson=(${helperJson.toString()});return (${installCardMvuRunner.toString()})((${createHelperMvuInitialData.toString()}),helperJson);})()` : 'function(){}'};
  var ro = null, mo = null, timers = [], lastHeight = 0;
  var heightFrame = null, heightFrameKind = '', heightActive = true;
  var scriptContext=${escapeScriptJson(options.scriptContext ?? null)};
  var scriptLibraries=${options.scriptLibraries ? cachedScriptJson(options.scriptLibraries, () => escapeScriptJson(options.scriptLibraries)) : 'null'};
  var cleanupScriptLibraries=scriptLibraries?(function(){
    var HELPER_MAX_BYTES=1024*1024;
    var helperRecord=(${helperRecord.toString()});
    var helperJson=(${helperJson.toString()});
    var parseScriptTrees=(${parseHelperScriptTrees.toString()});
    var normalize=function(input){return parseScriptTrees(input,helperJson,helperRecord);};
    return (${installCardScriptLibraries.toString()})(scriptLibraries,normalize,helperJson,${escapeScriptJson(options.scriptLibraryLabels ?? { saving: 'Saving script library…', saved: 'Script library saved', failed: 'Script library save failed; keep your edits and refresh' })});
  })():function(){};
  var worldbooks=${options.worldbooks ? cachedScriptJson(options.worldbooks, () => escapeScriptJson(options.worldbooks)) : 'null'};
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
      // 用实际边界及外边距测量，避免根 scrollHeight 在有/无滚动条之间反复撑高和缩小。
      function bottomWithMargin(node) {
        var rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
        var margin = typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(node).marginBottom) || 0 : 0;
        return rect ? rect.bottom + (window.scrollY || 0) + Math.max(0, margin) : 0;
      }
      if (body) {
        h = Math.max(h, body.offsetHeight || 0, bottomWithMargin(body));
        if (body.scrollHeight > (el ? el.clientHeight : 0)) h = Math.max(h, body.scrollHeight);
        var nodes = body.querySelectorAll('*');
        var n = Math.min(nodes.length, 400);
        for (var i = 0; i < n; i++) {
          // Chromium 仍可返回收起 details 内部的旧矩形，不能把不可见内容撑回 iframe。
          var hidden = false;
          var clippedBottom = Infinity;
          for (var ancestor = nodes[i].parentElement; ancestor && ancestor !== body; ancestor = ancestor.parentElement) {
            if (ancestor.tagName === 'DETAILS' && !ancestor.open) {
              var summary = Array.prototype.find.call(ancestor.children, function(child) { return child.tagName === 'SUMMARY'; });
              if (!summary || !summary.contains(nodes[i])) { hidden = true; break; }
            }
            // 卡内滚动/裁切区域不应被其隐藏后代反向撑高；body/root 仍由外层自适应。
            if (typeof getComputedStyle === 'function' && /^(auto|scroll|hidden|clip)$/.test(getComputedStyle(ancestor).overflowY)) {
              clippedBottom = Math.min(clippedBottom, ancestor.getBoundingClientRect().bottom + (window.scrollY || 0));
            }
          }
          if (hidden) continue;
          h = Math.max(h, Math.min(clippedBottom, bottomWithMargin(nodes[i])));
        }
      }
      if (h > 0 && Math.ceil(h) !== lastHeight) {
        lastHeight = Math.ceil(h);
        post('resize', { height: lastHeight });
      }
    } catch (e) {}
  }
  // DOM 库常在一个任务内连续改多处节点；观察器、资源事件与兜底定时器都只预约
  // 下一帧的一次布局读取，避免同一帧反复 query/getComputedStyle 强制回流。
  function scheduleHeight() {
    if (!heightActive || heightFrame !== null) return;
    var flush = function () {
      heightFrame = null;
      heightFrameKind = '';
      if (heightActive) reportHeight();
    };
    if (typeof window.requestAnimationFrame === 'function' && typeof window.cancelAnimationFrame === 'function') {
      heightFrameKind = 'raf';
      heightFrame = window.requestAnimationFrame(flush);
    } else {
      heightFrameKind = 'timeout';
      heightFrame = setTimeout(flush, 0);
    }
  }
  function watchHeight() {
    scheduleHeight();
    if (typeof ResizeObserver !== 'undefined') {
      try {
        ro = new ResizeObserver(function () { scheduleHeight(); });
        if (document.documentElement) ro.observe(document.documentElement);
        if (document.body) ro.observe(document.body);
      } catch (e2) {}
    }
    // 绝对定位组件、延迟脚本和图片的尺寸变化不一定改变 body/root 的 content box，
    // ResizeObserver 因而可能完全不触发。观察 DOM 变更并捕获资源 load，保证旧卡后续展开仍能自适应。
    if (typeof MutationObserver !== 'undefined' && document.documentElement) {
      try {
        mo = new MutationObserver(function () { scheduleHeight(); });
        mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      } catch (e3) {}
    }
    window.addEventListener('load', scheduleHeight);
    document.addEventListener('load', scheduleHeight, true);
    document.addEventListener('toggle', scheduleHeight, true);
    timers.push(setTimeout(scheduleHeight, 300), setTimeout(scheduleHeight, 1200));
  }
  window.__dshTavernBridgeCleanup = function () {
    heightActive = false;
    if (heightFrame !== null) {
      if (heightFrameKind === 'raf') window.cancelAnimationFrame(heightFrame);
      else clearTimeout(heightFrame);
      heightFrame = null;
      heightFrameKind = '';
    }
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
    if (mo) mo.disconnect();
    timers.forEach(clearTimeout);
    window.removeEventListener('load', scheduleHeight);
    document.removeEventListener('load', scheduleHeight, true);
    document.removeEventListener('toggle', scheduleHeight, true);
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
    return (${wrapCardDocument.toString()})(html, cspHtml + libraryHtml + stubHtml, (${hasCardDocumentShell.toString()})(html));
  }
  // 浏览器里 document.write 后不调用 close 仍会渲染（文档保持打开）。缓冲整页时若同一任务内
  // 没等到 close，就在下一任务补写并保持打开；否则只写不关的封面会整页空白。
  var flushTimer = null;
  function flushBuffered(close) {
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    if (writeBuf === null) return false;
    var html = injectBridge(writeBuf);
    writeBuf = null;
    origOpen();
    origWrite(html);
    if (close) origClose();
    return true;
  }
  function deferFlush() {
    if (flushTimer === null) flushTimer = setTimeout(function () { flushTimer = null; flushBuffered(false); }, 0);
  }
  document.open = function () {
    writeBuf = '';
    deferFlush();
    return document;
  };
  document.write = function () {
    var chunk = Array.prototype.join.call(arguments, '');
    if (writeBuf === null) {
      if (/<!DOCTYPE/i.test(chunk) || /<html[\\s>]/i.test(chunk) || /<body[\\s>]/i.test(chunk)) {
        writeBuf = chunk;
        deferFlush();
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
    if (!flushBuffered(true)) return origClose();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchHeight);
  else watchHeight();
})();
</script>`;
}
/**
 * 所有第三方字节之前先建立真实 head；不能用正则在不可信 HTML 中找插入点。
 * 完整卡不预建 body：原有 html/body start tag 会由 HTML 解析器把
 * lang/dir/class/style/onload 等属性投影到真实根节点。普通片段仍预建 body，保证
 * 放在首位的旧卡脚本立即访问 document.body。初次加载和 document.write 共用此包装。
 */
function wrapCardDocument(html, trustedHead, fullDocument) {
    const head = `<!DOCTYPE html><html><head><meta charset="utf-8">${trustedHead}<meta name="color-scheme" content="light dark"></head>`;
    return fullDocument ? `${head}${html}</html>` : `${head}<body>${html}</body></html>`;
}
/** document.write 运行时的独立文档壳识别；可安全 toString 注入，不依赖宿主模块。 */
function hasCardDocumentShell(html) {
    const tokens = /<!--[\s\S]*?(?:-->|$)|<!doctype\s+html\b[^>]*>|<\/?([A-Za-z][A-Za-z0-9:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
    for (let token = tokens.exec(html); token; token = tokens.exec(html)) {
        const raw = token[0];
        if (raw.startsWith('<!--'))
            continue;
        if (/^<!doctype/i.test(raw))
            return true;
        const tag = token[1]?.toLowerCase(), closing = raw.startsWith('</');
        if (!closing && (tag === 'html' || tag === 'body'))
            return true;
        if (!closing && ['script', 'style', 'textarea', 'title', 'pre', 'code', 'template'].includes(tag ?? '')) {
            const close = new RegExp('</' + tag + '\\s*>', 'gi');
            close.lastIndex = tokens.lastIndex;
            const found = close.exec(html);
            // code/pre 在浏览器中是普通元素，未闭合时只跳过该开标签，与宿主侧识别口径一致。
            if (!found) {
                if (tag === 'code' || tag === 'pre')
                    continue;
                return false;
            }
            tokens.lastIndex = close.lastIndex;
        }
    }
    return false;
}
/**
 * 只在卡面可能执行自有 JavaScript 时注入兼容库。误判为 true 只多加载库；只有完全
 * 没有 script、内联事件或 javascript: URL 的静态标记才会走轻量路径。后台脚本和
 * MVU runner 即使正文为空也依赖库，必须强制保留。
 */
function needsCardLibraries(html, options) {
    return Boolean(options.mvuRunner || options.scriptContext)
        || /<script\b|\bon[a-z][\w:-]*\s*=|javascript\s*:/i.test(html);
}
/** 把 CSP 与 ST 桥接脚本注入交互卡 HTML，得到 iframe srcDoc。 */
export function buildCardSrcDoc(html, options) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${cspContent(options.connectHosts ?? [])}">`;
    const stub = tavernCardBridgeScript(options);
    const libraries = needsCardLibraries(html, options) ? CARD_LIBRARY_TAG : '';
    return wrapCardDocument(html, meta + libraries + stub, isFullHtmlDocument(html));
}
export function parseCardBridgeMessage(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return null;
    const rec = data;
    if (rec.source !== CARD_BRIDGE_SOURCE || typeof rec.action !== 'string')
        return null;
    if (rec.action !== 'swipeGreeting' && rec.action !== 'resize')
        return null;
    if (rec.action === 'swipeGreeting' && (typeof rec.index !== 'number' || !Number.isSafeInteger(rec.index) || rec.index < 0))
        return null;
    const index = typeof rec.index === 'number' && Number.isFinite(rec.index) ? rec.index : undefined;
    const height = typeof rec.height === 'number' && Number.isFinite(rec.height) ? rec.height : undefined;
    return {
        source: rec.source,
        action: rec.action,
        ...(index !== undefined ? { index } : {}),
        ...(height !== undefined ? { height } : {}),
    };
}
