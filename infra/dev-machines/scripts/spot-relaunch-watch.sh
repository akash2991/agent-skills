#!/bin/bash
# spot-relaunch-watch.sh — runs on the developer's computer (launchd, every minute) and replaces their home machine
# after AWS reclaims it on Spot (machine policy DM10). Idle and deadline terminations are left alone: it acts only
# when no machine holds CLOUD_HOME_VOLUME and the last one to hold it ended with Server.SpotInstanceTermination.
# Each reclaimed machine is replaced once: its id is recorded after a successful launch.
#
# Usage: CLOUD_ENV_FILE=<settings> infra/dev-machines/scripts/spot-relaunch-watch.sh [<ticket>-<slug>]
# The work name for the replacement defaults to the reclaimed machine's brain:ticket. Status goes to stdout, for
# launchd's log; a notification is shown on macOS.
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

live="$(aws ec2 describe-instances --filters "Name=tag:brain:home-volume,Values=$HOME_VOLUME" \
  Name=instance-state-name,Values=pending,running,stopping,stopped --query 'length(Reservations[].Instances[])' --output text)"
[ "$live" = 0 ] || exit 0

read -r last reason ticket <<<"$(aws ec2 describe-instances --filters "Name=tag:brain:home-volume,Values=$HOME_VOLUME" \
  Name=instance-state-name,Values=shutting-down,terminated \
  --query "sort_by(Reservations[].Instances[], &LaunchTime)[-1].[InstanceId, StateReason.Code, Tags[?Key=='brain:ticket']|[0].Value]" \
  --output text)"
[ "$reason" = Server.SpotInstanceTermination ] || exit 0
[ ! -e "$STATE/$last" ] || exit 0

name="${1:-${ticket:-home}}"
notify "AWS reclaimed $last (Spot); launching a replacement for $name"
if out="$("$HERE/cloud-up.sh" "$name" --spot 2>&1)"; then
  touch "$STATE/$last"
  notify "replacement ready: $(printf %s "$out" | sed -n 's/.*"instance_id":"\([^"]*\)".*/\1/p' | tail -1); Herdr resumes the agents when it reconnects"
else
  # Not recorded: the next run tries again (the home volume may still be detaching).
  echo "$out"
  notify "replacement for $last failed; retrying in a minute"
  exit 1
fi
