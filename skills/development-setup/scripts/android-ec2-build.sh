#!/bin/bash
# android-ec2-build.sh — build the Android app on an EC2 dev machine in Docker (development-setup DS16).
#
# Usage: skills/development-setup/scripts/android-ec2-build.sh [<profile>] [<ticket>]
# Run from the project root. The profile is passed to the build command; the ticket defaults to the
# current branch name. Builds Android in a Docker container on a shared EC2 dev machine and copies
# the artifact back.
#
# The build command is, in order of preference:
#   1. scripts/build-android.sh <profile>  (project-specific)
#   2. eas build --platform android --profile <profile> --local --non-interactive
#      (runs on the EC2 machine, does not count against EAS build limits)
#
#   exit 0  built successfully; prints {"artifact_path":"<local file>"} on stdout
#   exit 1  build failed on the remote
#   exit 2  bad invocation or missing settings
#   exit 3  cloud-up.sh refused (ask user and retry with --approved)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/cloud-lib.sh"

PROFILE="${1:-production}"
TICKET="${2:-$(git branch --show-current 2>/dev/null || basename "$(pwd)")}"
TICKET="$(printf %s "$TICKET" | tr -cd 'A-Za-z0-9._-')"
[ -n "$TICKET" ] || { echo "cannot determine ticket; pass one as the second argument" >&2; exit 2; }

REMOTE_ORIGIN="$(git remote get-url origin 2>/dev/null || true)"
BRANCH="$(git branch --show-current 2>/dev/null || echo main)"

# Get a dev machine
echo "provisioning EC2 dev machine for Android build..." >&2
MACHINE="$("$HERE/cloud-up.sh" "$TICKET")"
ID="$(printf %s "$MACHINE" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).instance_id)")"
IP="$(printf %s "$MACHINE" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).public_ip)")"
echo "machine $ID at $IP" >&2

cleanup() {
  echo "cleaning up..." >&2
  "$HERE/cloud-down.sh" "$ID" "$TICKET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

REMOTE="ec2-user@$IP"

# Clone or update the repo on the remote
"${SSH[@]}" "$REMOTE" "
  mkdir -p ~/work
  if [ ! -d ~/work/$TICKET ]; then
    if [ -n '$REMOTE_ORIGIN' ]; then
      git clone '$REMOTE_ORIGIN' ~/work/$TICKET
    else
      echo 'no remote origin; cannot clone on remote' >&2
      exit 2
    fi
  fi
  cd ~/work/$TICKET && git fetch && git checkout '$BRANCH' && git pull
"

# Run cloud-capacity.sh before the build
if ! CAP="$("$HERE/cloud-capacity.sh" "$IP" 2>/dev/null)"; then
  echo "WARNING: cannot read capacity of $ID; continuing anyway" >&2
else
  echo "machine capacity: $CAP" >&2
fi

# Build
echo "building Android $PROFILE on $ID..." >&2
"${SSH[@]}" "$REMOTE" "
  cd ~/work/$TICKET
  if [ -f scripts/build-android.sh ]; then
    ./scripts/build-android.sh '$PROFILE'
  else
    # Build locally on the EC2 machine. --local does not count against EAS build limits.
    npx --yes eas-cli build --platform android --profile '$PROFILE' --local --non-interactive
  fi
"

# Find and copy artifact back
ARTIFACT="$(${SSH[@]} "$REMOTE" "find ~/work/$TICKET -maxdepth 4 \( -name '*.apk' -o -name '*.aab' \) -printf '%T@ %p\\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-")"
[ -n "$ARTIFACT" ] || { echo "no APK or AAB found on remote" >&2; exit 1; }

EXT="${ARTIFACT##*.}"
LOCAL_ARTIFACT="android-${PROFILE}-$(date +%Y%m%d-%H%M%S).$EXT"
scp -o StrictHostKeyChecking=accept-new -o ConnectTimeout=30 "$REMOTE:$ARTIFACT" "./$LOCAL_ARTIFACT"
echo "artifact: $LOCAL_ARTIFACT" >&2
echo "{\"artifact_path\":\"$LOCAL_ARTIFACT\"}"
