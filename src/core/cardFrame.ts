/**
 * 交互卡 iframe srcDoc 组装：CSP + SillyTavern / JS-Slash-Runner 窄桥脚本 +
 * 内存版 localStorage/sessionStorage shim（opaque origin 下原生访问会抛 SecurityError）。
 * 卡内 JS 不能碰主窗口；只通过 postMessage 请求切换开场白 swipe。
 */

export const CARD_BRIDGE_SOURCE = 'dsh-tavern-card'

export interface CardFrameOptions {
  /** 开场白变体（0 = first_mes）。供 getChatMessages / swipe_id 使用。 */
  greetings: string[]
  greetingIndex: number
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
  const script = allowAll ? "'unsafe-inline' https: http:" : ["'unsafe-inline'", ...hosts].join(' ')
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
export function tavernCardBridgeScript(options: Pick<CardFrameOptions, 'greetings' | 'greetingIndex'>): string {
  const payload = escapeScriptJson({
    greetings: options.greetings,
    greetingIndex: options.greetingIndex,
    source: CARD_BRIDGE_SOURCE,
  })
  return `<script data-dsh-tavern-bridge>
(function () {
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
  function post(action, extra) {
    var msg = { source: cfg.source, action: action };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
    try { parent.postMessage(msg, '*'); } catch (e) {}
  }
  function msgAt(i) {
    var g = cfg.greetings || [];
    var idx = typeof i === 'number' ? i : cfg.greetingIndex;
    if (idx < 0) idx = 0;
    if (g.length && idx >= g.length) idx = idx % g.length;
    var mes = g[idx] != null ? g[idx] : (g[0] || '');
    return {
      message: mes,
      mes: mes,
      name: '',
      is_user: false,
      is_system: false,
      swipe_id: idx,
      swipes: g.slice(),
      extra: {},
      send_date: Date.now()
    };
  }
  async function getChatMessages(range) {
    void range;
    return [msgAt(cfg.greetingIndex)];
  }
  async function setChatMessage(field, messageId, options) {
    void field;
    void messageId;
    var opts = options || {};
    var index = typeof opts.swipe_id === 'number' ? opts.swipe_id : cfg.greetingIndex;
    post('swipeGreeting', { index: index });
  }
  async function triggerSlash(text) {
    var t = String(text || '');
    if (/^\\/swipe\\b/i.test(t)) post('swipeGreeting', { index: cfg.greetingIndex + 1 });
    return t;
  }
  var chat = [msgAt(cfg.greetingIndex)];
  function saveChat() {
    var swipe = chat[0] && typeof chat[0].swipe_id === 'number' ? chat[0].swipe_id : cfg.greetingIndex;
    post('swipeGreeting', { index: swipe });
    return Promise.resolve();
  }
  var ctx = {
    chat: chat,
    swipe: function () { post('swipeGreeting', { index: cfg.greetingIndex + 1 }); },
    saveChat: saveChat
  };
  var api = { getChatMessages: getChatMessages, setChatMessage: setChatMessage, triggerSlash: triggerSlash };
  window.getChatMessages = getChatMessages;
  window.setChatMessage = setChatMessage;
  window.triggerSlash = triggerSlash;
  window.toastr = window.toastr || { info: function () {}, success: function () {}, warning: function () {}, error: function () {} };
  window.SillyTavern = { getContext: function () { return ctx; } };
  window.TavernHelper = Object.assign(window.TavernHelper || {}, api);
  function reportHeight() {
    try {
      var h = 0;
      var el = document.documentElement;
      var body = document.body;
      if (el) h = Math.max(h, el.scrollHeight || 0, el.offsetHeight || 0);
      if (body) {
        h = Math.max(h, body.scrollHeight || 0, body.offsetHeight || 0);
        var nodes = body.querySelectorAll('*');
        var n = Math.min(nodes.length, 400);
        for (var i = 0; i < n; i++) {
          var r = nodes[i].getBoundingClientRect();
          if (r && r.bottom > h) h = r.bottom;
        }
      }
      if (h > 0) post('resize', { height: Math.ceil(h) });
    } catch (e) {}
  }
  function watchHeight() {
    reportHeight();
    if (typeof ResizeObserver !== 'undefined') {
      try {
        var ro = new ResizeObserver(function () { reportHeight(); });
        if (document.documentElement) ro.observe(document.documentElement);
        if (document.body) ro.observe(document.body);
      } catch (e2) {}
    }
    window.addEventListener('load', reportHeight);
    setTimeout(reportHeight, 300);
    setTimeout(reportHeight, 1200);
  }
  // 封面常 document.write 整页 HTML，会冲掉 head 里的桥。把 stub/CSP 写回后再落盘。
  var origOpen = document.open.bind(document);
  var origWrite = document.write.bind(document);
  var origClose = document.close.bind(document);
  var writeBuf = null;
  var stubNode = document.currentScript;
  var stubHtml = stubNode && stubNode.outerHTML ? stubNode.outerHTML : '';
  var cspNode = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  var cspHtml = cspNode && cspNode.outerHTML ? cspNode.outerHTML : '';
  function injectBridge(html) {
    if (!html) return html;
    if (stubHtml && html.indexOf('data-dsh-tavern-bridge') < 0) {
      if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, function (m) { return m + cspHtml + stubHtml; });
      else html = '<head>' + cspHtml + stubHtml + '</head>' + html;
    }
    return html;
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

function injectHead(html: string, headInner: string): string {
  const head = /<head[^>]*>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + headInner + html.slice(at)
  }
  return `<head>${headInner}</head>${html}`
}

/** 正则常产出无 html 根的片段；包一层文档，CSS/脚本和高度测量才站得住。 */
function ensureHtmlDocument(html: string): string {
  if (/<html[\s>]/i.test(html)) return html
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`
}

/** 把 CSP 与 ST 桥接脚本注入交互卡 HTML，得到 iframe srcDoc。 */
export function buildCardSrcDoc(html: string, options: CardFrameOptions): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${cspContent(options.connectHosts ?? [])}">`
  const stub = tavernCardBridgeScript(options)
  return injectHead(ensureHtmlDocument(html), meta + stub)
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
  const index = typeof rec.index === 'number' && Number.isFinite(rec.index) ? rec.index : undefined
  const height = typeof rec.height === 'number' && Number.isFinite(rec.height) ? rec.height : undefined
  return {
    source: rec.source,
    action: rec.action,
    ...(index !== undefined ? { index } : {}),
    ...(height !== undefined ? { height } : {}),
  }
}
