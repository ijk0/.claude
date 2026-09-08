---
name: fable-gpt
description: Fable-GPT orchestration workflow — the main agent (Fable) only dispatches and adjudicates; heavy implementation/debugging/refactoring goes to Codex (gpt-5.6-sol high by default); Codex cold-read reviews run on gpt-6-astra at xhigh; exploration/review/gate re-runs go to tiered Claude subagents. Use when orchestrating multi-agent work; when delegating implementation, debugging, refactoring, or test-fixing to Codex; when launching, resuming, monitoring, or cancelling a codex-companion task; or when the user says use Codex / run a Codex task / Fable-GPT. Also covers program-scale campaigns (scope manifest, risk-ordered waves, wave gates, inventory approval for irreversible steps, docs closeout).
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
file to avoid shell-quoting issues). Subcommands: `run` (implement),
`review` (generate + launch the adversarial review brief), `watch`
(re-attach), plus companion passthrough (`status`, `result`, `cancel`, …).

## Codex model + effort tiers

`--effort` accepts `none|minimal|low|medium|high|xhigh|max|ultra`. GPT-5.6
treats effort as a **ceiling, not a floor** — easy work doesn't overspend at a
high setting, so err upward. Tiering:

| Situation | Model + effort |
|---|---|
| Routine implementation / refactor / test fixing (driver default) | `gpt-5.6-sol` + `high` |
| Hard debugging, gnarly multi-file work | `gpt-5.6-sol` + `xhigh` |
| Cold-read adversarial review, design review of a brief (single-chain judgment) | `gpt-6-astra` + `xhigh` (fallback: `gpt-5.6-sol` + `max`/`xhigh`) |
| `ultra` | **never in this workflow** — it spawns Codex-internal parallel subagents, duplicating what Fable-GPT already does at the orchestration layer; one dispatch = one focused task |

**gpt-6-astra is the review model only** (adopted 2026-09-07, on its release):
reviews are single-chain judgment work, where the newest generation's gains
land hardest; implementation stays on `gpt-5.6-sol` (the driver default) until
astra's write-mode behavior is field-tested in this workflow. `driver.sh
review` passes `--model gpt-6-astra --effort xhigh` itself; a hand-launched
review must pass them explicitly — `run` never infers them. `xhigh` is within
the stock companion allowlist, so astra reviews do not depend on the `max`
allowlist patch below. If the relay rejects `gpt-6-astra` (task fails
immediately), fall back to the pre-astra review config: `gpt-5.6-sol` + `max`
(then `xhigh`).

Status (field-checked 2026-08-10): **`max` is confirmed working on this
setup** — the companion allowlist patch is applied and the relay accepts it.
(`max` now only matters for the gpt-5.6-sol review fallback above.)
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
     input / 1.5× output *for the entire request*. The 1M window is for
     Codex's own exploration, not for stuffing repo context into the brief.

2. **cd into the target project directory** (the companion tracks tasks by cwd,
   see Gotchas), then launch with `Bash run_in_background`, using the literal
   path:

```bash
cd <project-dir> && ~/.claude/skills/fable-gpt/driver.sh run ~/.claude/fable-gpt/briefs/<project-dir-name>/<timestamp>-<task>.md --write
```

   Defaults: `--fresh --model gpt-5.6-sol --effort high` (override with the
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
   xhigh`, no `--write` — with the brief and spec sections by absolute path,
   asked to find races, missing contract-table rows, and contradictory rules
   in the contract, output by severity. Fold findings into the brief, then
   implement. About 15 minutes; one such review would have replaced seven
   fix rounds plus seven re-reviews in DJI-M4T Wave 8.
1. **Implementation**: dispatch per the launch path above (`--write`, effort
   per the tier table). On completion, Read `.reply.md` for the "original
   conclusion".
2. **Checks — dispatch all three in parallel** (all read-only and independent;
   this collapses what used to be two serial phases into one):
   - **Codex cold-read review** via the driver, from the main session with
     `Bash run_in_background`:

```bash
cd <project-dir> && ~/.claude/skills/fable-gpt/driver.sh review ~/.claude/fable-gpt/briefs/<project-dir-name>/<timestamp>-<task>.md [--scope '<diff scope>'] [--extra-file <blocker-criteria-and-probes.md>]
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
     launches it **`--fresh --model gpt-6-astra --effort xhigh`, never
     `--write`** (conclusions only; fixes are dispatched separately after
     adjudication). `--scope` defaults to uncommitted working-tree changes
     (`git diff` / untracked files); give an explicit file list when the
     tree holds more than this task. `--extra-file` carries the wave's
     blocker criteria and the reproductions to re-run — the Write tool
     writes it to the briefs directory like any brief. `--no-launch` only
     writes the brief; `--reply <file>` names the reply for runs older than
     the `.reply.md` mechanism; `--model`/`--effort` select the fallback per
     the tier section. **Never `--resume` the implementation thread to
     self-review** — with its own reasoning context intact, its wrong
     premises hold during self-review too; that catches slips, not "the
     whole approach is wrong". A cold read does.
   - **Reviewer subagent** (`subagent_type: reviewer`): give it the task-brief
     path, the `.reply.md` path, and the diff scope (e.g. `git diff`).
   - **Gate re-run subagent**: re-runs build/test on the host, returns
     pass/fail + failure summary only (gate rules under Program-scale work).

   *Sequential short-circuit variant*: when the implementation already looks
   shaky (Codex's own summary hedges, gates are obviously broken), run the
   Codex cold read alone first and hold the other two — saves reviewer/gate
   spend on a doomed diff. Parallel is the default because the wall-clock win
   (the astra xhigh review is usually the longest leg) normally beats the
   occasional wasted check.

   (The companion's built-in `review`/`adversarial-review` subcommands accept
   `--model` but **no `--effort`**, and upstream `codex /review` runs at
   hardcoded LOW effort — both reasons the task path is the only adequate
   review vehicle.)

3. **Adjudication**: one pass over all three verdicts — any blocker →
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
     session with bounded commands (user instruction 2026-09-02) or sends a
     reviewer subagent, plus the gate. Any touch of concurrency, safety or
     shared authority: `driver.sh review` on the fix brief (astra) plus the
     gate. Implementation waves always get the full fan-out.
   - **Stop rule.** A second rejection of the same kind on the same
     subsystem (a second race in the same module, a second missing lifecycle
     path in the same state machine) ends point fixes. The next dispatch is
     a **full-enumeration task**: enumerate every operation and event of
     that kind in the subsystem into the contract table, fix every row in
     one pass with one named test per row, then one astra re-review. Log
     `kind × subsystem` for every rejection in the manifest rulings log so
     the second hit is visible. (DJI-M4T Wave 8, 2026-09-08: seven rounds
     patching one reported path each.)

## Program-scale work (more than ~3 dispatches): manifest, waves, closeout

The flow above is the task loop. When work grows into a campaign — many
dispatches, multiple days, risky or irreversible steps — add the program
layer:

1. **Audit first; freeze scope in a manifest.** Fan out parallel audit
   subagents (Explore / general-purpose + `model: sonnet` — cheap) over the
   affected slices, then synthesize one manifest file at
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
   previous one passes a full regression gate (the gate re-run subagent,
   scoped to the whole program's test surface, not one task's diff). A failed
   gate spawns a scoped Codex fix dispatch, then the gate re-runs. Gate
   rules: **one build-tool client per worktree at a time** — only the gate
   subagent runs Gradle (or the project's equivalent); reviewer subagents
   and Codex reviews are static (in-memory compile and direct test runs
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
  launching the companion, checking status, reading `.reply.md` — single
  small tool calls that don't grow context; **launching must happen in the
  main session via `Bash run_in_background`** (see the launch section — a
  subagent launch loses the watcher and its completion notification).
- **Repo exploration / locating** → Explore subagent; conclusions + file:line
  only.
- **Codex result review** → the parallel check fan-out above, tiered for fix
  rounds. The reviewer subagent is a custom agent at
  `~/.claude/agents/reviewer.md` (frontmatter `model: opus` → Opus 5, native
  1M context; no Write/Edit tools so physically read-only; **do not pass a
  model parameter**). It returns a verdict (pass / issue list); the main
  agent decides: accept, dispatch a Codex fix task, or change approach.
- **Model tiering: fable orchestrates only**; subagents get models by task
  tier (table below); except for reviewer, **always pass an explicit model
  alias** in Agent calls.
- **Build/test gates** → a verification subagent re-runs them on the host and
  returns pass/fail + a failure summary only. Codex saying "verified" does not
  count — its sandbox forbids loopback sockets, so the Gradle daemon cannot
  start (`SocketException: Operation not permitted`) and such gates physically
  cannot run there; the brief's self-check clause makes the direct toolchain
  (kotlinc/JBR + `java -cp` JUnit, etc.) the required in-sandbox substitute,
  and Claude subagents run the real gate on the host.
- When dispatching any subagent, require **conclusions + key evidence only, no
  full dumps**.
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
  conversation — use /handoff if installed, otherwise have a subagent write a
  handoff file. At program scale, the manifest (see Program-scale work) is the
  durable, structured version of this.

## Model tiers (task tier ↔ model tier)

| Task | Dispatch | Model |
|---|---|---|
| Orchestration / adjudication | main session itself | fable = Fable 5 (sole user; never for subagents) |
| Codex result review | `subagent_type: reviewer`, no model param | opus = Opus 5 (pinned in frontmatter) |
| Exploration / locating / spec extraction | Explore or general-purpose + `model: sonnet` | sonnet = Sonnet 5 |
| Gate re-runs / device acceptance | general-purpose + `model: sonnet` | sonnet |
| Exception: heavy analysis (e.g. large transcript audits) | general-purpose + `model: opus` | opus |
| Implementation / refactor / test fixing | Codex, effort per tier table | gpt-5.6-sol |
| Codex cold-read adversarial review | `driver.sh review <impl-brief>` (= `--fresh --model gpt-6-astra --effort xhigh`, no `--write`) | gpt-6-astra |
| Design review of a concurrency brief (flow step 0) | Codex `run`, `--fresh --model gpt-6-astra --effort xhigh`, no `--write` | gpt-6-astra |

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
| Task fails immediately at `max` effort (HTTP 400 from backend) | The relay/backend doesn't support `max` — fall back to `xhigh` |
| Review task fails immediately with `--model gpt-6-astra` | The relay/backend doesn't serve astra yet — fall back to the pre-astra review config: `driver.sh review ... --model gpt-5.6-sol --effort max` (then `xhigh`) |
| Codex hits Gradle `SocketException: Operation not permitted` | Sandbox forbids loopback — expected. Codex compiles and tests with the direct toolchain (self-check clause); gates are re-run by the verification subagent on the host |
| Codex finished but no files changed | `--write` was missing. Write a small brief saying "apply the changes", then `driver.sh run <that-file> --resume --write` to continue the thread |
| `status` can't find a just-launched task | Wrong cwd — return to the project directory the task was launched from |
| Background shell shows "No output available" while the task runs | The launch was piped through `tail`/`head`, which buffer until EOF — the task is fine. Watch the brief's `.result.md` instead (streamed in real time); launch bare next time |
