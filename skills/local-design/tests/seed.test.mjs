import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, extract, seed, TEMPLATE, fileInDirectory, renderCanvas } from '../seed-canvas.mjs';

const driver = fileURLToPath(new URL('../driver.mjs', import.meta.url));
const source = '<!doctype html><html><head><script src="./support.js"></script></head><body><x-dc><p>Preserved design</p></x-dc></body></html>';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-design-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function imported(dir, files) {
  // Model an externally supplied document, bypassing the trusted seed helper.
  const html = '<title>Imported Design</title><script type="application/json" id="appifact-doc">' +
    JSON.stringify({ v: 1, files }).replace(/</g, '\\u003c') + '</script>';
  const file = path.join(dir, 'imported-design.html');
  fs.writeFileSync(file, html);
  return file;
}

test('imported path names are rejected before any driver output is written', (t) => {
  const dir = fixture(t), outside = path.join(dir, 'keep.dc.html');
  fs.writeFileSync(outside, 'original source');
  for (const name of ['../keep.dc.html', '/tmp/keep.dc.html', 'C:\\keep.dc.html', 'safe/../../keep.dc.html']) {
    const file = imported(dir, { [name]: source });
    assert.throws(() => check(file), /unsafe files entry/);
    const r = spawnSync(process.execPath, [driver, 'check', file, '--shots', path.join(dir, 'shots')], {
      env: { ...process.env, LOCAL_DESIGN_BROWSER: '/usr/bin/false' }, encoding: 'utf8', timeout: 5000,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unsafe files entry/);
    assert.equal(fs.existsSync(path.join(dir, 'shots')), false);
  }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'original source');
  assert.throws(() => fileInDirectory(dir, '../keep.dc.html'), /unsafe output/);
});

test('malformed state and case-colliding artboards fail validation', (t) => {
  const dir = fixture(t);
  for (const files of [null, [], { 'Main.dc.html': {} }, { 'Main.dc.html': source, 'main.dc.html': source }]) {
    assert.throws(() => check(imported(dir, files)));
  }
});

test('invalid manifests fail check instead of producing an ok result', (t) => {
  const file = imported(fixture(t), { 'Main.dc.html': source, 'canvas.json': JSON.stringify({
    artboards: [{ file: 'Missing.dc.html', x: 0, y: 0, w: 400, h: 300 }],
  }) });
  assert.throws(() => check(file), /canvas.json refused/);
});

test('checking into an existing directory preserves unrelated files even on startup failure', (t) => {
  const dir = fixture(t), file = imported(dir, { 'Main.dc.html': source });
  const shots = path.join(dir, 'existing'); fs.mkdirSync(shots);
  const sentinel = path.join(shots, 'keep.txt'); fs.writeFileSync(sentinel, 'user data');
  const r = spawnSync(process.execPath, [driver, 'check', file, '--shots', shots], {
    env: { ...process.env, LOCAL_DESIGN_BROWSER: '/usr/bin/false' }, encoding: 'utf8', timeout: 5000,
  });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'user data');
  assert.equal(fs.readdirSync(shots).filter((name) => name.startsWith('check-')).length, 1);
});

test('source and binary assets survive seed and extraction without overwrites', (t) => {
  const dir = fixture(t), board = path.join(dir, 'Main.dc.html'), image = path.join(dir, 'logo.png');
  fs.writeFileSync(board, source);
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 1]); fs.writeFileSync(image, bytes);
  const out = path.join(dir, 'portable-review.html');
  seed({ template: TEMPLATE, out, title: 'Portable Review', artboards: [board], images: [image], fonts: [] });
  assert.deepEqual(check(out).names, ['Main.dc.html', 'logo.png']);
  const dest = path.join(dir, 'extracted'); extract(out, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'Main.dc.html'), 'utf8'), source);
  assert.deepEqual(fs.readFileSync(path.join(dest, 'logo.png')), bytes);
  assert.throws(() => extract(out, dest), /not empty/);
});

test('state content cannot escape its JSON script block', () => {
  const marker = '</script><script>window.untrusted=true</script>';
  const html = renderCanvas({ files: { 'Main.dc.html': source + marker } }, 'Safe Title');
  const state = html.match(/id="appifact-doc">([\s\S]*?)<\/script>/)[1];
  assert.equal(JSON.parse(state).files['Main.dc.html'], source + marker);
  assert.equal(state.includes('</script>'), false);
});

test('open refuses an untrusted wrapper before invoking a browser', (t) => {
  const dir = fixture(t), file = imported(dir, { 'Main.dc.html': source });
  const r = spawnSync(process.execPath, [driver, 'open', file], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /older or modified viewer/);
});
