#!/bin/bash
# StatusLine script for Claude Code - Robbyrussell theme style with cost

input=$(cat)
cwd=$(echo "$input" | jq -r '.workspace.current_dir')
dir=$(basename "$cwd")

# Colors
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
DIM='\033[2m'
RESET='\033[0m'

# Build directory and git info
output="$(printf "${CYAN}➜${RESET} ${CYAN}%s${RESET} " "$dir")"

if git -C "$cwd" rev-parse --git-dir > /dev/null 2>&1; then
    branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null || git -C "$cwd" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
    if [ -n "$branch" ]; then
        if git -C "$cwd" --no-optional-locks diff --quiet 2>/dev/null && git -C "$cwd" --no-optional-locks diff --cached --quiet 2>/dev/null; then
            output+="$(printf "${GREEN}(git:%s)${RESET} " "$branch")"
        else
            output+="$(printf "${YELLOW}(git:%s)${RESET} " "$branch")"
        fi
    fi
fi

# Extract model name and cost
model=$(echo "$input" | jq -r '.model.display_name // empty')
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')

# Format model name
if [ -n "$model" ]; then
    output+="$(printf "${DIM}[${RESET}${GREEN}%s${RESET}${DIM}]${RESET} " "$model")"
fi

# Format cost
if [ "$cost" != "0" ] && [ "$cost" != "null" ]; then
    cost_str=$(printf "\$%.2f" "$cost")
    output+="$(printf "${DIM}[${RESET}${YELLOW}%s${RESET}${DIM}]${RESET}" "$cost_str")"
fi

printf "%s" "$output"
