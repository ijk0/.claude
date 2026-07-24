#!/bin/bash
# Fable-GPT driver — launch/manage Codex tasks via codex-companion.
#
# The companion is cwd-sensitive: tasks are tracked per workspaceRoot (= the
# current directory). Always cd into the project Codex should work on before
# running this script.
#
# Usage:
#   driver.sh run <task-file.md> [--write] [--model M] [--effort E] [--resume|--fresh]
#   driver.sh <subcommand> [...]   # passthrough: status / result / cancel / task-resume-candidate ...
#
# run defaults: --fresh --model gpt-5.6-sol --effort high
# --write is NEVER added implicitly — pass it explicitly when Codex must modify files.
# run persists the full companion output to <task-file minus .md>.result.md
# (append mode, one dated header per run).
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

if [[ "$1" == "run" ]]; then
  shift
  task_file="$1"; shift
  if [[ ! -s "$task_file" ]]; then
    echo "task file missing or empty: $task_file" >&2
    exit 1
  fi
  flags=("$@")
  joined=" ${flags[*]} "
  [[ "$joined" == *" --model"*  ]] || flags+=(--model gpt-5.6-sol)
  [[ "$joined" == *" --effort"* ]] || flags+=(--effort high)
  [[ "$joined" == *" --resume"* || "$joined" == *" --fresh "* ]] || flags+=(--fresh)
  # Persist the complete run output (progress lines + final reply + stderr)
  # next to the brief. Append mode: reruns of the same brief stack under
  # dated headers instead of clobbering earlier attempts.
  result_file="${task_file%.md}.result.md"
  printf '\n===== fable-gpt run %s =====\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" >> "$result_file"
  echo "[driver] full output persisted to: $result_file"
  node "$companion" task "${flags[@]}" "$(cat "$task_file")" 2>&1 | tee -a "$result_file"
else
  exec node "$companion" "$@"
fi
