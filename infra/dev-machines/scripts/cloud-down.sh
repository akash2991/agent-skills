#!/bin/bash
# cloud-down.sh — take an agent off a brain machine, and terminate the machine when nobody is left (machine policy DM5).
#
# Usage: infra/dev-machines/scripts/cloud-down.sh <instance-id> [<work-dir>]
# Settings from CLOUD_ENV_FILE or ./.env (env.example). Refuses a machine without the brain=dev tag.
#   dev machine  stops and removes the Compose project <work-dir> with its volumes and this agent's registration;
#                never deletes a directory: the agent removes its own worktree (development-setup DS2). Terminates
#                the machine when no agent is registered on it (and, on a home machine (DM9), no other SSH session
#                is open). A machine that cannot be reached is left to its deadline and cloud-reap.sh
#   Mac machine  terminated; its host stays allocated until its scheduled release, 24 h after allocation,
#                so further iOS builds reuse it (DM8)
# Prints the result as JSON on stdout; status goes to stderr.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/cloud-lib.sh"

ID="${1:-}"
DIR="$(printf %s "${2:-}" | tr -cd 'A-Za-z0-9._-')"
[ -n "$ID" ] || { echo "usage: cloud-down.sh <instance-id> [<work-dir>]" >&2; exit 2; }
read -r TAG KIND HOST HOMEVOL <<<"$(aws ec2 describe-instances --instance-ids "$ID" \
  --query "Reservations[0].Instances[0].[Tags[?Key=='brain']|[0].Value, Tags[?Key=='brain:kind']|[0].Value, Placement.HostId, Tags[?Key=='brain:home-volume']|[0].Value]" --output text)"
[ "$TAG" = dev ] || { echo "refused: $ID is not a brain machine (no brain=dev tag)" >&2; exit 3; }
[ "$HOST" = None ] && HOST=""
[ "$HOMEVOL" = None ] && HOMEVOL=""

terminate() {
  aws ec2 terminate-instances --instance-ids "$ID" >/dev/null
  aws scheduler delete-schedule --name "brain-kill-$ID" >/dev/null 2>&1 || true
  echo "terminated $ID" >&2
  [ -z "$HOST" ] || echo "Mac host $HOST stays allocated until its scheduled release; reuse it for further iOS builds" >&2
  echo "{\"instance_id\":\"$ID\",\"terminated\":true,\"agents_left\":0,\"host_id\":\"$HOST\"}"
  exit 0
}

[ "$KIND" = mac ] && terminate
need_ssh

# cloud-up.sh registered this agent under its work directory; what is left is the other registered agents, and on a
# home machine also the SSH sessions besides this one (the developer working there).
[ -z "$DIR" ] || UNREGISTER="sudo rm -f /var/lib/brain/agents/'$DIR' /run/brain-agents/'$DIR'"
AGENTS='$(find /var/lib/brain/agents /run/brain-agents -type f 2>/dev/null | wc -l)'
LEFT_CMD="echo $AGENTS"
[ -z "$HOMEVOL" ] || LEFT_CMD="echo \$(( $AGENTS + \$(ss -Htn state established '( sport = :22 )' | wc -l) - 1 ))"
LEFT="$("${SSH[@]}" "ec2-user@$ID" "
  ${UNREGISTER:-}
  [ -z '$DIR' ] || docker compose -p '$(printf %s "$DIR" | tr '[:upper:]' '[:lower:]')' down -v --remove-orphans >/dev/null 2>&1 || true
  $LEFT_CMD")" \
  || { echo "cannot reach $ID; it terminates at its deadline, and cloud-reap.sh terminates it after that" >&2; exit 1; }
LEFT="$(printf %s "$LEFT" | tr -d ' ')"
[ -z "$DIR" ] || echo "removed the Compose project $DIR and its registration from $ID" >&2
[ "$LEFT" = 0 ] && terminate
echo "$ID still has $LEFT registered agents or sessions; left running for them" >&2
echo "{\"instance_id\":\"$ID\",\"terminated\":false,\"agents_left\":$LEFT,\"host_id\":\"\"}"
