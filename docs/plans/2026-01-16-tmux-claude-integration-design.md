# tmux + Claude Integration Design

A command center setup where Claude orchestrates work across multiple tmux panes.

## Goals

- Leader Claude in pane 1 orchestrates worker panes
- Worker panes run: servers, clients, spawned Claude sessions, gitui, git watchers
- Claude queries tmux state via commands
- Hybrid pane naming: auto-detect from command + manual override
- Flexible structure: start minimal, grow organically

## Core tmux Configuration

```bash
# ~/.tmux.conf

# Pane indexing starts at 1 (pane 1 = leader)
set -g pane-base-index 1
set -g base-index 1

# Auto-rename from running command (hybrid: auto + manual override)
set -g automatic-rename on
set -g automatic-rename-format '#{pane_current_command}'

# Allow programs to set pane title (for manual override)
set -g allow-rename on
set -g set-titles on

# Show pane titles on borders (visual aid)
set -g pane-border-status top
set -g pane-border-format ' #{pane_index}:#{pane_title} [#{pane_current_command}] '

# Refresh status frequently for real-time updates
set -g status-interval 1
```

## Claude Query Commands

```bash
# Get all panes across all windows (primary query)
tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_title} [#{pane_current_command}] #{pane_id}'

# Get current pane info (Claude confirms it's in pane 1)
tmux display-message -p '#{pane_index}:#{pane_title}'

# Send command to pane - use C-m (carriage return)
tmux send-keys -t :1.2 'npm run dev' C-m

# For multiple commands, sleep between them
tmux send-keys -t :1.2 'cd /app' C-m && sleep 0.1 && tmux send-keys -t :1.2 'npm run dev' C-m

# Or chain with semicolon in one shell command
tmux send-keys -t :1.2 'cd /app && npm run dev' C-m

# Create new pane and name it
tmux split-window -h \; select-pane -T "worker"

# Create new window with named pane
tmux new-window -n "services" \; select-pane -T "api"

# Kill a pane by index
tmux kill-pane -t :1.3
```

Key points:
- Use `C-m` not `Enter` (more reliable)
- Sleep between separate commands if needed
- Or combine into one shell command with `&&`

## Setting Pane Titles (Hybrid System)

**Automatic:** tmux auto-sets title from running command (`node`, `claude`, `gitui`)

**Manual override:**

```bash
# Method 1: tmux command (from any pane, target specific pane)
tmux select-pane -t :1.2 -T "api-server"

# Method 2: Escape sequence (sets title of current pane)
printf '\033]2;%s\033\\' 'api-server'

# Method 3: In ZSH, create helper function (~/.zshrc)
pane-title() { printf '\033]2;%s\033\\' "$1" }
# Usage: pane-title "api-server"
```

## Startup Script

```bash
#!/bin/bash
# ~/bin/claude-tmux

SESSION="${1:-claude}"  # Pass project name or default to "claude"

# If session exists, attach to it
if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux attach -t "$SESSION"
  exit 0
fi

# Create new session with first window "command"
tmux new-session -d -s "$SESSION" -n "command"

# Pane 1 is leader (already exists), set title
tmux select-pane -t "$SESSION:1.1" -T "leader"

# Create pane 2: worker slot
tmux split-window -h -t "$SESSION:1"
tmux select-pane -t "$SESSION:1.2" -T "worker"

# Create pane 3: shell slot (below leader)
tmux split-window -v -t "$SESSION:1.1"
tmux select-pane -t "$SESSION:1.3" -T "shell"

# Return focus to leader pane
tmux select-pane -t "$SESSION:1.1"

# Attach to session
tmux attach -t "$SESSION"
```

**Result layout:**
```
┌─────────────────────┬─────────────────────┐
│ 1:leader [zsh]      │ 2:worker [zsh]      │
├─────────────────────┤                     │
│ 3:shell [zsh]       │                     │
└─────────────────────┴─────────────────────┘
```

## Dynamic Window/Pane Creation

```bash
# Create new pane in current window (horizontal split)
tmux split-window -h \; select-pane -T "new-worker"

# Create new pane (vertical split)
tmux split-window -v \; select-pane -T "logs"

# Create new window with named pane
tmux new-window -n "services" \; select-pane -T "api"

# Create window with multiple panes in one command
tmux new-window -n "services" \; \
  select-pane -T "api" \; \
  split-window -h \; select-pane -T "web" \; \
  split-window -v -t 1 \; select-pane -T "db"

# List all windows
tmux list-windows -F '#{window_index}:#{window_name}'

# Switch to window by name/index
tmux select-window -t "services"
tmux select-window -t 2
```

**Claude workflow for spawning a sub-Claude:**
```bash
# Find an idle pane or create new one
tmux split-window -h \; select-pane -T "claude-task"

# Send Claude command to it
sleep 0.2 && tmux send-keys -t :1.4 'claude "run the tests and fix failures"' C-m
```

## Monitoring & Capturing Pane Output

```bash
# Capture recent output from a pane (last 50 lines)
tmux capture-pane -t :1.2 -p -S -50

# Capture entire scrollback buffer
tmux capture-pane -t :1.2 -p -S -

# Capture and save to file
tmux capture-pane -t :1.2 -p -S -100 > /tmp/pane-output.txt

# Check if pane is busy (command running vs idle shell)
tmux list-panes -F '#{pane_index}:#{pane_current_command}'
# Output: 1:claude  2:node  3:zsh  (zsh = idle)

# Wait for pane to become idle (command finished)
while [ "$(tmux display-message -t :1.2 -p '#{pane_current_command}')" != "zsh" ]; do
  sleep 1
done
echo "Pane 2 finished"
```

## ZSH Integration (~/.zshrc)

```bash
# ===== tmux + Claude Integration =====

# Helper: set pane title
pane-title() { printf '\033]2;%s\033\\' "$1" }

# Auto-title: show running command
preexec() {
  local cmd="${1%% *}"
  printf '\033]2;%s\033\\' "$cmd"
}

# Auto-title: reset to "zsh" when idle
precmd() {
  printf '\033]2;%s\033\\' "zsh"
}

# Helper: list all panes (quick status)
tpanes() {
  tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_title} [#{pane_current_command}]'
}

# Helper: send command to pane
tsend() {
  local target="$1"
  shift
  tmux send-keys -t "$target" "$*" C-m
}
# Usage: tsend :1.2 npm run dev

# Helper: capture pane output
tcap() {
  tmux capture-pane -t "${1:-}" -p -S -50
}
# Usage: tcap :1.2
```

## Quick Reference for Claude

| Task | Command |
|------|---------|
| List panes | `tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_title} [#{pane_current_command}]'` |
| Send command | `tmux send-keys -t :1.2 'cmd' C-m` |
| Capture output | `tmux capture-pane -t :1.2 -p -S -50` |
| Set pane title | `tmux select-pane -t :1.2 -T "name"` |
| New pane | `tmux split-window -h \; select-pane -T "name"` |
| New window | `tmux new-window -n "name"` |
| Check if idle | `tmux display-message -t :1.2 -p '#{pane_current_command}'` |

## Key Conventions

- **Pane 1 = Leader** - Always the orchestrating Claude session
- **`:1.2` notation** - Window 1, pane 2
- **`C-m` not `Enter`** - More reliable for send-keys
- **Sleep between commands** - When sending multiple sequential commands
- **`zsh` = idle** - Pane ready for new commands
