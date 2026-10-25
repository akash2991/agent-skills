#!/bin/bash
# android-ec2-build.sh — build the Android app on an EC2 dev machine (machine policy DM7).
#
# Usage: infra/dev-machines/scripts/android-ec2-build.sh [<profile>] [<ticket>]
# Run from the project root, with the machine settings in CLOUD_ENV_FILE or the project's .env. The profile is passed to the build command; the ticket defaults to the
# current branch name. Builds Android in a Docker container on a shared EC2 dev machine and copies
# the artifact back.
#
# The build command is, in order of preference:
#   1. scripts/build-android.sh <profile>  (project-specific)
#   2. eas build --platform android --profile <profile> --local --non-interactive
#      (runs on the EC2 machine, does not count against EAS build limits)
#
#   exit 0  built successfully; prints {"artifact_path":"<local file>"} on stdout
#   exit 1  build failed on the remote, or the machine is being reclaimed (Spot): run it again
#   exit 2  bad invocation or missing settings
#   exit 3  cloud-up.sh refused (ask user and retry with --approved)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/cloud-lib.sh"

PROFILE="${1:-production}"
TICKET="${2:-$(git branch --show-current 2>/dev/null || basename "$(pwd)")}"
TICKET="$(printf %s "$TICKET" | tr -cd 'A-Za-z0-9._-')"
[ -n "$TICKET" ] || { echo "cannot determine ticket; pass one as the second argument" >&2; exit 2; }

# The build's own name, never an agent's: an agent on this branch has the worktree, Compose project, and machine
# registration <ticket>-<slug>, which this build must not touch (development-setup DS2, DS3; machine policy DM5).
NAME="android-$TICKET-$$"
REMOTE_ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
BRANCH="$(git branch --show-current 2>/dev/null || echo main)"

# Get a dev machine
echo "provisioning EC2 dev machine for Android build..." >&2
MACHINE="$("$HERE/cloud-up.sh" "$NAME")"
ID="$(printf %s "$MACHINE" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).instance_id)")"
echo "machine $ID" >&2
# Set at once: cloud-up.sh has registered $NAME, and a registration left behind keeps the machine alive (DM5).
cleanup() {
  echo "cleaning up..." >&2
  "${SSH[@]}" "ec2-user@$ID" "rm -rf ~/work/$NAME" >/dev/null 2>&1 || true
  "$HERE/cloud-down.sh" "$ID" "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

need_ssh
# A new machine is reachable once SSH answers through Session Manager, and ready once cloud-init has finished.
wait_ssm "$ID" || exit 1

REMOTE="ec2-user@$ID"

# Clone or update the repo on the remote
"${SSH[@]}" "$REMOTE" "
  timeout 900 cloud-init status --wait >/dev/null
  mkdir -p ~/work
  if [ ! -d ~/work/$NAME ]; then
    if [ -n '$REMOTE_ORIGIN' ]; then
      git clone '$REMOTE_ORIGIN' ~/work/$NAME
    else
      echo 'no remote origin; cannot clone on remote' >&2
      exit 2
    fi
  fi
  cd ~/work/$NAME && git fetch && git checkout '$BRANCH' && git pull
"

# Run cloud-capacity.sh before the build
RC=0; CAP="$("$HERE/cloud-capacity.sh" "$ID" 2>/dev/null)" || RC=$?
if [ "$RC" = 3 ]; then
  echo "$ID is being reclaimed by AWS (Spot); run the build again" >&2
  exit 1
elif [ "$RC" != 0 ] && [ "$RC" != 1 ]; then
  echo "WARNING: cannot read capacity of $ID; continuing anyway" >&2
else
  echo "machine capacity: $CAP" >&2
fi

# Build
echo "building Android $PROFILE on $ID..." >&2
"${SSH[@]}" "$REMOTE" "
  cd ~/work/$NAME
  if [ -f scripts/build-android.sh ]; then
    ./scripts/build-android.sh '$PROFILE'
  else
    # Build locally on the EC2 machine. --local does not count against EAS build limits.
    npx --yes eas-cli build --platform android --profile '$PROFILE' --local --non-interactive
  fi
"

# Find and copy artifact back
ARTIFACT="$("${SSH[@]}" "$REMOTE" "find ~/work/$NAME -maxdepth 4 \( -name '*.apk' -o -name '*.aab' \) -printf '%T@ %p\\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-")"
[ -n "$ARTIFACT" ] || { echo "no APK or AAB found on remote" >&2; exit 1; }

EXT="${ARTIFACT##*.}"
LOCAL_ARTIFACT="android-${PROFILE}-$(date +%Y%m%d-%H%M%S).$EXT"
scp -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 "${PROXY[@]}" "$REMOTE:$ARTIFACT" "./$LOCAL_ARTIFACT"
echo "artifact: $LOCAL_ARTIFACT" >&2
echo "{\"artifact_path\":\"$LOCAL_ARTIFACT\"}"
