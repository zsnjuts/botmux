import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  bridgeRemoteWebTerminal,
  fetchRemoteWebTerminalPage,
  readPlatformCredential,
  remoteWebTerminalHostAllowed,
  remoteWebTerminalSocketUrl,
  isPinnedTtydPage,
  withRemoteWebTerminalPage,
} from '../src/core/remote-web-terminal.js';
import { runInNewContext } from 'node:vm';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      closers.push(() => new Promise((done) => server.close(() => done())));
      resolve((server.address() as { port: number }).port);
    });
  });
}

/** A stand-in for ttyd behind the gateway: checks the credential header and echoes frames. */
async function fakeTtyd(credential: string, page: Buffer = Buffer.from('<html>ttyd</html>')) {
  const seen: { headers: Record<string, unknown>; protocol: string; frames: Array<{ text: string; binary: boolean }> } = {
    headers: {}, protocol: '', frames: [],
  };
  const server = createServer((req, res) => {
    if (req.headers['x-zti-token'] !== credential) {
      res.writeHead(403).end('denied');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(gzipSync(page));
  });
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ req }) => req.headers['x-zti-token'] === credential,
  });
  wss.on('connection', (socket, req) => {
    seen.headers = req.headers;
    seen.protocol = socket.protocol;
    socket.on('message', (data: RawData, isBinary: boolean) => {
      seen.frames.push({ text: data.toString(), binary: isBinary });
      if (data.toString() === 'bye') socket.close(4000, 'done');
      else socket.send(Buffer.from(`0echo:${data.toString()}`), { binary: true });
    });
  });
  closers.push(() => new Promise((done) => { for (const c of wss.clients) c.terminate(); wss.close(() => done()); }));
  const port = await listen(server);
  return { pageUrl: `http://127.0.0.1:${port}/`, seen };
}

/** The worker side: every browser connection is bridged to `pageUrl`. */
async function front(
  pageUrl: string,
  credential: string,
  opts: Parameters<typeof bridgeRemoteWebTerminal>[3] = {},
  bridges: Array<ReturnType<typeof bridgeRemoteWebTerminal>> = [],
): Promise<string> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => bridges.push(bridgeRemoteWebTerminal(socket, pageUrl, credential, opts)));
  closers.push(() => new Promise((done) => { for (const c of wss.clients) c.terminate(); wss.close(() => done()); }));
  const port = await listen(server);
  return `ws://127.0.0.1:${port}/ws?token=t`;
}

function nextMessage(ws: WebSocket): Promise<{ text: string; binary: boolean }> {
  return new Promise((resolve) => ws.once('message', (data: RawData, isBinary: boolean) => resolve({ text: data.toString(), binary: isBinary })));
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => ws.once('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() })));
}

describe('remote web terminal', () => {
  it('derives the ttyd socket from the page URL', () => {
    expect(remoteWebTerminalSocketUrl('https://port-7681-abc.sandbox.example.test/'))
      .toBe('wss://port-7681-abc.sandbox.example.test/ws');
  });

  it('only allows hosts under the deployment-injected gateway suffixes', () => {
    const env = { BOTMUX_REMOTE_WEB_TERMINAL_HOST_SUFFIXES: '.sandbox.example.test, .other.example.test' };
    expect(remoteWebTerminalHostAllowed('https://port-7681-abc.sandbox.example.test/', env)).toBe(true);
    expect(remoteWebTerminalHostAllowed('https://port-7681-abc.other.example.test/', env)).toBe(true);
    expect(remoteWebTerminalHostAllowed('https://port-7681-abc.sandbox.example.test.evil.test/', env)).toBe(false);
    expect(remoteWebTerminalHostAllowed('https://evilsandbox.example.test/', env)).toBe(false);
    expect(remoteWebTerminalHostAllowed('https://port-7681-abc.sandbox.example.test/', {})).toBe(false);
    expect(remoteWebTerminalHostAllowed('https://port-7681-abc.sandbox.example.test/', {
      BOTMUX_REMOTE_WEB_TERMINAL_HOST_SUFFIXES: 'sandbox.example.test',
    })).toBe(false);
  });

  it('reads the platform credential inline or from the rotated file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zti-'));
    const file = join(dir, 'identity.token');
    writeFileSync(file, 'from-file\n');
    expect(readPlatformCredential({ SEC_TOKEN_STRING: ' inline ', SEC_TOKEN_PATH: file })).toBe('inline');
    expect(readPlatformCredential({ SEC_TOKEN_PATH: file })).toBe('from-file');
    expect(readPlatformCredential({ SEC_TOKEN_PATH: join(dir, 'missing') })).toBeUndefined();
    expect(readPlatformCredential({})).toBeUndefined();
  });

  it('fetches the ttyd page with the credential and treats a refusal as unavailable', async () => {
    const ttyd = await fakeTtyd('zti');
    const anyPage = { pinned: () => true };
    expect(await fetchRemoteWebTerminalPage(ttyd.pageUrl, 'zti', anyPage)).toBe('<html>ttyd</html>');
    expect(await fetchRemoteWebTerminalPage(ttyd.pageUrl, 'wrong', anyPage)).toBeUndefined();
    expect(await fetchRemoteWebTerminalPage('http://127.0.0.1:1/', 'zti', { ...anyPage, timeoutMs: 1000 })).toBeUndefined();
  });

  it('only serves the pinned ttyd page, never whatever the sandbox port returns', async () => {
    const ttyd = await fakeTtyd('zti', Buffer.from('<html><script>steal()</script></html>'));
    const reasons: string[] = [];
    expect(await fetchRemoteWebTerminalPage(ttyd.pageUrl, 'zti', { log: (m) => reasons.push(m) })).toBeUndefined();
    expect(reasons.join('\n')).toContain('not the pinned ttyd build');
    expect(isPinnedTtydPage(Buffer.from('<html>ttyd</html>'))).toBe(false);
  });

  it('refuses a gzip bomb and a page that never finishes', async () => {
    const bomb = await fakeTtyd('zti', Buffer.alloc(64 * 1024 * 1024, 0x20));
    expect(await fetchRemoteWebTerminalPage(bomb.pageUrl, 'zti', { pinned: () => true })).toBeUndefined();

    const drip = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      const timer = setInterval(() => res.write(' '), 50);
      res.on('close', () => clearInterval(timer));
    });
    const port = await listen(drip);
    const started = Date.now();
    expect(await fetchRemoteWebTerminalPage(`http://127.0.0.1:${port}/`, 'zti', { pinned: () => true, timeoutMs: 400 })).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('bridges frames both ways with the credential and the tty subprotocol', async () => {
    const ttyd = await fakeTtyd('zti');
    const inputs: number[] = [];
    const browser = new WebSocket(await front(ttyd.pageUrl, 'zti', { onInput: (n) => inputs.push(n) }), ['tty']);
    // ttyd's page sends its init frame right on open — before the upstream is up.
    browser.on('open', () => browser.send(Buffer.from('{"AuthToken":""}'), { binary: true }));
    const first = await nextMessage(browser);
    expect(first).toEqual({ text: '0echo:{"AuthToken":""}', binary: true });
    browser.send('0ls');
    expect(await nextMessage(browser)).toEqual({ text: '0echo:0ls', binary: true });
    expect(ttyd.seen.protocol).toBe('tty');
    expect(ttyd.seen.headers['x-zti-token']).toBe('zti');
    expect(ttyd.seen.frames).toEqual([
      { text: '{"AuthToken":""}', binary: true },
      { text: '0ls', binary: false },
    ]);
    expect(inputs).toEqual([2]);

    const browserClosed = closed(browser);
    browser.send('bye');
    expect(await browserClosed).toEqual({ code: 4000, reason: 'done' });
  });

  it('drops input frames on a read-only connection but keeps init, resize and flow control', async () => {
    const ttyd = await fakeTtyd('zti');
    const browser = new WebSocket(await front(ttyd.pageUrl, 'zti', { readOnly: true }), ['tty']);
    await new Promise((resolve) => browser.once('open', resolve));
    browser.send('{"AuthToken":""}');
    await nextMessage(browser);
    browser.send('0rm -rf /');
    browser.send('1{"columns":160,"rows":50}');
    await nextMessage(browser);
    browser.send('2');
    await nextMessage(browser);
    expect(ttyd.seen.frames.map(f => f.text)).toEqual(['{"AuthToken":""}', '1{"columns":160,"rows":50}', '2']);
    browser.close();
  });

  it('drops the browser abnormally when the upstream cannot be reached, so ttyd does not loop reconnecting', async () => {
    const ttyd = await fakeTtyd('zti');
    const browser = new WebSocket(await front(ttyd.pageUrl, 'wrong'), ['tty']);
    browser.on('error', () => {});
    expect((await closed(browser)).code).toBe(1006);
  });

  it('closes both ends at once when the grant expires', async () => {
    const ttyd = await fakeTtyd('zti');
    const bridges: Array<ReturnType<typeof bridgeRemoteWebTerminal>> = [];
    const browser = new WebSocket(await front(ttyd.pageUrl, 'zti', {}, bridges), ['tty']);
    await new Promise((resolve) => browser.once('open', resolve));
    browser.send('{"AuthToken":""}');
    await nextMessage(browser);
    const browserClosed = closed(browser);
    bridges[0].close(4003, 'control expired');
    expect(await browserClosed).toEqual({ code: 4003, reason: 'control expired' });
  });

  it('puts its shell script at the top of <head> so it runs before ttyd builds the terminal', () => {
    const html = withRemoteWebTerminalPage('<html><head><title>t</title></head><body><script>ttyd()</script></body></html>', {
      pane: { cols: 160, rows: 50 }, readOnly: false,
    });
    expect(html.indexOf('<script>(function(cfg)')).toBe('<html><head>'.length);
    expect(html.indexOf('<script>(function(cfg)')).toBeLessThan(html.indexOf('ttyd()'));
    // A login URL that could break out of the script is dropped.
    const evil = withRemoteWebTerminalPage('<head></head>', {
      pane: null, readOnly: true, platformReadonly: true, loginUrl: 'https://x/"</script><script>alert(1)//',
    });
    expect(evil).not.toContain('alert(1)');
  });

  describe('page shell script', () => {
    /** Runs the injected script against a fake ttyd page: a cell is 0.6em x 1.2em. */
    function runShell(opts: Parameters<typeof withRemoteWebTerminalPage>[1], viewport = { w: 1000, h: 560 }, search = '?viewToken=v&fontSize=99&enableZmodem=1') {
      const html = withRemoteWebTerminalPage('<head></head>', opts);
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
      const timers: Array<() => void> = [];
      const listeners: Record<string, Array<() => void>> = {};
      const appended: Array<{ textContent: string; href?: string }> = [];
      const replaced: string[] = [];
      const posted: unknown[] = [];
      const container = { clientWidth: viewport.w, clientHeight: viewport.h };
      const resizes: Array<[number, number]> = [];
      const osc: Record<number, (data: string) => boolean> = {};
      const buffer = { active: { viewportY: 10, baseY: 10 } };
      let fontSize = 13;
      const term = {
        cols: 80, rows: 24,
        // xterm 换字号后按像素保留滚动位置：模拟成视图往上漂一行。
        options: {
          get fontSize() { return fontSize; },
          set fontSize(v: number) { fontSize = v; buffer.active.viewportY = Math.max(0, buffer.active.viewportY - 1); },
        },
        buffer,
        parser: { registerOscHandler: (id: number, fn: (data: string) => boolean) => { osc[id] = fn; } },
        scrollToBottom() { this.buffer.active.viewportY = this.buffer.active.baseY; },
        element: null as null | { parentElement: typeof container; querySelector: () => { getBoundingClientRect: () => { width: number; height: number } } },
        resize(cols: number, rows: number) { resizes.push([cols, rows]); this.cols = cols; this.rows = rows; },
      };
      const window: Record<string, unknown> = {
        addEventListener: (type: string, fn: () => void) => { (listeners[type] ??= []).push(fn); },
        parent: { postMessage: (msg: unknown, origin: string) => posted.push({ msg, origin }) },
      };
      runInNewContext(script, {
        window,
        location: { search, pathname: '/s/x', hash: '', ancestorOrigins: ['https://workbench.example'] },
        history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
        document: {
          body: { appendChild: (el: { textContent: string }) => appended.push(el) },
          createElement: () => ({ style: {}, textContent: '', addEventListener() {}, remove() {} }),
        },
        URLSearchParams,
        setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
        clearTimeout() {},
        Object, Math, JSON,
      });
      // ttyd assigns window.term, opens it, then fits to the window.
      (window as { term?: unknown }).term = term;
      term.element = {
        parentElement: container,
        querySelector: () => ({ getBoundingClientRect: () => ({ width: term.cols * 0.6 * term.options.fontSize, height: term.rows * 1.2 * term.options.fontSize }) }),
      };
      term.resize(200, 60); // ttyd's own fit() to the window size
      const flush = () => { for (let i = 0; i < 200 && timers.length; i++) timers.shift()!(); };
      flush();
      for (const fn of listeners.load ?? []) fn();
      return { term, resizes, replaced, appended, posted, listeners, flush, container, osc };
    }

    it('locks the grid to the pane and picks the largest font that holds it', () => {
      const { term, resizes } = runShell({ pane: { cols: 160, rows: 50 }, readOnly: false });
      expect(term.cols).toBe(160);
      expect(term.rows).toBe(50);
      expect(resizes.every(([c, r]) => c === 160 && r === 50)).toBe(true);
      // width: (1000-26)/(160*0.6)=10.1 → 10; height: (560-10)/(50*1.2)=9.16 → 9
      expect(term.options.fontSize).toBe(9);
    });

    it('only changes the font when the window resizes, never the grid', () => {
      const run = runShell({ pane: { cols: 160, rows: 50 }, readOnly: false });
      const before = run.resizes.length;
      run.term.buffer.active.viewportY = 30;
      run.term.buffer.active.baseY = 30;
      run.container.clientWidth = 2000;
      run.container.clientHeight = 1300;
      for (const fn of run.listeners.resize ?? []) fn();
      for (const fn of run.listeners.resize ?? []) fn();
      run.flush();
      expect(run.term.options.fontSize).toBe(20);
      // 原本停在底部，换完字号还在底部。
      expect(run.term.buffer.active.viewportY).toBe(30);
      expect(run.resizes.slice(before).every(([c, r]) => c === 160 && r === 50)).toBe(true);
    });

    it('leaves the grid to ttyd when the pane size is unknown', () => {
      const { term } = runShell({ pane: null, readOnly: false });
      expect([term.cols, term.rows]).toEqual([200, 60]);
      expect(term.options.fontSize).toBe(13);
    });

    it('locks to the tmux window size the attach script reports', () => {
      // Host 重启后还没收到快照时不知道 pane 尺寸；沙箱里的 attach 脚本会报出来。
      const run = runShell({ pane: null, readOnly: false });
      expect(run.osc[5379]('botmux-pane=160x50')).toBe(true);
      run.flush();
      expect([run.term.cols, run.term.rows]).toEqual([160, 50]);
      expect(run.term.options.fontSize).toBe(9);
      // Runner 改了尺寸后，下一次接入报的新尺寸覆盖 Host 给的初值。
      const resized = runShell({ pane: { cols: 160, rows: 50 }, readOnly: false });
      resized.osc[5379]('botmux-pane=120x40');
      resized.flush();
      expect([resized.term.cols, resized.term.rows]).toEqual([120, 40]);
    });

    it('ignores a malformed or absurd size report', () => {
      const run = runShell({ pane: { cols: 160, rows: 50 }, readOnly: false });
      for (const bad of ['botmux-pane=5x2', 'botmux-pane=99999x50', 'botmux-pane=160x50;rm', 'other=160x50']) {
        expect(run.osc[5379](bad)).toBe(true);
      }
      run.flush();
      expect([run.term.cols, run.term.rows]).toEqual([160, 50]);
    });

    it('keeps only the auth parameters in the URL ttyd reads its options from', () => {
      const { replaced } = runShell({ pane: null, readOnly: true });
      expect(replaced).toEqual(['/s/x?viewToken=v']);
      // 写链接的签名领取人要跟着 ttyd 的 /ws 连接带回 worker，输入审计才记得到人。
      const write = runShell(
        { pane: null, readOnly: false },
        undefined,
        '?token=w&issuedTo=ou_abc.1.sig&enableZmodem=1',
      );
      expect(write.replaced).toEqual(['/s/x?token=w&issuedTo=ou_abc.1.sig']);
    });

    it('shows the read-only banner and reports the write state to the workbench', () => {
      const ro = runShell({ pane: null, readOnly: true });
      expect(ro.appended.map(b => b.textContent)).toEqual(['只读模式 · 无写入权限']);
      expect(ro.posted).toEqual([{ msg: { type: 'botmux:wb-terminal-write', write: false }, origin: 'https://workbench.example' }]);
      const login = runShell({ pane: null, readOnly: true, platformReadonly: true, loginUrl: 'https://host/open/m?next=/s/x' });
      expect(login.appended.map(b => [b.textContent, b.href])).toEqual([['owner 登录后可操作 →', 'https://host/open/m?next=/s/x']]);
      const rw = runShell({ pane: null, readOnly: false });
      expect(rw.appended).toEqual([]);
      expect(rw.posted).toEqual([{ msg: { type: 'botmux:wb-terminal-write', write: true }, origin: 'https://workbench.example' }]);
    });
  });
});
