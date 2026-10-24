# Cloud machines and mobile builds

How agents develop on shared EC2 machines and build the mobile app under `development-setup` DS10–DS18. The scripts are in `scripts/`, run from the project root (`android-ec2-build.sh` and `ios-eas-build.sh` from the app directory), and read the project's `.env`; the project's `.env.example` lists every variable.

## One-time setup (the user)

An agent never creates these; when one is missing, the script names it and the agent asks the user.

The network, access, and deadline role are defined in the [brain source repository's Terraform directory](https://github.com/akash2991/agent-skills/tree/main/skills/development-setup/terraform), applied once per AWS account and shared by every project in it: a dev VPC with public subnets and no NAT gateway, an EC2 Instance Connect Endpoint, the `brain-dev` security group (SSH from that endpoint only, nothing from the internet), the `brain-dev` key pair, the `brain-dev-scheduler` role, a home volume per developer with daily snapshots (DS18), and a `brain-dev-operator` policy to attach to each developer's IAM user or role. State is in the S3 bucket `init.sh` creates.

Provisioning sources are not installed into consuming projects. For an already provisioned account, reuse its output IDs in the new project's `.env`; do not provision again per repository. For initial setup or account-wide changes, the user runs these commands from a checkout of the brain source repository, not from the consuming project:

```bash
cd /path/to/agent-skills/skills/development-setup/terraform
cp terraform.tfvars.example terraform.tfvars      # the profile, the public key, each developer's home volume
./init.sh <aws-profile>
terraform plan -out=dev.tfplan && terraform apply dev.tfplan
terraform output -raw env                         # paste into the project's .env
terraform output home_volume_ids                  # each developer's CLOUD_HOME_VOLUME
```

Nobody's address is listed: the endpoint lets in whoever's AWS profile may open a tunnel to it (`brain-dev-operator`). A new developer's home volume is a line in `home_volumes` and another apply; Terraform never deletes one (`prevent_destroy`), so a volume that is no longer wanted is deleted by hand after its last snapshot.

| `.env` variable | What it is |
|---|---|
| `AWS_PROFILE` | the profile the scripts run as; its credentials stay on this machine (DS15) |
| `CLOUD_REGION` | the region for every brain machine |
| `CLOUD_SUBNET` | a subnet that assigns public addresses, used for outbound traffic only, in the home volumes' zone |
| `CLOUD_SECURITY_GROUP` | inbound TCP 22 from the Instance Connect Endpoint only, nothing else (DS15) |
| `CLOUD_KEY_NAME` | an EC2 key pair whose private key is in this machine's SSH agent |
| `CLOUD_HOME_VOLUME` | optional: this developer's home volume, from `terraform output home_volume_ids` (DS18) |
| `CLOUD_SCHEDULER_ROLE_ARN` | a role EventBridge Scheduler assumes (trust `scheduler.amazonaws.com`) with `ec2:TerminateInstances` and `ec2:ReleaseHosts`, conditioned on the tag `brain=dev` |
| `CLOUD_MAC_AMI` | for iOS on AWS only: a macOS AMI prepared with the Xcode, Node, CocoaPods, and EAS CLI versions the project pins |
| `EXPO_TOKEN` | an Expo access token for EAS Build |

The tunables, with their defaults, are in `.env.example`; a project that changes one records why in `docs/DEVELOPMENT.md`.

The profile needs `ec2:RunInstances`, `TerminateInstances`, `Describe*`, `CreateTags`, `AttachVolume`, `AllocateHosts`, `ReleaseHosts`; `ec2-instance-connect:OpenTunnel` on the endpoint; `ssm:GetParameter`; `scheduler:CreateSchedule`, `UpdateSchedule`, `DeleteSchedule`, `ListSchedules`; and `iam:PassRole` on the scheduler role.

## What guards the cost

| Guard | Where | Stops |
|---|---|---|
| Sharing | `cloud-up.sh` joins the first live machine with headroom by `cloud-capacity.sh` | a machine per agent (DS11) |
| Size and count | `cloud-up.sh` refuses another type, a machine past `CLOUD_MAX_MACHINES`, and a new Mac host without `--approved` | the machine nobody asked for (DS12) |
| Idle | a watchdog on the machine | a machine with no SSH connection and a load under a quarter of its vCPUs for `CLOUD_IDLE_MINUTES` (DS13) |
| Deadline | the watchdog, and an EventBridge schedule from the AWS side; each join moves it to `CLOUD_MAX_HOURS` from then | a forgotten or hung machine (DS13) |
| Shutdown | `--instance-initiated-shutdown-behavior terminate` | the disk bill: a shutdown terminates, it never stops (DS13) |
| Leaving | `cloud-down.sh` terminates when the last agent's directory is gone | a machine nobody is on (DS14) |
| Reaper | `cloud-reap.sh` at every session's start and end | expired or stopped machines, stale schedules, Mac hosts past 24 hours (DS14) |

A job left running detached with no SSH connection and a low load is idle; keep the SSH session open for the length of any long job.

## Metrics

The watchdog appends `epoch load1 vcpus mem_used_pct disk_used_pct` to `/var/lib/brain/metrics` every minute. `cloud-capacity.sh <instance-id>` reads the last 15 minutes and says whether the machine has headroom: average load under `CLOUD_MAX_CPU_PCT` of its vCPUs, and memory and disk under `CLOUD_MAX_MEM_PCT` and `CLOUD_MAX_DISK_PCT`. A machine with under 5 minutes of metrics counts as having room. These are the machine's metrics, not the app's: a project's own Prometheus and Grafana stay per agent (DS6). Run it yourself before starting a heavy job (a full build, a load test) on a shared machine; if it shows no headroom, wait or ask for another machine with its output as the evidence (DS12).

## Development

1. `scripts/cloud-reap.sh`.
2. `scripts/cloud-up.sh <ticket>` joins a machine with headroom or launches one, and prints `instance_id`, `home_volume`, `ssh`, `expires_at`, and `joined`. When it refuses, ask the user with its message and the metrics, record the answer on the ticket, then rerun with `--approved "<their words>"` (and `--type <type>` for a larger machine).
3. SSH by instance ID through the endpoint, with the command `cloud-up.sh` printed or this entry in `~/.ssh/config`, then `ssh <instance-id>`:
   ```
   Host i-*
     User ec2-user
     ForwardAgent yes
     ProxyCommand aws ec2-instance-connect open-tunnel --instance-id %h --profile <AWS_PROFILE> --region <CLOUD_REGION>
   ```
   On a new machine wait for `cloud-init status --wait`. `git clone` the repository into `~/work/<ticket>-<slug>` and check out the branch. The forwarded agent pushes, and the machine pins GitHub to the key that logged in (`CLOUD_KEY_NAME`'s key), so an agent holding a work and a personal GitHub key uses the right one; clone with `git@github.com:<owner>/<repo>.git`. Nothing else is copied over (DS15).
4. In that directory, as locally: `docker compose -p <ticket>-<slug> up` for the services you touch, LocalStack, the seed or snapshot, and Prometheus, Grafana, and Loki when debugging (DS3–DS6, DS10). Pick host ports no other project on the machine uses (`docker ps --format '{{.Ports}}'`) and set them in the directory's `.env`.
5. Reach a service with a tunnel, `ssh -L 3000:localhost:<port> <instance-id>`; never open a port on the security group.
6. Commit and push before every pause (DS15).
7. Done: push, `scripts/cloud-down.sh <instance-id> <ticket>-<slug>`, `scripts/cloud-reap.sh`.

## Home volume

With `CLOUD_HOME_VOLUME` set, a developer's machine mounts their home volume as `/home/ec2-user` (DS18), so `~/work`, agent sessions, user-level tools, and anything else under the home folder survive termination; Docker images, system packages, and everything else on the root disk do not. The first machine formats an empty volume; later ones mount it as it was.

- One machine at a time: the volume attaches to one machine, in its zone, so `cloud-up.sh` joins the machine that has it, and refuses when that machine has no headroom.
- Snapshots: one every 24 hours at 17:00 UTC; only the latest is kept (`snapshot_days`, 1), so a mistake noticed after the next snapshot cannot be undone from it. Each snapshot stores only the blocks in use and changed since the last. Restore a file by creating a volume from a snapshot in the same zone, attaching it to the machine, and copying back; restore the whole home by setting `CLOUD_HOME_VOLUME` to that new volume.
- Size: grow it in `home_volumes` and apply, then `sudo resize2fs` the device on the machine; a volume never shrinks.
- It is one copy in one zone: push before every pause all the same (DS15).

## Mobile builds

Android on EC2 by default; EAS for iOS only with explicit permission (DS16).

### Android

From the app directory:

```bash
skills/development-setup/scripts/android-ec2-build.sh production
```

This joins or launches a dev machine, builds in a Docker container with the JDK and Android SDK the project pins, copies the artifact back, and cleans up. Run `cloud-capacity.sh` first if you are already on a shared machine: a Gradle release build needs several GiB of memory and all the cores it can get.

The user may send an Android build to EAS as an override; record it on the ticket.

### iOS

From the app directory, only with explicit user permission:

```bash
skills/development-setup/scripts/ios-eas-build.sh production
```

| Exit | Meaning | Next |
|---|---|---|
| 0 | built on EAS; prints the artifact URL | done |
| 4 | this month's free iOS builds are used up | ask the user whether to wait for next month or build on AWS; note the decision on the ticket |
| 5 | the queue wait passed `EAS_MAX_QUEUE_MINUTES`; the EAS build was canceled | ask the user whether to retry or build on AWS; note the decision on the ticket |
| 1 | the build failed on EAS; prints the error code and message | read the logs (`eas build:view <id>`), report the reason on the ticket with a recommendation; the app's own failure is fixed and rebuilt on EAS; moving to AWS or local is the user's call |

**iOS on this machine (override):** only with explicit user permission, on macOS with the Xcode version the project pins. Record the decision on the ticket; permission to build locally does not waive the pinned toolchain.

**iOS on AWS (override):** `scripts/cloud-up.sh <ticket> --mac`. It reuses a free brain Mac host; when none exists it refuses until the user approves a new one, asked with "a Mac host bills for at least 24 hours" (DS17). A Mac takes several minutes to boot. Build with `eas build --platform ios --local` or `xcodebuild archive`. Signing credentials come the way `docs/DEVELOPMENT.md` says, for this build only, never committed. `scp` the artifact back or submit it from the machine, then `cloud-down.sh`. A Mac machine is terminated at once; its host stays allocated for further iOS builds and is released 24 hours after allocation by its schedule, or by `cloud-reap.sh` after that.
