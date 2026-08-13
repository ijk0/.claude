---
name: fable-gpt
description: Fable-GPT orchestration workflow — the main agent (Fable) only dispatches and adjudicates; heavy implementation/debugging/refactoring goes to Codex (gpt-5.6-sol); exploration/review/gate re-runs go to tiered Claude subagents. Use when orchestrating multi-agent work; when delegating implementation, debugging, refactoring, or test-fixing to Codex; when launching, resuming, monitoring, or cancelling a codex-companion task; or when the user says use Codex / run a Codex task / Fable-GPT.
---

# Fable-GPT: Fable orchestrates, Codex executes

Division of labor: **the main agent (Fable) only dispatches and decides** —
planning, architecture calls, task decomposition, dispatching, adjudicating from
summaries. **Codex (gpt-5.6-sol) does the heavy execution** — large
implementations, debugging, test fixing, multi-file refactors. **All other
concrete work (repo exploration, result review, gate re-runs) goes to Claude
subagents**, which return conclusions only. Keep Codex tasks focused, specific,
one thing at a time; never trust its output blindly — but the checking itself is
also done by subagents, never in the main context. Heavy tasks default to
implementation followed by a **parallel check fan-out** (Codex cold-read review
+ reviewer subagent + gate re-run), with all verdicts returned to the main
agent for one adjudication pass (see below).

Driver: `~/.claude/skills/fable-gpt/driver.sh` (wraps codex-companion.mjs,
resolves the active plugin version automatically, takes the task brief from a
file to avoid shell-quoting issues).

## Codex effort tiers (gpt-5.6 generation)

`--effort` accepts `none|minimal|low|medium|high|xhigh|max|ultra`. GPT-5.6
treats effort as a **ceiling, not a floor** — easy work doesn't overspend at a
high setting, so err upward. Tiering:

| Situation | Effort |
|---|---|
| Routine implementation / refactor / test fixing (driver default) | `high` |
| Hard debugging, gnarly multi-file work | `xhigh` |
| Cold-read adversarial review (single-chain judgment — exactly what max scales) | `max` (fallback `xhigh`) |
| `ultra` | **never in this workflow** — it spawns Codex-internal parallel subagents, duplicating what Fable-GPT already does at the orchestration layer; one dispatch = one focused task |

Status (field-checked 2026-08-10): **`max` is confirmed working on this
setup** — the companion allowlist patch is applied and the relay accepts it.
Two things can regress:
- **Plugin updates reset the companion allowlist** (stock 1.0.6 stops at
  `xhigh`). The driver detects an unpatched companion and refuses
  `max`/`ultra` with the one-line manual `sed` patch command printed to
  stderr — it never patches the plugin itself; re-run the patch after updates.
- **A backend/relay change could start rejecting `max`** (some proxies 400 on
  it). The task fails visibly — rerun with `xhigh`.

Never set effort via `~/.codex/config.toml` fallback: a known codex bug
(openai/codex#17436) lets the sqlite-persisted last-used effort silently
override config. The driver always passes `--effort` explicitly.

## Launching a Codex task (the only reliable path)

**Launch from the MAIN session with `Bash run_in_background`.** The driver runs
the task in a **detached worker** (survives the launching shell), so a dead
shell no longer kills Codex — but the main-session background shell is still
required: it hosts the watcher that yields the automatic completion
notification. A forwarding subagent's shell is reaped when its turn ends, which
silently kills the watcher and loses the notification (the worker survives;
re-attach with `driver.sh watch`).

1. Use the **Write tool** to put the task brief at a **fresh, unique literal
   path** in the persistent briefs directory:
   `~/.claude/fable-gpt/briefs/<project-dir-name>/<timestamp>-<task>.md`
   (timestamp first so briefs sort chronologically per project). Notes:
   - **Never use /tmp** — macOS sweeps it periodically and on reboot, which
     silently breaks later `--resume` follow-ups that reference the brief and
     destroys the audit trail. The briefs directory is permanent and lives
     outside every repo, so it never pollutes a review's untracked-file scope.
   - The **Write tool needs the expanded absolute path**
     (`/Users/<user>/.claude/fable-gpt/briefs/...`, not `~/...`); it creates
     missing parent directories itself — no mkdir needed.
   - **Do not pre-create the file with shell commands** (mktemp etc.) — the
     Write tool refuses to overwrite an existing file it hasn't Read;
   - **Do not pass the path through a shell variable across Bash calls** —
     shell state does not persist between calls, so `$task_file` is empty in
     the next call; reference the literal path everywhere;
   - `$CLAUDE_JOB_DIR` may be unset — do not rely on it.
   - **Keep briefs lean**: gpt-5.6-sol requests over 272K input tokens bill 2×
     input / 1.5× output *for the entire request*. The 1M window is for
     Codex's own exploration, not for stuffing repo context into the brief.

2. **cd into the target project directory** (the companion tracks tasks by cwd,
   see Gotchas), then launch with `Bash run_in_background`, using the literal
   path:

```bash
cd <project-dir> && ~/.claude/skills/fable-gpt/driver.sh run ~/.claude/fable-gpt/briefs/<project-dir-name>/<timestamp>-<task>.md --write
```

   Defaults: `--fresh --model gpt-5.6-sol --effort high` (override with the
   same flags; effort tiers above). **Pass `--write` explicitly whenever Codex
   must modify files** — the driver never adds it implicitly. `--foreground`
   restores the old in-process mode (no detached worker) if ever needed.

   **Launch the command bare — never append a pipe** (`| tail -c 4000`,
   `| head`, `| grep` …): `tail`/`head` buffer until EOF, so the background
   shell shows "No output available" for the entire run (looks dead while
   Codex works fine) and the harness record gets truncated. Output size is a
   non-issue anyway: the full log is streamed to the brief's `.result.md`.

3. What the driver does: enqueues the task as a **detached companion worker**,
   prints `[driver] job-id: <id>`, then watches the job — streaming the
   companion log into `<brief minus .md>.result.md` in real time (append mode,
   one `===== fable-gpt run <timestamp> =====` header per run) and finishing
   with the final assistant reply as the **last stdout lines** (stdout only:
   the companion log records the reply twice — as the last `Assistant
   message` entry and again under `Final output` — so in the `.result.md`
   the driver truncates the `Final output` repeat and appends just its
   `[driver] job ... finished` verdict line; the file keeps a single copy
   of the reply). Completion
   notifies automatically — no polling. Exit codes: 0 = clean completion with
   a final reply; 1 = job failed; 2 = watcher lost the job (worker may still
   run — re-attach); **3 = suspected false completion** (job marked completed
   but no final reply captured — the driver auto-runs the verification that
   used to be manual; continue the thread with `--resume`). The `.result.md`
   copy is the durable record — the harness's own background-output file is
   session-scoped and eventually cleaned up.

## Monitoring and management (always from the same project directory)

Completion notifies automatically — **no routine polling**. Use these when you
suspect a hang, need the result, or want to clean up:

```bash
~/.claude/skills/fable-gpt/driver.sh status --json            # progress; check the pid is alive — broker state can be false
~/.claude/skills/fable-gpt/driver.sh result --json            # latest task result (the summary field)
~/.claude/skills/fable-gpt/driver.sh watch <brief.md> [job-id]  # re-attach a watcher (job id auto-recovered from .result.md)
~/.claude/skills/fable-gpt/driver.sh task-resume-candidate --json   # resumable thread? (available: true → run ... --resume)
~/.claude/skills/fable-gpt/driver.sh cancel                   # clear zombie jobs (graceful when none)
```

**Live progress without polling the shell**: read the tail of the brief's
`.result.md` — the watcher streams the companion log into it in real time. Its
size/mtime growth is also the most reliable liveness signal: `status --json`
run from a *different* Claude session than the one that launched the task can
come back empty (`"running": []`) while the task is demonstrably mid-flight
(observed live). Single-job queries by id (`status <job-id>`) read the job
file directly and stay reliable cross-session.

## Standard heavy-task flow: implement → parallel checks → adjudicate

Heavy / multi-file / high-risk tasks default to this; trivial tasks may skip
the checks and go straight to adjudication.

1. **Implementation**: dispatch per the launch path above (`--write`, effort
   per the tier table). On completion, Read the output tail for the "original
   conclusion".
2. **Checks — dispatch all three in parallel** (all read-only and independent;
   this collapses what used to be two serial phases into one):
   - **Codex cold-read review**: a second task from the main session —
     **`--fresh` new thread + `--effort max` (fallback `xhigh`), WITHOUT
     `--write`** (conclusions only, no fixing; fixes are dispatched separately
     after adjudication). **Never `--resume` the implementation thread to
     self-review** — with its own reasoning context intact, its wrong premises
     hold during self-review too; that catches slips, not "the whole approach
     is wrong". A cold read does. Review brief template below; write it to the
     same briefs directory (outside every repo, so it never pollutes the
     review's untracked-file scope).
   - **Reviewer subagent** (`subagent_type: reviewer`): give it the task-brief
     path, Codex's conclusion summary, and the diff scope (e.g. `git diff`).
   - **Gate re-run subagent**: re-runs build/test on the host, returns
     pass/fail + failure summary only.

   *Sequential short-circuit variant*: when the implementation already looks
   shaky (Codex's own summary hedges, gates are obviously broken), run the
   Codex cold read alone first and hold the other two — saves reviewer/gate
   spend on a doomed diff. Parallel is the default because the wall-clock win
   (the max-effort review is usually the longest leg) normally beats the
   occasional wasted check.

   (The companion's built-in `review`/`adversarial-review` subcommands accept
   `--model` but **no `--effort`**, and upstream `codex /review` runs at
   hardcoded LOW effort — both reasons the task path is the only adequate
   review vehicle.)

```
# Adversarial review (read-only, do not modify any files)
Do your best to find reasons to REJECT the current change. Look only at
uncommitted working-tree changes (git diff / untracked files).
Output an issue list by severity (blocker / major / minor); if none, say
explicitly "no blockers found".
Only report TRUE issues reachable in realistic usage: before listing one,
confirm the triggering input/state actually occurs in normal use. Do not
report speculative extreme-edge-case findings or demand over-defensive
hardening against conditions that won't happen in practice.

## Original task brief
<full text>

## Implementer's conclusion
<summary>
```

   (Template tested: caught a planted blocker, ran code for evidence, modified
   nothing.)

3. **Adjudication**: one pass over all three verdicts — any blocker →
   dispatch a Codex fix task (may `--resume` the implementation thread, now
   with `--write`), then re-run the failed check(s); all green = done. Codex's
   review verdict is decision input, not a pass stamp — "never trust Codex
   blindly" applies to its self-review too. Filter reviewer findings for
   practicality: an issue only counts (at any severity) if its triggering
   input/state occurs in realistic use — drop extreme-edge-case /
   over-defensive findings rather than dispatching fixes for them.

## Orchestration rules: the main agent dispatches, never executes

The main agent's context is the scarcest resource — flooded with execution
detail (large diffs, build logs, whole files), its decomposition and
adjudication quality degrades fast. **The main agent only: decomposes,
dispatches, reads returned summaries, decides next. Everything concrete sinks
down:**

- **Heavy implementation / debugging / refactoring** → Codex. The only
  "hands-on" exceptions are lightweight dispatch actions — writing task briefs,
  launching the companion, checking status — single small tool calls that don't
  grow context; **launching must happen in the main session via
  `Bash run_in_background`** (see the launch section — a subagent launch loses
  the watcher and its completion notification).
- **Repo exploration / locating** → Explore subagent; conclusions + file:line
  only.
- **Codex result review** → the parallel check fan-out above. The reviewer
  subagent is a custom agent at `~/.claude/agents/reviewer.md` (frontmatter
  `model: opus` → Opus 5, native 1M context; no Write/Edit tools so physically
  read-only; **do not pass a model parameter**). It returns a verdict (pass /
  issue list); the main agent decides: accept, dispatch a Codex fix task, or
  change approach.
- **Model tiering: fable orchestrates only**; subagents get models by task
  tier (table below); except for reviewer, **always pass an explicit model
  alias** in Agent calls.
- **Build/test gates** → a verification subagent re-runs them on the host and
  returns pass/fail + a failure summary only. Codex saying "verified" does not
  count — its sandbox forbids loopback sockets, so the Gradle daemon cannot
  start (`SocketException: Operation not permitted`) and such gates physically
  cannot run there; Claude subagents run on the host and can.
- When dispatching any subagent, require **conclusions + key evidence only, no
  full dumps**.
- Small, clearly-bounded asks may go through `/codex:rescue`, but **foreground
  (`--wait`) only** — the rescue subagent prefers backgrounding "complex"
  tasks, which loses the completion notification. Heavy/long tasks always use
  this skill's main-session direct launch.
- Multiple concurrent Codex tasks: separate brief files and separate background
  shells (user-tested: 5–7 concurrent on a Codex 20x plan without hitting
  limits). When context rots (~4 compactions), preserve context then clear the
  conversation — use /handoff if installed, otherwise have a subagent write a
  handoff file.

## Model tiers (task tier ↔ model tier)

| Task | Dispatch | Model |
|---|---|---|
| Orchestration / adjudication | main session itself | fable = Fable 5 (sole user; never for subagents) |
| Codex result review | `subagent_type: reviewer`, no model param | opus = Opus 5 (pinned in frontmatter) |
| Exploration / locating / spec extraction | Explore or general-purpose + `model: sonnet` | sonnet = Sonnet 5 |
| Gate re-runs / device acceptance | general-purpose + `model: sonnet` | sonnet |
| Exception: heavy analysis (e.g. large transcript audits) | general-purpose + `model: opus` | opus |
| Implementation / refactor / test fixing | Codex, effort per tier table | gpt-5.6-sol |

**Context windows**: the whole Claude 5 family (Fable 5, Opus 5, Sonnet 5) runs
the **1M token window natively** on the Anthropic API — there is no `[1m]`
variant to select and no frontmatter pinning needed for context reasons. (The
old machinery — pinning `claude-opus-4-8[1m]` in reviewer frontmatter because
the Agent tool rejects `[1m]` aliases — was for the pre-5 generation;
claude-opus-4-8 remains available but is superseded as the `opus` alias
target since Claude Code 2.1.219.)

## Gotchas (every one field-tested)

- **The companion is cwd-sensitive**: `status`/`result`/`cancel` only see the
  workspaceRoot of the current directory (state lives under
  `~/.claude/plugins/data/codex-openai-codex/state/<workspace-hash>/jobs/`).
  Query from the wrong directory and you see nothing. Launch and query from
  the same project directory.
- **Broker state can be false**: an orphaned task still shows running in
  `status --json`. Check the `pid` field against a live process; clear false
  running jobs with `cancel`.
- **`--write` must be explicit**, or Codex has no write permission and cannot
  change any files (confirm via `"write": false` in status).
- **The plugin version changes**: the driver resolves the active version from
  `installed_plugins.json` first, falling back to the newest cached version;
  never hardcode a versioned path anywhere. A plugin update also resets the
  companion's effort allowlist — re-apply the manual `max`/`ultra` patch (the
  driver prints the command when needed).
- **The Agent tool's model parameter takes aliases only**
  (sonnet/opus/haiku/fable); full model IDs are rejected by the schema
  (tested). Pinning an exact version requires a custom agent's frontmatter
  (that is what reviewer does). Newly created agent definitions are **not
  discovered immediately** — the registry refreshed only later in the
  authoring session (and reliably at the next session).
- **Never set `CLAUDE_CODE_SUBAGENT_MODEL`**: it is the highest-priority source
  in subagent model resolution and overrides explicit model params and
  frontmatter (re-confirmed in current docs) — setting it silently disables
  the whole tiering scheme.
- **The default model without an explicit param is unreliable**: docs say
  inherit-from-main (i.e. fable), but a real session landed on a different
  model — hence: always pass an explicit alias, except for reviewer.
- **Shell state does not persist between Bash tool calls** (variables and cwd
  both reset). Pass task-brief paths as literals; chain `cd` with the follow-up
  command via `&&` in the same call.
- **False completions exist and are auto-detected**: the companion infers turn
  completion 250ms after a final-looking assistant message if no subagent
  activity is visible (`scheduleInferredCompletion` in lib/codex.mjs); with
  codex `multi_agent` enabled, apply-patch work can outrun that heuristic
  (field case: exit 0 mid-"Applying file changes"). The driver now verifies
  after every completion — **exit 3 + a WARNING line = suspected false
  completion**; treat the thread as unfinished and continue it with
  `run <new-brief> --resume --write`. The detached worker also means the
  historical ~5–8 min host-process deaths no longer kill Codex — if the
  watcher dies, `driver.sh watch` re-attaches.
- **`$CLAUDE_JOB_DIR` is not guaranteed to exist** (it was unset in the session
  that authored this skill); keep task briefs at unique literal paths under
  `~/.claude/fable-gpt/briefs/<project-dir-name>/` — never /tmp, which macOS
  sweeps periodically (breaks `--resume` briefs and the audit trail).
- **gpt-5.4 retires from ChatGPT-auth Codex on 2026-08-31** — never pass it as
  `--model` in a dispatch (`~/.codex/config.toml` was already migrated to 5.5
  on 2026-08-10).

## Troubleshooting

| Symptom | Action |
|---|---|
| Task stuck at "Turn started", broker shows running | Check the `pid` in `status --json`. Watcher dead but worker alive → `driver.sh watch <brief.md>`. Worker dead → `driver.sh cancel`, then relaunch via the main-session direct path |
| Driver exit 3 / "suspected FALSE COMPLETION" | The companion exited before Codex finished (premature turn-completion inference). Verify with `status --json`, then continue the thread via `run <new-brief> --resume --write` |
| `--effort max` refused by the driver | Companion allowlist unpatched — run the printed `sed` command once (re-run after plugin updates), or use `xhigh` |
| Task fails immediately at `max` effort (HTTP 400 from backend) | The relay/backend doesn't support `max` — fall back to `xhigh` |
| Codex hits Gradle `SocketException: Operation not permitted` | Sandbox forbids loopback — expected. Codex only changes code; gates are re-run by the verification subagent on the host |
| Codex finished but no files changed | `--write` was missing. Write a small brief saying "apply the changes", then `driver.sh run <that-file> --resume --write` to continue the thread |
| `status` can't find a just-launched task | Wrong cwd — return to the project directory the task was launched from |
| Background shell shows "No output available" while the task runs | The launch was piped through `tail`/`head`, which buffer until EOF — the task is fine. Watch the brief's `.result.md` instead (streamed in real time); launch bare next time |
