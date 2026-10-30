// 远端会话真终端：provider 在远端沙箱里跑 ttyd（可写 / 只读各一个），worker 在自己的
// `/s/<id>` 路由下转发它的页面和 WebSocket，带上平台凭证（TAE 网关认 Pod 的 ZTI）。
// 链接、token、过期这些授权仍由 worker 现有逻辑判定，这里只负责「接到哪里」。
//
// WebSocket 按消息逐帧转发，不拼原始 socket：编译态跑在 Bun 上，Bun 的客户端 upgrade
// 事件和服务端 upgrade socket 都不可靠（见 terminal-proxy.ts 头注释），ws 的消息层在
// Bun / Node 上行为一致。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { gunzipSync } from 'node:zlib';
import { WebSocket, type RawData } from 'ws';

export const REMOTE_WEB_TERMINAL_CREDENTIAL_HEADER = 'x-zti-token';
/** ttyd 的 WebSocket 子协议；浏览器和上游都必须协商到它。 */
export const TTYD_SUBPROTOCOL = 'tty';
/** 取页面的总时限（不是空闲超时）：超时就退回截屏页，不让一次打开挂太久。 */
const PAGE_TIMEOUT_MS = 8_000;
/** ttyd 1.7.7 的页面 gzip 后约 190KB、解开约 730KB；上限留出余量，也挡住 gzip 炸弹。 */
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_PAGE_DECODED_BYTES = 2 * 1024 * 1024;
/**
 * 允许下发的 ttyd 页面（解压后的 sha256）。页面来自沙箱端口，沙箱里的程序可以换掉
 * ttyd；页面又以本站同源下发，所以只认 Runtime 钉住的 ttyd 版本自带的那一份，其它
 * 一律退回截屏页。升级 ttyd 时在这里加新版本的哈希。
 */
const TTYD_PAGE_SHA256 = new Set([
  'dea8c4fd372afc6984abe3857438421cc2ef3eb37a5ac5306a9080b5403a2140', // ttyd 1.7.7
]);
const UPSTREAM_HANDSHAKE_TIMEOUT_MS = 10_000;
/** 上游握手完成前浏览器先发的数据（ttyd 的初始化 JSON 等）；正常只有几百字节。 */
const MAX_PENDING_BYTES = 64 * 1024;
/** 浏览器发来的单帧上限：按键和粘贴都远小于它。 */
const MAX_CLIENT_FRAME_BYTES = 1024 * 1024;
/** 两段连接都定时 ping：轮次之间画面不动，前门和网关会把空闲连接断掉。 */
const KEEPALIVE_MS = 25_000;
/** 浏览器读得慢时先停读上游，积压降下来再恢复，避免在 Host 内存里无限堆积。 */
const CLIENT_HIGH_WATER_BYTES = 4 * 1024 * 1024;
const CLIENT_LOW_WATER_BYTES = 1024 * 1024;
const BACKPRESSURE_POLL_MS = 100;

/** 部署注入的网关域名后缀（逗号分隔，如 `.region.gateway.example`）。 */
export const REMOTE_WEB_TERMINAL_HOST_SUFFIXES_ENV = 'BOTMUX_REMOTE_WEB_TERMINAL_HOST_SUFFIXES';

/**
 * 只有部署声明过的网关地址才会被带上平台凭证访问；没配置时网页终端整体关闭，
 * 退回截屏页。公开仓库不写内部域名，后缀由部署方在启动时注入。
 */
export function remoteWebTerminalHostAllowed(
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const suffixes = (env[REMOTE_WEB_TERMINAL_HOST_SUFFIXES_ENV] ?? '')
    .split(',')
    .map(suffix => suffix.trim().toLowerCase())
    .filter(suffix => /^\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(suffix));
  if (suffixes.length === 0) return false;
  let host: string;
  try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return false; }
  return suffixes.some(suffix => host.endsWith(suffix) && host.length > suffix.length);
}

/** Pod 的平台凭证。TCE 会轮换文件内容，所以每次连接都重新读。 */
export function readPlatformCredential(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const inline = env.SEC_TOKEN_STRING?.trim();
  if (inline) return inline;
  const path = env.SEC_TOKEN_PATH?.trim();
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** ttyd 的 WebSocket 地址：页面地址 + `ws`（页面地址以 `/` 结尾）。 */
export function remoteWebTerminalSocketUrl(pageUrl: string): string {
  const url = new URL('ws', pageUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** 页面是否就是钉住的 ttyd 版本自带的那一份。 */
export function isPinnedTtydPage(page: Buffer): boolean {
  return TTYD_PAGE_SHA256.has(createHash('sha256').update(page).digest('hex'));
}

/**
 * 取 ttyd 的页面，同时充当探活：ttyd 没起来、端口没暴露、网关拒绝、页面不是钉住的
 * ttyd 版本时返回 undefined，调用方退回截屏页。不抛异常。
 */
export function fetchRemoteWebTerminalPage(
  pageUrl: string,
  credential: string,
  opts: { timeoutMs?: number; log?: (message: string) => void; pinned?: (page: Buffer) => boolean } = {},
): Promise<string | undefined> {
  const timeoutMs = opts.timeoutMs ?? PAGE_TIMEOUT_MS;
  const pinned = opts.pinned ?? isPinnedTtydPage;
  let url: URL;
  try { url = new URL(pageUrl); } catch { return Promise.resolve(undefined); }
  const doRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: string | undefined, why?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (why) opts.log?.(`Remote web terminal page unavailable: ${why}`);
      resolve(value);
    };
    let req: ReturnType<typeof httpRequest>;
    try {
      req = doRequest(url, {
        method: 'GET',
        headers: {
          [REMOTE_WEB_TERMINAL_CREDENTIAL_HEADER]: credential,
          accept: 'text/html',
          'accept-encoding': 'gzip',
        },
      }, (res: IncomingMessage) => {
        const type = String(res.headers['content-type'] ?? '');
        if (res.statusCode !== 200 || !type.startsWith('text/html')) {
          res.resume();
          finish(undefined, `HTTP ${res.statusCode}`);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_PAGE_BYTES) {
            req.destroy();
            finish(undefined, 'page too large');
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          let page: Buffer;
          try {
            const body = Buffer.concat(chunks);
            const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
            page = encoding === 'gzip'
              ? gunzipSync(body, { maxOutputLength: MAX_PAGE_DECODED_BYTES })
              : body;
          } catch {
            finish(undefined, 'page decode failed');
            return;
          }
          if (!pinned(page)) {
            finish(undefined, 'page is not the pinned ttyd build');
            return;
          }
          finish(page.toString('utf8'));
        });
        res.on('error', () => finish(undefined, 'response error'));
      });
    } catch (err) {
      finish(undefined, `request failed: ${(err as Error).message}`);
      return;
    }
    timer = setTimeout(() => { req.destroy(); finish(undefined, 'timed out'); }, timeoutMs);
    req.on('error', () => finish(undefined, 'request error'));
    req.end();
  });
}

export interface RemoteWebTerminalPageOptions {
  /** provider 定的 pane 尺寸；未知时不锁定行列，退回 ttyd 自己按窗口铺满。 */
  pane: { cols: number; rows: number } | null | undefined;
  /** 这一页的连接只读：显示只读横幅（与截屏页同一套提示）。 */
  readOnly: boolean;
  /** 平台认证过的只读访客：横幅换成 owner 登录引导。 */
  platformReadonly?: boolean;
  /** owner 登录入口；空串时登录引导只显示文字。 */
  loginUrl?: string;
}

function validPane(pane: RemoteWebTerminalPageOptions['pane']): { cols: number; rows: number } | null {
  if (!pane || !Number.isInteger(pane.cols) || !Number.isInteger(pane.rows)
      || pane.cols < 1 || pane.rows < 1 || pane.cols > 1000 || pane.rows > 1000) {
    return null;
  }
  return pane;
}

/**
 * 给 ttyd 页面加上本站的外壳，脚本放在 `<head>` 开头，赶在 ttyd 建终端之前生效：
 *
 * - 终端行列锁定为 pane 尺寸，窗口变化只调字号。ttyd 默认按窗口铺满，每次窗口变化
 *   都会把新尺寸发给 tmux；之前按窗口二分字号会在一秒内连发十几个尺寸，tmux 按中间
 *   尺寸画出来的内容落到已经变了尺寸的 xterm 上，画面就错位了。行列不变时 xterm 也
 *   不会重排内容。
 * - 查询串只留 `token` / `viewToken` / `issuedTo`（写链接的签名领取人，只用于审计）：
 *   ttyd 会把其它键当终端选项（比如开启文件传输）。
 * - 只读横幅、owner 登录引导和工作台的可写状态上报，与截屏页保持一致。
 */
export function withRemoteWebTerminalPage(html: string, opts: RemoteWebTerminalPageOptions): string {
  const pane = validPane(opts.pane);
  const config = JSON.stringify({
    cols: pane?.cols ?? 0,
    rows: pane?.rows ?? 0,
    readOnly: opts.readOnly,
    platformReadonly: opts.readOnly && opts.platformReadonly === true,
    loginUrl: /^https?:\/\/[^"'<>\s]+$/.test(opts.loginUrl ?? '') ? opts.loginUrl : '',
  }).replace(/</g, '\\u003c');
  const script = `<script>(function(cfg){${PAGE_SHELL_SCRIPT}})(${config});</script>`;
  const at = html.indexOf('<head>');
  return at >= 0 ? html.slice(0, at + 6) + script + html.slice(at + 6) : script + html;
}

// 注入到 ttyd 页面的脚本（ES5，不依赖 ttyd / xterm 的内部实现：只用 window.term、
// term.resize、term.parser.registerOscHandler、term.options.fontSize 和 .xterm-screen
// 的实际尺寸）。
const PAGE_SHELL_SCRIPT = [
  "try{var q=new URLSearchParams(location.search),k=new URLSearchParams();",
  "['token','viewToken','issuedTo'].forEach(function(n){var v=q.get(n);if(v!==null)k.set(n,v);});",
  "var s=k.toString();history.replaceState(history.state,'',location.pathname+(s?'?'+s:'')+location.hash);}catch(e){}",
  "var C=cfg.cols,R=cfg.rows,MIN=4,MAX=40,t=null,timer=null,gen=0,tries=0;",
  // ttyd 赋值 window.term 的瞬间把 resize 固定成 pane 尺寸（它的 fit() 也走 resize）。
  // 尺寸以沙箱里 attach 脚本报的 tmux 窗口实际尺寸为准（私有 OSC 5379），Host 给的只是
  // 初值；两者都没有时不锁，由 ttyd 按窗口铺满。
  "function lock(x){var r=x.resize;x.resize=function(c,w){return C&&R?r.call(x,C,R):r.call(x,c,w);};",
  "if(x.parser&&typeof x.parser.registerOscHandler==='function')x.parser.registerOscHandler(5379,function(d){",
  "var m=/^botmux-pane=(\\d{1,4})x(\\d{1,4})$/.exec(d);if(m){var c=+m[1],w=+m[2];",
  "if(c>=20&&w>=5&&c<=1000&&w<=1000&&(c!==C||w!==R)){C=c;R=w;schedule(0);}}return true;});}",
  "try{Object.defineProperty(window,'term',{configurable:true,get:function(){return t;},",
  "set:function(v){t=v;if(v&&typeof v.resize==='function')lock(v);schedule(0);}});}catch(e){}",
  "function screen(){var e=t&&t.element&&t.element.querySelector('.xterm-screen');return e?e.getBoundingClientRect():null;}",
  // 容器四周各 5px 内边距，右侧再让出滚动条。
  "function area(){var p=t.element.parentElement;return{w:p.clientWidth-26,h:p.clientHeight-10};}",
  // 换字号会改行高，xterm 按滚动条的像素位置重新换算视图所在的行，停在底部的视图会
  // 漂到上面（之后也不再跟随新输出）。一串窗口变化开始时记下是否在底部，字号定下来、
  // xterm 重新换算完之后再回到底部。
  "var bottom=null;",
  "function atBottom(){var b=t&&t.buffer&&t.buffer.active;return !b||b.viewportY>=b.baseY;}",
  "function fit(g){if(g!==gen||!C||!R)return;if(t.cols!==C||t.rows!==R)t.resize(C,R);var s=screen(),a=area();",
  "if(!s||!s.width||a.w<=0||a.h<=0){if(++tries<100)setTimeout(function(){fit(g);},50);return;}",
  "var f=t.options.fontSize,n=Math.max(MIN,Math.min(MAX,Math.floor(f*Math.min(a.w/s.width,a.h/s.height))));",
  "if(n!==f)t.options.fontSize=n;setTimeout(function(){shrink(g);},30);}",
  // 按比例估出的字号可能大一号（取整、像素对齐），放不下就逐级减小；只改字号，不改行列。
  "function shrink(g){if(g!==gen)return;var s=screen(),a=area();",
  "if(s&&(s.width>a.w||s.height>a.h)&&t.options.fontSize>MIN){t.options.fontSize=t.options.fontSize-1;setTimeout(function(){shrink(g);},30);return;}",
  "setTimeout(function(){if(g!==gen)return;var w=bottom;bottom=null;if(w&&typeof t.scrollToBottom==='function')t.scrollToBottom();},120);}",
  "function schedule(d){if(bottom===null)bottom=atBottom();clearTimeout(timer);var g=++gen;tries=0;timer=setTimeout(function(){if(t&&t.element)fit(g);else if(++tries<100)schedule(100);},d);}",
  "window.addEventListener('resize',function(){schedule(150);});",
  // 横幅：与截屏页同样的文案和样式，点一下收起只读提示。
  "function banner(){if(!cfg.readOnly||!document.body)return;",
  "var link=cfg.platformReadonly&&cfg.loginUrl,b=document.createElement(link?'a':'div');",
  "var c=cfg.platformReadonly?'224,175,104':'247,118,142';",
  "b.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:50;padding:4px 10px;font:12px monospace;white-space:nowrap;cursor:pointer;text-decoration:none;border-radius:4px;'",
  "+'color:rgb('+c+');background:rgba('+c+',0.12);border:1px solid rgba('+c+',0.35)';",
  "if(link){b.href=cfg.loginUrl;b.target='_top';b.rel='noopener';b.textContent='owner 登录后可操作 →';}",
  "else{b.textContent=cfg.platformReadonly?'owner 登录后可操作':'只读模式 · 无写入权限';",
  "if(!cfg.platformReadonly)b.addEventListener('click',function(){b.remove();});}",
  "document.body.appendChild(b);}",
  // 工作台终端面板据此显示「可输入 / 只读」；目标 origin 只用 ancestorOrigins，不广播。
  "function post(){try{var o=location.ancestorOrigins;if(window.parent===window||!o||!o.length||!o[0]||o[0]==='null')return;",
  "window.parent.postMessage({type:'botmux:wb-terminal-write',write:!cfg.readOnly},o[0]);}catch(e){}}",
  "window.addEventListener('load',function(){banner();post();});",
].join('');

/** 只有这些关闭码可以由服务端发出；其它（1005/1006/1015 等）换成 1011。 */
function sendableCloseCode(code: number): number {
  if (code === 1000 || code === 1001 || (code >= 3000 && code <= 4999)) return code;
  if (code >= 1007 && code <= 1014 && code !== 1010) return code;
  return 1011;
}

function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else if (ws.readyState === WebSocket.OPEN) ws.close(sendableCloseCode(code), reason.slice(0, 120));
  } catch { /* already closing */ }
}

function terminateQuietly(ws: WebSocket): void {
  try { ws.terminate(); } catch { /* already gone */ }
}

/** ttyd 协议里浏览器发给服务端的帧：首字节 '0' 输入、'1' 调尺寸、'2'/'3' 暂停/恢复输出，'{' 是初始化 JSON。 */
const TTYD_INPUT = 0x30;
const TTYD_READ_ONLY_FRAMES = new Set([0x7b, 0x31, 0x32, 0x33]);

function frameBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export interface RemoteWebTerminalBridgeOptions {
  log?: (message: string) => void;
  /** 只读连接：输入帧在 Host 这里就丢掉，不依赖沙箱里只读端口的配置。 */
  readOnly?: boolean;
  /** 可写连接每发一次输入回调一次（字节数），供审计。 */
  onInput?: (bytes: number) => void;
}

export interface RemoteWebTerminalBridge {
  /** 立即断开两端（授权到期时用）：不等浏览器配合关闭握手，上游先断。 */
  close(code: number, reason: string): void;
}

/**
 * 把一个已授权的浏览器连接接到远端 ttyd。任一端断开，另一端随之关闭。
 *
 * 断开方式决定 ttyd 前端会不会立刻重连：它对非 1000 的正常关闭会马上重连，没有退避。
 * 所以上游连不上、或连接异常中断时，对浏览器直接 terminate（浏览器按异常断开处理，
 * ttyd 停在「按回车重连」），避免沙箱暂停、网关出错时每个开着的页面循环重连。
 */
export function bridgeRemoteWebTerminal(
  client: WebSocket,
  pageUrl: string,
  credential: string,
  opts: RemoteWebTerminalBridgeOptions = {},
): RemoteWebTerminalBridge {
  const log = opts.log ?? (() => {});
  let upstream: WebSocket;
  try {
    upstream = new WebSocket(remoteWebTerminalSocketUrl(pageUrl), [TTYD_SUBPROTOCOL], {
      headers: { [REMOTE_WEB_TERMINAL_CREDENTIAL_HEADER]: credential },
      perMessageDeflate: false,
      handshakeTimeout: UPSTREAM_HANDSHAKE_TIMEOUT_MS,
    });
  } catch (err) {
    log(`Remote web terminal upstream failed: ${(err as Error).message}`);
    terminateQuietly(client);
    return { close: () => {} };
  }
  const pending: Array<{ data: Buffer; binary: boolean }> = [];
  let pendingBytes = 0;
  let upstreamOpened = false;
  let keepalive: NodeJS.Timeout | undefined;
  let drain: NodeJS.Timeout | undefined;
  const stopTimers = () => {
    clearInterval(keepalive);
    clearInterval(drain);
  };

  client.on('message', (data: RawData, isBinary: boolean) => {
    if (client.readyState !== WebSocket.OPEN) return;
    const frame = frameBytes(data);
    if (frame.length === 0) return;
    if (frame.length > MAX_CLIENT_FRAME_BYTES) {
      closeQuietly(client, 1009, 'frame too large');
      terminateQuietly(upstream);
      return;
    }
    if (opts.readOnly && !TTYD_READ_ONLY_FRAMES.has(frame[0])) return;
    if (!opts.readOnly && frame[0] === TTYD_INPUT) opts.onInput?.(frame.length - 1);
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(frame, { binary: isBinary });
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      pendingBytes += frame.length;
      if (pendingBytes > MAX_PENDING_BYTES) {
        closeQuietly(client, 1008, 'terminal input overflow');
        terminateQuietly(upstream);
        return;
      }
      pending.push({ data: frame, binary: isBinary });
    }
  });
  upstream.on('open', () => {
    upstreamOpened = true;
    for (const frame of pending.splice(0)) upstream.send(frame.data, { binary: frame.binary });
    pendingBytes = 0;
    keepalive = setInterval(() => {
      try { if (client.readyState === WebSocket.OPEN) client.ping(); } catch { /* closing */ }
      try { if (upstream.readyState === WebSocket.OPEN) upstream.ping(); } catch { /* closing */ }
    }, KEEPALIVE_MS);
    keepalive.unref?.();
  });
  upstream.on('message', (data: RawData, isBinary: boolean) => {
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(data, { binary: isBinary });
    if (client.bufferedAmount > CLIENT_HIGH_WATER_BYTES && !drain) {
      upstream.pause();
      drain = setInterval(() => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount < CLIENT_LOW_WATER_BYTES) {
          clearInterval(drain);
          drain = undefined;
          upstream.resume();
        }
      }, BACKPRESSURE_POLL_MS);
      drain.unref?.();
    }
  });
  upstream.on('close', (code: number, reason: Buffer) => {
    stopTimers();
    if (upstreamOpened && code !== 1006) closeQuietly(client, code, reason.toString('utf8') || 'terminal closed');
    else terminateQuietly(client);
  });
  upstream.on('error', (err: Error) => {
    stopTimers();
    log(`Remote web terminal upstream error: ${err.message}`);
    terminateQuietly(client);
  });
  client.on('close', () => {
    stopTimers();
    closeQuietly(upstream, 1000, 'client closed');
  });
  client.on('error', () => {
    stopTimers();
    closeQuietly(upstream, 1000, 'client error');
  });
  return {
    close(code: number, reason: string) {
      stopTimers();
      terminateQuietly(upstream);
      closeQuietly(client, code, reason);
    },
  };
}
