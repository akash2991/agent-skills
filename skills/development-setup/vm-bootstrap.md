# Ubuntu VM development bootstrap

Run `scripts/bootstrap-vm.sh` from this skill **on the VM**, not on a Mac. First independently confirm that `$HOME` is on durable storage; the script cannot determine whether a mount survives VM replacement. No Hermes directory/configuration is copied.

```sh
scp skills/development-setup/scripts/bootstrap-vm.sh vm:~/bootstrap-vm.sh
ssh vm 'bash ~/bootstrap-vm.sh'                     # default: plan, no mutations
ssh vm 'bash ~/bootstrap-vm.sh --help'
ssh vm 'bash ~/bootstrap-vm.sh --apply'
# Explicit optional installs:
ssh vm 'bash ~/bootstrap-vm.sh --apply --with-docker --with-terraform'
```

## Contract

Apply requires Ubuntu **24.04**, Linux **x86_64/aarch64**, a non-root user, an absolute writable existing HOME, `flock` (Ubuntu's util-linux), GNU `timeout` (coreutils), and noninteractive sudo apt privileges. Sudo policy must permit `apt-get` and the `DEBIAN_FRONTEND=noninteractive` assignment (the preflight uses that same form). With cached sudo credentials rather than NOPASSWD, authenticate in the same session: `ssh -t vm 'sudo -v && bash ~/bootstrap-vm.sh --apply'`. Separate SSH calls do not reliably share sudo's timestamp; a long install can require refreshing it before retrying. No new apt repositories are added. `--dry-run` is an explicit alias for the default plan; if both mode flags appear, the last one wins. Unknown options fail with exit 2. Plans and help work on other platforms without host checks or writes.

Normal plan/apply stdout is **one JSON object** with `status` (`planned`, `ok`, `error`), `mode`, optional-install booleans, and `installed`/`skipped` lists. Status, apt output, checksum results, and installer output go to stderr. Help is human-readable; invalid options report to stderr. Any failed download, checksum, installer, or required command verification makes apply exit nonzero and emit an error summary. Verification uses command version checks, not login, a Docker daemon connection, or an interactive agent session.

## What gets installed

| Component | Missing/broken installation behavior |
| --- | --- |
| Apt base | `git gh ripgrep jq rsync curl ca-certificates unzip xz-utils build-essential pkg-config python3 python3-venv` via Ubuntu apt, with `--no-remove` |
| Node + npm | Retain a working Node **>=22.19** with working npm (including Node 24). Otherwise install official **22.23.2** archive from `nodejs.org`, verifying its exact canonical filename against official `SHASUMS256.txt` before extraction |
| pnpm / Pi | `pnpm@9.15.9` and `@earendil-works/pi-coding-agent@1.3.0`, using `npm install --global --ignore-scripts --prefix "$HOME/.local/share/npm"`; no `npm config set` or `.npmrc` edits |
| Herdr | Official `https://herdr.dev/install.sh`, `HERDR_INSTALL_DIR="$HOME/.local/bin"`. This installs the **actual latest public stable release** via the official latest manifest, **not a claimed 0.9.5 pin**. Linux is supported by that installer |
| uv | Official versioned `https://astral.sh/uv/0.12.5/install.sh`, `UV_INSTALL_DIR="$HOME/.local/bin"`, `UV_NO_MODIFY_PATH=1` |
| Bun | Official `https://bun.sh/install`, `bash -s -- bun-v1.3.14`, `BUN_INSTALL="$HOME/.local"`, `SHELL=/bin/false` to avoid its bash/zsh/fish profile-editing branches |
| Claude Code | Official `https://claude.ai/install.sh`, `bash -s -- 2.1.306`. The upstream script bootstraps using its latest installer binary and passes the requested target version to `claude install` |
| Optional Docker | `--with-docker`: preserve and skip a working Docker CLI plus Compose plugin. Otherwise request apt `docker.io docker-compose-v2` with `--no-remove`, then verify both. Conflicts requiring package removal fail rather than replacing an existing engine |
| Optional Terraform | `--with-terraform`: official **1.16.1** Linux binary ZIP from `releases.hashicorp.com`, verified against official `terraform_1.16.1_SHA256SUMS` **before extraction**, then installed to user bin |

**Reruns preserve working commands**: pnpm, Pi, Herdr, uv, Bun, Claude, and Terraform are checked with `--version` and skipped even if their versions differ from the first-install targets. Node is the exception: an insufficient version (e.g. 22.0) or missing/broken npm triggers the official Node fallback. Apt update/install still runs on each apply (and may update existing distro packages); all install calls use `--no-remove`, which prevents removals, not upgrades or maintainer-script service effects. Docker apt packages are requested only when opted in and the existing Docker/Compose pair does not work. Package locks held by cloud-init/unattended upgrades can cause a reported failure; let the other operation finish before retrying. A broken existing managed Node target directory is not silently overwritten: inspect/remove it manually before repairing. These are bootstrap targets, not continuous version enforcement. Detection uses the **apply process's PATH**, not an automatically sourced version-manager configuration. If the intended working Node is exposed only by an interactive nvm/fnm/asdf setup, run apply from that configured shell; for example, `ssh -t vm 'bash -lic "sudo -v && bash ~/bootstrap-vm.sh --apply"'`. Once the fallback is installed it receives the managed precedence described below.

## PATH, safety, and boundaries

User installs live under durable HOME: `~/.local/bin`, `~/.local/share/npm`, and `~/.local/lib/nodejs/node-v22.23.2-linux-{x64,arm64}`. Installers may also use their standard HOME-local caches/state (for example Claude's `~/.claude` and uv's receipt). Downloads/checksum staging use a private temporary directory under `~/.cache`; it is removed on normal completion, errors, INT, or TERM. SIGKILL/power loss cannot run cleanup. Partial completed installs are **not rolled back**; fix the cause and rerun. A persistent `~/.cache/vm-bootstrap.lock` is held with nonblocking `flock`; concurrent applies fail before package installation. The lock file intentionally remains after exit to avoid lock-inode races.

Every direct curl has connection/transfer/retry bounds and HTTPS-only redirects. Installers receive a private curl shim with the same limits, and each installer has a 15-minute GNU timeout plus a 30-second kill grace. Official installer scripts and their transitive behavior remain upstream-controlled; this is not a fully reproducible or offline installation. Node/Terraform checksums are fetched over official TLS, not independently signature-verified. No live installer execution was used to test this bootstrap.

One managed `~/.config/vm-bootstrap-env.sh` restores canonical precedence on **every** source: managed Node fallback, npm user bin, then local bin. It removes duplicate managed entries while preserving unrelated PATH entries (including their order and empty components), so Ubuntu's `.profile` sourcing `.bashrc` and then prepending local bin cannot restore an older Node ahead of the fallback. Re-sourcing is idempotent. `.profile` and `.bashrc` receive one exact sourcing line, preserving their other content. An unrelated/modified env file or symlink is refused, not overwritten; symlinked shell profiles are also refused rather than appended through. Existing `.bash_profile` files are not changed; if yours bypasses `.profile`, source the env file there yourself. This script does not export PATH into its parent shell. Open a new configured shell or source the env file explicitly.

**Noninteractive SSH usually does not read these shell profiles.** The example below assumes a compatible Node is already on the runtime PATH or the managed fallback was installed. If apply retained nvm/fnm/asdf Node, initialize that manager in the SSH command or use a shell configured to load it before invoking Pi/pnpm; sourcing `vm-bootstrap-env.sh` alone does **not** supply that retained Node. Then use:

```sh
ssh vm '. "$HOME/.config/vm-bootstrap-env.sh"; pi --version; herdr --version'
```

No authentication, credentials, config/session copying, cloud provisioning, mount changes, user/group changes, AWS/gcloud installs, or manual service operations occur. **Docker exception:** explicitly opting into Docker authorizes ordinary apt maintainer-script behavior, which **may automatically enable/start its daemon**. The bootstrap never invokes `systemctl` or adds the user to the Docker group; daemon access may still require sudo. Do not opt in if that service behavior is unacceptable. Upstream agent installers may create their own installation metadata; account login is still manual.

To undo PATH setup, remove the two exact sourcing lines and the managed env file. Package/binary removal is manual; do not remove unrelated preexisting tools.

## Hermetic verification

```sh
node --test scripts/bootstrap-vm-test.js
bash -n skills/development-setup/scripts/bootstrap-vm.sh
shellcheck skills/development-setup/scripts/bootstrap-vm.sh
```

The suite uses temporary fake HOME directories (including spaces), an allowlisted PATH, local archives with real SHA-256 checking/extraction, fake apt/sudo/npm/curl/installers, and sourced host-release probes. It exercises the real `main` parser and full apply flow plus direct CLI plan/help/error/root-gate tests. No real apt, sudo, curl, npm, downloaded upstream installer, or real HOME is used. Test prerequisites: Node's test runner, Bash, tar with xz, zip/unzip, SHA-256 tools, and standard filesystem/text utilities. GNU timeout and flock are stubbed in these cross-platform tests: Linux kernel lock exclusion, real timeout signal delivery, upstream installer compatibility, live release availability, and actual Ubuntu apt/daemon behavior still need a separately authorized VM smoke test.
