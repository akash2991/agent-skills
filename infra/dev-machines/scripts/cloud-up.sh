#!/bin/bash
# cloud-up.sh — place an agent on a shared EC2 dev machine, or launch one (machine policy DM1–DM4, DM8, DM9).
#
# Usage: infra/dev-machines/scripts/cloud-up.sh <ticket>-<slug> [--type <instance-type>] [--mac] [--format-home] [--approved "<the user's words>"]
# Settings from CLOUD_ENV_FILE or ./.env (env.example; README.md, One-time setup).
#
#   default   joins the first live dev machine whose metrics show headroom (cloud-capacity.sh) and moves its
#             deadline to CLOUD_MAX_HOURS from now; when none has room, launches CLOUD_DEFAULT_TYPE (m8i.2xlarge)
#             on Amazon Linux 2023 with Docker and Compose. Launching past CLOUD_MAX_MACHINES (2) live dev
#             machines refuses without --approved (DM2, DM3)
#   --type    launches a new machine of that type; any type but the default refuses without --approved (DM3)
#   --mac     a macOS build machine from CLOUD_MAC_AMI on CLOUD_MAC_TYPE (mac2-m2.metal); reuses a free brain Mac
#             host, and allocating a new one refuses without --approved. A new host is released 24 h after
#             allocation (DM8)
#   --approved  the user's explicit permission for this machine, recorded on the ticket
#   --format-home  format CLOUD_HOME_VOLUME on first use although it already has snapshots (the daily policy snapshots
#             a new volume before it is ever used); refuses without --approved: only on the user's word that it never
#             held a home (DM9)
#
# With CLOUD_HOME_VOLUME set (DM9), a dev machine is that developer's own: it joins only the machine that has the
# volume (waiting for it while it starts; without headroom only with --approved), and otherwise launches one in
# CLOUD_SUBNET, mounts the volume as /home/ec2-user, and reports the machine only once the mount is confirmed; a
# machine whose volume cannot be mounted is terminated. Without it, machines that hold someone's home volume are never
# joined. Home machines do not count against CLOUD_MAX_MACHINES.
#
# A machine terminates itself after CLOUD_IDLE_MINUTES with no SSH connection and no load, and at its deadline
# regardless; an EventBridge schedule terminates it at the same deadline from the AWS side (DM4). If that
# schedule cannot be created the new machine is terminated at once. Prints the machine as JSON on stdout;
# status goes to stderr.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/cloud-lib.sh"

usage() { sed -n '4p' "$0" | sed 's/^# //' >&2; exit 2; }
TICKET="$(tag_safe "${1:-}" | tr -cd 'A-Za-z0-9._-')"
[ -n "$TICKET" ] && [ "${1#-}" = "$1" ] || usage
shift
TYPE=""; MAC=0; APPROVED=""; FORMAT_HOME=0
while [ $# -gt 0 ]; do
  case "$1" in
    --type) TYPE="$2"; shift 2 ;;
    --mac) MAC=1; shift ;;
    --approved) APPROVED="$(tag_safe "$2")"; shift 2 ;;
    --format-home) FORMAT_HOME=1; shift ;;
    *) usage ;;
  esac
done
need CLOUD_SUBNET CLOUD_SECURITY_GROUP CLOUD_KEY_NAME CLOUD_SCHEDULER_ROLE_ARN CLOUD_INSTANCE_PROFILE
need_ssh

refuse() { echo "refused: $1. Ask the user, record the answer on the ticket, and pass --approved \"<their words>\" (DM3)." >&2; exit 3; }
machine_json() { echo "{\"instance_id\":\"$1\",\"type\":\"$2\",\"host_id\":\"$3\",\"home_volume\":\"$4\",\"ssh\":\"$SSH_HINT$1\",\"expires_at\":\"$5\",\"joined\":$6}"; }
[ "$MAC" = 0 ] || HOME_VOLUME=""

NOW="$(date +%s)"
DEADLINE=$(( NOW + MAX_HOURS * 3600 ))
EXPIRES="$(iso_utc "$DEADLINE")Z"

# setup_reason <instance-id>: why the machine's user data gave up, from its console output, or where to look.
setup_reason() {
  local r
  r="$(aws ec2 get-console-output --instance-id "$1" --latest --query Output --output text 2>/dev/null \
    | grep -o '[a-z][^]]*, shutting down' | tail -1)"
  echo "${r:-its console output has no shutdown reason yet (aws ec2 get-console-output --instance-id $1 --latest)}"
}

# register <instance-id>: mark this agent, by its work directory <ticket>-<slug>, as on the machine until cloud-down.sh
# removes the mark (DM5); two agents on one ticket are two marks.
register() { "${SSH[@]}" "ec2-user@$1" "sudo mkdir -p /run/brain-agents && sudo touch /run/brain-agents/$TICKET"; }

# Join a live dev machine with headroom (DM2); with a home volume, only the machine that has it (DM9). Only shared
# machines count against CLOUD_MAX_MACHINES: a home machine is one per volume.
if [ "$MAC" = 0 ] && [ -z "$TYPE" ]; then
  LIVE=0
  while read -r id type expires home; do
    [ -n "$id" ] || continue
    [ "$home" = None ] && LIVE=$((LIVE + 1))
    [ "$home" = "${HOME_VOLUME:-None}" ] || continue
    RC=0; CAP="$("$HERE/cloud-capacity.sh" "$id" 2>/dev/null)" || RC=$?
    if [ "$RC" = 2 ] && [ -n "$HOME_VOLUME" ]; then
      echo "$id is still starting; waiting for it" >&2
      if wait_ssm "$id"; then RC=0; CAP="$("$HERE/cloud-capacity.sh" "$id" 2>/dev/null)" || RC=$?; fi
    fi
    if [ "$RC" = 0 ] || { [ "$RC" = 1 ] && [ -n "$HOME_VOLUME" ] && [ -n "$APPROVED" ]; }; then
      [ "$RC" = 0 ] || echo "WARNING: joining $id without headroom, as approved: ${CAP:-metrics unreadable}" >&2
      echo "joining $id ($type): $CAP" >&2
      if [ -n "$HOME_VOLUME" ]; then
        # A home machine that is still starting may answer before its home is mounted over ~ (DM9).
        "${SSH[@]}" "ec2-user@$id" "timeout 900 cloud-init status --wait >/dev/null; mountpoint -q ~" \
          || { echo "refused: $id has no home volume mounted on ~; $(setup_reason "$id") (DM9)" >&2; exit 1; }
      fi
      register "$id" || echo "WARNING: could not register on $id; cloud-down.sh may terminate it under another agent" >&2
      if [[ "$expires" < "$EXPIRES" ]]; then
        if schedule update "brain-kill-$id" "$DEADLINE" terminateInstances "{\"InstanceIds\":[\"$id\"]}"; then
          aws ec2 create-tags --resources "$id" --tags "Key=brain:expires-at,Value=$EXPIRES"
          "${SSH[@]}" "ec2-user@$id" "sudo sed -i 's/^DEADLINE=.*/DEADLINE=$DEADLINE/' /usr/local/etc/brain-watchdog.env" \
            || echo "WARNING: could not move the watchdog deadline on $id; it stays at $expires" >&2
          expires="$EXPIRES"
        else
          echo "WARNING: could not move the deadline of $id; it stays at $expires" >&2
        fi
      fi
      machine_json "$id" "$type" "" "$HOME_VOLUME" "$expires" true
      exit 0
    fi
    echo "$id has no headroom: ${CAP:-metrics unreadable}" >&2
    [ -z "$HOME_VOLUME" ] || refuse "$id holds your home volume and has no headroom; wait for it, or join it anyway (DM2, DM9)"
  done < <(aws ec2 describe-instances --filters Name=tag:brain,Values=dev Name=tag:brain:kind,Values=dev Name=instance-state-name,Values=pending,running \
    --query "Reservations[].Instances[].[InstanceId, InstanceType, Tags[?Key=='brain:expires-at']|[0].Value, Tags[?Key=='brain:home-volume']|[0].Value]" --output text)
  [ -n "$HOME_VOLUME" ] || [ "$LIVE" -lt "$MAX_MACHINES" ] || [ -n "$APPROVED" ] || refuse "$LIVE shared dev machines are live and none has headroom; another passes CLOUD_MAX_MACHINES ($MAX_MACHINES)"
fi

EXTRA=()
HOST=""
if [ "$MAC" = 1 ]; then
  need CLOUD_MAC_AMI
  KIND=mac
  TYPE="${TYPE:-$MAC_TYPE}"
  AMI="$CLOUD_MAC_AMI"
  HOST="$(aws ec2 describe-hosts --filter Name=tag:brain,Values=dev "Name=instance-type,Values=$TYPE" Name=state,Values=available \
    --query 'Hosts[?length(Instances)==`0`] | [0].HostId' --output text)"
  [ "$HOST" = None ] && HOST=""
  if [ -n "$HOST" ]; then
    echo "reusing Mac host $HOST" >&2
  else
    [ -n "$APPROVED" ] || refuse "a new $TYPE host bills for at least 24 hours (DM8)"
    AZ="$(aws ec2 describe-subnets --subnet-ids "$CLOUD_SUBNET" --query 'Subnets[0].AvailabilityZone' --output text)"
    HOST="$(aws ec2 allocate-hosts --instance-type "$TYPE" --availability-zone "$AZ" --quantity 1 \
      --tag-specifications "[{\"ResourceType\":\"dedicated-host\",\"Tags\":[{\"Key\":\"brain\",\"Value\":\"dev\"},{\"Key\":\"brain:ticket\",\"Value\":\"$TICKET\"},{\"Key\":\"brain:approved\",\"Value\":\"$APPROVED\"}]}]" \
      --query 'HostIds[0]' --output text)"
    echo "allocated Mac host $HOST in $AZ" >&2
    schedule create "brain-release-$HOST" $(( NOW + 24 * 3600 + 300 )) releaseHosts "{\"HostIds\":[\"$HOST\"]}" \
      || echo "WARNING: could not schedule the release of $HOST; run cloud-reap.sh after 24 hours to release it" >&2
  fi
  EXTRA+=(--placement "HostId=$HOST,Tenancy=host")
else
  KIND=dev
  TYPE="${TYPE:-$DEFAULT_TYPE}"
  [ "$TYPE" = "$DEFAULT_TYPE" ] || [ -n "$APPROVED" ] || refuse "$TYPE is not the default $DEFAULT_TYPE"
  ARCH="$(aws ec2 describe-instance-types --instance-types "$TYPE" --query 'InstanceTypes[0].ProcessorInfo.SupportedArchitectures[0]' --output text)"
  AMI="${CLOUD_AMI:-$(aws ssm get-parameter --name "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-$ARCH" --query Parameter.Value --output text)}"
  EXTRA+=(--block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":$DISK_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]")
  if [ -n "$HOME_VOLUME" ]; then
    read -r VSTATE VAZ VOWNER <<<"$(aws ec2 describe-volumes --volume-ids "$HOME_VOLUME" \
      --query "Volumes[0].[State, AvailabilityZone, Tags[?Key=='brain:home']|[0].Value]" --output text)"
    SAZ="$(aws ec2 describe-subnets --subnet-ids "$CLOUD_SUBNET" --query 'Subnets[0].AvailabilityZone' --output text)"
    [ -n "$VOWNER" ] && [ "$VOWNER" != None ] || { echo "$HOME_VOLUME is not a brain home volume (no brain:home tag)" >&2; exit 2; }
    # A volume that has ever been snapshotted may hold a home: its machine formats it only with --format-home.
    SNAPS="$(aws ec2 describe-snapshots --owner-ids self --filters "Name=volume-id,Values=$HOME_VOLUME" \
      --query 'length(Snapshots)' --output text)" || { echo "cannot list the snapshots of $HOME_VOLUME" >&2; exit 1; }
    FORMAT_OK=0
    { [ "$SNAPS" = 0 ] || [ "$FORMAT_HOME" = 1 ]; } && FORMAT_OK=1
    [ "$FORMAT_HOME" = 0 ] || [ -n "$APPROVED" ] || refuse "--format-home formats $HOME_VOLUME if it has no filesystem; only on the user's word that it never held a home"
    echo "home volume $HOME_VOLUME belongs to $VOWNER" >&2
    [ "$VSTATE" = available ] || { echo "home volume $HOME_VOLUME is $VSTATE, not available; cloud-reap.sh lists the machine that has it" >&2; exit 1; }
    [ "$VAZ" = "$SAZ" ] || { echo "home volume $HOME_VOLUME is in $VAZ but CLOUD_SUBNET is in $SAZ" >&2; exit 2; }
  fi
fi

OWNER="$(tag_safe "$(git config user.email 2>/dev/null || echo "${USER:-unknown}")")"
TMP="$(mktemp -t brain-user-data.XXXXXX)"
trap 'rm -f "$TMP"' EXIT
{
  echo '#!/bin/bash'
  echo 'mkdir -p /usr/local/bin /usr/local/etc'
  printf 'printf "IDLE_MINUTES=%s\\nDEADLINE=%s\\n" > /usr/local/etc/brain-watchdog.env\n' "$IDLE_MINUTES" "$DEADLINE"
  echo "cat > /usr/local/bin/brain-watchdog <<'WATCHDOG'"
  cat "$HERE/brain-watchdog.sh"
  echo 'WATCHDOG'
  echo 'chmod +x /usr/local/bin/brain-watchdog'
  if [ -n "$HOME_VOLUME" ]; then
    # DM9: the home volume becomes ec2-user's home before anything is written there. cloud-up.sh attaches it once
    # the machine runs; a machine it never reaches shuts down, which terminates it.
    printf 'DEV=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_%s\nFORMAT_OK=%s\n' "${HOME_VOLUME//-/}" "$FORMAT_OK"
    cat <<'HOMEVOL'
fail() { echo "$1, shutting down"; shutdown -h now; exit 1; }
H="$(eval echo ~ec2-user)"
for i in $(seq 150); do [ -e "$DEV" ] && break; sleep 2; done
[ -e "$DEV" ] || fail "home volume never attached"
udevadm settle
for i in $(seq 15); do head -c 4096 "$DEV" >/dev/null 2>&1 && break; sleep 2; done
head -c 4096 "$DEV" >/dev/null 2>&1 || fail "home volume unreadable"
NEW=0
blkid -p "$DEV" >/dev/null 2>&1 && RC=0 || RC=$?
[ "$RC" = 0 ] || [ "$RC" = 2 ] || fail "blkid cannot tell what is on the home volume (exit $RC)"
if [ "$RC" = 2 ]; then
  # A new volume need not read back as zeros, so "no filesystem" decides, with two guards: a snapshotted volume is
  # formatted only on --format-home, and one whose primary superblock is gone but an ext4 backup survives is a damaged
  # home, never formatted.
  [ "$FORMAT_OK" = 1 ] || fail "home volume has no filesystem but has snapshots; if it never held a home, rerun cloud-up.sh with --format-home --approved, else restore it from a snapshot"
  for sb in 8193:1024 16384:2048 32768:4096 98304:4096; do
    dumpe2fs -h -o superblock="${sb%:*}" -o blocksize="${sb#*:}" "$DEV" >/dev/null 2>&1 \
      && fail "home volume has an ext4 backup superblock but no readable filesystem; repair it, never format it"
  done
  mkfs.ext4 -q -b 4096 -L brain-home "$DEV" || fail "could not format the home volume"
  NEW=1
fi
mkdir -p /mnt/brain-home && mount "$DEV" /mnt/brain-home || fail "could not mount the home volume"
[ "$NEW" = 0 ] || cp -a "$H/." /mnt/brain-home/ || fail "could not seed the new home volume"
# The key that launched this machine logs in, whatever an earlier machine left there.
mkdir -p /mnt/brain-home/.ssh && cp "$H/.ssh/authorized_keys" /mnt/brain-home/.ssh/authorized_keys || fail "could not install the login key"
umount /mnt/brain-home && mount "$DEV" "$H" && mountpoint -q "$H" || fail "could not mount the home volume on $H"
chown ec2-user:ec2-user "$H" "$H/.ssh" "$H/.ssh/authorized_keys"
chmod 700 "$H/.ssh" && chmod 600 "$H/.ssh/authorized_keys"
echo "$DEV $H ext4 defaults,nofail 0 2" >> /etc/fstab
# The watchdog shuts the machine down if the home is ever not mounted, after a reboot for one.
echo "HOME_MOUNT=$H" >> /usr/local/etc/brain-watchdog.env
HOMEVOL
  fi
  # Git reaches GitHub with the key that logs in (DM6): the forwarded agent may hold several GitHub keys, so pin the
  # one whose public half is in authorized_keys. GitHub's host keys come from its API over TLS, not from the first scan.
  # A home volume keeps these files, so each is rewritten, never appended to twice.
  cat <<'GITHUB'
H="$(eval echo ~ec2-user)"
for i in $(seq 30); do [ -s "$H/.ssh/authorized_keys" ] && break; sleep 2; done
head -n 1 "$H/.ssh/authorized_keys" > "$H/.ssh/github.pub"
{ grep -v '^github\.com ' "$H/.ssh/known_hosts" 2>/dev/null
  curl -fsSL https://api.github.com/meta | tr -d '\n' | grep -o '"ssh_keys": *\[[^]]*\]' | grep -oE '"(ssh|ecdsa)-[^"]*"' \
    | tr -d '"' | sed 's/^/github.com /'; } > "$H/.ssh/known_hosts.new"
mv "$H/.ssh/known_hosts.new" "$H/.ssh/known_hosts"
grep -q '^Host github.com$' "$H/.ssh/config" 2>/dev/null \
  || printf 'Host github.com\n    User git\n    IdentityFile ~/.ssh/github.pub\n    IdentitiesOnly yes\n' >> "$H/.ssh/config"
chown ec2-user "$H/.ssh/github.pub" "$H/.ssh/known_hosts" "$H/.ssh/config"
chmod 600 "$H/.ssh/config"
GITHUB
  if [ "$MAC" = 1 ]; then
    echo 'nohup /usr/local/bin/brain-watchdog >/var/log/brain-watchdog.log 2>&1 &'
  else
    # A unit, not systemd-run, so the watchdog comes back after a reboot and checks the home mount again (DM4, DM9).
    printf '%s\n' '[Unit]' 'Description=brain watchdog' '[Service]' 'ExecStart=/usr/local/bin/brain-watchdog' 'Restart=always' \
      '[Install]' 'WantedBy=multi-user.target' | sed 's/^/echo "/; s/$/" >> \/etc\/systemd\/system\/brain-watchdog.service/'
    echo 'systemctl daemon-reload && systemctl enable --now brain-watchdog'
    echo 'dnf install -y docker git'
    echo 'systemctl enable --now docker'
    echo 'usermod -aG docker ec2-user'
    echo 'mkdir -p /usr/local/lib/docker/cli-plugins /home/ec2-user/work'
    echo 'chown ec2-user:ec2-user /home/ec2-user/work'
    echo 'curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" -o /usr/local/lib/docker/cli-plugins/docker-compose'
    echo 'chmod +x /usr/local/lib/docker/cli-plugins/docker-compose'
  fi
} > "$TMP"

TAGS="{\"Key\":\"Name\",\"Value\":\"brain-$KIND-$TICKET\"},{\"Key\":\"brain\",\"Value\":\"dev\"},{\"Key\":\"brain:kind\",\"Value\":\"$KIND\"},{\"Key\":\"brain:ticket\",\"Value\":\"$TICKET\"},{\"Key\":\"brain:owner\",\"Value\":\"$OWNER\"},{\"Key\":\"brain:expires-at\",\"Value\":\"$EXPIRES\"}"
[ -n "$APPROVED" ] && TAGS="$TAGS,{\"Key\":\"brain:approved\",\"Value\":\"$APPROVED\"}"
[ -n "$HOME_VOLUME" ] && TAGS="$TAGS,{\"Key\":\"brain:home-volume\",\"Value\":\"$HOME_VOLUME\"}"

echo "launching $TYPE ($KIND) for $TICKET until $EXPIRES" >&2
ID="$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --key-name "$CLOUD_KEY_NAME" \
  --network-interfaces "[{\"DeviceIndex\":0,\"SubnetId\":\"$CLOUD_SUBNET\",\"Groups\":[\"$CLOUD_SECURITY_GROUP\"],\"AssociatePublicIpAddress\":true}]" \
  --iam-instance-profile "Name=$CLOUD_INSTANCE_PROFILE" \
  --instance-initiated-shutdown-behavior terminate \
  --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1 \
  --user-data "file://$TMP" \
  --tag-specifications "[{\"ResourceType\":\"instance\",\"Tags\":[$TAGS]},{\"ResourceType\":\"volume\",\"Tags\":[$TAGS]}]" \
  "${EXTRA[@]}" \
  --query 'Instances[0].InstanceId' --output text)"

if ! schedule create "brain-kill-$ID" "$DEADLINE" terminateInstances "{\"InstanceIds\":[\"$ID\"]}"; then
  aws ec2 terminate-instances --instance-ids "$ID" >/dev/null
  echo "could not schedule the AWS-side termination of $ID, so it was terminated (DM4); check CLOUD_SCHEDULER_ROLE_ARN" >&2
  exit 1
fi

aws ec2 wait instance-running --instance-ids "$ID" || echo "$ID is still starting; cloud-reap.sh lists it" >&2
if [ -n "$HOME_VOLUME" ] && ! aws ec2 attach-volume --volume-id "$HOME_VOLUME" --instance-id "$ID" --device /dev/sdh >/dev/null; then
  aws ec2 terminate-instances --instance-ids "$ID" >/dev/null
  aws scheduler delete-schedule --name "brain-kill-$ID" >/dev/null 2>&1 || true
  echo "could not attach home volume $HOME_VOLUME to $ID, so it was terminated (DM9)" >&2
  exit 1
fi
if [ "$MAC" = 0 ]; then
  # Report the machine only once it answers (and, with a home volume, has it mounted), and register this agent on it,
  # so cloud-down.sh never terminates it under an agent (DM5, DM9).
  echo "waiting for $ID${HOME_VOLUME:+ to mount $HOME_VOLUME}" >&2
  WHY=""; RC=0
  wait_ssm "$ID" || RC=$?
  if [ "$RC" = 2 ]; then
    WHY="it shut itself down during setup"
  elif [ "$RC" != 0 ]; then
    WHY="it never answered over SSH"
  elif [ -n "$HOME_VOLUME" ] && ! "${SSH[@]}" "ec2-user@$ID" "timeout 900 cloud-init status --wait >/dev/null; mountpoint -q ~"; then
    WHY="home volume $HOME_VOLUME was not mounted"
  elif ! register "$ID"; then
    WHY="this agent could not register on it"
  fi
  if [ -n "$WHY" ]; then
    WHY="$WHY; $(setup_reason "$ID")"
    aws ec2 terminate-instances --instance-ids "$ID" >/dev/null
    aws scheduler delete-schedule --name "brain-kill-$ID" >/dev/null 2>&1 || true
    echo "$ID was terminated: $WHY (DM5)" >&2
    exit 1
  fi
fi
machine_json "$ID" "$TYPE" "$HOST" "$HOME_VOLUME" "$EXPIRES" false
