#!/bin/bash
# on-reclaim.sh — the developer's Spot reclaim hook (machine policy DM10). Install it once as ~/.brain/on-reclaim on the
# home volume; brain-spot-watch runs it as ec2-user on the two-minute warning, with the seconds left as its argument
# and, while a developer is connected, their forwarded agent in SSH_AUTH_SOCK.
#
# It keeps what the next machine needs to carry on:
#   1. Herdr's saved layout and agent sessions: copied aside, Herdr stopped so every agent flushes its session, and
#      the copy put back (an agent that exits clears its own resume entry);
#   2. every repository's uncommitted work, tracked and untracked (as .gitignore allows), as a commit on
#      wip/<branch>, without touching the branch, the index, or the files; pushed when SSH_AUTH_SOCK is set, else
#      kept on the home volume.
# Repositories are found under BRAIN_WIP_ROOTS (default "$HOME/Desktop $HOME/work"), up to three levels deep.
LEFT="${1:-120}"
ROOTS="${BRAIN_WIP_ROOTS:-$HOME/Desktop $HOME/work}"
HERDR="$HOME/.local/bin/herdr"
STATE="$HOME/.config/herdr/session.json"
SAVED="$HOME/.brain/herdr-session.reclaim.json"
mkdir -p "$HOME/.brain"
echo "on-reclaim: ${LEFT}s left"

# 1. Herdr: save the layout, stop cleanly (it signals every pane), put the layout back for the next machine.
if [ -x "$HERDR" ] && [ -f "$STATE" ]; then
  cp -p "$STATE" "$SAVED"
  timeout 20 "$HERDR" server stop >/dev/null 2>&1 || echo "on-reclaim: herdr server stop did not finish"
  cp -p "$SAVED" "$STATE"
fi

# 2. Work in progress: one commit per repository with changes, on wip/<branch>.
wip() {
  local dir="$1" branch idx tree commit
  cd "$dir" || return 0
  [ -n "$(git status --porcelain 2>/dev/null)" ] || return 0
  branch="$(git symbolic-ref -q --short HEAD || echo detached)"
  idx="$(mktemp)"
  cp "$(git rev-parse --git-path index)" "$idx" 2>/dev/null || true
  if GIT_INDEX_FILE="$idx" git add -A >/dev/null 2>&1 && tree="$(GIT_INDEX_FILE="$idx" git write-tree)" \
    && commit="$(git commit-tree "$tree" -p HEAD -m "wip: Spot reclaim $(date -u +%FT%TZ)")" \
    && git update-ref "refs/heads/wip/$branch" "$commit"; then
    if [ -n "${SSH_AUTH_SOCK:-}" ] && timeout 45 git push -q -f origin "wip/$branch" >/dev/null 2>&1; then
      echo "on-reclaim: $dir: pushed wip/$branch"
    else
      echo "on-reclaim: $dir: committed wip/$branch on the home volume"
    fi
  else
    echo "on-reclaim: $dir: could not commit work in progress"
  fi
  rm -f "$idx"
}

pids=()
# shellcheck disable=SC2086  # ROOTS is a space-separated list of directories
while IFS= read -r git; do
  wip "$(dirname "$git")" &
  pids+=($!)
done < <(find $ROOTS -maxdepth 3 -name .git 2>/dev/null)
for p in "${pids[@]}"; do wait "$p"; done
sync
echo "on-reclaim: done"
