# Assets, commands, and troubleshooting

## What lives where

Everything the user gets lives in the one seeded `.html` file:

- **The viewer and runtime code** is `payload.template.html` in the
  skill's base directory. Never paste it or hand-edit a copy; only
  copy and seed it with the helper.
- **The design content** is the `files` record in the state block
  (script id `appifact-doc`): path -> raw `.dc.html` source. EVERY
  `.dc.html` entry renders as an artboard; `Main.dc.html` is the entry
  file for a new design. Preserve existing names when editing. Components a design
  imports (`<dc-import name="Card">`) are sibling `.dc.html` entries -
  artboards in their own right.
- **The canvas layout** is a `canvas.json` files entry (see
  [format.md](format.md)): positions, pages, launch view. Seed it for any
  multi-artboard design.
- **Images** become `files` entries holding base64 under their
  filename. The canvas file carries every image, so keep each to what
  it needs - downsample with whatever is on the machine (`sips -Z 1600
  in.jpg --out out.jpg` on macOS, `magick in.png -resize 1600x
  out.png`, Pillow). The helper stores them (`--image`), warns over
  512 KB and refuses over 8 MiB.
- **Fonts**: installed system fonts work as they are; a font file
  becomes a `files` entry the same way (`--font Brand.woff2`; `.woff2
  .woff .ttf .otf`), used from an `@font-face` in the artboard's
  `<helmet>`; Google Fonts (or another font CDN) loads through a
  `<link rel="stylesheet">` in `<helmet>`. Embedded files work offline;
  linked ones need a connection wherever the canvas is opened.
- **Network resources** - CDN libraries, remote images, API calls from
  a prototype - are allowed: the canvas loads whatever the artboards
  link. Embed what must work offline or outlive its URL.
- **Referencing files from .dc.html** - the failures below are silent
  in the canvas (the driver's `check` names them): store images as
  **BARE base64** (the helper does; no `data:` prefix - the runtime
  adds the wrapper); reference by filename, `<img src="logo.png">` or
  `./logo.png`, with the `src` **double-quoted** and the name matching
  the files key exactly (literal substitution; CSS `url(./logo.png)`
  and `@font-face src: url("./Brand.woff2")` work in any quote form);
  only `.png .jpg .jpeg .gif .webp .avif .bmp .svg` entries resolve as
  images and `.woff2 .woff .ttf .otf` as fonts; a missing entry renders
  broken with no warning on the canvas.

## Known limits (set expectations honestly)

- View and export only: no WYSIWYG editing, properties panel, inline
  text editing, undo/redo or Save. Tweak-chip changes and artboard
  moves live in that browser tab and reset on reload; they never
  change the file. Every real change goes through the working files.
- Artboards share nothing at runtime - no state, logic or tweaks cross
  files (a toggle on the desktop artboard does not move the mobile
  one); duplicate what each needs.
- PNG/PDF export runs from the driver, not from a canvas
  button. The PDF is vector with selectable text, except text set in
  `system-ui` / `-apple-system` (embedded without a text layer, so not
  searchable) - name a real family when the PDF must be searchable.
  Notes are not exported.
- Linked resources (font CDN, remote images, APIs) need a connection
  wherever the canvas is opened; exports capture them as they loaded.
- Design-system color tokens and the "request tweaks" agent loop of
  claude.ai/design are not available.
- The runtime and viewer are this skill's own implementation of the
  format; don't promise parity with claude.ai/design or that a canvas
  opens there.

## Driver and helper reference

Both run with `node` (>= 22) or `bun`, no install. The driver renders
through a headless Chromium-family browser with a throwaway profile:
ego lite (`/Applications/ego lite.app`), else Google Chrome or
Chromium; `LOCAL_DESIGN_BROWSER=<binary>` overrides. `open` uses ego
lite unless `LOCAL_DESIGN_APP=<app name>` says otherwise.

| command | what it does |
|---|---|
| `seed-canvas.mjs --template T --out O --title "Name" --artboard F... [--image F]... [--font F]... [--canvas canvas.json]` | seed a fresh canvas  |
| `seed-canvas.mjs --check O` | parse check: `ok: "Title" - files` |
| `seed-canvas.mjs --extract O --to <fresh dir>` | working files back out (never overwrites) |
| `driver.mjs check O [--board F]... [--theme dark] [--tweak K=V]...` | render every artboard, report problems, write PNGs; exit 1 on errors |
| `driver.mjs shot O --board F [--click CSS \| --fill CSS=TEXT \| --press KEY]... [--tweak K=V]... [--width W --height H] [--theme dark]` | screenshot one artboard, then after each step |
| `driver.mjs shot O --canvas [--view '#focus=F' \| '#page=ID&fit']` | screenshot the canvas page itself |
| `driver.mjs export O [--to DIR] [--scale 2] [--board F]... [--no-png] [--no-pdf]` | PNG per artboard + one PDF |
| `driver.mjs open O [--view '#focus=F']` | open in ego lite |
| `driver.mjs fonts [filter]` | installed font families |

Screenshots land in `$TMPDIR/local-design-shots/<canvas name>/`
(`--shots DIR` to change). Each `check` creates a fresh `check-*` subdirectory and preserves existing files; `shot` writes named PNGs directly. Exports in `<canvas name>-export/` next to
the canvas. Checks and exports rebuild the trusted viewer from the input state;
scripts added to an imported HTML wrapper are not executed. Check/shot and PNG
rendering use opaque-origin iframes with `sandbox="allow-scripts allow-forms"`.
PDF uses a temporary document on `127.0.0.1` with the same sandbox flags applied
by an HTTP CSP header, so the browser can paginate with `@page` and
`break-inside`. The temporary server closes after the operation. PDF code sees
a top-level document rather than a parent iframe; avoid depending on the
embedding context for print content. Imported names and manifests are validated
before rendering. `open` requires the current unmodified viewer; extract and
re-seed older canvases first.

The canvas URL takes `#focus=<file>`, `#page=<id>` and
`#fit`; it sets `window.__ldReady = true` once the artboards in view
have rendered.

**Looking at it together in the user's browser.** When the user wants
you to drive the live canvas in their ego lite (follow the
`ego-browser` skill's rules for task spaces), one task space, the
same pattern each time:

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace("design: Spring Menu Poster");
const page = task.page("p1");
await page.goto("file:///abs/path/spring-menu-poster.html#focus=Main.dc.html");
await page.waitForFunction(() => window.__ldReady === true, undefined, { timeout: 20000 });
console.log({ space: task.spaceId });
console.log(await page.snapshot());
EOF
```

Use the current snapshot's refs for controls inside the expanded artboard;
raw selectors can match another copy in a hidden canvas iframe. On the
canvas view, tweak chips are `.ld-swatch[title="#365314"]` / `.ld-chip
input`, the pages menu is `#ld-pages`, an artboard's expand button is
`.ld-board[data-file="Main.dc.html"] .ld-strip .ld-btn`. End with
`await task.finish({ keep: [] })` (or keep `p1` when the user wants
the tab).

## Gotchas

- **Run `check` after every seed.** The viewer reports runtime errors in
  Help, but missing assets, font fallbacks, and clipping still need driver
  diagnostics and visual inspection.
- **A fixed `width` plus padding overflows the frame** unless the
  root has `box-sizing: border-box`; `check` reports "content is Npx
  wider than the frame".
- **Linked resources load at view time**: a font CDN or remote image
  that is unreachable falls back silently on the canvas; `check` lists
  every network request (`info`) and flags failed ones (`warn`).
- **Re-seeding does not refresh an open tab** - reload it. A tab that
  was already open also returns to its last page/zoom, not `launch`.
- **macOS `open` drops the `#fragment` of a file URL**, so a plain
  `open -a "ego lite" "file:///...#focus=X"` lands on the canvas view;
  `driver.mjs open --view` goes through a redirect stub to keep it.
- **Selector clicks via ego-browser on the canvas view** can match an
  artboard's copy you can't see. Expand it (`#focus=...`) and use a current
  snapshot ref from that frame; the hidden canvas may still contain a copy.
- **PDF text in `system-ui`** (SF Pro) is not selectable or
  searchable; named families (Avenir Next, Iowan Old Style, embedded
  faces) are.
- **Flow artboards paginate in print layout**, so the page count can
  exceed `check`'s estimate when `@page` margins are set.

## Troubleshooting

- **`error: --title "Design" is generic`** / **`--out "index.html" is
  generic`**: name the design and the file as the user would.
- **`canvas.json refused: artboards[N] (X.dc.html): canvas.json lists
  an artboard that was not passed with --artboard`**: pass every
  listed artboard, or drop it from `canvas.json`.
- **`missing file: hero.png - not seeded ...`** (check): add
  `--image hero.png` to the seed, and reference it by exact basename
  in a double-quoted `src`.
- **`font "X" is not installed here - text rendered in Helvetica`**:
  pick an installed family (`driver.mjs fonts X`) or embed the file
  with `--font` and an `@font-face`.
- **`<dc-import name="Nope">: there is no Nope.dc.html in this
  canvas`**: seed the component file as an artboard too.
- **`the artboard never signalled ready`**: its `<script
  src="./support.js"></script>` line is missing or altered.
- **`no Chromium-family browser found`**: install ego lite or Chrome,
  or set `LOCAL_DESIGN_BROWSER` to a Chromium binary.
- **`unsafe files entry`**: an imported canvas contains a path instead of a
  basename. Recover the original sources from the author; do not run its HTML
  wrapper or silently normalize names that could collide.


## Maintaining this skill

Run `node --test skills/local-design/tests/seed.test.mjs` for file-safety and round-trip checks. Run `node --test skills/local-design/tests/browser.test.mjs` for sandbox, interaction, and export regressions; it launches a temporary headless browser. Run these from the repository root. Ordinary design work uses `driver.mjs check` instead.
