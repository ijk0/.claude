---
name: fable-gpt
description: Fable-GPT orchestration workflow — the main agent (Opus 5.5) only dispatches and adjudicates; Codex (gpt-6-astra) does the work — implementation/debugging/refactoring at xhigh, read-only exploration and audits, cold-read reviews at xhigh (important reviews: astra max + a Sonnet-max reviewer subagent); Claude subagents are otherwise the exception; host gates run from the main session; a Monitor keepalive pings after 290s without a request so the 5-minute prompt cache survives Codex waits. Use when orchestrating multi-agent work; when delegating implementation, debugging, refactoring, or test-fixing to Codex; when launching, resuming, monitoring, or cancelling a codex-companion task; or when the user says use Codex / run a Codex task / Fable-GPT. Also covers program-scale campaigns (scope manifest, risk-ordered waves, wave gates, inventory approval for irreversible steps, docs closeout).
---

# Fable-GPT: the main session orchestrates, Codex executes

(The name is historical: the orchestrator is now **Opus 5.5** as the main
session model — switched from Fable 5 on 2026-10-27.)

Division of labor (user ruling 2026-10-29: few subagents, hand the work to
Codex): **the main agent (Opus 5.5) only dispatches and decides** — planning,
architecture calls, task decomposition, dispatching, adjudicating from
summaries. **Codex (gpt-6-astra) does all the work its sandbox allows** —
implementation, debugging, test fixing, multi-file refactors, and the
read-only work too: repo exploration, audits, design and cold-read reviews.
**Claude subagents are the exception** (Orchestration rules): the Sonnet-max
reviewer as the cross-family leg of important reviews, and host-side work
that needs multi-step judgment. Host build/test gates run from the main
session as a background shell with bounded output. Keep Codex tasks focused,
specific, one thing at a time; never trust its output blindly — but the
checking is dispatched too, never done by reading diffs in the main context.
Heavy tasks default to implementation followed by a **parallel check pair**
(Codex cold-read review + host gate; important reviews add the reviewer
subagent), all returned to the main agent for one adjudication pass (see
below). While Codex runs, a **keepalive** stops the
main session's 5-minute prompt cache from expiring (see Monitoring).

Driver: `~/.claude/skills/fable-gpt/driver.sh` (wraps codex-companion.mjs,
resolves the active plugin version automatically, takes the task brief from a
file to avoid shell-quoting issues). Subcommands: `run` (implement),
`review` (generate + launch the adversarial review brief), `watch`
(re-attach), `keepalive` (prompt-cache pings for the Monitor tool), plus
companion passthrough (`status`, `result`, `cancel`, …).

## Codex model + effort tiers

`--effort` accepts `none|minimal|low|medium|high|xhigh|max|ultra`. GPT-5.6
treats effort as a **ceiling, not a floor** — easy work doesn't overspend at a
high setting, so err upward. Tiering:

| Situation | Model + effort |
|---|---|
| Implementation / refactor / test fixing / hard debugging (driver default) | `gpt-6-astra` + `xhigh` (fallback: `gpt-5.6-sol` + `xhigh`) |
| Read-only exploration, locating, audits, spec extraction | `gpt-6-astra` + `xhigh`, no `--write` |
| Routine cold-read review (fix rounds, changes with no concurrency, safety or shared-authority surface) | `gpt-6-astra` + `xhigh` (`driver.sh review` default) |
| **Important review**: design review of a brief (flow step 0), implementation waves touching concurrency / lifecycle / safety / shared authority, the stop-rule re-review, acceptance before an irreversible step | `gpt-6-astra` + **`max`** (`--effort max`); fallback: astra `xhigh`, then `gpt-5.6-sol` + `max`. Diff reviews other than fix rounds also get the Sonnet-max reviewer subagent (flow step 2) |
| `ultra` | **never in this workflow** — it spawns Codex-internal parallel subagents, duplicating what Fable-GPT already does at the orchestration layer; one dispatch = one focused task |

**gpt-6-astra is the model for everything Codex does; effort separates routine
work (`xhigh`) from important reviews (`max`, user ruling 2026-10-29).**
Adopted for reviews 2026-09-07 (on its release), implementation 2026-10-27.
`driver.sh run` defaults to `--model gpt-6-astra --effort xhigh`, and
`driver.sh review` passes the same pair unless given `--effort max`.
**astra at `max` is not field-checked yet** — the first important review is
the check: if it fails immediately (HTTP 400 / effort rejected), rerun at
`xhigh` and record the outcome in this section. If the relay rejects
`gpt-6-astra` itself, fall back to `gpt-5.6-sol`: `xhigh` for implementation,
`max` (then `xhigh`) for reviews.

The implementer and the Codex cold reader are the same model. A fresh thread
breaks the implementer's reasoning chain and `max` deepens the read where it
matters, but only a different model family catches the blind spots astra
shares with itself. So important diff reviews add one cross-family leg: the
reviewer subagent, pinned to **Sonnet 5.5 at `max` effort** in its
frontmatter (user ruling 2026-10-29). Routine reviews have no cross-family
leg.

Status (field-checked 2026-08-10 with gpt-5.6-sol; allowlist re-checked
2026-10-29): **`max` passes the companion** — the allowlist patch is applied
and the relay accepted it for sol. Two things can regress:
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
   (timestamp first so briefs sort chronologically per project), following
   the brief template below. Notes:
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
     input / 1.5× output *for the entire request* (check astra's long-context
     pricing before assuming it is exempt). The large window is for Codex's
     own exploration, not for stuffing repo context into the brief.

2. **cd into the target project directory** (the companion tracks tasks by cwd,
   see Gotchas), then launch with `Bash run_in_background`, using the literal
   path:

```bash
cd <project-dir> && ~/.claude/skills/fable-gpt/driver.sh run ~/.claude/fable-gpt/briefs/<project-dir-name>/<timestamp>-<task>.md --write
```

   Defaults: `--fresh --model gpt-6-astra --effort xhigh` (override with the
   same flags; model + effort tiers above). **Pass `--write` explicitly
   whenever Codex must modify files** — the driver never adds it implicitly.
   `--foreground` restores the old in-process mode (no detached worker) if
   ever needed.

   **Launch the command bare — never append a pipe** (`| tail -c 4000`,
   `| head`, `| grep` …): `tail`/`head` buffer until EOF, so the background
   shell shows "No output available" for the entire run (looks dead while
   Codex works fine) and the harness record gets truncated. Output size is a
   non-issue anyway: the full log is streamed to the brief's `.result.md`.

3. What the driver does: enqueues the task as a **detached companion worker**,
   prints `[driver] job-id: <id>`, then watches the job — streaming the
   companion log into `<brief minus .md>.result.md` in real time (append
   mode, one `===== fable-gpt run <timestamp> =====` header per run), and on
   completion writes **only the final assistant reply** to
   `<brief minus .md>.reply.md` (overwritten per run; removed at run start,
   so its presence means "this run finished with a reply") and prints that
   reply as the **last stdout lines**. **Read `.reply.md` for the
   conclusion** — the `.result.md` is the audit log (progress lines, every
   command Codex ran); it is grep material, never main-context reading.
   Completion notifies automatically — no polling. Exit codes: 0 = clean
   completion with a final reply; 1 = job failed; 2 = watcher lost the job
   (worker may still run — re-attach); **3 = suspected false completion**
   (job marked completed but no final reply captured — the driver auto-runs
   the verification that used to be manual; continue the thread with
   `--resume`). The `.result.md`/`.reply.md` copies are the durable record —
   the harness's own background-output file is session-scoped and eventually
   cleaned up.

4. **Arm the prompt-cache keepalive** as the last tool call of the launch
   turn (Monitoring → Prompt-cache keepalive).

### Brief template (every implementation brief, in this order)

1. **Title + repo line + location statement.** After the repo/worktree line,
   verbatim: *"This brief and every brief or manifest it references live
   outside the repo at absolute paths under
   `/Users/<user>/.claude/fable-gpt/briefs/<project-dir-name>/`; read them
   by absolute path — the worktree contains none of them."* (A resume was
   wasted when Codex searched the worktree for a referenced brief.)
2. **Read first**: spec sections, seams to reuse (read-only, named), test-fake
   precedents, prior-round briefs by absolute path.
3. **Deliver**: files, type/function names, test class names with the cases
   each must contain.
4. **Contract table — required for lifecycle, concurrency or shared-authority
   work** (state machines, sessions, callbacks, anything with a lock or an
   executor). One row per operation that mutates shared state (start,
   submit, stop, tick, config or generation change, detach, every callback)
   and one row per event that invalidates an action already in flight
   (timeout, restart, stale data, reordered delivery, blocked I/O, a late
   callback from a previous session). Columns:
   `# | operation or event | shared state it mutates | in-flight actions it invalidates | ordering or lock rule | named test`.
   A row without a test is unfinished spec. The table is complete before
   implementation and is what the design review reads (flow step 0); a
   review finding that adds a row triggers a re-sweep of the whole table
   (stop rule, flow step 3), never a one-row patch. (Wave 8 of the DJI-M4T
   program needed six spec revisions because this table was assembled one
   review finding at a time.)
5. **Constraints**: allowed imports, protected files, no new dependencies,
   "the build tool cannot run in the sandbox — say so".
6. **Fixture rule — whenever fixtures or expected outputs exist**, verbatim:
   *"Fixtures and their expected outputs run under production default
   configuration. Expected outputs are derived by hand from the spec or from
   an independent reference computation, and the final reply marks each one
   hand-derived or regenerated; an expected file regenerated from the
   implementation under test is a snapshot, not evidence. Thresholds,
   tolerances and policy constants keep their production values — when a
   fixture and the implementation disagree, report the disagreement instead
   of tuning either side."* (W5: a threshold was tightened to make fixtures
   match and hid wrong piece identities.)
7. **Final reply**: what to list — changed files with line references,
   judgment calls, test names with counts, fixtures regenerated and why.
8. **Self-check clause**, verbatim, immediately before the escalation clause:
   *"Before reporting completion, run this self-check in the sandbox and
   report each item's outcome with the command used: (1) compile every
   changed source against the real project seams with the direct toolchain
   (Kotlin: `kotlinc` under the Android Studio JBR with the project's cached
   jars on the classpath; other languages: the compiler or type-checker
   itself) — stubs of project types are not a compile; (2) run the existing
   test suite of every touched package directly with the same toolchain
   (JUnit via `java -cp`, pytest, …) — the build tool cannot run here and
   the direct run is its required substitute, not an option; (3) enumerate
   every caller of every changed signature and state per caller: updated or
   unaffected; (4) for lifecycle or concurrency code, probe each of: timeout,
   restart after stop, stale data, reordered events, blocked I/O, a late
   callback from a previous session — one named test or a reported reason
   per probe. An item that could not run is reported as not run, with the
   reason."*
9. **Escalation clause**, verbatim, last: *"If reality contradicts this
   brief — a file doesn't exist, a dependency the brief assumes is absent,
   the described approach can't work — stop and report the contradiction. Do
   not improvise a different approach and do not expand scope. The brief (and
   the manifest, if one exists) is authoritative; corrections come from the
   orchestrator."* Without it, Codex with a 1M window and `--write`
   improvises a redesign rather than stopping — a known source of multi-round
   fix churn.

Fix-round briefs use the same skeleton: findings (each with the reviewer's
reproduction, the required behaviour, and the test to add) replace block 3,
and the contract table is re-attached whenever a finding touched it.

Read-only briefs (exploration, audits, design reviews — the work that used to
go to Claude subagents) are shorter: title + location statement, the
question, the scope (paths; specs and manifests by absolute path), the output
contract — conclusions with file:line evidence, by severity for reviews, no
file or diff dumps, a length cap — and, verbatim, *"Read-only: do not modify
any files."* Launch them without `--write`; any number may run concurrently.

## Monitoring and management (always from the same project directory)

Completion notifies automatically — **no routine polling**. Use these when you
suspect a hang, need the result, or want to clean up:

```bash
~/.claude/skills/fable-gpt/driver.sh status --json            # progress; check the pid is alive — broker state can be false
~/.claude/skills/fable-gpt/driver.sh status <job-id> --json   # one job by id — reliable cross-session (progressPreview = cheapest liveness check)
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

### Prompt-cache keepalive while waiting

The main session's prompt cache has a **5-minute TTL**, refreshed by every
request that reads it. A Codex run leaves the session idle for 15–60 minutes;
with no request in between, the completion turn re-reads the whole context
uncached — a cache write at 1.25× base input price instead of a 0.1× read,
plus a slow cold prefill on a large context. A ping turn once the session
has made **no request for 290 s (4 min 50 s)** keeps it warm at about 0.1×
per ping; a session that is active anyway is never pinged.

**Mechanism: the Monitor tool running `driver.sh keepalive`.** Every stdout
line is one event, and each event wakes the idle session for one turn — no
re-arming tool call, so a ping is a single cache-reading request. Monitor and
TaskStop are deferred tools: load them with ToolSearch
`select:Monitor,TaskStop` first. Arm it as the last tool call of the turn
that launched the run(s):

```
Monitor  description: "fable-gpt cache keepalive"   timeout_ms: 1800000
         command: ~/.claude/skills/fable-gpt/driver.sh keepalive ~/.claude/fable-gpt/briefs/<project-dir-name>/<timestamp>-<task>.md [<more briefs>]
```

- **Activity-aware.** The script tails this session's transcript
  (`<config dir>/projects/*/$CLAUDE_CODE_SESSION_ID.jsonl`). Claude Code
  logs every main-session request there as an `api-request` entry stamped
  at request start, which is when the cache is read and its TTL restarts.
  A ping fires only once no request has started for 290 s, within about
  0.1 s of that mark (10 s margin). User turns, tool loops and notifications
  all push the next ping back. Without the transcript (variable unset, or a
  Claude Code version that doesn't log `api-request`) it degrades to a
  fixed 290 s schedule from the arm time and says so in its first line.
- With briefs listed, the keepalive reads each brief's `.result.md` run
  markers (file-only — no companion call, works from any cwd) and exits with
  one line within 5 s of every listed run finishing; the run's own
  background shell delivers the result notification. With no briefs (e.g. a
  long host gate) it runs until its budget or window ends — TaskStop it
  when the awaited notification arrives.
- **One keepalive per session.** When another run launches mid-wait,
  TaskStop the current monitor and arm a new one listing every in-flight
  brief.

**Ping-turn protocol.** On a `[keepalive] ping` event: no tool calls, no
reads, no status checks — end the turn with at most one short line (e.g.
`keepalive 3/11`). The ping exists only to send one request; work in it
costs output tokens and context growth. Ignore the `watched runs finished`
and `idle budget spent` events — the completion notification carries the
result. The one exception is the arm-end line (below), which asks for a
re-arm.

**Cap (ski rental).** Each ping costs about 0.1 × C (C = the cost of the
context as uncached input); letting the cache lapse costs about 1.15 × C once
(1.25 write − 0.1 read). Break-even is about 11 pings ≈ 53 min: ping up to
that, then stop — worst case about twice the better choice in hindsight, with
no need to predict the run length. The script enforces it: `--pings`
(default 11) caps **consecutive** idle pings, and any request that isn't a
ping turn's own resets the count. Each arm lasts at most 29 min
(`--window 1740`, inside Monitor's 30-minute cap); it ends with a line
naming the budget left (`… re-arm with --pings N`) — if runs are still in
flight, re-arm with exactly that. After `idle budget spent` the cache is
left to lapse, so don't re-arm. Skip the keepalive entirely when the wait is
known to exceed an hour (overnight wave, user away) or when the wait is on
the user rather than on a job.

Fallback if the Monitor tool is unavailable: `driver.sh keepalive --pings 1
<briefs>` via `Bash run_in_background` exits at its first ping (its line
then reads `idle budget spent`). Re-arm it once per wake, counting pings
yourself up to 11. That costs two requests per ping instead of one.

### After an interruption (compaction, /clear, dead shell)

The worker is detached; only the watcher and the notification are lost. From
the project directory the task was launched in:

1. Job id: the last `[driver] job-id:` line of `<brief>.result.md`
   (`grep '^\[driver\] job-id:' <brief>.result.md | tail -1`).
2. `driver.sh status <job-id> --json` → running / completed / failed.
3. Running → `driver.sh watch <brief.md> <job-id>` via `Bash
   run_in_background` (streams new bytes only, writes `.reply.md` at the
   end, notifies on completion). Completed → Read `<brief>.reply.md`; if it
   is missing, the same `watch` command renders it from the stored result
   without waiting. Failed → `driver.sh result --json` for the error, then
   relaunch or `--resume`.

`task-resume-candidate` names the **latest thread for the cwd** — after an
intervening read-only task (a review) that is the review thread; check it
before `--resume`, or dispatch a fresh self-contained fix brief instead.

## Standard heavy-task flow: design review → implement → parallel checks → adjudicate

Heavy / multi-file / high-risk tasks default to this; trivial tasks may skip
the checks and go straight to adjudication.

0. **Design review (concurrency, lifecycle or shared-authority modules
   only)**: before any code exists, dispatch astra read-only on the brief
   itself — `run <design-review-brief> --fresh --model gpt-6-astra --effort
   max`, no `--write` (an important review — tier table) — with the brief
   and spec sections by absolute path, asked to find races, missing
   contract-table rows, and contradictory rules in the contract, output by
   severity. Fold findings into the brief, then implement. About 15 minutes
   at `xhigh`, longer at `max`; one such review would have replaced seven fix
   rounds plus seven re-reviews in DJI-M4T Wave 8.
1. **Implementation**: dispatch per the launch path above (`--write`, effort
   per the tier table). On completion, Read `.reply.md` for the "original
   conclusion".
2. **Checks — dispatch in parallel** (read-only and independent): the Codex
   cold read and the host gate always; the reviewer subagent as well when
   this is an important review (tier table):
   - **Codex cold-read review** via the driver, from the main session with
     `Bash run_in_background` (add `--effort max` for an important review):

```bash
cd <project-dir> && ~/.claude/skills/fable-gpt/driver.sh review ~/.claude/fable-gpt/briefs/<project-dir-name>/<timestamp>-<task>.md [--effort max] [--scope '<diff scope>'] [--extra-file <blocker-criteria-and-probes.md>]
```

     `review` writes `<task>-review.md` next to the brief (suffix `-r2`,
     `-r3` … if it exists) from the implementation brief and its
     `.reply.md` — the tested adversarial header (reject-seeking; issue list
     by severity or an explicit "no blockers found"; TRUE issues reachable
     in realistic usage only, no speculative edge cases or over-defensive
     hardening; evidence against the REAL seams, never stubs; re-run every
     reproduction named in the brief; regenerated expected outputs are not
     evidence), the location statement, the full original brief, the
     implementer's conclusion, and the optional extra-checks section — then
     launches it **`--fresh --model gpt-6-astra --effort xhigh` (or the
     `--effort` given), never `--write`** (conclusions only; fixes are
     dispatched separately after adjudication). `--scope` defaults to
     uncommitted working-tree changes (`git diff` / untracked files); give
     an explicit file list when the tree holds more than this task.
     `--extra-file` carries the wave's blocker criteria and the
     reproductions to re-run — the Write tool writes it to the briefs
     directory like any brief. `--no-launch` only writes the brief;
     `--reply <file>` names the reply for runs older than the `.reply.md`
     mechanism; `--model`/`--effort` select `max` or a fallback per the tier
     section. Arm one keepalive listing the review brief. **Never `--resume` the implementation thread to
     self-review** — with its own reasoning context intact, its wrong
     premises hold during self-review too; that catches slips, not "the
     whole approach is wrong". A cold read does.
   - **Host gate** from the main session with `Bash run_in_background`: the
     full build/test output goes to a log in the briefs directory, and only
     the exit code plus a grep'd summary come back (gate rules under
     Program-scale work):

```bash
cd <project-dir> && touch ~/.claude/fable-gpt/briefs/<project-dir-name>/<timestamp>-gate.start && <gate command> > ~/.claude/fable-gpt/briefs/<project-dir-name>/<timestamp>-gate.log 2>&1; echo "gate exit=$?"; grep -E '<failure + summary pattern, e.g. FAILED|BUILD (SUCCESSFUL|FAILED)|tests completed>' ~/.claude/fable-gpt/briefs/<project-dir-name>/<timestamp>-gate.log | tail -20
```

     Then the freshness check, also bounded: `find <test-report-dir> -name
     'TEST-*.xml' -newer <…>-gate.start | wc -l` must equal the expected
     report count. Read the log only through `grep … | tail`, never whole.
     A failure that needs real triage on the host is one of the subagent
     exceptions (Orchestration rules).
   - **Reviewer subagent — important reviews only** (implementation waves
     touching concurrency / lifecycle / safety / shared authority, the
     stop-rule re-review, acceptance before an irreversible step; not fix
     rounds, not the step-0 design review): `subagent_type: reviewer`, **no
     `model` or `effort` param** (frontmatter pins Sonnet 5.5 at `max`). Give
     it the task-brief path, the `.reply.md` path and the diff scope (e.g.
     `git diff`).

   *Sequential short-circuit variant*: when the implementation already looks
   shaky (Codex's own summary hedges, the build obviously fails), run the
   Codex cold read alone first and hold the other legs — saves gate and
   reviewer spend on a doomed diff. Parallel is the default because the
   wall-clock win (the Codex review is usually the longest leg) normally
   beats the occasional wasted check.

   (The companion's built-in `review`/`adversarial-review` subcommands accept
   `--model` but **no `--effort`**, and upstream `codex /review` runs at
   hardcoded LOW effort — both reasons the task path is the only adequate
   review vehicle.)

3. **Adjudication**: one pass over all verdicts — any blocker →
   dispatch a Codex fix task (may `--resume` the implementation thread, now
   with `--write`; verify the resume candidate first), then re-check; all
   green = done. Codex's review verdict is decision input, not a pass stamp —
   "never trust Codex blindly" applies to its self-review too. Filter
   reviewer findings for practicality: an issue only counts (at any severity)
   if its triggering input/state occurs in realistic use — drop extreme-edge-
   case / over-defensive findings rather than dispatching fixes for them.
   - **Re-review is tiered by what the fix diff touches.** Trivial rounds
     (renames, test-only changes, a guard added exactly where the reviewer
     pointed): the orchestrator checks the fix points directly in the main
     session with bounded commands (user instruction 2026-09-02), plus the
     gate. Other fix rounds: `driver.sh review` on the fix brief (astra
     `xhigh`) plus the gate. Any touch of concurrency, safety or shared
     authority: the same at `--effort max`. Implementation waves always get
     the full step-2 checks (with the reviewer when important).
   - **Stop rule.** A second rejection of the same kind on the same
     subsystem (a second race in the same module, a second missing lifecycle
     path in the same state machine) ends point fixes. The next dispatch is
     a **full-enumeration task**: enumerate every operation and event of
     that kind in the subsystem into the contract table, fix every row in
     one pass with one named test per row, then one astra re-review at
     `--effort max`. Log
     `kind × subsystem` for every rejection in the manifest rulings log so
     the second hit is visible. (DJI-M4T Wave 8, 2026-09-08: seven rounds
     patching one reported path each.)

## Program-scale work (more than ~3 dispatches): manifest, waves, closeout

The flow above is the task loop. When work grows into a campaign — many
dispatches, multiple days, risky or irreversible steps — add the program
layer:

1. **Audit first; freeze scope in a manifest.** Fan out parallel read-only
   Codex audit tasks (one read-only brief per slice, no `--write`; one
   keepalive listing all of them) over the affected slices, then synthesize
   one manifest file at
   `~/.claude/fable-gpt/briefs/<project-dir-name>/<date>-MANIFEST.md`. It
   assigns every unit of code a verdict and a wave number. Every subsequent
   brief cites it as authoritative — no worker re-litigates scope. Anything
   the audits were silent on is marked UNKNOWN: workers stop and report it
   (the standing escalation clause), the orchestrator gets a user ruling
   where needed, and the ruling is written back into the manifest so later
   dispatches inherit it. The manifest is also the durable answer to context
   rot — it survives compactions and session clears where conversation
   context and ad-hoc handoff files do not.

2. **Rulings rewrite, never append.** A ruling that changes a spec or brief
   section rewrites that section in place so it reads as written once; a
   `## Changelog` at the bottom of the document holds one dated line per
   revision (what changed, which review round). Normative bullets stay
   under about 500 characters — split before one grows. (DJI-M4T stage 3
   spec section 4 accumulated six "revised again" sentences and a
   1500-character authority bullet that neither Codex nor astra read
   reliably.) The manifest's rulings log keeps its one-line-per-ruling
   history as is.

3. **Order waves by risk, irreversible last.** Sequence safest → most
   irreversible: verified-no-dependents changes first, shared-infrastructure
   surgery and bulk edits in the middle, production data changes then schema
   migrations last — and only after every code path touching the affected
   state is verifiably updated. Before each risky wave, create a
   restore-point git tag.

4. **Gate between waves, not just per task.** No wave starts until the
   previous one passes a full regression gate (the host gate, scoped to the
   whole program's test surface, not one task's diff). A failed gate spawns
   a scoped Codex fix dispatch, then the gate re-runs. Gate rules: **one
   build-tool client per worktree at a time** — only the host gate runs
   Gradle (or the project's equivalent); Codex reviews and any reviewer
   subagent are static (in-memory compile and direct test runs
   allowed, the build tool never — a concurrent targeted Gradle run
   clobbered a gate's XML reports on 2026-09-07); the **pass criterion is
   every expected test report present, counts matching, and report mtimes
   inside the gate's own time window** — a report left over from an earlier
   run is a fail.

5. **Fixture baseline at acceptance.** When a wave is accepted, commit its
   fixtures and expected files immediately, or record `shasum -a 256` of
   each in the manifest's wave row. Untracked fixtures have no history, so a
   later review cannot tell a hand-derived expected file from one
   regenerated to match a tuned threshold.

6. **Irreversible steps: propose the inventory, approve the list, execute
   exactly the list.** For production data changes, schema migrations, bulk
   deletions: dispatch task 1 WITHOUT `--write` to emit the exact inventory
   (rows, files, migrations); surface that literal list to the user for
   approval; then dispatch task 2 with the approved list pasted into its
   brief, executing only that inventory and re-verifying counts afterwards.
   The user approves a list, never an intention.

7. **Closeout: teach the system what changed.** The program's mandatory final
   phase updates the repo's agent-facing docs — run
   `/claude-md-management:revise-claude-md` for CLAUDE.md and (if installed)
   `/ce-compound` to capture durable learnings — so future sessions start
   from the new architecture, not stale instructions.

## Orchestration rules: the main agent dispatches, never executes

The main agent's context is the scarcest resource — flooded with execution
detail (large diffs, build logs, whole files), its decomposition and
adjudication quality degrades fast. **The main agent only: decomposes,
dispatches, reads returned summaries, decides next. Everything concrete sinks
down:**

- **Heavy implementation / debugging / refactoring** → Codex. The only
  "hands-on" exceptions are lightweight dispatch actions — writing task briefs,
  launching the companion, checking status, reading `.reply.md`, arming the
  keepalive — single small tool calls that don't grow context; **launching
  must happen in the main session via `Bash run_in_background`** (see the
  launch section — a subagent launch loses the watcher and its completion
  notification).
- **Repo exploration / locating / audits** → a read-only Codex task (read-only
  brief, no `--write`); conclusions + file:line only. A lookup whose target is
  already known (one file, one symbol) needs no dispatch: the main session
  runs bounded commands (`grep -n … | head`, `sed -n` ranges).
- **Codex result review** → the Codex cold read in the check pair above,
  tiered for fix rounds (`xhigh` routine, `max` important). The main agent
  decides from its verdict: accept, dispatch a Codex fix task, or change
  approach.
- **Build/test gates** → the host gate, run by the main session as a
  background shell with bounded output (recipe in flow step 2). Codex saying
  "verified" does not count — its sandbox forbids loopback sockets, so the
  Gradle daemon cannot start (`SocketException: Operation not permitted`) and
  such gates physically cannot run there; the brief's self-check clause makes
  the direct toolchain (kotlinc/JBR + `java -cp` JUnit, etc.) the required
  in-sandbox substitute, and the real gate runs on the host.
- **Claude subagents: by exception only, one at a time** (user ruling
  2026-10-29 — anything that looks like subagent work is a Codex read-only
  task first). Two exceptions:
  1. The cross-family leg of an important review (flow step 2) — and, ad
     hoc, a second opinion when astra and the implementer disagree on a
     blocker: `subagent_type: reviewer`, a custom agent at
     `~/.claude/agents/reviewer.md` (frontmatter `model: sonnet` + `effort:
     max` → Sonnet 5.5 at max; no Write/Edit tools so physically read-only;
     **do not pass a model or effort parameter**).
  2. Host-side work that needs multi-step judgment the sandbox cannot give:
     device acceptance, triaging a host gate failure whose grep'd summary
     doesn't explain it (general-purpose + `model: sonnet`).

  Except for reviewer, **always pass an explicit model alias** in Agent
  calls, and require **conclusions + key evidence only, no full dumps**.
- Small, clearly-bounded asks may go through `/codex:rescue`, but **foreground
  (`--wait`) only** — the rescue subagent prefers backgrounding "complex"
  tasks, which loses the completion notification. Heavy/long tasks always use
  this skill's main-session direct launch.
- Multiple concurrent Codex tasks: separate brief files and separate background
  shells (user-tested: 5–7 concurrent on a Codex 20x plan without hitting
  limits) — but **at most one `--write` task per repo at a time**. Concurrent
  read-only tasks (reviews, audits, exploration) are unrestricted. Reason: all
  write tasks share one working tree, and both the adversarial-review template
  ("uncommitted working-tree changes") and the gate re-run assume that tree
  holds exactly one task's changes — two concurrent writers produce a blended
  diff the reviewer misattributes and a half-edited tree the gate builds.
  Disjoint file boundaries alone don't fix the gate. If a program genuinely
  needs parallel writes: one git worktree per write task, plus an explicit
  disjoint file boundary restated in every brief (never assumed), and review
  briefs scoped to that task's file list (`driver.sh review --scope`).
  Worktrees change the flow: the companion is cwd-keyed (launch and query
  from each worktree), and merging back needs commits — the
  review-the-uncommitted-tree default no longer applies as-is.
- When context rots (~4 compactions), preserve context then clear the
  conversation — use /handoff if installed, otherwise write a handoff file to
  the briefs directory with the Write tool. At program scale, the manifest
  (see Program-scale work) is the durable, structured version of this.

## Model tiers (task tier ↔ model tier)

| Task | Dispatch | Model |
|---|---|---|
| Orchestration / adjudication / host gates / keepalive | main session itself | Opus 5.5 (session model) |
| Implementation / refactor / test fixing | Codex `run --write` (= `--model gpt-6-astra --effort xhigh`) | gpt-6-astra xhigh |
| Exploration / locating / audits / spec extraction | Codex `run`, read-only brief, no `--write` | gpt-6-astra xhigh |
| Routine cold-read review | `driver.sh review <impl-brief>` (= `--fresh --model gpt-6-astra --effort xhigh`, no `--write`) | gpt-6-astra xhigh |
| Important review (flow step 0 design review, concurrency / safety / shared-authority waves, stop-rule re-review, pre-irreversible acceptance) | `driver.sh review <impl-brief> --effort max`; design review: `run <brief> --fresh --effort max`, no `--write` | gpt-6-astra max |
| Cross-family leg of important diff reviews (not fix rounds or design review) | `subagent_type: reviewer`, no model or effort param | Sonnet 5.5 at `max` (both pinned in frontmatter) |
| Exception: host-side judgment (device acceptance, gate-failure triage) | general-purpose + `model: sonnet` | sonnet = Sonnet 5.5 |

**Context windows**: the whole Claude 5 family (Opus 5.5, Sonnet 5.5, …) runs
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
  (tested). Pinning an exact version requires a custom agent's frontmatter;
  reviewer pins its model alias and `effort` there instead of per call. Newly created agent definitions are **not
  discovered immediately** — the registry refreshed only later in the
  authoring session (and reliably at the next session).
- **Never set `CLAUDE_CODE_SUBAGENT_MODEL`**: it is the highest-priority source
  in subagent model resolution and overrides explicit model params and
  frontmatter (re-confirmed in current docs) — setting it silently disables
  the whole tiering scheme.
- **The default model without an explicit param is unreliable**: docs say
  inherit-from-main (i.e. Opus 5.5), but a real session landed on a different
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
  completion** (and no `.reply.md`); treat the thread as unfinished and
  continue it with `run <new-brief> --resume --write`. The detached worker
  also means the historical ~5–8 min host-process deaths no longer kill
  Codex — if the watcher dies, `driver.sh watch` re-attaches.
- **Codex's sandbox cannot create directories under the project cwd** (mkdtemp
  in tests, output dirs), and `/tmp` is read-only there — its "gate passed"
  for such steps is unreliable; the host gate is the only trustworthy run.
- **`$CLAUDE_JOB_DIR` is not guaranteed to exist** (it was unset in the session
  that authored this skill); keep task briefs at unique literal paths under
  `~/.claude/fable-gpt/briefs/<project-dir-name>/` — never /tmp, which macOS
  sweeps periodically (breaks `--resume` briefs and the audit trail).
- **gpt-5.4 retired from ChatGPT-auth Codex on 2026-08-31** — never pass it as
  `--model` in a dispatch (`~/.codex/config.toml` was already migrated to 5.5
  on 2026-08-10).

## Troubleshooting

| Symptom | Action |
|---|---|
| Task stuck at "Turn started", broker shows running | Check the `pid` in `status --json`. Watcher dead but worker alive → `driver.sh watch <brief.md>`. Worker dead → `driver.sh cancel`, then relaunch via the main-session direct path |
| Session interrupted mid-task (compaction, /clear, dead shell) | Recovery recipe under Monitoring: job id from `.result.md` → `status <job-id> --json` → `watch` (running) or Read `.reply.md` (completed) |
| Driver exit 3 / "suspected FALSE COMPLETION" | The companion exited before Codex finished (premature turn-completion inference). Verify with `status --json`, then continue the thread via `run <new-brief> --resume --write` |
| `driver.sh review`: "implementer reply not found" | The implementation ran before the `.reply.md` mechanism, or the run failed — pass `--reply <file>` holding the final assistant message (the last `Assistant message` block of `.result.md`) |
| Second rejection of the same kind on the same subsystem | Stop point fixes — dispatch the full-enumeration task (flow step 3, stop rule) |
| `--effort max` refused by the driver | Companion allowlist unpatched — run the printed `sed` command once (re-run after plugin updates), or use `xhigh` |
| Task fails immediately at `max` effort (HTTP 400 from backend) | The relay/backend doesn't support `max` for that model — fall back to `xhigh` (astra) and record it in the tier section; for an important review, `--model gpt-5.6-sol --effort max` is the next option |
| Task fails immediately with `--model gpt-6-astra` | The relay/backend doesn't serve astra — fall back to gpt-5.6-sol: `driver.sh run ... --model gpt-5.6-sol --effort xhigh` for implementation, `driver.sh review ... --model gpt-5.6-sol --effort max` (then `xhigh`) for reviews |
| Codex hits Gradle `SocketException: Operation not permitted` | Sandbox forbids loopback — expected. Codex compiles and tests with the direct toolchain (self-check clause); the host gate (main-session background shell) runs the build tool |
| Codex finished but no files changed | `--write` was missing. Write a small brief saying "apply the changes", then `driver.sh run <that-file> --resume --write` to continue the thread |
| `status` can't find a just-launched task | Wrong cwd — return to the project directory the task was launched from |
| Background shell shows "No output available" while the task runs | The launch was piped through `tail`/`head`, which buffer until EOF — the task is fine. Watch the brief's `.result.md` instead (streamed in real time); launch bare next time |
| Keepalive keeps pinging after the run finished | The watcher died without writing its `finished` marker (dead shell), so the `.result.md` still reads as in flight — TaskStop the monitor, then the interruption recipe. Runs launched with `--foreground` write no markers at all; don't list their briefs |
| No `[keepalive] ping` turns in the transcript across an idle wait (monitor still armed) | Monitor events are not waking the idle session on this Claude Code version — switch to the `Bash run_in_background` fallback (`keepalive --pings 1`, re-armed per wake) |
