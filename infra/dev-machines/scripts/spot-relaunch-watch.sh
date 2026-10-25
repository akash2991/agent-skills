#!/bin/bash
# spot-relaunch-watch.sh — runs on the developer's computer (launchd, every minute) and replaces their home machine
# after AWS reclaims it on Spot (machine policy DM10). Idle and deadline terminations are left alone.
#
# A reclaim is seen when no machine holds CLOUD_HOME_VOLUME and the last one to hold it ended with
# Server.SpotInstanceTermination. It is then pending until a machine holds the volume again, whoever launched it, so a
# replacement that fails (and terminates itself) is retried the next minute, up to 10 times; nothing is launched while
# the reclaimed machine is still shutting down. Agents resume when the developer's Herdr reconnects to the new machine
# (README, "Surviving a Spot reclaim"). AWS lists a terminated machine for about an hour: a computer asleep longer
# misses the reclaim.
#
# Usage: CLOUD_ENV_FILE=<settings> infra/dev-machines/scripts/spot-relaunch-watch.sh [<ticket>-<slug>]
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
if ! live="$(describe pending,running,stopping,stopped 2>"$STATE/aws-stderr")"; then
  if [ ! -e "$STATE/aws-error" ] || [ -n "$(find "$STATE/aws-error" -mmin +60 2>/dev/null)" ]; then
    touch "$STATE/aws-error"
    notify "cannot reach AWS ($(tail -1 "$STATE/aws-stderr" | cut -c1-80)); try: aws login --profile ${AWS_PROFILE:-<profile>}"
  fi
  exit 1
fi
rm -f "$STATE/aws-error"

# A machine holds the volume: whatever was pending is replaced.
if [ -n "$live" ]; then
  for f in "$STATE"/*.pending; do [ -e "$f" ] && mv "$f" "${f%.pending}.done"; done
  exit 0
fi

ended="$(describe shutting-down,terminated)"
read -r last reason ticket <<<"$(printf '%s\n' "$ended" | tail -1)"
if [ "$reason" = Server.SpotInstanceTermination ] && [ ! -e "$STATE/$last.done" ] && [ ! -e "$STATE/$last.pending" ] \
  && [ ! -e "$STATE/$last.failed" ]; then
  [ "$ticket" != None ] || ticket=""
  printf '%s\n' "${ticket:-home}" > "$STATE/$last.pending"
fi
pending="$(find "$STATE" -name '*.pending' -print 2>/dev/null | head -1)"
[ -n "$pending" ] || exit 0
# The volume is released only once the machine is gone.
[ -z "$(describe shutting-down)" ] || exit 0

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
  notify "replacement $(printf %s "$out" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p' | tail -1) ready; open Herdr to resume the agents"
else
  echo "$out"
  echo "retry" >> "$pending"
  notify "replacement for $reclaimed failed; retrying in a minute"
  exit 1
fi
