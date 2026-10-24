#!/bin/bash
# cloud-lib.sh — settings and helpers shared by the cloud-*.sh scripts. Sourced, never run.
# Reads its settings from CLOUD_ENV_FILE, else .env in the current directory. The variables are in
# infra/dev-machines/env.example and README.md, One-time setup.
# shellcheck disable=SC2034  # the settings are used by the scripts that source this file
ENV_FILE="${CLOUD_ENV_FILE:-.env}"
# shellcheck disable=SC1090  # the settings file is the user's
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
REGION="${CLOUD_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
[ -n "$REGION" ] || { echo "set CLOUD_REGION in $ENV_FILE" >&2; exit 2; }
export AWS_REGION="$REGION" AWS_PAGER=""
DEFAULT_TYPE="${CLOUD_DEFAULT_TYPE:-m8i.2xlarge}"
MAC_TYPE="${CLOUD_MAC_TYPE:-mac2-m2.metal}"
IDLE_MINUTES="${CLOUD_IDLE_MINUTES:-30}"
MAX_HOURS="${CLOUD_MAX_HOURS:-8}"
MAX_MACHINES="${CLOUD_MAX_MACHINES:-2}"
DISK_GB="${CLOUD_DISK_GB:-100}"
MAX_CPU_PCT="${CLOUD_MAX_CPU_PCT:-70}"
MAX_MEM_PCT="${CLOUD_MAX_MEM_PCT:-75}"
MAX_DISK_PCT="${CLOUD_MAX_DISK_PCT:-80}"
HOME_VOLUME="${CLOUD_HOME_VOLUME:-}"
# A machine is reached by its instance ID, over SSH inside a Session Manager session opened as AWS_PROFILE; nothing is
# open to the internet (M6): ssh ec2-user@<instance-id>. The keepalive keeps an idle session from timing out.
need_ssh() {
  command -v session-manager-plugin >/dev/null \
    || { echo "install the Session Manager plugin: brew install --cask session-manager-plugin (README.md)" >&2; exit 2; }
}
PROXY_CMD="aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --region $REGION${AWS_PROFILE:+ --profile $AWS_PROFILE}"
PROXY=(-o "ProxyCommand=$PROXY_CMD" -o ServerAliveInterval=30)
SSH=(ssh -n -A -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 -o BatchMode=yes "${PROXY[@]}")
SSH_HINT="ssh -A -o ServerAliveInterval=30 -o ProxyCommand='$PROXY_CMD' ec2-user@"

# wait_ssm <instance-id>: until SSH answers through Session Manager, for at most 5 minutes; on giving up it prints the
# last error and returns 1, or 2 at once when the machine shut itself down. The SSM agent reports Online seconds before sshd listens, so Online alone is not ready.
wait_ssm() {
  local end=$(( $(date +%s) + 300 )) err="SSM agent not online"
  while [ "$(date +%s)" -lt "$end" ]; do
    case "$(aws ec2 describe-instances --instance-ids "$1" --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null)" in
      shutting-down|terminated|stopping|stopped) echo "$1 shut itself down during setup" >&2; return 2 ;;
    esac
    if [ "$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$1" \
      --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null)" = Online ]; then
      err="$("${SSH[@]}" "ec2-user@$1" true 2>&1)" && return 0
    fi
    sleep 5
  done
  echo "$1 is not reachable over SSH through Session Manager: ${err:-no output}" >&2
  return 1
}

need() {
  for v in "$@"; do
    [ -n "${!v:-}" ] || { echo "set $v in $ENV_FILE (infra/dev-machines/README.md, One-time setup)" >&2; exit 2; }
  done
}

# ISO 8601 UTC, without zone suffix, for epoch seconds $1 (GNU or BSD date).
iso_utc() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%S; }

# Keep only characters EC2 tag values accept.
tag_safe() { printf %s "$1" | tr -cd 'A-Za-z0-9 +=._:/@-' | cut -c1-250; }

# schedule <create|update> <name> <epoch> <ec2 api action> <input json>: a one-shot EventBridge schedule
# that calls the EC2 API at <epoch> as CLOUD_SCHEDULER_ROLE_ARN and deletes itself afterwards.
schedule() {
  local verb="$1" input
  shift
  input="$(printf %s "$4" | sed 's/"/\\"/g')"
  aws scheduler "$verb-schedule" --name "$1" \
    --schedule-expression "at($(iso_utc "$2"))" --schedule-expression-timezone UTC \
    --flexible-time-window Mode=OFF --action-after-completion DELETE \
    --target "{\"Arn\":\"arn:aws:scheduler:::aws-sdk:ec2:$3\",\"RoleArn\":\"$CLOUD_SCHEDULER_ROLE_ARN\",\"Input\":\"$input\"}" >/dev/null
}
