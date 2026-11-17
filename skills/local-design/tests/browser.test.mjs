import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { renderCanvas } from '../seed-canvas.mjs';
import { withCanvas, Tab } from '../driver.mjs';

const dc = (body, logic, meta = '{}', style = '') => `<!doctype html><html><head><script src="./support.js"></script></head><body><x-dc><helmet><style>body{margin:0;background:white;font:16px Georgia}a{color:#222}a:hover{color:#111}${style}</style></helmet>${body}</x-dc>${logic ? `<script data-dc-script data-props='${meta}'>${logic}</script>` : ''}</body></html>`;

test('sandbox, form lifecycle, imported defaults, and PDF export', { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-design-browser-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = {
    'Main.dc.html': dc('<button id="update" onClick="{{update}}">Update</button><select id="choice" value="{{choice}}"><option value="a">A</option><option value="{{option}}">Other</option></select><textarea id="text" value="{{text}}"></textarea><dc-import name="Child" hint-size="100%,100px"></dc-import>',
      'class Component extends DCLogic {constructor(p){super(p);this.state={changed:false};} renderVals(){return {choice:this.state.changed?"c":"b",option:this.state.changed?"c":"b",text:"Initial text",update:()=>this.setState({changed:true})};}}'),
    'Child.dc.html': dc('<p id="default">{{label}}</p>', 'class Component extends DCLogic {renderVals(){return {label:this.props.label};}}', '{"label":{"editor":"text","default":"Default remains"}}'),
    'Isolation.dc.html': dc('<p>Sandbox probe</p>', 'class Component extends DCLogic {componentDidMount(){window.probe={top:window===top};try{window.probe.storage=!!localStorage;}catch(e){window.probe.storage=e.name;}}}'),
    'StorageFailure.dc.html': dc('<p>Requires storage</p>', 'class Component extends DCLogic {componentDidMount(){localStorage.getItem("probe");}}'),
    'BlockedResource.dc.html': dc('<p>Blocked request</p>', 'class Component extends DCLogic {componentDidMount(){fetch("data:text/plain,blocked").catch(()=>{});}}'),
    'Flow.dc.html': dc(Array.from({ length: 12 }, (_, i) => `<section style="height:180px;break-inside:avoid;display:flex;flex-direction:column;justify-content:space-between"><p>FLOW_MARKER_${i}_START</p><p>FLOW_MARKER_${i}_END</p></section>`).join(''), '', '{}', '@page{margin:16mm 0;}'),
  };
  files['canvas.json'] = JSON.stringify({
    pages: [{ id: 'designs', name: 'Designs' }, { id: 'errors', name: 'Error states' }],
    launch: { view: 'canvas', page: 'designs' },
    artboards: Object.keys(files).map((file, i) => ({
      file, x: i * 900, y: 0, w: 794, h: 500, print: file === 'Flow.dc.html' ? 'flow' : 'fixed',
      page: ['StorageFailure.dc.html', 'BlockedResource.dc.html'].includes(file) ? 'errors' : 'designs',
    })),
  });
  const canvas = path.join(dir, 'regression-canvas.html');
  fs.writeFileSync(canvas, renderCanvas({ files }, 'Regression Canvas') + '<script>window.untrustedOuterExecuted=true</script>');
  await withCanvas(canvas, async (ctx) => {
    const viewer = await Tab.open(ctx.browser, { width: 1200, height: 800 });
    try {
      await viewer.goto(pathToFileURL(ctx.canvasPath).href, { settle: false });
      await viewer.waitFor('window.__ldReady');
      assert.equal(await viewer.eval('!!window.untrustedOuterExecuted'), false);
      await viewer.eval(`(() => {
        const input = document.querySelector('.ld-board[data-file="Child.dc.html"] input[type=text]');
        input.value = 'Changed preview'; input.dispatchEvent(new Event('input', { bubbles: true }));
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.copied = text; } } });
        document.getElementById('ld-copy').click();
      })()`);
      assert.equal((await viewer.eval('JSON.parse(window.copied)')).tweaks['Child.dc.html'].label, 'Changed preview');
      await viewer.eval(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } }); document.getElementById('ld-copy').click()`);
      await viewer.waitFor('!document.getElementById("ld-settings").hidden');
      assert.equal((await viewer.eval('JSON.parse(document.getElementById("ld-settings").value)')).tweaks['Child.dc.html'].label, 'Changed preview');
      await viewer.eval('document.getElementById("ld-reset").click()');
      await viewer.waitFor('window.__ldReady');
      assert.equal(await viewer.eval('document.querySelector(\'.ld-board[data-file="Child.dc.html"] input[type=text]\').value'), 'Default remains');
      await viewer.s('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await viewer.waitFor('Math.abs(document.getElementById("ld-bar").getBoundingClientRect().bottom - document.getElementById("ld-stage").getBoundingClientRect().top) < 1');
      assert.equal(await viewer.eval(`(() => {
        return document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('#ld-bar button,#ld-pages,#ld-help summary')]
          .filter(el => el.getBoundingClientRect().height).every(el => {
            const r = el.getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth;
          });
      })()`), true, 'mobile toolbar controls must fit and remain tappable');
      await viewer.eval('document.getElementById("ld-pages").value="errors";document.getElementById("ld-pages").dispatchEvent(new Event("change"))');
      await viewer.waitFor('document.getElementById("ld-status").textContent.includes("errors")');
      assert.match(await viewer.eval('document.getElementById("ld-errors").textContent'), /localStorage|sandbox/i);
    } finally { await viewer.close(); }
    const tab = await Tab.open(ctx.browser, { width: 794, height: 500 });
    try {
      await tab.goto(await ctx.boardFile(ctx.pick(['Main'])[0]));
      assert.equal(await tab.eval('Array.isArray(window.__ldViolations)'), true, 'diagnostics must attach before artboard scripts');
      const values = () => tab.eval('({choice:document.querySelector("#choice").value,text:document.querySelector("#text").value,child:document.querySelector("#default").textContent})');
      assert.deepEqual(await values(), {choice:'b',text:'Initial text',child:'Default remains'});
      await tab.click('#update');
      assert.deepEqual(await values(), {choice:'c',text:'Initial text',child:'Default remains'});
      await tab.goto(await ctx.boardFile(ctx.pick(['Isolation'])[0]));
      assert.deepEqual(await tab.eval('window.probe'), {top:false,storage:'SecurityError'});
      await tab.goto(await ctx.boardFile(ctx.pick(['StorageFailure'])[0]));
      const report = await tab.diagnose(ctx.pick(['StorageFailure'])[0]);
      assert.ok(report.errors.some((e) => /localStorage|sandbox/i.test(e)), JSON.stringify(report));
      await tab.goto(await ctx.boardFile(ctx.pick(['BlockedResource'])[0]));
      assert.ok((await tab.eval('window.__ldViolations')).some((v) => v.directive === 'connect-src'), 'blocked fetch must be recorded');
    } finally { await tab.close(); }
    const pdfTab = await Tab.open(ctx.browser, { width: 794, height: 500 });
    try {
      await pdfTab.goto(await ctx.printFile(ctx.pick(['Isolation'])[0]), { printDocument: true });
      assert.deepEqual(await pdfTab.eval('window.probe'), {top:true,storage:'SecurityError'});
      const buf = await ctx.pdf(ctx.pick(['Flow'])[0], {}, {paperWidth:794/96,paperHeight:1123/96,firstPageOnly:false,preferCSSPageSize:true});
      assert.equal(buf.subarray(0,4).toString(), '%PDF');
      const pdf = path.join(dir, 'flow.pdf'); fs.writeFileSync(pdf,buf);
      const text = spawnSync('pdftotext', [pdf, '-'], {encoding:'utf8'});
      if (text.error?.code === 'ENOENT') t.diagnostic('pdftotext unavailable; PDF text/pagination assertions skipped');
      else {
        assert.equal(text.status,0,text.stderr);
        for(let i=0;i<12;i++) assert.ok(text.stdout.includes(`FLOW_MARKER_${i}`),`missing FLOW_MARKER_${i}`);
        const pages = text.stdout.split('\f');
        assert.ok(pages.length >= 4, 'flow must span at least three pages with its margins');
        for (let i=0;i<12;i++) assert.ok(pages.some(page => page.includes(`FLOW_MARKER_${i}_START`) && page.includes(`FLOW_MARKER_${i}_END`)), `block ${i} split despite break-inside:avoid`);
      }
    } finally { await pdfTab.close(); }
  });
});
