#!/bin/bash
# on-reclaim.sh — the developer's Spot reclaim hook (machine policy DM10). Install it once as ~/.brain/on-reclaim on the
# home volume; brain-spot-watch runs it as ec2-user on the two-minute warning, with the seconds left as its argument
# and, while a developer is connected, their forwarded agent in SSH_AUTH_SOCK.
#
# It keeps what the next machine needs to carry on:
#   1. Herdr's saved layout and agent sessions: copied to ~/.brain/herdr-session.saved.json, then Herdr stopped so
#      every agent flushes its session. The next machine's herdr-server unit puts the copy back before Herdr starts
#      (a stopping agent clears its own resume entry, so the state after the stop is not the one to resume).
#   2. Every repository's uncommitted work as a commit on wip/<folder>/<branch>, without touching the branch, the
#      index, or the files: tracked changes and staged files, and untracked files too when BRAIN_WIP_UNTRACKED=1
#      (off by default: an untracked file can be a secret, and a pushed branch is as public as its repository; the
#      files themselves stay on the home volume either way). Pushed with [skip ci] and without hooks when
#      SSH_AUTH_SOCK is set, else kept on the home volume.
# Settings come from ~/.brain/config, sourced if present: BRAIN_WIP_ROOTS (default "$HOME/Desktop $HOME/work"; searched
# three levels deep) and BRAIN_WIP_UNTRACKED.
LEFT="${1:-120}"
# shellcheck disable=SC1091  # the developer's own settings
[ -f "$HOME/.brain/config" ] && . "$HOME/.brain/config"
ROOTS="${BRAIN_WIP_ROOTS:-$HOME/Desktop $HOME/work}"
HERDR="$HOME/.local/bin/herdr"
STATE="$HOME/.config/herdr/session.json"
mkdir -p "$HOME/.brain"
echo "on-reclaim: ${LEFT}s left"

# 1. Herdr: keep the state to resume from, then stop cleanly (it signals every pane).
if [ -x "$HERDR" ] && [ -f "$STATE" ]; then
  cp -p "$STATE" "$HOME/.brain/herdr-session.saved.json"
  timeout 20 "$HERDR" server stop >/dev/null 2>&1 || echo "on-reclaim: herdr server stop did not finish"
fi

# 2. Work in progress: one commit per repository with changes.
wip() {
  local dir="$1" branch ref idx tree commit
  cd "$dir" || return 0
  [ -n "$(git --no-optional-locks status --porcelain 2>/dev/null)" ] || return 0
  branch="$(git symbolic-ref -q --short HEAD || echo detached)"
  ref="wip/$(basename "$dir")/$branch"
  idx="$(mktemp -u)"
  cp "$(git rev-parse --git-path index)" "$idx" 2>/dev/null || true   # no index yet: git starts from an empty one
  if [ "${BRAIN_WIP_UNTRACKED:-0}" = 1 ]; then add=(-A); else add=(-u); fi
  if GIT_INDEX_FILE="$idx" git add "${add[@]}" >/dev/null 2>&1 && tree="$(GIT_INDEX_FILE="$idx" git write-tree)" \
    && commit="$(git commit-tree "$tree" -p HEAD -m "wip: Spot reclaim $(date -u +%FT%TZ) [skip ci]")" \
    && git update-ref "refs/heads/$ref" "$commit"; then
    if [ -n "${SSH_AUTH_SOCK:-}" ] && timeout 45 git push -q --no-verify -f origin "$ref" >/dev/null 2>&1; then
      echo "on-reclaim: $dir: pushed $ref"
    else
      echo "on-reclaim: $dir: committed $ref on the home volume"
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
