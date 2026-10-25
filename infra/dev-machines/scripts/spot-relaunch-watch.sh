#!/bin/bash
# spot-relaunch-watch.sh — runs on the developer's computer (launchd, every minute) and replaces their home machine
# after AWS reclaims it on Spot (machine policy DM10). Idle and deadline terminations are left alone.
#
# A reclaim is seen when no machine holds CLOUD_HOME_VOLUME and the last one to hold it ended with
# Server.SpotInstanceTermination; it is then pending until a replacement launches, so a replacement that fails (and
# terminates itself) is retried the next minute, up to 10 times. After a launch, if BRAIN_HERDR_MACHINE names the
# developer's saved Herdr machine, Herdr is told to reconnect to it, so the agents resume and the new machine is not
# left idle. AWS terminated instances stay visible for about an hour: a computer asleep longer misses the reclaim.
#
# Usage: CLOUD_ENV_FILE=<settings> [BRAIN_HERDR_MACHINE=<name>] infra/dev-machines/scripts/spot-relaunch-watch.sh [<ticket>-<slug>]
# The work name defaults to the reclaimed machine's brain:ticket. Status goes to stdout (launchd's log), with a
# notification on macOS.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/cloud-lib.sh"
need CLOUD_HOME_VOLUME
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/brain-spot-relaunch"
mkdir -p "$STATE"

notify() {
  echo "$(date '+%F %T') $1"
  command -v osascript >/dev/null && osascript -e "display notification \"$1\" with title \"brain dev machine\"" || true
}

# describe <states>: the machines that held the home volume, in these states, oldest first.
describe() {
  aws ec2 describe-instances --filters "Name=tag:brain:home-volume,Values=$HOME_VOLUME" "Name=instance-state-name,Values=$1" \
    --query "sort_by(Reservations[].Instances[], &LaunchTime)[].[InstanceId, StateReason.Code, Tags[?Key=='brain:ticket']|[0].Value]" \
    --output text
}

# AWS unreachable (an expired login, most often): say so, at most once an hour.
if ! live="$(describe pending,running,stopping,stopped 2>&1)"; then
  if [ ! -e "$STATE/aws-error" ] || [ -n "$(find "$STATE/aws-error" -mmin +60 2>/dev/null)" ]; then
    touch "$STATE/aws-error"
    notify "cannot reach AWS ($(printf %s "$live" | tail -1 | cut -c1-80)); try: aws login --profile ${AWS_PROFILE:-<profile>}"
  fi
  exit 1
fi
rm -f "$STATE/aws-error"
[ -z "$live" ] || exit 0

# A reclaim not yet replaced: the newest one seen, or one already pending after a failed replacement.
read -r last reason ticket <<<"$(describe shutting-down,terminated | tail -1)"
if [ "$reason" = Server.SpotInstanceTermination ] && [ ! -e "$STATE/$last.done" ] && [ ! -e "$STATE/$last.pending" ]; then
  printf '%s\n' "${ticket:-home}" > "$STATE/$last.pending"
fi
pending="$(find "$STATE" -name '*.pending' -print 2>/dev/null | head -1)"
[ -n "$pending" ] || exit 0
reclaimed="$(basename "$pending" .pending)"
tries="$(wc -l < "$pending" | tr -d ' ')"
name="${1:-$(head -1 "$pending")}"
if [ "$tries" -gt 10 ]; then
  mv "$pending" "$STATE/$reclaimed.failed"
  notify "gave up replacing $reclaimed after 10 tries; run cloud-up.sh $name --spot by hand"
  exit 1
fi

notify "AWS reclaimed $reclaimed (Spot); launching a replacement for $name (try $tries)"
if out="$("$HERE/cloud-up.sh" "$name" --spot 2>&1)"; then
  mv "$pending" "$STATE/$reclaimed.done"
  id="$(printf %s "$out" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p' | tail -1)"
  if [ -n "${BRAIN_HERDR_MACHINE:-}" ] && command -v herdr >/dev/null; then
    herdr machine reconnect "$BRAIN_HERDR_MACHINE" >/dev/null 2>&1 || true
    notify "replacement $id ready; Herdr reconnecting to $BRAIN_HERDR_MACHINE to resume the agents"
  else
    notify "replacement $id ready; connect to it and Herdr resumes the agents"
  fi
else
  echo "$out"
  echo "retry" >> "$pending"
  notify "replacement for $reclaimed failed; retrying in a minute"
  exit 1
fi
