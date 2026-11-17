#!/usr/bin/env node
// seed-canvas.mjs - seed .dc.html artboards, canvas.json, images and fonts into a fresh
// copy of payload.template.html, producing ONE self-contained, offline canvas page.
//
//   node seed-canvas.mjs --template <base>/payload.template.html --out spring-menu-poster.html \
//     --title "Spring Menu Poster" --artboard Main.dc.html --artboard Pricing.dc.html \
//     --image hero.png --font Brand.woff2 --canvas canvas.json
//   node seed-canvas.mjs --check spring-menu-poster.html
//   node seed-canvas.mjs --extract spring-menu-poster.html --to <fresh empty dir>
//
// Zero dependencies. Prints one summary line on stdout; anything on stderr is a warning.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class SeedError extends Error {}

const GENERIC_OUT = new Set(['design.html', 'index.html', 'main.html', 'page.html', 'canvas.html', 'output.html',
  'untitled.html', 'design-canvas.html', 'mockup.html', 'test.html', 'draft.html']);
const GENERIC_TITLE = /^(untitled( design| canvas)?|design( canvas)?|canvas|mockup|my design|new design|test|draft|output|page|main)$/i;
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
export const FONT_EXT = /\.(woff2?|ttf|otf)$/i;
export const BOARD_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.dc\.html$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_TEXT_ENTRY = 2 * 1024 * 1024;
const BIG_ASSET = 512 * 1024;
const MAX_ASSET = 8 * 1024 * 1024;
const STATE_RE = /<script type="application\/json" id="appifact-doc">([\s\S]*?)<\/script>/;
const README = `<!--
  Design canvas, seeded locally by the local-design skill (seed-canvas.mjs).
  Open this file in any browser - no account, no upload; it needs a connection only
  for online resources the design links (web fonts, CDN libraries, remote images).
  The design content is the "appifact-doc" state block below ("files": artboard source,
  canvas.json, images and fonts as base64). Do not hand-edit this file: edit the working
  .dc.html files and re-seed, or recover them with: seed-canvas.mjs --extract <this file> --to <dir>
-->`;

const kb = (n) => `${Math.round(n / 1024)} KB`;
const warn = (msg) => process.stderr.write(`warn: ${msg}\n`);

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|#39);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l === 'amp') return '&';
    if (l === 'lt') return '<';
    if (l === 'gt') return '>';
    if (l === 'quot') return '"';
    if (l === 'apos' || l === '#39') return "'";
    if (l.startsWith('#x')) return String.fromCodePoint(parseInt(l.slice(2), 16));
    if (l.startsWith('#')) return String.fromCodePoint(parseInt(l.slice(1), 10));
    return m;
  });
}

// Static lint of one artboard's source: the silent failures of the format.
export function lintArtboard(name, src, allNames) {
  const out = [];
  if (!/<script\s+src=["']\.\/support\.js["']\s*>\s*<\/script>/i.test(src)) {
    out.push(`${name}: the <script src="./support.js"></script> head line is missing or altered - keep it exactly`);
  }
  if (!/<x-dc\b/i.test(src)) out.push(`${name}: no <x-dc> template - nothing will render`);
  const script = src.match(/<script\b([^>]*\bdata-dc-script\b[^>]*)>([\s\S]*?)<\/script>/i);
  if (script) {
    if (!script[2].trim()) out.push(`${name}: an empty <script data-dc-script> errors - omit it on a static artboard`);
    else if (!/class\s+Component\s+extends\s+DCLogic/.test(script[2])) out.push(`${name}: the logic script must define class Component extends DCLogic`);
    const dq = script[1].match(/\bdata-props\s*=\s*"/);
    if (dq) out.push(`${name}: single-quote data-props (data-props='...') - a double-quoted attribute changes the escaping`);
    const sq = script[1].match(/\bdata-props\s*=\s*'([^']*)'/);
    if (sq) {
      try { JSON.parse(decodeEntities(sq[1])); }
      catch (e) { out.push(`${name}: data-props is not valid JSON after entity decoding (${e.message}) - its tweaks will be missing`); }
    }
  }
  for (const m of src.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const e = m[1].trim();
    const literal = /^(true|false|null|undefined|-?\d+(\.\d+)?|(['"]).*\3)$/.test(e);
    if (!literal && !/^[$A-Za-z_][$\w]*(\.[$\w]+)*$/.test(e)) {
      out.push(`${name}: {{ ${e} }} is not a dotted lookup - holes cannot hold expressions; compute it in renderVals()`);
    }
  }
  for (const m of src.matchAll(/style="[^"]*\}\}\s*\?[^"]*"/g)) out.push(`${name}: operators outside the braces are text: ${m[0].slice(0, 60)}`);
  for (const m of src.matchAll(/<dc-import\b([^>]*)>/gi)) {
    if (/\/\s*$/.test(m[1])) out.push(`${name}: <dc-import ... /> must not self-close - write <dc-import ...></dc-import>`);
    const nm = m[1].match(/\bname\s*=\s*["']([^"']+)["']/);
    if (nm && !allNames.has(`${nm[1]}.dc.html`)) out.push(`${name}: <dc-import name="${nm[1]}"> but no ${nm[1]}.dc.html was passed`);
    if (!/\bhint-size\s*=/.test(m[1])) out.push(`${name}: <dc-import${nm ? ` name="${nm[1]}"` : ''}> has no hint-size`);
  }
  for (const m of src.matchAll(/<([A-Z][A-Za-z0-9]*)(\s|\/|>)/g)) out.push(`${name}: capitalized tag <${m[1]}> - mount components with <dc-import name="${m[1]}">`);
  for (const m of src.matchAll(/<img\b[^>]*\bsrc='([^']*)'/gi)) out.push(`${name}: <img src='${m[1]}'> - double-quote src or the image will not resolve`);
  if (/<sc-for\b/i.test(src) && /<(table|tbody|thead|tr|select)\b[^>]*>\s*<sc-for\b/i.test(src)) {
    out.push(`${name}: <sc-for> directly inside <table>/<tr>/<select> is dropped by the HTML parser - use CSS grid/flex rows`);
  }
  return out;
}

// Validate canvas.json against the artboards present; returns {errors, warnings, canvas}.
export function lintCanvas(text, boardNames) {
  const errors = [];
  const warnings = [];
  let c;
  try { c = JSON.parse(text); } catch (e) { return { errors: [`canvas.json is not valid JSON: ${e.message}`], warnings, canvas: null }; }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { errors: ['canvas.json must be an object'], warnings, canvas: null };
  const top = new Set(['artboards', 'annotations', 'pages', 'launch']);
  for (const k of Object.keys(c)) if (!top.has(k)) warnings.push(`canvas.json: unknown key "${k}" is dropped by the canvas`);

  const pageIds = new Set();
  if (c.pages !== undefined) {
    if (!Array.isArray(c.pages)) errors.push('canvas.json: "pages" must be an array');
    else {
      if (c.pages.length > 40) errors.push('canvas.json: at most 40 pages');
      c.pages.forEach((p, i) => {
        if (!p || typeof p !== 'object') return errors.push(`pages[${i}] must be {id, name}`);
        const extra = Object.keys(p).filter((k) => k !== 'id' && k !== 'name');
        if (extra.length) errors.push(`pages[${i}]: each page is exactly {id, name} (drop ${extra.join(', ')})`);
        if (!ID.test(p.id || '')) errors.push(`pages[${i}].id must be 1-40 letters, digits, - or _`);
        else if (pageIds.has(p.id)) errors.push(`pages[${i}]: duplicate page id "${p.id}"`);
        else pageIds.add(p.id);
        if (typeof p.name !== 'string' || !p.name.trim()) errors.push(`pages[${i}] ("${p.id}") needs a name`);
      });
      if (c.pages.length === 1) warnings.push('canvas.json: a single page needs no "pages" - omit it');
    }
  }
  const firstPage = Array.isArray(c.pages) && c.pages[0] ? c.pages[0].id : undefined;

  const listed = [];
  const boardKeys = new Set(['file', 'x', 'y', 'w', 'h', 'title', 'expand', 'print', 'page', 'is_interactive']);
  if (c.artboards !== undefined && !Array.isArray(c.artboards)) errors.push('canvas.json: "artboards" must be an array');
  (Array.isArray(c.artboards) ? c.artboards : []).forEach((a, i) => {
    if (!a || typeof a.file !== 'string') return errors.push(`artboards[${i}] needs "file"`);
    const at = `artboards[${i}] (${a.file})`;
    if (!boardNames.has(a.file)) errors.push(`${at}: canvas.json lists an artboard that was not passed with --artboard`);
    if (listed.some((q) => q.file === a.file)) errors.push(`${at}: listed twice`);
    for (const k of Object.keys(a)) if (!boardKeys.has(k)) errors.push(`${at}: unknown key "${k}" - the editor would drop it`);
    for (const k of ['x', 'y']) if (!Number.isFinite(a[k])) errors.push(`${at}: "${k}" must be a number`);
    for (const k of ['w', 'h']) if (!(Number.isFinite(a[k]) && a[k] > 0)) errors.push(`${at}: "${k}" must be a positive number`);
    if (a.expand !== undefined && !['fit', 'fill'].includes(a.expand)) errors.push(`${at}: "expand" is "fit" or "fill"`);
    if (a.print !== undefined && !['fixed', 'flow'].includes(a.print)) errors.push(`${at}: "print" is "fixed" or "flow"`);
    if (a.page !== undefined && !pageIds.has(a.page)) errors.push(`${at}: page "${a.page}" is not listed in "pages"`);
    if (a.title !== undefined && typeof a.title !== 'string') errors.push(`${at}: "title" must be a string`);
    if (a.is_interactive !== undefined && typeof a.is_interactive !== 'boolean') errors.push(`${at}: "is_interactive" must be true or false`);
    listed.push({ ...a, page: a.page ?? firstPage });
  });
  for (let i = 0; i < listed.length; i++) {
    for (let j = i + 1; j < listed.length; j++) {
      const a = listed[i], b = listed[j];
      if (a.page !== b.page || ![a, b].every((q) => [q.x, q.y, q.w, q.h].every(Number.isFinite))) continue;
      const band = 56; // name strip + tweak chips above each frame
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y - band < b.y + b.h && b.y - band < a.y + a.h) {
        warnings.push(`canvas.json: ${a.file} and ${b.file} overlap (leave >=80px between frames in a row, >=120px between rows)`);
      }
    }
  }
  const stems = new Map();
  for (const n of boardNames) {
    const s = n.toLowerCase();
    if (stems.has(s)) errors.push(`artboards ${stems.get(s)} and ${n} differ only by case`);
    stems.set(s, n);
  }

  const noteKeys = new Set(['id', 'x', 'y', 'w', 'text', 'page', 'kind', 'size', 'bold', 'italic', 'color']);
  const ids = new Set();
  if (c.annotations !== undefined && !Array.isArray(c.annotations)) errors.push('canvas.json: "annotations" must be an array');
  const notes = Array.isArray(c.annotations) ? c.annotations : [];
  if (notes.length > 200) errors.push('canvas.json: at most 200 annotations');
  notes.forEach((n, i) => {
    const at = `annotations[${i}]`;
    if (!n || typeof n !== 'object') return errors.push(`${at} must be an object`);
    for (const k of Object.keys(n)) if (!noteKeys.has(k)) errors.push(`${at}: unknown key "${k}"`);
    if (!ID.test(n.id || '')) errors.push(`${at}: id must be 1-40 letters, digits, - or _`);
    else if (ids.has(n.id)) errors.push(`${at}: duplicate note id "${n.id}"`);
    else ids.add(n.id);
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) errors.push(`${at}: x and y must be numbers`);
    if (n.w !== undefined && !(Number.isFinite(n.w) && n.w >= 120 && n.w <= 2000)) errors.push(`${at}: w must be 120-2000`);
    if (n.h !== undefined) errors.push(`${at}: notes have no "h" (height auto-fits)`);
    if (typeof n.text !== 'string') errors.push(`${at}: text must be ONE plain string (use \\n for new lines)`);
    else if (n.text.length > 5000) errors.push(`${at}: text is over ~5000 characters`);
    if (n.page !== undefined && !pageIds.has(n.page)) errors.push(`${at}: page "${n.page}" is not listed in "pages"`);
    if (pageIds.size > 1 && n.page === undefined) warnings.push(`${at}: no "page" on a multi-page canvas - it lands on the first page`);
  });

  if (c.launch !== undefined) {
    const l = c.launch;
    if (!l || typeof l !== 'object') errors.push('canvas.json: "launch" must be an object');
    else if (l.view === 'canvas') {
      const extra = Object.keys(l).filter((k) => k !== 'view' && k !== 'page');
      if (extra.length) errors.push(`launch: {"view":"canvas"} takes only an optional "page" (drop ${extra.join(', ')})`);
      if (l.page !== undefined && !pageIds.has(l.page)) errors.push(`launch.page "${l.page}" is not a listed page`);
    } else if (l.view === 'focused') {
      const extra = Object.keys(l).filter((k) => k !== 'view' && k !== 'file');
      if (extra.length) errors.push(`launch: {"view":"focused"} takes only "file" (drop ${extra.join(', ')})`);
      if (!boardNames.has(l.file)) errors.push(`launch.file "${l.file}" is not an artboard on this canvas`);
    } else errors.push('launch is {"view":"canvas"[, "page": id]} or {"view":"focused", "file": "<artboard>"}');
  }
  if (pageIds.size > 1 && (!c.launch || c.launch.view !== 'canvas' || !c.launch.page)) {
    warnings.push('canvas.json has pages - set launch to {"view":"canvas","page":"<the page you just added or changed>"}');
  }
  return { errors, warnings, canvas: c };
}

export function validateState(state) {
  if (!state || !state.files || typeof state.files !== 'object' || Array.isArray(state.files)) {
    throw new SeedError('the state block must have a "files" record');
  }
  const boards = new Set();
  for (const [name, value] of Object.entries(state.files)) {
    if (!name || /[/\\\x00-\x1f:]/.test(name) || name.startsWith('.')) {
      throw new SeedError(`unsafe files entry: ${JSON.stringify(name)} - use a basename, not a path`);
    }
    if (typeof value !== 'string') throw new SeedError(`files entry ${name} must be a string`);
    if (/\.dc\.html$/i.test(name)) {
      if (!BOARD_NAME.test(name)) throw new SeedError(`invalid artboard name: ${name}`);
      if (boards.has(name.toLowerCase())) throw new SeedError(`duplicate artboard stem: ${name}`);
      boards.add(name.toLowerCase());
    }
  }
}

export function fileInDirectory(dir, name) {
  if (!name || /[/\\\x00-\x1f:]/.test(name) || name.startsWith('.')) {
    throw new SeedError(`unsafe output name: ${JSON.stringify(name)}`);
  }
  const dest = path.resolve(dir, name);
  if (path.dirname(dest) !== path.resolve(dir)) throw new SeedError(`output escapes its directory: ${name}`);
  return dest;
}

export function readCanvasFile(file) {
  const html = fs.readFileSync(file, 'utf8');
  const m = html.match(STATE_RE);
  if (!m) throw new SeedError(`${file} is not a local-design canvas (no appifact-doc state block)`);
  let state;
  try { state = JSON.parse(m[1]); } catch (e) { throw new SeedError(`${file}: the state block does not parse (${e.message})`); }
  validateState(state);
  const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  return { html, state, title: decodeEntities(title) };
}

function escapeTitle(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function scriptSafe(json) {
  // a seeded source can never close the state block
  return json.replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// Rebuild imported canvases from data only; never execute their outer HTML.
export function renderCanvas(state, title, template = TEMPLATE) {
  validateState(state);
  let html = fs.readFileSync(template, 'utf8');
  for (const ph of ['__LD_TITLE__', '<!--__LD_README__-->', '__LD_STATE__']) {
    if (!html.includes(ph)) throw new SeedError(`template is missing the ${ph} placeholder - re-copy payload.template.html`);
  }
  return html.replace('__LD_TITLE__', () => escapeTitle(title))
    .replace('<!--__LD_README__-->', () => README)
    .replace('__LD_STATE__', () => scriptSafe(JSON.stringify(state)));
}

export function seed({ template, out, title, artboards, images, fonts, canvas }) {
  if (!template) throw new SeedError('--template is required (the payload.template.html in the skill directory)');
  if (!out) throw new SeedError('--out is required');
  if (!fs.existsSync(template)) throw new SeedError(`no template at ${template}`);
  const outBase = path.basename(out).toLowerCase();
  if (!outBase.endsWith('.html')) throw new SeedError('--out must be a .html file');
  if (GENERIC_OUT.has(outBase)) throw new SeedError(`--out "${path.basename(out)}" is generic - name the file as the user would ("spring-menu-poster.html")`);
  if (path.resolve(out) === path.resolve(template)) throw new SeedError('--out must not be the template');
  const t = (title || '').trim();
  if (!t) throw new SeedError('--title is required - what the design is called');
  if (GENERIC_TITLE.test(t)) throw new SeedError(`--title "${t}" is generic - name the design ("Spring Menu Poster")`);
  if (/[<>&"\\]/.test(t)) throw new SeedError('--title must not contain < > & " or a backslash (apostrophes are fine)');
  if (!artboards.length) throw new SeedError('pass at least one --artboard <Name>.dc.html (Main.dc.html on a first seed)');

  const files = {};
  const names = new Set();
  const warnings = [];
  for (const p of artboards) {
    const name = path.basename(p);
    if (!BOARD_NAME.test(name)) throw new SeedError(`--artboard ${p}: artboards are named <Name>.dc.html (letters, digits, - and _)`);
    if ([...names].some((n) => n.toLowerCase() === name.toLowerCase())) throw new SeedError(`--artboard ${name} passed twice (stems are case-insensitive)`);
    if (!fs.existsSync(p)) throw new SeedError(`--artboard ${p}: no such file`);
    const src = fs.readFileSync(p, 'utf8');
    if (Buffer.byteLength(src) > MAX_TEXT_ENTRY) throw new SeedError(`--artboard ${name} is ${kb(Buffer.byteLength(src))} - over the 2 MiB entry limit; move images out to --image`);
    names.add(name);
    files[name] = src;
  }
  for (const name of names) warnings.push(...lintArtboard(name, files[name], names));
  if (!names.has('Main.dc.html')) warnings.push('no artboard is Main.dc.html - name the entry Main on a first seed');

  const addAsset = (p, kind, re) => {
    const name = path.basename(p);
    if (!re.test(name)) throw new SeedError(`--${kind} ${p}: unsupported type (${kind === 'image' ? '.png .jpg .jpeg .gif .webp .avif .bmp .svg' : '.woff2 .woff .ttf .otf'})`);
    if (own(files, name)) throw new SeedError(`--${kind} ${p}: another file already has the basename ${name}`);
    if (!fs.existsSync(p)) throw new SeedError(`--${kind} ${p}: no such file`);
    const buf = fs.readFileSync(p);
    if (buf.length > MAX_ASSET) throw new SeedError(`--${kind} ${name} is ${kb(buf.length)} - downsample it (sips -Z 1600 in.jpg --out out.jpg)`);
    if (buf.length > BIG_ASSET) warnings.push(`${name} is ${kb(buf.length)} - every image rides inside the canvas file; downsample (sips -Z 1600 ...) unless it needs the pixels`);
    files[name] = buf.toString('base64');
  };
  for (const p of images) addAsset(p, 'image', IMAGE_EXT);
  for (const p of fonts) addAsset(p, 'font', FONT_EXT);

  if (canvas) {
    if (!fs.existsSync(canvas)) throw new SeedError(`--canvas ${canvas}: no such file`);
    const text = fs.readFileSync(canvas, 'utf8');
    const r = lintCanvas(text, names);
    if (r.errors.length) throw new SeedError(`canvas.json refused:\n  ${r.errors.join('\n  ')}`);
    warnings.push(...r.warnings);
    files['canvas.json'] = `${JSON.stringify(r.canvas, null, 2)}\n`;
  } else if (names.size > 1) {
    warnings.push('more than one artboard but no --canvas - they will sit in one row; seed a canvas.json for any multi-artboard design');
  }

  // references to image/font files that were not passed
  for (const name of names) {
    const src = files[name];
    const refs = [...src.matchAll(/\s(?:src|href|poster)="(?:\.\/)?([^"\/?#{}]+)"/gi), ...src.matchAll(/url\(\s*["']?(?:\.\/)?([^"')\/?#{}]+)["']?\s*\)/gi)].map((m) => m[1]);
    for (const r of new Set(refs)) {
      if ((IMAGE_EXT.test(r) || FONT_EXT.test(r)) && !own(files, r)) warnings.push(`${name} references ${r} but it was not passed with --image/--font - it will render broken`);
    }
  }

  const html = renderCanvas({ v: 1, files }, t, template);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, html);
  for (const w of warnings) warn(w);
  const assetBytes = Object.entries(files).filter(([n]) => IMAGE_EXT.test(n) || FONT_EXT.test(n)).reduce((s, [, v]) => s + v.length * 0.75, 0);
  return { out, title: t, names: Object.keys(files), size: Buffer.byteLength(html), assetBytes, warnings };
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function check(file) {
  const { html, state, title } = readCanvasFile(file);
  if (html.includes('__LD_TITLE__') || html.includes('__LD_STATE__')) throw new SeedError(`${file}: a template placeholder is left over - re-seed from the template`);
  const names = Object.keys(state.files);
  const boards = names.filter((n) => /\.dc\.html$/i.test(n));
  if (!boards.length) throw new SeedError(`${file}: no .dc.html in the state block`);
  const warnings = [];
  const boardSet = new Set(boards);
  for (const b of boards) warnings.push(...lintArtboard(b, state.files[b], boardSet));
  if (own(state.files, 'canvas.json')) {
    const r = lintCanvas(state.files['canvas.json'], boardSet);
    if (r.errors.length) throw new SeedError(`canvas.json refused:\n  ${r.errors.join('\n  ')}`);
    warnings.push(...r.warnings);
  }
  if (!title.trim()) warnings.push('the page has no title');
  return { title, names, warnings };
}

export function extract(file, to) {
  if (!to) throw new SeedError('--extract needs --to <a fresh, empty directory>');
  const { state } = readCanvasFile(file);
  if (fs.existsSync(to)) {
    if (!fs.statSync(to).isDirectory()) throw new SeedError(`--to ${to} is not a directory`);
    if (fs.readdirSync(to).length) throw new SeedError(`--to ${to} is not empty - extract into a fresh, empty directory (nothing is overwritten)`);
  }
  fs.mkdirSync(to, { recursive: true });
  const written = [];
  const skipped = [];
  for (const [name, value] of Object.entries(state.files)) {
    if (typeof value !== 'string' || name.includes('/') || name.includes('\\') || name.startsWith('.')) { skipped.push(name); continue; }
    const dest = fileInDirectory(to, name);
    if (/\.dc\.html$/i.test(name) || name === 'canvas.json') fs.writeFileSync(dest, value, { flag: 'wx' });
    else if (IMAGE_EXT.test(name) || FONT_EXT.test(name)) fs.writeFileSync(dest, Buffer.from(value, 'base64'), { flag: 'wx' });
    else { skipped.push(name); continue; }
    written.push(name);
  }
  return { written, skipped };
}

function parseArgs(argv) {
  const o = { artboards: [], images: [], fonts: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new SeedError(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--template': o.template = val(); break;
      case '--out': o.out = val(); break;
      case '--title': o.title = val(); break;
      case '--artboard': o.artboards.push(val()); break;
      case '--image': o.images.push(val()); break;
      case '--font': o.fonts.push(val()); break;
      case '--canvas': o.canvas = val(); break;
      case '--check': o.check = val(); break;
      case '--extract': o.extract = val(); break;
      case '--to': o.to = val(); break;
      case '-h': case '--help': o.help = true; break;
      default: throw new SeedError(`unknown argument ${a}`);
    }
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || process.argv.length <= 2) {
    console.log('usage: seed-canvas.mjs --template T --out O --title "Name" --artboard Main.dc.html [--artboard ...] [--image F]... [--font F]... [--canvas canvas.json]\n       seed-canvas.mjs --check O\n       seed-canvas.mjs --extract O --to <fresh dir>');
    return;
  }
  if (o.check) {
    const r = check(o.check);
    for (const w of r.warnings) warn(w);
    console.log(`ok: "${r.title}" - ${r.names.join(', ')}`);
    return;
  }
  if (o.extract) {
    const r = extract(o.extract, o.to);
    for (const s of r.skipped) warn(`skipped ${s} (not an artboard, canvas.json, image or font)`);
    console.log(`extracted ${r.written.length} file(s) to ${o.to}: ${r.written.join(', ')}`);
    return;
  }
  const r = seed(o);
  console.log(`seeded ${r.out} - "${r.title}": ${r.names.join(', ')} (${kb(r.size)}${r.assetBytes ? `, ${kb(r.assetBytes)} of images/fonts` : ''})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch (e) {
    if (e instanceof SeedError) { console.error(`error: ${e.message}`); process.exit(1); }
    throw e;
  }
}

export const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'payload.template.html');
