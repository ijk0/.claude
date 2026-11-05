# Provenance: local-design vs. Claude Code's `design` skill

Ported from `Skill: Design` (Claude Code v2.1.248, the last version before the
skill left the bundle), as extracted in
github.com/Piebald-AI/claude-code-system-prompts
(`system-prompts/skill-design.md` at commit 17ca6170f9). SKILL.md keeps that
skill's section order and wording, its `.dc.html` format, its `canvas.json`
schema, its helper CLI (`seed-canvas.mjs --template/--out/--title/--artboard/
--image/--canvas/--check/--extract`) and its craft and content rules, including
its ask-first gates (settle the aesthetic with the user, static vs. clickable).
The newer ask-first intake (v2.1.317) is layered in front of them; once it has
run, those later gates count as answered. Only what depended on Anthropic's
cloud or closed code was replaced:

| upstream (cloud / proprietary) | here (local) |
|---|---|
| precompiled ~2 MiB Claude Design editor payload | `payload.template.html`: this skill's own canvas viewer + `.dc.html` runtime, written from the format as the skill documents it |
| `seed-canvas.mjs` shipped with the closed payload | `seed-canvas.mjs` reimplemented, same flags, plus `--font` and format linting |
| publish with the `Artifact` tool, `contract: "0.1.31"` pin, `artifact-capabilities` roster, `self`/`downloads` capabilities, `favicon`, `force`, approval flow | step 4 "Show it": `driver.mjs open` in ego lite; the seeded file is the deliverable |
| WYSIWYG editor, properties panel, inline text editing, undo/redo, Save = republish, CAS conflicts, `not_writer`, sharing/org rules | view-and-export canvas; changes go through the working files and a re-seed |
| toolbar PNG/PDF export (rasterized JPEG pages) | `driver.mjs export` via headless ego lite: PNG per artboard + one vector PDF |
| "you will not normally see the canvas" | `driver.mjs check`/`shot` render every artboard and report what screenshots miss |
| `upload_asset`, `_blob/<id>` references | removed; images and fonts are seeded as base64 files entries |
| Google Fonts as the one allowed network host | network opened up (user's choice): the CSP allows http/https fonts, stylesheets, scripts, images, media, `fetch`/WebSockets; `check` lists requests as info and failed ones as warnings |
| reading a live canvas via `Artifact action:"read"` / WebFetch | `--extract` on the local file |
| `consent`/`revoke`/`login`/`sync`/`import`/`status` -> claude.ai/design, `/design-sync`, DesignSync, ClaudeDesign tools | quick exit: no account or service here |
| "Do not recreate copyrighted designs" rule (keyed on the account's email domain) | removed at the user's request |
| ask-first intake (v2.1.310, updated v2.1.317: `data-artifact-ask-first-intake-form-instructions.md`) in the claude.ai Visualizer question form, with colour-swatch look cards | "Ask first" section: the same skip rules, question limits and look rules through one `AskUserQuestion` call; look cards become `preview` text with four hex colours; the topic list (upstream's `${INTAKE_QUESTION_TOPICS}` template variable) is filled in locally; one allowed pre-question call: a quick look for the codebase's design system |

Upstream companion prompts consulted and not carried over (all cloud-bound):
`tool-description-claudedesign.md`, `tool-description-designsync.md`,
`system-reminder-*design-canvas*-appifactrepl-workflow.md`,
`tool-description-artifact-design-*`.
