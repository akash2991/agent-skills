# Dev machines (source repository only)

The EC2 machines a developer can work on, with their agents: provisioning (Terraform), the scripts that launch, join, leave, and reap them, and the policy that keeps them few, private, and short-lived. This folder lives only in the brain source repository. It is not a skill and is never installed into a project: the build copies `skills/`, `agents/`, `references/`, `templates/`, and `project/`, never `infra/`. Agents do not know which machine they run on; on one of these machines an agent follows `development-setup` exactly as it would on a laptop.

The scripts read their settings from the file named by `CLOUD_ENV_FILE`, else `.env` in the current directory; `env.example` lists them.

## Machine policy

| ID | Policy |
| --- | --- |
| DM1 | **Machines are shared and reached through `scripts/cloud-up.sh`.** One machine hosts several agents at once; each sets up its environment there exactly as on a laptop (`development-setup`), with the main checkout at `~/work/<repo-name>` and its worktree beside it at `~/work/<ticket>-<slug>`. `cloud-up.sh` registers each agent on the machine under its worktree basename. |
| DM2 | **Metrics decide when another machine launches.** `cloud-up.sh` joins a live machine whose metrics show headroom (`scripts/cloud-capacity.sh`: 15-minute CPU under 70%, memory under 75%, disk under 80%); another machine launches only when none has. |
| DM3 | **The default type, anything else with permission.** A new machine is `m8i.2xlarge` (`CLOUD_DEFAULT_TYPE`). Any other type, more than `CLOUD_MAX_MACHINES` (2) shared machines live at once, and every new Mac host only with the user's explicit permission for that machine (`--approved`), asked with the evidence. Permission for one machine never carries to the next. |
| DM4 | **An unused machine dies.** A machine terminates itself after `CLOUD_IDLE_MINUTES` (30) with no SSH connection and no load, and at its deadline regardless, `CLOUD_MAX_HOURS` (8) after the last agent joined; an AWS-side schedule terminates it at that deadline if it cannot. Terminate, never stop: a stopped machine still bills its disk. |
| DM5 | **Leave when done, reap at every start and end.** `scripts/cloud-down.sh <instance-id> <ticket>-<slug>` stops that agent's Compose project and removes its registration, and terminates the machine when no agent is registered (on a home machine, also no other SSH session); it never deletes a directory, as the agent removes its own worktree. `scripts/cloud-reap.sh` at the start and the end of every session that uses the cloud. |
| DM6 | **Nothing lives only on the machine, and no AWS credentials go onto it.** Git reaches the remote through SSH agent forwarding; the AWS profile's credentials, tokens, and keys stay on the developer's computer. SSH runs only inside a Session Manager session, and services only through SSH tunnels; the security group has no inbound rule. |
| DM7 | **Android can build on a dev machine.** `scripts/android-ec2-build.sh` joins or launches one and runs the build there, when the developer's own computer cannot (`development-setup` DS16 still decides Android versus EAS). |
| DM8 | **An iOS build on AWS is a 24-hour commitment.** An EC2 Mac runs on a dedicated host billed for at least 24 hours: only with that stated and approved (DM3); reuse an allocated host for every iOS build in those 24 hours, and let the scheduled release free it. |
| DM9 | **A developer's files persist on their own home volume, never on a machine.** With `CLOUD_HOME_VOLUME` set, `cloud-up.sh` joins the machine that has that volume, or launches one in its zone and reports it only once the volume is mounted as `/home/ec2-user`. The machine stays short-lived (DM4) and is that developer's alone: no one else's agents join it, and it does not count against `CLOUD_MAX_MACHINES`. One volume per developer, listed in the Terraform. |
| DM10 | **A machine may run on Spot.** `cloud-up.sh --spot` (or `CLOUD_SPOT=1`) launches the same machine at Spot's price, typically 55–75% less, which AWS may reclaim with a two-minute warning; with no Spot capacity it launches on-demand and says so. The machine watches for the warning every 5 seconds (`brain-spot-watch`), tells every terminal, and runs the developer's `~/.brain/on-reclaim` hook, if present, to stop agents cleanly; the hook can push work in progress while a developer is connected (their forwarded agent, DM6), and otherwise commits it to the home volume. A machine being reclaimed is never joined. Work on a home volume survives a reclaim like any termination (DM9); running processes do not. Mac machines are never Spot. After a reclaim, `scripts/spot-relaunch-watch.sh` on the developer's computer launches the replacement and Herdr resumes the agents ("Surviving a Spot reclaim"). |

## One-time setup

The user creates these once per AWS account; when one is missing, the script names it.

The network, access, and deadline role are defined in the [brain source repository's Terraform directory](https://github.com/akash2991/agent-skills/tree/main/infra/dev-machines/terraform), applied once per AWS account and shared by every project in it: a dev VPC with public subnets and no NAT gateway, the `brain-dev` security group (no inbound rule: SSH runs inside Session Manager), the `brain-dev-machine` instance profile its SSM agent registers with, the `brain-dev` key pair, the `brain-dev-scheduler` role, a home volume per developer with daily snapshots (DM9), and a `brain-dev-operator` policy to attach to each developer's IAM user or role. State is in the S3 bucket `init.sh` creates.

For initial setup or account-wide changes, run these from a checkout of this repository:

```bash
cd /path/to/agent-skills/infra/dev-machines/terraform
cp terraform.tfvars.example terraform.tfvars      # the profile, the public key, each developer's home volume
./init.sh <aws-profile>
terraform plan -out=dev.tfplan && terraform apply dev.tfplan
terraform output -raw env                         # paste into the settings file (env.example)
terraform output home_volume_ids                  # each developer's CLOUD_HOME_VOLUME
```

Nobody's address is listed: Session Manager lets in whoever's AWS profile may start a session on a `brain=dev` machine (`brain-dev-operator`). Each developer installs the Session Manager plugin once (`brain-dev-operator` cannot do it for them): `brew install --cask session-manager-plugin`.

A new developer's home volume is a line in `home_volumes` and another apply. Terraform never deletes one (`prevent_destroy`): to retire a volume, let a last snapshot finish, run `terraform state rm 'aws_ebs_volume.home["<name>"]'`, remove the line, apply, and delete the volume by hand.

| Setting | What it is |
|---|---|
| `AWS_PROFILE` | the profile the scripts run as; its credentials stay on this machine (DM6) |
| `CLOUD_REGION` | the region for every brain machine |
| `CLOUD_SUBNET` | a subnet that assigns public addresses, used for outbound traffic only, in the home volumes' zone |
| `CLOUD_SECURITY_GROUP` | no inbound rule at all; outbound for packages, images, git, and Session Manager (DM6) |
| `CLOUD_INSTANCE_PROFILE` | the instance profile whose role lets a machine's SSM agent register and carry sessions, nothing else; bridge-networked containers on the machine cannot reach it (metadata hop limit 1) |
| `CLOUD_KEY_NAME` | an EC2 key pair whose private key is in this machine's SSH agent |
| `CLOUD_HOME_VOLUME` | optional: this developer's home volume, from `terraform output home_volume_ids` (DM9) |
| `CLOUD_SCHEDULER_ROLE_ARN` | a role EventBridge Scheduler assumes (trust `scheduler.amazonaws.com`) with `ec2:TerminateInstances` and `ec2:ReleaseHosts`, conditioned on the tag `brain=dev` |
| `CLOUD_MAC_AMI` | for iOS on AWS only: a macOS AMI prepared with the Xcode, Node, CocoaPods, and EAS CLI versions the project pins, and the SSM agent running (AWS's macOS AMIs include it), since Session Manager is the only way in |

A settings file that predates Session Manager adds `CLOUD_INSTANCE_PROFILE` from `terraform output -raw env`; until then `cloud-up.sh` refuses and names it.

The tunables, with their defaults, are in `env.example`.

The profile needs the `brain-dev-operator` policy and nothing more; attach it rather than rebuilding it by hand. It assumes EBS encryption with the default `aws/ebs` key; in an account that encrypts with its own KMS key by default, a developer also needs `kms:CreateGrant`, `kms:Decrypt`, and `kms:GenerateDataKeyWithoutPlaintext` on that key through EC2 (`kms:ViaService`), or every launch and attach fails. It launches machines only in the brain VPC with the `brain-dev` group and the `brain=dev` tag, tags only at creation (afterwards only a machine's `brain:expires-at`), attaches only `brain:home` volumes to `brain=dev` machines, opens Session Manager SSH only to `brain=dev` machines, and passes only the scheduler and machine roles.

## What guards the cost

| Guard | Where | Stops |
|---|---|---|
| Sharing | `cloud-up.sh` joins the first live machine with headroom by `cloud-capacity.sh` | a machine per agent (DM2) |
| Size and count | `cloud-up.sh` refuses another type, a machine past `CLOUD_MAX_MACHINES`, and a new Mac host without `--approved` | the machine nobody asked for (DM3) |
| Idle | a watchdog on the machine | a machine with no SSH connection and a load under a quarter of its vCPUs for `CLOUD_IDLE_MINUTES` (DM4) |
| Deadline | the watchdog, and an EventBridge schedule from the AWS side; each join moves it to `CLOUD_MAX_HOURS` from then | a forgotten or hung machine (DM4) |
| Shutdown | `--instance-initiated-shutdown-behavior terminate` | the disk bill: a shutdown terminates, it never stops (DM4) |
| Leaving | `cloud-down.sh` terminates when the last registered agent has left (on a home machine, also the last other SSH session) | a machine nobody is on (DM5) |
| Reaper | `cloud-reap.sh` at every session's start and end | expired or stopped machines, stale schedules, Mac hosts past 24 hours (DM5) |

A job left running detached with no SSH connection and a low load is idle; keep the SSH session open for the length of any long job.

## Metrics

The watchdog appends `epoch load1 vcpus mem_used_pct disk_used_pct` to `/var/lib/brain/metrics` every minute. `cloud-capacity.sh <instance-id>` reads the last 15 minutes and says whether the machine has headroom: average load under `CLOUD_MAX_CPU_PCT` of its vCPUs, and memory and disk under `CLOUD_MAX_MEM_PCT` and `CLOUD_MAX_DISK_PCT`. A machine with under 5 minutes of metrics counts as having room. These are the machine's metrics, not the app's: a project's own Prometheus and Grafana stay per agent (`development-setup` DS6). Run it yourself before starting a heavy job (a full build, a load test) on a shared machine; if it shows no headroom, wait or ask for another machine with its output as the evidence (DM3).

## Working on a machine

1. `scripts/cloud-reap.sh`.
2. `scripts/cloud-up.sh <ticket>-<slug>` joins a machine with headroom or launches one, and prints `instance_id`, `home_volume`, `ssh`, `expires_at`, `joined`, and `spot`. When it refuses, decide with its message and the metrics, then rerun with `--approved "<their words>"` (and `--type <type>` for a larger machine).
3. SSH by instance ID inside a Session Manager session, with the command `cloud-up.sh` printed or this entry in `~/.ssh/config`, then `ssh <instance-id>`:
   ```
   Host i-*
     User ec2-user
     ForwardAgent yes
     ServerAliveInterval 30
     ProxyCommand aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters portNumber=%p --profile <AWS_PROFILE> --region <CLOUD_REGION>
   ```
   A new machine answers once SSH answers through Session Manager, a minute or two after launch; then wait for `cloud-init status --wait`. Session Manager closes a session after 20 minutes without input; the keepalive is that input. Clone the main repository once into `~/work/<repo-name>`, unless it is there already. The forwarded agent pushes, and the machine pins GitHub to the key that logged in (`CLOUD_KEY_NAME`'s key), so an agent holding a work and a personal GitHub key uses the right one; clone with `git@github.com:<owner>/<repo>.git`. Nothing else is copied over (DM6).
4. Set up the environment as on a laptop (`development-setup`): the worktree beside the main checkout, its own Compose project and ports, LocalStack, data. `docker ps --format '{{.Ports}}'` shows the ports other agents on the machine already use.
5. Reach a service with a tunnel, `ssh -L 3000:localhost:<port> <instance-id>`; never open a port on the security group.
6. Done with the work: remove the worktree as `development-setup` says.
7. Leave: `scripts/cloud-down.sh <instance-id> <ticket>-<slug>`, then `scripts/cloud-reap.sh`.

## Home volume

With `CLOUD_HOME_VOLUME` set, a developer's machine mounts their home volume as `/home/ec2-user` (DM9), so `~/work`, agent sessions, user-level tools, and anything else under the home folder survive termination; Docker images, system packages, and everything else on the root disk do not. The first machine formats an empty volume; later ones mount it as it was.

- One machine at a time: the volume attaches to one machine, in its zone, so `cloud-up.sh` joins the machine that has it, waits for it while it starts, and joins it without headroom only with `--approved`. Each agent on it is registered in `/var/lib/brain/agents` until `cloud-down.sh`.
- Mounted or nothing: the first machine formats the volume only if it holds no filesystem and no ext4 backup superblock (a damaged home is refused, never formatted), and, once the daily policy has snapshotted it, only with `cloud-up.sh --format-home --approved "<the user's words>"` that it never held a home; a launch that fails says which step failed and the machine's own shutdown reason; a machine that cannot mount it, or loses the mount, shuts down, and `cloud-up.sh` reports the machine only after it confirmed the mount. Machine metrics count the fuller of the root disk and the home volume.
- Snapshots: daily at 17:00 UTC, kept for `snapshot_days` (7); each stores only the blocks changed since the last. Restoring is the user's, with administrator access, since the operator policy cannot create volumes: create a volume from the snapshot in the same zone, tag it `brain:home=<name>` and `brain:backup=daily`, then either attach it beside the home and copy back, or replace the home with it (`terraform state rm` the old one, `terraform import` the new one under the same name, and update `CLOUD_HOME_VOLUME`).
- Size: grow it in `home_volumes` and apply, then `sudo resize2fs` the device on the machine; a volume never shrinks.
- It is one copy in one zone: push before every pause all the same (`development-setup` DS1).

## Surviving a Spot reclaim

With Spot (DM10), AWS may take the machine back with two minutes' warning. Work on the home volume (DM9) is never lost; what follows brings the running agents back on the next machine, in the same Herdr workspaces, as soon as its Herdr server starts. For the developer's Herdr to show them, its machine must be a stable SSH host whose `ProxyCommand` finds whichever machine holds the home volume, not an instance id (the `Host i-*` entry above reaches only one machine).

| When | What happens | Where |
|---|---|---|
| Always | Herdr keeps the layout and each agent's session in `~/.config/herdr/session.json` on the home volume, and resumes agents after a restart (`claude --resume`, `codex resume`, `pi --session`) | Herdr, with its agent integrations installed |
| Two-minute warning | `brain-spot-watch` runs `~/.brain/on-reclaim`: Herdr's state saved to `~/.brain/herdr-session.saved.json`, then Herdr stopped so agents flush their sessions; every repository's uncommitted work committed to `reclaim-wip/<folder>-<path hash>/<branch, + for />` (branch, index, and files untouched; nothing for untracked-only changes; tracked changes only unless `BRAIN_WIP_UNTRACKED=1`), pushed without hooks and with `[skip ci]` while the developer is connected | the machine |
| Machine gone | `spot-relaunch-watch.sh` sees the home machine ended with `Server.SpotInstanceTermination` and runs `cloud-up.sh --spot` once the old machine is gone, retrying a failed replacement every minute up to 10 times; a machine launched by anyone else ends the wait; idle and deadline terminations are left alone | the developer's computer |
| New machine boots | at the end of setup, after Docker, `herdr-server.service` replaces any server a client started during setup, puts the saved state back (unless it is stale) and starts `herdr server`, which resumes each agent in its pane at once; until the developer connects, agents have no forwarded SSH agent, so they cannot push. Any later stop of the unit (idle, deadline, reboot) saves the state first, without replacing the reclaim hook's copy, so agents resume after those too | the machine |

One-time setup, per developer:

1. On the machine (stored on the home volume): `herdr integration install claude`, then `codex` and `pi`, so Herdr learns each agent's session; Codex may ask once to trust the hook. Then install the hook: `mkdir -p ~/.brain && cp <agent-skills>/infra/dev-machines/scripts/on-reclaim.sh ~/.brain/on-reclaim`. Its settings go in `~/.brain/config` (it runs from a system service, not your shell): `BRAIN_WIP_ROOTS` (default `~/Desktop ~/work`) and `BRAIN_WIP_UNTRACKED=1` to include untracked files (only where every pushable remote is private: an untracked file can be a secret).
2. On the developer's computer, a launchd job that runs the watcher every minute, `~/Library/LaunchAgents/dev.brain.spot-relaunch.plist`:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0"><dict>
     <key>Label</key><string>dev.brain.spot-relaunch</string>
     <key>ProgramArguments</key><array>
       <string><agent-skills>/infra/dev-machines/scripts/spot-relaunch-watch.sh</string>
     </array>
     <key>EnvironmentVariables</key><dict>
       <key>CLOUD_ENV_FILE</key><string><settings file></string>
       <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
     </dict>
     <key>StartInterval</key><integer>60</integer>
     <key>StandardOutPath</key><string>/tmp/brain-spot-relaunch.log</string>
     <key>StandardErrorPath</key><string>/tmp/brain-spot-relaunch.log</string>
   </dict></plist>
   ```
   then `launchctl load ~/Library/LaunchAgents/dev.brain.spot-relaunch.plist`. Remove it with `launchctl unload` and deleting the file.

Limits: a replacement nobody connects to and whose agents sit idle is shut down after `CLOUD_IDLE_MINUTES` like any other machine (not relaunched; its saved state waits for the next one); Herdr resumes with the bare commands, so options such as `--model` come from each agent's own config; a turn in flight at the warning is cut off (the conversation up to it is kept); the watcher acts only while the developer's computer is awake and the AWS login is valid (it notifies when AWS cannot be reached), and AWS lists a terminated machine for about an hour, so a computer asleep longer misses the reclaim.

## Mobile builds on a machine

`development-setup` DS16 decides where a build runs: Android in the agent's own environment, iOS on EAS only with explicit permission. These are the machine-side paths.

**Android on a dev machine (DM7).** From the project root, with the settings file in `CLOUD_ENV_FILE` and this repository checked out at `<agent-skills>`:

```bash
CLOUD_ENV_FILE=<settings file> <agent-skills>/infra/dev-machines/scripts/android-ec2-build.sh production
```

It joins or launches a dev machine, clones the project's branch there, and runs the project's `scripts/build-android.sh`, else `npx eas-cli build --platform android --local`, on the machine itself, then copies the artifact back and cleans up. The machine image has neither Node, a JDK, nor the Android SDK, and no Expo login: a project that builds this way ships a `scripts/build-android.sh` that runs the build in a container with its pinned toolchain, and the Expo login (`EXPO_TOKEN`) reaches it the way the project's `docs/DEVELOPMENT.md` says; the script copies nothing to the machine itself. It works under its own name, `android-<ticket>-<pid>`, so it never touches an agent's worktree, containers, or registration on the same branch, and removes its own clone when done. Run `cloud-capacity.sh` first if the machine is shared: a Gradle release build needs several GiB of memory and all the cores it can get.

**iOS on an AWS Mac (DM8).** Only when the user has approved it: `scripts/cloud-up.sh <ticket>-<slug> --mac`. It reuses a free brain Mac host; when none exists it refuses until the user approves a new one, asked with "a Mac host bills for at least 24 hours". A Mac takes several minutes to boot. Build with `eas build --platform ios --local` or `xcodebuild archive`; signing credentials come the way the project's `docs/DEVELOPMENT.md` says, for this build only, never committed. Copy the artifact back or submit it from the machine, then `cloud-down.sh`. A Mac machine is terminated at once; its host stays allocated for further iOS builds and is released 24 hours after allocation by its schedule, or by `cloud-reap.sh` after that.
