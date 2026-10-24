#!/bin/bash
# brain-spot-watch.sh — runs on a Spot machine as root; cloud-up.sh installs it through user data (machine policy DM10).
# Every 5 seconds it asks the instance metadata service whether AWS has scheduled this machine's reclaim (the Spot
# two-minute warning). On the warning it records it in /var/lib/brain/reclaim, tells every terminal (wall), and runs
# the developer's hook ~ec2-user/.brain/on-reclaim, if it is executable, as ec2-user with the seconds left as its
# argument, so agents can be stopped cleanly before AWS terminates the machine. Git reaches the remote only through a
# developer's forwarded SSH agent (DM6): while one is connected, the hook gets that agent (SSH_AUTH_SOCK) and can push;
# otherwise it can only commit, to the home volume. Its log goes to stdout.
HOOK=/home/ec2-user/.brain/on-reclaim
while sleep 5; do
  token="$(curl -s -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" \
    || continue
  # 404 until a reclaim is scheduled; then {"action":"terminate","time":"2026-10-25T12:00:00Z"}
  action="$(curl -s -f -m 2 -H "X-aws-ec2-metadata-token: $token" \
    http://169.254.169.254/latest/meta-data/spot/instance-action)" || continue
  mkdir -p /var/lib/brain && echo "$action" > /var/lib/brain/reclaim
  when="$(printf %s "$action" | sed -n 's/.*"time" *: *"\([^"]*\)".*/\1/p')"
  at=$(( $(date +%s) + 120 ))
  [ -n "$when" ] && at="$(date -d "$when" +%s 2>/dev/null || echo "$at")"
  left=$(( at - $(date +%s) ))
  echo "reclaim scheduled at $when (${left}s)"
  wall "AWS reclaims this Spot machine in about ${left}s. Work on the home volume is kept; push anything else now."
  if [ -x "$HOOK" ]; then
    # A connected developer's forwarded agent holding the key GitHub is pinned to (~/.ssh/github.pub), so the hook
    # can push.
    sock=""
    for s in /tmp/ssh-*/agent.*; do
      [ -S "$s" ] && [ "$(stat -c %U "$s")" = ec2-user ] \
        && SSH_AUTH_SOCK="$s" runuser -u ec2-user -- timeout 5 ssh-add -T /home/ec2-user/.ssh/github.pub >/dev/null 2>&1 \
        && { sock="$s"; break; }
    done
    runuser -u ec2-user -- env ${sock:+SSH_AUTH_SOCK="$sock"} timeout "$(( left > 15 ? left - 10 : 5 ))" "$HOOK" "$left" \
      || echo "on-reclaim hook failed"
  fi
  exit 0
done
