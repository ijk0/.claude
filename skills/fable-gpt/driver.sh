#!/bin/bash
# Fable-GPT driver — launch/manage Codex tasks via codex-companion.
#
# The companion is cwd-sensitive: tasks are tracked per workspaceRoot (= the
# current directory). Always cd into the project Codex should work on before
# running this script.
#
# Usage:
#   driver.sh run <task-file.md> [--write] [--model M] [--effort E] [--resume|--fresh] [--foreground]
#   driver.sh watch <task-file.md> [job-id]   # re-attach a watcher to a running job
#   driver.sh <subcommand> [...]   # passthrough: status / result / cancel / task-resume-candidate ...
#
# run defaults: --fresh --model gpt-5.6-sol --effort high
# effort: none|minimal|low|medium|high|xhigh — plus max/ultra IF the installed
#   companion accepts them (codex-cli >= 0.147 does; companion 1.0.6 stops at
#   xhigh — the driver detects this and refuses max/ultra with instructions
#   rather than letting the companion throw).
# --write is NEVER added implicitly — pass it explicitly when Codex must modify files.
#
# run launches the task in a DETACHED WORKER (survives this shell), then
# watches it: streams the companion log into <task-file minus .md>.result.md
# (append mode, one dated header per run), prints the final reply last, and
# exits non-zero on failure — exit 3 = suspected false completion (job marked
# completed but no final reply captured). --foreground restores the old
# in-process mode.
set -eo pipefail

# Resolve the companion path: prefer the active version registered in
# installed_plugins.json (schema-agnostic walk for any installPath containing
# the plugin path), then fall back to the newest version in the plugin cache.
companion=$(python3 -c '
import json, os
def walk(x):
    if isinstance(x, dict):
        p = x.get("installPath")
        if isinstance(p, str) and "/openai-codex/codex/" in p:
            yield p
        for v in x.values():
            yield from walk(v)
    elif isinstance(x, list):
        for v in x:
            yield from walk(v)
try:
    data = json.load(open(os.path.expanduser("~/.claude/plugins/installed_plugins.json")))
    for p in walk(data):
        f = p + "/scripts/codex-companion.mjs"
        if os.path.isfile(f):
            print(f)
            break
except Exception:
    pass
' 2>/dev/null || true)
if [[ -z "$companion" ]]; then
  companion=$(ls "$HOME/.claude/plugins/cache/openai-codex/codex/"*/scripts/codex-companion.mjs 2>/dev/null | sort -V | tail -1 || true)
fi
if [[ -z "$companion" ]]; then
  echo "codex-companion.mjs not found (checked installed_plugins.json and plugin cache)" >&2
  exit 1
fi

# Companion <= 1.0.6 hard-rejects max/ultra efforts before codex ever sees
# them (VALID_REASONING_EFFORTS allowlist), although codex-cli >= 0.147
# accepts both. The driver does not modify the plugin; if the allowlist is
# still unpatched, requesting max/ultra fails here with the manual patch
# command instead of the companion's opaque error. Re-run the patch after
# plugin updates (the allowlist resets).
check_effort_supported() {
  local effort="$1"
  case "$effort" in
    max|ultra) ;;
    *) return 0 ;;
  esac
  if grep -q '"max", "ultra"' "$companion"; then
    return 0
  fi
  cat >&2 <<EOF
[driver] effort '$effort' is rejected by the installed companion ($companion).
[driver] Either use --effort xhigh, or patch the allowlist yourself (one line, keeps a .orig backup):
[driver]   sed -i.orig 's/"high", "xhigh"\]/"high", "xhigh", "max", "ultra"]/' "$companion"
EOF
  return 1
}

# Watch a background job to completion. Streams new companion-log bytes into
# the result file as they appear (real-time liveness signal), then renders the
# final result. Exit: 0 ok, 1 failed, 2 lost track of job, 3 suspected false
# completion.
watch_job() {
  local job_id="$1" result_file="$2" skip_existing="${3:-0}"
  local log_file="" copied=0 status="" misses=0 snap size

  while :; do
    snap=$(node "$companion" status "$job_id" --wait --timeout-ms 300000 --json 2>/dev/null || true)
    if [[ -z "$log_file" ]]; then
      log_file=$(printf '%s' "$snap" | python3 -c 'import json,sys
try: print((json.load(sys.stdin).get("job") or {}).get("logFile") or "")
except Exception: print("")')
      # Re-attached watchers (skip_existing=1) stream only NEW log bytes —
      # re-copying from byte 0 would duplicate everything the first watcher
      # already wrote into the result file. Any gap stays recoverable from
      # the companion log itself, and the final reply is guaranteed by the
      # render step below.
      if [[ "$skip_existing" == "1" && -n "$log_file" && -f "$log_file" ]]; then
        copied=$(wc -c < "$log_file" | tr -d ' ')
      fi
    fi
    if [[ -n "$log_file" && -f "$log_file" ]]; then
      size=$(wc -c < "$log_file" | tr -d ' ')
      if [ "$size" -gt "$copied" ]; then
        tail -c +"$((copied + 1))" "$log_file" >> "$result_file"
        copied=$size
      fi
    fi
    status=$(printf '%s' "$snap" | python3 -c 'import json,sys
try: print((json.load(sys.stdin).get("job") or {}).get("status") or "unknown")
except Exception: print("unknown")')
    case "$status" in
      queued|running)
        misses=0
        ;;
      unknown)
        misses=$((misses + 1))
        if [ "$misses" -ge 10 ]; then
          echo "[driver] ERROR: lost track of job $job_id (10 consecutive status failures); the detached worker may still be running — retry: driver.sh watch <task-file> $job_id" | tee -a "$result_file" >&2
          return 2
        fi
        sleep 15
        ;;
      *)
        break
        ;;
    esac
  done

  # Final verdict + final reply last on stdout (the notification tail must end
  # with the assistant's reply, not a progress line). The result file is NOT a
  # tee of this: the streamed companion log records the reply twice (last
  # "Assistant message" entry + "Final output" section) — the python below
  # truncates the "Final output" repeat (strict pattern match only), appends
  # just the [driver] lines, and re-appends the reply only if the stream
  # missed it entirely.
  node "$companion" result "$job_id" --json 2>/dev/null | python3 -c '
import json, re, sys

result_path = sys.argv[1]
stdout_lines = []
file_lines = []

def emit(text, to_file=True):
    stdout_lines.append(text)
    if to_file:
        file_lines.append(text)

def flush(code):
    print("\n".join(stdout_lines))
    if file_lines:
        with open(result_path, "a") as f:
            f.write("\n".join(file_lines) + "\n")
    sys.exit(code)

try:
    d = json.load(sys.stdin)
except Exception:
    emit("[driver] WARNING: could not read job result; verify with `driver.sh status --json`")
    flush(3)

job = d.get("job") or {}
stored = d.get("storedJob") or {}
res = stored.get("result") or {}
raw = (res.get("rawOutput") or "").strip()
status = job.get("status") or "unknown"
thread = res.get("threadId") or stored.get("threadId") or job.get("threadId") or "?"
emit("[driver] job %s finished: status=%s thread=%s" % (job.get("id", "?"), status, thread))
err = stored.get("errorMessage") or ""
if err:
    emit("[driver] job error: " + err)
if raw:
    raw_b = raw.encode("utf-8")
    in_file = False
    try:
        with open(result_path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            window = min(size, 2 * len(raw_b) + 16384)
            f.seek(size - window)
            tail = f.read()
        j = tail.rfind(raw_b)
        in_file = j >= 0
        i = tail.rfind(raw_b, 0, j) if j >= 0 else -1
        if i >= 0:
            # Between the two copies the log emits only bracketed status
            # lines ("[ts] Turn completed." / "[ts] Turn completion
            # inferred..." — wording varies) and then the "[ts] Final
            # output" marker. Keep the status lines, drop the marker and
            # the repeated reply after it.
            m = re.fullmatch(
                rb"((?:\s*\[[^\]\n]*\][^\n]*\n)*?\s*)\[[^\]\n]*\] Final output[^\n]*\n",
                tail[i + len(raw_b):j])
            if m and not tail[j + len(raw_b):].strip():
                with open(result_path, "r+b") as f:
                    f.truncate(size - window + i + len(raw_b) + m.end(1))
    except Exception:
        pass
    emit(raw, to_file=not in_file)
if status == "completed" and raw:
    flush(0)
if status == "completed":
    emit("[driver] WARNING: suspected FALSE COMPLETION — job marked completed but no final reply captured. Verify with `driver.sh status --json`, then continue the thread: driver.sh run <new-brief> --resume --write")
    flush(3)
emit("[driver] job did not complete cleanly (status=%s)" % status)
flush(1)
' "$result_file"
}

if [[ "$1" == "run" ]]; then
  shift
  task_file="$1"; shift
  if [[ ! -s "$task_file" ]]; then
    echo "task file missing or empty: $task_file" >&2
    exit 1
  fi
  foreground=0
  flags=()
  for f in "$@"; do
    if [[ "$f" == "--foreground" ]]; then
      foreground=1
    else
      flags+=("$f")
    fi
  done
  joined=" ${flags[*]} "
  [[ "$joined" == *" --model"*  ]] || flags+=(--model gpt-5.6-sol)
  [[ "$joined" == *" --effort"* ]] || flags+=(--effort high)
  [[ "$joined" == *" --resume"* || "$joined" == *" --fresh "* ]] || flags+=(--fresh)
  effort_value=""
  prev=""
  for f in "${flags[@]}"; do
    if [[ "$prev" == "--effort" ]]; then
      effort_value="$f"
    elif [[ "$f" == --effort=* ]]; then
      effort_value="${f#--effort=}"
    fi
    prev="$f"
  done
  check_effort_supported "$effort_value"
  # Persist the complete run output (progress lines + final reply + stderr)
  # next to the brief. Append mode: reruns of the same brief stack under
  # dated headers instead of clobbering earlier attempts.
  result_file="${task_file%.md}.result.md"
  printf '\n===== fable-gpt run %s =====\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" >> "$result_file"
  echo "[driver] full output persisted to: $result_file"

  if [ "$foreground" -eq 1 ]; then
    node "$companion" task "${flags[@]}" --prompt-file "$task_file" 2>&1 | tee -a "$result_file"
    exit 0
  fi

  launch_json=$(node "$companion" task --background --json "${flags[@]}" --prompt-file "$task_file" 2>>"$result_file") || {
    echo "[driver] launch failed:" >&2
    printf '%s\n' "$launch_json" | tee -a "$result_file" >&2
    exit 1
  }
  job_id=$(printf '%s' "$launch_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["jobId"])') || {
    echo "[driver] could not parse jobId from launch output:" >&2
    printf '%s\n' "$launch_json" | tee -a "$result_file" >&2
    exit 1
  }
  echo "[driver] job-id: $job_id (detached worker — survives this shell; re-attach: driver.sh watch $task_file)" | tee -a "$result_file"
  watch_job "$job_id" "$result_file"
elif [[ "$1" == "watch" ]]; then
  shift
  task_file="$1"; shift || true
  result_file="${task_file%.md}.result.md"
  job_id="${1:-}"
  if [[ -z "$job_id" ]]; then
    job_id=$(grep -a '^\[driver\] job-id: ' "$result_file" 2>/dev/null | tail -1 | awk '{print $3}')
  fi
  if [[ -z "$job_id" ]]; then
    echo "no job id given and none recorded in $result_file" >&2
    exit 1
  fi
  echo "[driver] re-attaching watcher to job $job_id (streaming new log bytes only)" | tee -a "$result_file"
  watch_job "$job_id" "$result_file" 1
else
  exec node "$companion" "$@"
fi
