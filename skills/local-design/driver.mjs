#!/usr/bin/env node
// driver.mjs - look at, check, export and open a seeded local-design canvas.
//
// Zero npm dependencies (Node >= 22: global WebSocket). Renders through a headless
// Chromium-family browser over the DevTools protocol - ego lite first, then Google Chrome /
// Chromium - with a throwaway profile, so the user's own browser session is never touched.
// Each artboard is resolved by the canvas page itself (window.__ld.resolve), exactly as the
// canvas renders it, then loaded in an opaque-origin iframe at its frame size.
// PDF uses an equivalent CSP sandbox on a temporary loopback document for native
// pagination. The driver uploads nothing; artboards may load linked resources.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { check as seedCheck, SeedError, readCanvasFile, renderCanvas, fileInDirectory } from './seed-canvas.mjs';

class UserError extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rel = (p) => (path.relative(process.cwd(), p).startsWith('..') ? p : path.relative(process.cwd(), p) || '.');

const USAGE = `usage: node driver.mjs <command> <canvas.html> [options]

  check  <canvas.html>  render every artboard headless at its frame size, report what a
                        screenshot cannot show (clipping, blocked/missing files, script
                        errors, font fallbacks), write PNGs to look at + the canvas overview
                        [--board F]... [--theme light|dark] [--tweak KEY=VALUE]... [--scale N] [--shots DIR]
  shot   <canvas.html> --board F [--click CSS | --fill CSS=TEXT | --press KEY]...
                        screenshot one artboard, then once after each step (prototype flows)
                        [--tweak KEY=VALUE]... [--theme light|dark] [--width W] [--height H]
                        [--scale N] [--shots DIR]
  shot   <canvas.html> --canvas [--view '#focus=F' | '#page=ID'] [--width 1600] [--height 1000]
                        screenshot the canvas page itself
  export <canvas.html>  PNG per artboard + ONE PDF of every artboard (fixed = one page at its
                        size, flow = paginated) [--to DIR] [--scale 2] [--board F]... [--no-png] [--no-pdf]
  open   <canvas.html>  open the canvas in ego lite (else the default browser) [--view '#focus=F']
  fonts  [filter]       list font families installed on this machine

env: LOCAL_DESIGN_BROWSER=<binary>  rendering browser (default: ego lite, then Chrome, Chromium)
     LOCAL_DESIGN_APP=<app name>    app used by 'open' (default: ego lite)`;

// ------------------------------------------------------------------ args

function splitAssign(val, flag) {
  let depth = 0;
  for (let i = 0; i < val.length; i++) {
    const c = val[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '=' && depth === 0 && i > 0) return [val.slice(0, i), val.slice(i + 1)];
  }
  throw new UserError(`${flag} wants LEFT=RIGHT, got "${val}"`);
}

function parseValue(v) {
  if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(v)) return JSON.parse(v);
  return v;
}

function parseArgs(argv) {
  const o = { _: [], steps: [], board: [], tweaks: {} };
  const flags = new Set(['no-png', 'no-pdf', 'canvas']);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    a = a.slice(2);
    let val;
    const eq = a.indexOf('=');
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (flags.has(a)) { o[a] = true; continue; }
    if (val === undefined) {
      val = argv[++i];
      if (val === undefined) throw new UserError(`--${a} needs a value`);
    }
    switch (a) {
      case 'board': o.board.push(val); break;
      case 'click': o.steps.push({ type: 'click', sel: val }); break;
      case 'fill': { const [sel, text] = splitAssign(val, '--fill'); o.steps.push({ type: 'fill', sel, text }); break; }
      case 'press': o.steps.push({ type: 'press', key: val }); break;
      case 'tweak': { const [k, v] = splitAssign(val, '--tweak'); o.tweaks[k] = parseValue(v); break; }
      case 'theme':
        if (!['light', 'dark'].includes(val)) throw new UserError('--theme is light or dark');
        o.theme = val; break;
      case 'scale': case 'width': case 'height': {
        const n = Number(val);
        if (!(n > 0)) throw new UserError(`--${a} wants a positive number`);
        o[a] = n; break;
      }
      case 'view': o.view = val.startsWith('#') ? val : `#${val}`; break;
      case 'to': case 'shots': o[a] = path.resolve(val); break;
      default: throw new UserError(`unknown option --${a}\n\n${USAGE}`);
    }
  }
  return o;
}

function canvasArg(o) {
  const f = o._[0];
  if (!f) throw new UserError(`missing <canvas.html>\n\n${USAGE}`);
  const p = path.resolve(f);
  if (!fs.existsSync(p)) throw new UserError(`no such file: ${f}`);
  return p;
}

const stemOf = (file) => file.replace(/\.dc\.html$/i, '');
const slug = (canvasPath) => path.basename(canvasPath).replace(/\.html$/i, '');

function defaultPageHeight(w) {
  const near = (v) => Math.abs(w - v) <= 2;
  if (near(794)) return 1123; // A4
  if (near(816)) return 1056; // Letter
  if (near(559)) return 794; // A5
  if (near(1056)) return 1632; // Tabloid
  return Math.round(w * Math.SQRT2);
}

// ------------------------------------------------------------------ browser (CDP)

function findBrowser() {
  const home = os.homedir();
  const candidates = [
    process.env.LOCAL_DESIGN_BROWSER,
    '/Applications/ego lite.app/Contents/MacOS/ego lite',
    path.join(home, 'Applications/ego lite.app/Contents/MacOS/ego lite'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new UserError('no Chromium-family browser found - install ego lite or Chrome, or set LOCAL_DESIGN_BROWSER to its binary');
}

class CDP {
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new CDP(ws));
      ws.onerror = () => reject(new UserError(`cannot connect to the browser at ${url}`));
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Set();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else {
        for (const h of this.handlers) h(msg);
      }
    };
    ws.onclose = () => {
      for (const p of this.pending.values()) p.reject(new Error('browser connection closed'));
      this.pending.clear();
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }
}

async function launchBrowser() {
  const bin = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'local-design-profile-'));
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb',
    '--disable-extensions', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-default-apps', '--no-pings', '--mute-audio', 'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  let cdp;
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new UserError(`browser did not start within 20s: ${bin}\n${log.slice(-600)}`)), 20000);
      proc.stderr.on('data', (d) => {
        log += d;
        const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(timer); resolve(m[1]); }
      });
      proc.on('exit', (code) => { clearTimeout(timer); reject(new UserError(`browser exited (${code}) before it was ready: ${bin}\n${log.slice(-600)}`)); });
      proc.on('error', (e) => { clearTimeout(timer); reject(new UserError(`cannot start ${bin}: ${e.message}`)); });
    });
    cdp = await CDP.connect(wsUrl);
  } catch (e) {
    if (proc.exitCode === null) proc.kill('SIGKILL');
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    throw e;
  }
  return {
    cdp,
    bin,
    async close() {
      try { await Promise.race([cdp.send('Browser.close'), sleep(3000)]); } catch { /* already gone */ }
      if (proc.exitCode === null) proc.kill('SIGKILL');
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};

// recorded before any page script runs
const PRELUDE = `if (!window.__ldViolations) {
  window.__ldViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => { window.__ldViolations.push({ uri: e.blockedURI, directive: e.effectiveDirective }); });
}`;

const SETTLE_JS = `(async () => {
  const t0 = Date.now();
  while (!window.__dcReady && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 30));
  await document.fonts.ready;
  await Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.addEventListener('load', r); i.addEventListener('error', r); })));
  const finite = document.getAnimations().filter((a) => {
    const t = a.effect && a.effect.getComputedTiming();
    return t && Number.isFinite(t.endTime) && a.playState === 'running';
  });
  await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => 0))), new Promise((r) => setTimeout(r, 4000))]);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return !!window.__dcReady;
})()`;

const DIAG_JS = `(() => {
  const de = document.documentElement, b = document.body;
  const generic = new Set(['serif','sans-serif','monospace','cursive','fantasy','system-ui','ui-serif','ui-sans-serif','ui-monospace','ui-rounded','emoji','math','fangsong','-apple-system','blinkmacsystemfont','inherit','initial']);
  const families = [];
  const walker = document.createTreeWalker(b || de, NodeFilter.SHOW_TEXT);
  let n = 0;
  while (walker.nextNode() && n < 5000) {
    const t = walker.currentNode;
    if (!t.nodeValue.trim()) continue;
    const el = t.parentElement;
    if (!el || el.closest('script,style,noscript,template,title')) continue;
    n++;
    const first = (getComputedStyle(el).fontFamily.split(',')[0] || '').trim().replace(/^["']|["']$/g, '');
    if (!first || generic.has(first.toLowerCase()) || families.includes(first)) continue;
    families.push(first);
    el.setAttribute('data-ld-font', first);
  }
  const clear = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
  const raw = [...document.querySelectorAll('body *')].filter((el) => !el.closest('script,style,template')).flatMap((el) => [...el.childNodes])
    .filter((t) => t.nodeType === 3 && /\\{\\{[^}]*\\}\\}/.test(t.nodeValue)).map((t) => t.nodeValue.trim().slice(0, 60));
  return {
    W: innerWidth, H: innerHeight,
    sw: Math.max(de.scrollWidth, b ? b.scrollWidth : 0),
    sh: Math.max(de.scrollHeight, b ? b.scrollHeight : 0),
    noBackground: clear(getComputedStyle(de).backgroundColor) && (!b || clear(getComputedStyle(b).backgroundColor)),
    brokenImages: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => (i.getAttribute('src') || '').slice(0, 80)),
    faces: [...document.fonts].map((f) => ({ family: f.family.replace(/^["']|["']$/g, ''), status: f.status })),
    violations: window.__ldViolations || [],
    rawHoles: raw.slice(0, 5),
    families,
  };
})()`;

export class Tab {
  static async open(browser, { width, height, scale = 1, theme = 'light' }) {
    const t = new Tab();
    t.cdp = browser.cdp;
    t.width = width;
    t.height = height;
    t.errors = [];
    t.network = new Map(); // requestId -> { url, failed }
    t.contexts = new Map();
    t.childSessions = new Set();
    t.theme = theme;
    const { targetId } = await t.cdp.send('Target.createTarget', { url: 'about:blank' });
    t.targetId = targetId;
    const { sessionId } = await t.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    t.sessionId = sessionId;
    t.off = t.cdp.on((msg) => t.onEvent(msg));
    await t.s('Page.enable');
    await t.s('Runtime.enable');
    await t.s('DOM.enable');
    await t.s('CSS.enable');
    await t.s('Network.enable');
    await t.s('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE });
    await t.s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    await t.s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await t.s('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: theme }] });
    return t;
  }

  s(method, params = {}, sessionId = this.sessionId) {
    return this.cdp.send(method, params, sessionId);
  }

  onEvent(msg) {
    if (msg.sessionId !== this.sessionId && !this.childSessions.has(msg.sessionId)) return;
    const p = msg.params;
    if (msg.method === 'Target.attachedToTarget') {
      this.childSessions.add(p.sessionId);
      this.prepareFrame(p.sessionId).catch((e) => this.errors.push(`frame setup failed: ${e.message}`));
    } else if (msg.method === 'Runtime.executionContextCreated') {
      this.contexts.set(`${msg.sessionId}:${p.context.id}`, { ...p.context, sessionId: msg.sessionId });
    } else if (msg.method === 'Runtime.executionContextDestroyed') {
      this.contexts.delete(`${msg.sessionId}:${p.executionContextId}`);
    } else if (msg.method === 'Runtime.executionContextsCleared') {
      for (const [key, ctx] of this.contexts) if (ctx.sessionId === msg.sessionId) this.contexts.delete(key);
    } else if (msg.method === 'Fetch.requestPaused') {
      const allowed = p.frameId !== this.printFrameId || (p.request.url === this.printUrl && !this.printNavigated);
      if (p.frameId === this.printFrameId && allowed) this.printNavigated = true;
      this.s(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
        requestId: p.requestId, ...(!allowed ? { errorReason: 'Aborted' } : {}),
      }, msg.sessionId).catch((e) => this.errors.push(e.message));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails;
      this.errors.push(`script error: ${d.exception?.description?.split('\n')[0] ?? d.text}${d.lineNumber != null ? ` (line ${d.lineNumber + 1})` : ''}`);
    } else if (msg.method === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'assert')) {
      this.errors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ').replace(/^\[design\] /, '').slice(0, 300));
    } else if (msg.method === 'Network.requestWillBeSent' && /^(https?|wss?):/i.test(p.request.url)) {
      this.network.set(p.requestId, { url: p.request.url, failed: null });
    } else if (msg.method === 'Network.loadingFailed' && this.network.has(p.requestId)) {
      this.network.get(p.requestId).failed = p.blockedReason || p.errorText || 'failed';
    } else if (msg.method === 'Network.responseReceived' && this.network.has(p.requestId) && p.response.status >= 400) {
      this.network.get(p.requestId).failed = `HTTP ${p.response.status}`;
    } else if (msg.method === 'Page.loadEventFired' && msg.sessionId === this.sessionId && this.onLoad) {
      this.onLoad();
    } else if (msg.method === 'Page.javascriptDialogOpening') {
      this.s('Page.handleJavaScriptDialog', { accept: false }, msg.sessionId).catch(() => {});
    }
  }

  async prepareFrame(sessionId) {
    try {
      for (const domain of ['Page', 'Runtime', 'DOM', 'CSS', 'Network']) await this.s(`${domain}.enable`, {}, sessionId);
      await this.s('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE, runImmediately: true }, sessionId);
      await this.s('Emulation.setEmulatedMedia', { media: 'screen', features: [{ name: 'prefers-color-scheme', value: this.theme }] }, sessionId);
      await this.s('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    } finally {
      await this.s('Runtime.runIfWaitingForDebugger', {}, sessionId);
    }
  }

  async goto(url, { settle = true, printDocument = false } = {}) {
    this.artboardContext = null;
    if (printDocument) {
      const { frameTree } = await this.s('Page.getFrameTree');
      this.printFrameId = frameTree.frame.id;
      this.printUrl = url; this.printNavigated = false;
      await this.s('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] });
    }
    let timer;
    const loaded = new Promise((resolve, reject) => {
      this.onLoad = resolve;
      timer = setTimeout(() => reject(new UserError(`timed out loading ${url}`)), 30000);
    });
    const r = await this.s('Page.navigate', { url });
    if (r.errorText) { clearTimeout(timer); throw new UserError(`cannot open ${url}: ${r.errorText}`); }
    try { await loaded; } finally { clearTimeout(timer); this.onLoad = null; }
    if (printDocument) this.ready = await this.eval(SETTLE_JS);
    else if (settle) {
      const { root } = await this.s('DOM.getDocument');
      const { nodeId } = await this.s('DOM.querySelector', { nodeId: root.nodeId, selector: '#ld-render' });
      if (!nodeId) throw new UserError('render wrapper has no sandboxed artboard');
      const { node } = await this.s('DOM.describeNode', { nodeId });
      const deadline = Date.now() + 10000;
      while (!this.artboardContext && Date.now() < deadline) {
        this.artboardContext = [...this.contexts.values()].find((c) => c.auxData?.frameId === node.frameId && c.auxData?.isDefault);
        if (!this.artboardContext) await sleep(30);
      }
      if (!this.artboardContext) throw new UserError('could not attach to the sandboxed artboard');
      this.ready = await this.eval(SETTLE_JS);
    }
  }

  async eval(expression, outer = false) {
    const context = !outer && this.artboardContext;
    const r = await this.s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true,
      ...(context ? { contextId: context.id } : {}), timeout: 15000 }, context ? context.sessionId : this.sessionId);
    if (r.exceptionDetails) throw new Error(`in-page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  async waitFor(expr, timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await this.eval(`!!(${expr})`)) return;
      await sleep(100);
    }
    throw new UserError(`timed out waiting for ${expr}`);
  }

  async contentHeight() {
    return this.eval('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)');
  }

  async screenshot(file, height = this.height) {
    await this.eval('window.scrollTo(0, 0)');
    if (this.artboardContext) await this.eval(`document.getElementById('ld-render').style.height = ${JSON.stringify(`${height}px`)}`, true);
    const { data } = await this.s('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: height > this.height,
      clip: { x: 0, y: 0, width: this.width, height, scale: 1 },
    });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  async pdf({ paperWidth, paperHeight, firstPageOnly, preferCSSPageSize }) {
    if (this.artboardContext || !this.printUrl) throw new UserError('PDF needs a sandboxed print document');
    const { data } = await this.s('Page.printToPDF', {
      printBackground: true, paperWidth, paperHeight,
      marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
      preferCSSPageSize, pageRanges: firstPageOnly ? '1' : '',
    });
    return Buffer.from(data, 'base64');
  }

  async settle() {
    await this.eval(SETTLE_JS);
  }

  async point(sel, flag) {
    const r = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`);
    if (!r) throw new UserError(`${flag}: no element matches ${sel}`);
    return r;
  }

  async click(sel) {
    const { x, y } = await this.point(sel, '--click');
    await this.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await this.settle();
  }

  async fill(sel, text) {
    await this.click(sel);
    await this.eval(`(() => { const el = document.activeElement; if (el && typeof el.select === 'function') el.select(); })()`);
    await this.s('Input.insertText', { text });
    await this.settle();
  }

  async press(name) {
    const single = name.length === 1;
    const k = KEYS[name] || { key: name, code: single ? `Key${name.toUpperCase()}` : name, keyCode: single ? name.toUpperCase().charCodeAt(0) : 0, text: single ? name : undefined };
    await this.s('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, text: k.text });
    await this.s('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode });
    await this.settle();
  }

  // What a screenshot cannot show: clipping, blocked or missing files, script and template
  // errors, fonts that silently fell back.
  async diagnose(board, unresolved = []) {
    const d = await this.eval(DIAG_JS);
    const errors = [];
    const warnings = [];
    const info = [];
    if (!this.ready) warnings.push('the artboard never signalled ready (runtime missing or crashed?) - check its support.js line');
    if (d.sw > d.W + 1) warnings.push(`content is ${d.sw - d.W}px wider than the ${d.W}px frame - it is clipped on the canvas`);
    if (board.print === 'flow') {
      const ph = defaultPageHeight(board.w);
      info.push(`flow: ${d.sh}px of content -> at least ${Math.ceil(d.sh / ph)} PDF page(s) of ${board.w}x${ph} (@page margins add more)`);
    } else if (d.sh > d.H + 1) {
      warnings.push(`content is ${d.sh - d.H}px taller than the ${d.H}px frame - the bottom is clipped; grow "h" or tighten the layout`);
    }
    if (d.noBackground) warnings.push('neither html nor body paints a background - set one (surplus frame paints it)');
    const missing = new Set(unresolved);
    for (const src of d.brokenImages) if (src && !src.startsWith('data:') && !/^https?:/i.test(src)) missing.add(src.replace(/^\.\//, ''));
    for (const v of d.violations) {
      const uri = v.uri || '';
      if (uri === 'file' || uri.startsWith('file:')) { if (!missing.size) missing.add('(an unseeded local file)'); }
      else if (/^(https?|wss?):/i.test(uri) || /^[a-z0-9.-]+\.[a-z]{2,}/i.test(uri)) errors.push(`blocked by the canvas CSP (${v.directive}): ${uri}`);
      else if (uri === 'inline' || uri === 'eval') errors.push(`blocked ${uri} code (${v.directive})`);
      else errors.push(`blocked by the canvas CSP (${v.directive}): ${uri || '(no uri)'}`);
    }
    const seen = new Set();
    for (const { url, failed } of this.network.values()) {
      const key = `${url} ${failed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (failed) warnings.push(`network request failed (${failed}): ${url.slice(0, 160)} - unreachable or offline; it falls back silently on the canvas`);
      else info.push(`network: ${url.slice(0, 160)}`);
    }
    for (const f of missing) errors.push(`missing file: ${f} - not seeded (--image/--font) or not referenced by its exact basename in a double-quoted src / url()`);
    for (const h of d.rawHoles) warnings.push(`unrendered hole in the page text: "${h}"`);
    for (const e of new Set(this.errors)) errors.push(e);

    const sessionId = this.artboardContext?.sessionId || this.sessionId;
    await this.s('DOM.getDocument', { depth: -1, pierce: true }, sessionId);
    const { result } = await this.s('Runtime.evaluate', { expression: 'document.documentElement', contextId: this.artboardContext?.id }, sessionId);
    const { nodeId } = await this.s('DOM.requestNode', { objectId: result.objectId }, sessionId);
    const { nodeIds } = await this.s('DOM.querySelectorAll', { nodeId, selector: '[data-ld-font]' }, sessionId);
    await this.s('Runtime.releaseObject', { objectId: result.objectId }, sessionId);
    const norm = (s) => s.toLowerCase().replace(/[\s_-]+/g, '');
    for (const nodeId of nodeIds) {
      const { attributes } = await this.s('DOM.getAttributes', { nodeId }, sessionId);
      const fam = attributes[attributes.indexOf('data-ld-font') + 1];
      const { fonts } = await this.s('CSS.getPlatformFontsForNode', { nodeId }, sessionId);
      const used = fonts.map((f) => f.familyName);
      const faces = d.faces.filter((f) => norm(f.family) === norm(fam));
      if (faces.length) {
        if (faces.some((f) => f.status === 'loaded') && fonts.some((f) => f.isCustomFont)) continue;
        if (faces.some((f) => f.status === 'error')) { errors.push(`@font-face "${fam}" failed to load - seed the file with --font and reference it by basename`); continue; }
        warnings.push(`@font-face "${fam}" did not paint - text rendered in ${used.join(', ') || 'a fallback'}`);
        continue;
      }
      if (fonts.some((f) => norm(f.familyName) === norm(fam) || norm(f.postScriptName || '').startsWith(norm(fam)))) continue;
      warnings.push(`font "${fam}" is not installed here - text rendered in ${used.join(', ') || 'a fallback'} (embed it with --font, or pick one from "fonts")`);
    }
    return { errors, warnings, info, contentHeight: d.sh };
  }

  async close() {
    this.off();
    try { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* gone */ }
  }
}

// ------------------------------------------------------------------ canvas access

export async function withCanvas(canvasPath, fn) {
  const { state, title } = readCanvasFile(canvasPath);
  seedCheck(canvasPath);
  const browser = await launchBrowser();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'local-design-boards-'));
  let printServer;
  const printDocuments = new Map();
  try {
    const trustedCanvas = fileInDirectory(work, 'viewer.html');
    fs.writeFileSync(trustedCanvas, renderCanvas(state, title));
    const viewer = await Tab.open(browser, { width: 1600, height: 1000 });
    await viewer.goto(pathToFileURL(trustedCanvas).href, { settle: false });
    await viewer.waitFor('window.__ld');
    const info = await viewer.eval('({ title: __ld.title, entry: __ld.entry, pages: __ld.pages, boards: __ld.boards })');
    const pageIndex = new Map(info.pages.map((p, i) => [p.id, i]));
    const policy = await viewer.eval('document.querySelector(\'meta[http-equiv="Content-Security-Policy"]\').content');
    let lastUnresolved = [];
    info.ordered = [...info.boards].sort((a, b) => (pageIndex.get(a.page) ?? 0) - (pageIndex.get(b.page) ?? 0));
    const ctx = {
      browser,
      info,
      canvasPath: trustedCanvas,
      pick(names) {
        if (!names.length) return info.ordered;
        return names.map((n) => {
          const want = n.replace(/\.dc\.html$/i, '').toLowerCase();
          const b = info.boards.find((q) => stemOf(q.file).toLowerCase() === want);
          if (!b) throw new UserError(`no artboard "${n}" (have: ${info.boards.map((q) => q.file).join(', ')})`);
          return b;
        });
      },
      async boardFile(b, tweaks = {}) {
        const { html, source } = await viewer.eval(`({html: __ld.resolve(${JSON.stringify(b.file)}, { standalone: true, tweaks: ${JSON.stringify(tweaks)} }), source: __ld.resolve(${JSON.stringify(b.file)}, { tweaks: ${JSON.stringify(tweaks)} })})`);
        const f = fileInDirectory(work, b.file);
        fs.writeFileSync(f, html);
        // asset references that did not become data: URIs = files that were never seeded
        const refs = [...source.matchAll(/\s(?:src|href|poster)="(?:\.\/)?([^"{}:]+?\.(?:png|jpe?g|gif|webp|avif|bmp|svg|woff2?|ttf|otf))"/gi),
          ...source.matchAll(/url\(\s*["']?(?:\.\/)?([^"'(){}:]+?\.(?:png|jpe?g|gif|webp|avif|bmp|svg|woff2?|ttf|otf))["']?\s*\)/gi)];
        lastUnresolved = [...new Set(refs.map((m) => m[1]))];
        return pathToFileURL(f).href;
      },
      async printFile(b, tweaks = {}) {
        if (!printServer) {
          // Native print fragmentation is lost inside an iframe. The HTTP header
          // applies the same sandbox flags to the print document itself.
          printServer = createServer((req, res) => {
            const source = printDocuments.get(req.url);
            res.writeHead(source ? 200 : 404, {
              'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
              'Content-Security-Policy': `${policy}; sandbox allow-scripts allow-forms`,
            });
            res.end(source || 'Not found');
          });
          await new Promise((resolve, reject) => { printServer.once('error', reject); printServer.listen(0, '127.0.0.1', resolve); });
        }
        const route = `/${randomUUID()}`;
        printDocuments.set(route, await viewer.eval(`__ld.resolve(${JSON.stringify(b.file)}, { tweaks: ${JSON.stringify(tweaks)} })`));
        return `http://127.0.0.1:${printServer.address().port}${route}`;
      },
      async pdf(b, tweaks, options) {
        const tab = await Tab.open(browser, { width: b.w, height: b.h });
        try {
          await tab.goto(await ctx.printFile(b, tweaks), { printDocument: true });
          if (!tab.ready || tab.errors.length) throw new UserError(`${b.file}: print rendering failed: ${tab.errors.join('; ') || 'runtime not ready'}`);
          return await tab.pdf(options);
        } finally { await tab.close(); }
      },
      unresolved: () => lastUnresolved,
    };
    try { return await fn(ctx); } finally { await viewer.close(); }
  } finally {
    await browser.close();
    if (printServer) { printServer.closeAllConnections(); await new Promise((resolve) => printServer.close(resolve)); }
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function shootCanvas(ctx, canvasPath, file, { view = '#fit', width = 1600, height = 1000, scale = 1 } = {}) {
  const tab = await Tab.open(ctx.browser, { width, height, scale });
  try {
    await tab.goto(pathToFileURL(ctx.canvasPath).href + view, { settle: false });
    await tab.waitFor('window.__ldReady === true', 30000);
    await sleep(300);
    return await tab.screenshot(file);
  } finally {
    await tab.close();
  }
}

function lintFirst(canvasPath) {
  try {
    const r = seedCheck(canvasPath);
    const { html, state, title } = readCanvasFile(canvasPath);
    if (html !== renderCanvas(state, title)) r.warnings.push('using the current trusted viewer for this check/export; re-seed this canvas before opening or handing it over');
    for (const w of r.warnings) console.log(`warn  ${w}`);
    return r;
  } catch (e) {
    if (e instanceof SeedError) throw new UserError(e.message);
    throw e;
  }
}

// ------------------------------------------------------------------ commands

async function cmdCheck(o) {
  const canvasPath = canvasArg(o);
  const lint = lintFirst(canvasPath);
  const shotsBase = o.shots || path.join(os.tmpdir(), 'local-design-shots', slug(canvasPath));
  fs.mkdirSync(shotsBase, { recursive: true });
  const shots = fs.mkdtempSync(path.join(shotsBase, 'check-'));
  const suffix = o.theme === 'dark' ? '-dark' : '';
  let errors = 0;
  let warnings = lint.warnings.length;
  const written = [];
  await withCanvas(canvasPath, async (ctx) => {
    const boards = ctx.pick(o.board);
    console.log(`"${ctx.info.title}" - ${ctx.info.boards.length} artboard(s), rendering with ${path.basename(ctx.browser.bin)}`);
    for (const b of boards) {
      const tab = await Tab.open(ctx.browser, { width: b.w, height: b.h, scale: o.scale || 1, theme: o.theme || 'light' });
      try {
        await tab.goto(await ctx.boardFile(b, o.tweaks));
        const r = await tab.diagnose(b, ctx.unresolved());
        const h = b.print === 'flow' ? Math.max(b.h, r.contentHeight) : b.h;
        written.push(await tab.screenshot(path.join(shots, `${stemOf(b.file)}${suffix}.png`), h));
        const status = r.errors.length ? 'FAIL' : r.warnings.length ? 'warn' : 'ok';
        console.log(`${status.padEnd(4)}  ${b.file}  ${b.w}x${b.h} ${b.print}`);
        for (const e of r.errors) console.log(`        error ${e}`);
        for (const w of r.warnings) console.log(`        warn  ${w}`);
        for (const i of r.info) console.log(`        info  ${i}`);
        errors += r.errors.length;
        warnings += r.warnings.length;
      } finally {
        await tab.close();
      }
    }
    if (!o.board.length) {
      const pageIds = ctx.info.pages.length > 1 ? ctx.info.pages.map((p) => p.id) : [null];
      for (const id of pageIds) {
        const name = id ? `_canvas-${id}.png` : '_canvas.png';
        const view = id ? `#page=${encodeURIComponent(id)}&fit` : '#fit';
        written.push(await shootCanvas(ctx, canvasPath, path.join(shots, name), { view }));
      }
    }
  });
  console.log(`shots: ${written.map(rel).join('  ')}`);
  console.log(`result: ${errors} error(s), ${warnings} warning(s)`);
  if (errors) process.exitCode = 1;
}

async function cmdShot(o) {
  const canvasPath = canvasArg(o);
  const shots = o.shots || path.join(os.tmpdir(), 'local-design-shots', slug(canvasPath));
  await withCanvas(canvasPath, async (ctx) => {
    if (o.canvas) {
      const tag = (o.view || '#fit').slice(1).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-|-$/g, '') || 'fit';
      const file = await shootCanvas(ctx, canvasPath, path.join(shots, `_canvas-${tag}.png`), {
        view: o.view || '#fit', width: o.width || 1600, height: o.height || 1000, scale: o.scale || 1,
      });
      console.log(`shot ${rel(file)}`);
      return;
    }
    if (o.board.length !== 1) throw new UserError('shot needs exactly one --board (or --canvas)');
    const [picked] = ctx.pick(o.board);
    // --width/--height re-frame the artboard (e.g. a landing page at phone width)
    const b = { ...picked, w: o.width || picked.w, h: o.height || picked.h };
    const tab = await Tab.open(ctx.browser, { width: b.w, height: b.h, scale: o.scale || 1, theme: o.theme || 'light' });
    try {
      await tab.goto(await ctx.boardFile(b, o.tweaks));
      const sized = b.w !== picked.w || b.h !== picked.h ? `-${b.w}x${b.h}` : '';
      const base = path.join(shots, `${stemOf(b.file)}${sized}${o.theme === 'dark' ? '-dark' : ''}${Object.keys(o.tweaks).length ? '-tweaked' : ''}`);
      const h = async () => (b.print === 'flow' ? Math.max(b.h, await tab.contentHeight()) : b.h);
      console.log(`shot ${rel(await tab.screenshot(`${base}${o.steps.length ? '-step0' : ''}.png`, await h()))}`);
      let n = 0;
      for (const st of o.steps) {
        n++;
        if (st.type === 'click') await tab.click(st.sel);
        else if (st.type === 'fill') await tab.fill(st.sel, st.text);
        else await tab.press(st.key);
        const label = st.type === 'press' ? `press ${st.key}` : `${st.type} ${st.sel}`;
        console.log(`shot ${rel(await tab.screenshot(`${base}-step${n}.png`, await h()))}  (after ${label})`);
      }
      for (const e of new Set(tab.errors)) console.log(`error ${e}`);
      if (tab.errors.length) process.exitCode = 1;
    } finally {
      await tab.close();
    }
  });
}

function mergePdfs(parts, out) {
  if (parts.length === 1) { fs.copyFileSync(parts[0], out); return 'a single page set'; }
  if (process.platform === 'darwin') {
    const js = `ObjC.import('Quartz');
function run(argv) {
  const out = argv[0];
  const doc = $.PDFDocument.alloc.init;
  let n = 0;
  for (const p of argv.slice(1)) {
    const src = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(p));
    if (!src || src.isNil()) throw new Error('cannot read ' + p);
    for (let i = 0; i < src.pageCount; i++) doc.insertPageAtIndex(src.pageAtIndex(i), n++);
  }
  if (!doc.writeToFile(out)) throw new Error('cannot write ' + out);
  return String(n);
}`;
    const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', js, out, ...parts], { encoding: 'utf8' });
    if (r.status === 0) return 'PDFKit';
  }
  for (const [bin, args] of [['qpdf', ['--empty', '--pages', ...parts, '--', out]], ['pdfunite', [...parts, out]]]) {
    if (spawnSync(bin, args).status === 0) return bin;
  }
  return null;
}

async function cmdExport(o) {
  const canvasPath = canvasArg(o);
  lintFirst(canvasPath);
  const outDir = o.to || path.join(path.dirname(canvasPath), `${slug(canvasPath)}-export`);
  fs.mkdirSync(outDir, { recursive: true });
  const scale = o.scale || 2;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-design-pdf-'));
  const parts = [];
  let problems = 0;
  try {
    await withCanvas(canvasPath, async (ctx) => {
      for (const b of ctx.pick(o.board)) {
        const tab = await Tab.open(ctx.browser, { width: b.w, height: b.h, scale });
        try {
          await tab.goto(await ctx.boardFile(b, o.tweaks));
          const d = await tab.eval('(window.__ldViolations || []).length');
          if (d || tab.errors.length) { problems++; console.log(`warn  ${b.file}: has blocked/missing files or script errors - run check`); }
          if (!o['no-png']) {
            const h = b.print === 'flow' ? Math.max(b.h, await tab.contentHeight()) : b.h;
            const f = await tab.screenshot(path.join(outDir, `${stemOf(b.file)}.png`), h);
            console.log(`png  ${rel(f)}  (${b.w}x${h} @${scale}x)`);
          }
          if (!o['no-pdf']) {
            const flow = b.print === 'flow';
            const buf = await ctx.pdf(b, o.tweaks, {
              paperWidth: b.w / 96,
              paperHeight: (flow ? defaultPageHeight(b.w) : b.h) / 96,
              firstPageOnly: !flow,
              preferCSSPageSize: flow,
            });
            const part = path.join(tmp, `${String(parts.length).padStart(3, '0')}-${stemOf(b.file)}.pdf`);
            fs.writeFileSync(part, buf);
            parts.push(part);
          }
        } finally {
          await tab.close();
        }
      }
    });
    if (parts.length) {
      const out = path.join(outDir, `${slug(canvasPath)}.pdf`);
      const how = mergePdfs(parts, out);
      if (how) console.log(`pdf  ${rel(out)}  (${parts.length} artboard(s), joined with ${how})`);
      else {
        const pdfDir = path.join(outDir, 'pdf');
        fs.mkdirSync(pdfDir, { recursive: true });
        for (const p of parts) fs.copyFileSync(p, path.join(pdfDir, path.basename(p).replace(/^\d+-/, '')));
        console.log(`warn  no PDF joiner found (PDFKit/qpdf/pdfunite) - one PDF per artboard in ${rel(pdfDir)}`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (problems) process.exitCode = 1;
}

function cmdOpen(o) {
  const canvasPath = canvasArg(o);
  const { html, state, title } = readCanvasFile(canvasPath);
  if (html !== renderCanvas(state, title)) throw new UserError('canvas has an older or modified viewer - extract its sources and re-seed with the current template before opening');
  let url = pathToFileURL(canvasPath).href;
  if (o.view) {
    // macOS LaunchServices drops the #fragment of a file URL, so hand the browser a stub
    // page that redirects to the canvas with the fragment intact
    const target = url + o.view;
    const stub = path.join(os.tmpdir(), `local-design-open-${slug(canvasPath)}.html`);
    fs.writeFileSync(stub, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target.replace(/"/g, '%22')}"><script>location.replace(${JSON.stringify(target)})</script>`);
    url = pathToFileURL(stub).href;
  }
  const app = process.env.LOCAL_DESIGN_APP || 'ego lite';
  let how = null;
  if (process.platform === 'darwin') {
    if (spawnSync('open', ['-a', app, url]).status === 0) how = app;
    else if (spawnSync('open', [url]).status === 0) how = 'the default browser';
  } else if (spawnSync('xdg-open', [url]).status === 0) {
    how = 'the default browser';
  }
  if (!how) throw new UserError(`could not open ${url}`);
  console.log(`opened ${rel(canvasPath)}${o.view || ''} in ${how}`);
}

function cmdFonts(o) {
  let families = [];
  if (process.platform === 'darwin') {
    const js = "ObjC.import('AppKit'); function run() { return ObjC.deepUnwrap($.NSFontManager.sharedFontManager.availableFontFamilies).join('\\n'); }";
    const r = spawnSync('osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8' });
    if (r.status !== 0) throw new UserError(`could not list fonts: ${r.stderr}`);
    families = r.stdout.split('\n');
  } else {
    const r = spawnSync('fc-list', [':', 'family'], { encoding: 'utf8' });
    if (r.status !== 0) throw new UserError('could not list fonts (fc-list missing)');
    families = r.stdout.split('\n').map((l) => l.split(',')[0]);
  }
  const filter = (o._[0] || '').toLowerCase();
  const list = [...new Set(families.map((f) => f.trim()).filter((f) => f && !f.startsWith('.')))]
    .filter((f) => f.toLowerCase().includes(filter))
    .sort((a, b) => a.localeCompare(b));
  for (const f of list) console.log(f);
  console.log(`(${list.length} famil${list.length === 1 ? 'y' : 'ies'})`);
}

// ------------------------------------------------------------------ main

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(USAGE); return; }
  const o = parseArgs(rest);
  const commands = { check: cmdCheck, shot: cmdShot, export: cmdExport, open: cmdOpen, fonts: cmdFonts };
  const fn = commands[cmd];
  if (!fn) throw new UserError(`unknown command "${cmd}"\n\n${USAGE}`);
  await fn(o);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => {
  if (e instanceof UserError) {
    console.error(`error ${e.message}`);
    process.exit(1);
  }
  console.error(e.stack || String(e));
  process.exit(2);
});
