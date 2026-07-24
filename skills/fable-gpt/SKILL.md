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
also done by subagents, never in the main context. Heavy tasks default to the
two-phase flow: implementation, then a Codex cold-read xhigh pre-review, with
both conclusions returned to the main agent for adjudication (see below).

Driver: `~/.claude/skills/fable-gpt/driver.sh` (wraps codex-companion.mjs,
resolves the active plugin version automatically, takes the task brief from a
file to avoid shell-quoting issues).

## Launching a Codex task (the only reliable path)

**Iron rule: launch from the MAIN session with `Bash run_in_background`. Never
let a forwarding subagent put the companion in its own background shell** — the
moment the subagent's turn ends, its host process is reaped; the task orphans
right after "Turn started" and plays dead while the broker still shows it as
running (a false state). The companion's agent loop runs inside the host
process; the broker only shares sessions. Kill the host, kill the task.
Main-session background tasks survive across turns and notify on completion.

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

2. **cd into the target project directory** (the companion tracks tasks by cwd,
   see Gotchas), then launch with `Bash run_in_background`, using the literal
   path:

```bash
cd <project-dir> && ~/.claude/skills/fable-gpt/driver.sh run ~/.claude/fable-gpt/briefs/<project-dir-name>/<timestamp>-<task>.md --write
```

   Defaults: `--fresh --model gpt-5.6-sol --effort high` (override with the
   same flags; effort is one of `none|minimal|low|medium|high|xhigh`). **Pass
   `--write` explicitly whenever Codex must modify files** — the driver never
   adds it implicitly.

   **Launch the command bare — never append a pipe** (`| tail -c 4000`,
   `| head`, `| grep` …): `tail`/`head` buffer until EOF, so the background
   shell shows "No output available" for the entire run (looks dead while
   Codex works fine) and the harness record gets truncated. Output size is a
   non-issue anyway: the full log is tee'd to the brief's `.result.md`.

3. Completion notifies automatically — no polling. Read the **tail** of the
   output file returned at launch: the last stdout line is Codex's final reply,
   preceded by `[codex]` progress lines:

```
[codex] Starting Codex task thread.
[codex] Thread ready (<threadId>).
[codex] Turn started (<turnId>).
[codex] Assistant message captured: ...
<final reply>
```

   The driver also persists the complete run output (progress lines, final
   reply, stderr) next to the brief at `<brief minus .md>.result.md` — append
   mode, one `===== fable-gpt run <timestamp> =====` header per run, so
   relaunches of the same brief stack instead of clobbering. The harness's own
   background-output file is session-scoped and eventually cleaned up; the
   `.result.md` copy is the durable record — each run leaves a brief +
   result pair for later audits and false-completion forensics.

## Monitoring and management (always from the same project directory)

Completion notifies automatically — **no routine polling**. Use these when you
suspect a hang, need the result, or want to clean up:

```bash
~/.claude/skills/fable-gpt/driver.sh status --json            # progress; check the pid is alive — broker state can be false
~/.claude/skills/fable-gpt/driver.sh result --json            # latest task result (the summary field)
~/.claude/skills/fable-gpt/driver.sh task-resume-candidate --json   # resumable thread? (available: true → run ... --resume)
~/.claude/skills/fable-gpt/driver.sh cancel                   # clear zombie jobs (graceful when none)
```

**Live progress without polling the shell**: read the tail of the brief's
`.result.md` — the driver appends it in real time. Its size/mtime growth is
also the most reliable liveness signal: `status --json` run from a *different*
Claude session than the one that launched the task can come back empty
(`"running": []`) while the task is demonstrably mid-flight (observed live).

## Standard two-phase Codex flow: implement → cold-read review → adjudicate

Heavy / multi-file / high-risk tasks default to two phases; trivial tasks may
skip phase 2 and go straight to adjudication.

1. **Implementation**: dispatch per the launch path above (`--write`, effort
   defaults to high). On completion, Read the output tail for the "original
   conclusion".
2. **Cold-read review**: immediately dispatch a second task from the main
   session — **`--fresh` new thread + `--effort xhigh`, WITHOUT `--write`**
   (conclusions only, no fixing; fixes are dispatched separately after
   adjudication). **Never `--resume` the implementation thread to self-review**
   — with its own reasoning context intact, its wrong premises hold during
   self-review too; that catches slips, not "the whole approach is wrong". A
   cold read does. (The companion's built-in review/adversarial-review
   subcommands accept no `--model`/`--effort`; xhigh review must go through the
   task path.) The review brief contains three things — the original brief in
   full, the original conclusion summary, and adversarial instructions.
   Template (tested: caught a planted blocker, ran code for evidence, modified
   nothing). Write the review brief to the same briefs directory
   (`~/.claude/fable-gpt/briefs/<project-dir-name>/`) — it lives outside every
   repo, so it never pollutes the review's untracked-file scope:

```
# Adversarial review (read-only, do not modify any files)
Do your best to find reasons to REJECT the current change. Look only at
uncommitted working-tree changes (git diff / untracked files).
Output an issue list by severity (blocker / major / minor); if none, say
explicitly "no blockers found".

## Original task brief
<full text>

## Implementer's conclusion
<summary>
```

3. **Adjudication**: Fable judges with both conclusions — any blocker →
   dispatch a fix task (may `--resume` the implementation thread, now with
   `--write`); no blockers → dispatch the gate-rerun subagent and the reviewer
   subagent in parallel; all green = done. Codex's review verdict is decision
   input, not a pass stamp — "never trust Codex blindly" applies to its
   self-review too.

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
  `Bash run_in_background`** (a subagent launch triggers the orphaning trap,
  see the iron rule).
- **Repo exploration / locating** → Explore subagent; conclusions + file:line
  only.
- **Codex result review**: first the two-phase cold-read pre-review (above);
  with no blockers, dispatch `subagent_type: reviewer` (custom agent at
  `~/.claude/agents/reviewer.md`, model pinned to claude-opus-4-8[1m], no
  Write/Edit tools so physically read-only; **do not pass a model parameter**).
  Give it: the task-brief path, Codex's conclusion summary, the diff scope
  (e.g. `git diff`). It returns a verdict (pass / issue list); the main agent
  decides: accept, dispatch a Codex fix task, or change approach. Never trust
  Codex blindly — but the checking itself stays out of the main context.
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
  tasks, which is exactly the orphaning trap. Heavy/long tasks always use this
  skill's main-session direct launch.
- Multiple concurrent Codex tasks: separate brief files and separate background
  shells (user-tested: 5–7 concurrent on a Codex 20x plan without hitting
  limits). When context rots (~4 compactions), preserve context then clear the
  conversation — use /handoff if installed, otherwise have a subagent write a
  handoff file.

## Model tiers (task tier ↔ model tier)

| Task | Dispatch | Model |
|---|---|---|
| Orchestration / adjudication | main session itself | fable (sole user; never for subagents) |
| Codex result review | `subagent_type: reviewer`, no model param | claude-opus-4-8[1m] (pinned in frontmatter) |
| Exploration / locating / spec extraction | Explore or general-purpose + `model: sonnet` | sonnet |
| Gate re-runs / device acceptance | general-purpose + `model: sonnet` | sonnet |
| Exception: heavy analysis (e.g. large transcript audits) | general-purpose + `model: opus` | opus |
| Implementation / refactor / test fixing | Codex, `--effort high` (cold-read review: `xhigh`) | gpt-5.6-sol |

**1m-context variants**: this workflow prefers the 1M-context Claude models —
`claude-sonnet-5[1m]` and `claude-opus-4-8[1m]`. The `[1m]` suffix is part of
the full model ID, so it can only be set where a full ID is accepted: a custom
agent's frontmatter. Reviewer therefore pins `claude-opus-4-8[1m]`. The Agent
tool's `model` param accepts aliases only (sonnet/opus/haiku/fable) and rejects
the `[1m]` suffix (see Gotchas), so alias-dispatched tiers (Exploration, gate
re-runs, heavy analysis) take the harness's default resolution for that alias;
to force a specific 1m variant on such a tier, give it a custom agent with the
variant pinned in frontmatter. The driver's `--model` is a Codex model
(gpt-5.6-sol) and is unaffected.

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
- **The plugin version changes**: the cache already holds 1.0.4/1.0.6 side by
  side. The driver resolves the active version from `installed_plugins.json`
  first, falling back to the newest cached version; never hardcode a versioned
  path anywhere.
- **The Agent tool's model parameter takes aliases only**
  (sonnet/opus/haiku/fable); full IDs such as claude-opus-4-8 — and the `[1m]`
  suffix on an alias (`sonnet[1m]`) — are rejected by the schema (tested).
  Pinning an exact version, including a 1m-context variant like
  `claude-opus-4-8[1m]`, requires a custom agent's frontmatter (that is what
  reviewer does). Newly created agent definitions are **not discovered
  immediately** — the registry refreshed only later in the authoring session
  (and reliably at the next session).
- **Never set `CLAUDE_CODE_SUBAGENT_MODEL`**: it is the highest-priority source
  in subagent model resolution and overrides explicit model params and
  frontmatter (per official docs) — setting it silently disables the whole
  tiering scheme.
- **The default model without an explicit param is unreliable**: docs say
  inherit-from-main (i.e. fable), but a real session landed on opus-4-8 —
  hence: always pass an explicit alias, except for reviewer.
- **Shell state does not persist between Bash tool calls** (variables and cwd
  both reset). Pass task-brief paths as literals; chain `cd` with the follow-up
  command via `&&` in the same call.
- **Driver exit 0 can be a FALSE completion**: field case (harness 2.1.215,
  plugin 1.0.6) — a correct main-session background launch (no timeout param)
  exited 0 after ~8m21s while Codex was still mid-"Applying file changes", and
  a fully nohup-detached relaunch also died ~5 min in. So it is NOT a Bash
  time cap (a 63-min background run completed fine earlier; cap kills exit
  non-zero) and nohup does not fix it — the companion's "Turn completion
  inferred" path can fire prematurely. After EVERY completion notification,
  verify before trusting: the output tail must end with a final assistant
  reply (after "Turn completed"), not a progress line, and `status --json`
  must show the job completed with a summary. Otherwise treat it as orphaned
  and continue the thread with `--resume`.
- **`$CLAUDE_JOB_DIR` is not guaranteed to exist** (it was unset in the session
  that authored this skill); keep task briefs at unique literal paths under
  `~/.claude/fable-gpt/briefs/<project-dir-name>/` — never /tmp, which macOS
  sweeps periodically (breaks `--resume` briefs and the audit trail).

## Troubleshooting

| Symptom | Action |
|---|---|
| Task stuck at "Turn started", broker shows running | Orphaned (companion host process died). Check the pid in status; `driver.sh cancel`, then relaunch via the main-session direct path |
| Codex hits Gradle `SocketException: Operation not permitted` | Sandbox forbids loopback — expected. Codex only changes code; gates are re-run by the verification subagent on the host |
| Codex finished but no files changed | `--write` was missing. Write a small brief saying "apply the changes", then `driver.sh run <that-file> --resume --write` to continue the thread |
| `status` can't find a just-launched task | Wrong cwd — return to the project directory the task was launched from |
| Notification says exit 0 but the output tail is a progress line (e.g. "Applying file changes") | False completion — the companion exited before Codex finished (premature turn-completion inference; NOT a Bash 10-min cap, and nohup does not fix it). Verify with `status --json`, then continue the thread via `run <new-brief> --resume --write` |
| Background shell shows "No output available" while the task runs | The launch was piped through `tail`/`head`, which buffer until EOF — the task is fine. Watch the brief's `.result.md` instead (appended in real time); launch bare next time |
